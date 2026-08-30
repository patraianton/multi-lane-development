// Ready for acceptance is a fact derived from one sprint snapshot. Keeping the
// predicate here makes the watchtower edge (persist once, notify once) easy to
// test without GitHub, Telegram, or pipeline state.

function labelsOf(ticket) {
  return Array.isArray(ticket?.labels)
    ? ticket.labels.map(label => String(label).toLowerCase())
    : [];
}

function isQaRun(ticket) {
  return Boolean(ticket?.qaRun) || labelsOf(ticket).includes('qa-run');
}

function isClosed(ticket) {
  return ticket?.open === false
    || Boolean(ticket?.closedAt)
    || String(ticket?.state ?? '').toUpperCase() === 'CLOSED';
}

function createdMs(ticket) {
  const value = Date.parse(ticket?.createdAt ?? '');
  return Number.isFinite(value) ? value : null;
}

function qaTicketsOf(sprint) {
  return Array.isArray(sprint?.qaTickets) ? sprint.qaTickets : [];
}

// Clearing persisted readiness is deliberately narrower than losing the
// predicate: old readiness survives a transiently incomplete facts snapshot.
// It is invalidated only by the workflow event that starts another QA round.
function hasFindingAfterLatestRun(sprint) {
  const qaTickets = qaTicketsOf(sprint);
  const runTimes = qaTickets.filter(isQaRun).map(createdMs);
  if (!runTimes.length || runTimes.some(at => at === null)) return false;
  const latestRunAt = Math.max(...runTimes);
  return qaTickets.some(ticket => !isQaRun(ticket)
    && createdMs(ticket) !== null
    && createdMs(ticket) > latestRunAt);
}

// sprint is the value produced by sprintFactsFor:
//   { units: [{ merged }], qaTickets: [{ labels, qaRun?, merged, open,
//     closedAt, state, createdAt }] }
// `qaTickets` contains both QA findings and QA-run walks. A walk must close;
// unlike a finding, merely merging it is not its proof.
export function readyForAcceptance(sprint) {
  const units = Array.isArray(sprint?.units) ? sprint.units : [];
  const qaTickets = qaTicketsOf(sprint);
  const qaRuns = qaTickets.filter(isQaRun);
  const findings = qaTickets.filter(ticket => !isQaRun(ticket));

  if (!units.every(unit => Boolean(unit?.merged))) return false;
  if (!findings.every(ticket => Boolean(ticket?.merged) || isClosed(ticket))) return false;
  if (!qaRuns.length) return false;

  // Missing creation times make both "latest" and "none created later"
  // unknowable, so they cannot make a sprint ready.
  const runTimes = qaRuns.map(ticket => [ticket, createdMs(ticket)]);
  const findingTimes = findings.map(createdMs);
  if (runTimes.some(([, at]) => at === null) || findingTimes.some(at => at === null)) return false;

  const [latestRun, latestRunAt] = runTimes.reduce((latest, candidate) => (
    candidate[1] > latest[1] ? candidate : latest
  ));
  if (!isClosed(latestRun)) return false;
  if (findingTimes.some(at => at > latestRunAt)) return false;

  return true;
}

function isoNow(now) {
  const value = now instanceof Date ? now.valueOf() : Date.parse(now ?? '');
  if (!Number.isFinite(value)) throw new TypeError('applyReadyAt needs a valid now timestamp');
  return new Date(value).toISOString();
}

// Pure edge helper. The caller persists `card.readyAt` only when one of the
// flags is true, and sends the ready notification only for `becameReady`.
export function applyReadyAt(card, sprint, now) {
  const previous = typeof card?.readyAt === 'string' && card.readyAt.trim()
    ? card.readyAt
    : null;
  const ready = readyForAcceptance(sprint);
  const cleared = previous !== null && hasFindingAfterLatestRun(sprint);
  const next = cleared ? null : (previous ?? (ready ? isoNow(now) : null));

  return {
    card: { ...(card ?? {}), readyAt: next },
    becameReady: ready && previous === null,
    cleared,
  };
}
