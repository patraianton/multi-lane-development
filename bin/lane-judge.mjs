// Pure proof policy for lane runs. The caller owns persistence and side
// effects: this module returns an updated journal plus explicit failure and
// retry records, but never changes its inputs or calls the pipeline.

function timeOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return Date.parse(value);
}

function snapshot(source) {
  const at = source && !Array.isArray(source)
    ? source.at ?? source.fetchedAt ?? source.observedAt
    : source?.at;
  let items;
  if (Array.isArray(source)) items = source;
  else if (source instanceof Map) items = [...source.values()].flat();
  else if (Array.isArray(source?.items)) items = source.items;
  else if (Array.isArray(source?.value)) items = source.value;
  else if (source?.value instanceof Map) items = [...source.value.values()].flat();
  else items = [];
  return { at: timeOf(at), items };
}

function labelsOf(value) {
  return Array.isArray(value?.labels)
    ? value.labels.map(label => String(label?.name ?? label).toLowerCase())
    : [];
}

function ticketNumber(value) {
  const n = Number(value?.number ?? value?.ticket);
  return Number.isFinite(n) ? n : null;
}

function branchOf(value) {
  return String(value?.branch ?? value?.headRefName ?? '')
    .trim()
    .replace(/^refs\/heads\//, '');
}

function laneNameOf(value) {
  if (typeof value === 'string') return value;
  if (value?.name) return String(value.name);
  const lane = String(value?.lane ?? '');
  const host = String(value?.host ?? '');
  return host && lane ? `${host}/${lane}` : lane;
}

function laneIsFree(value) {
  if (typeof value === 'string') return true;
  if (!value || value.hostOk === false || value.remembered === true) return false;
  if (typeof value.busy === 'boolean') return !value.busy;
  if (typeof value.free === 'boolean') return value.free;
  const state = String(value.state ?? '').toLowerCase();
  return ['free', 'idle', 'ready', 'available'].includes(state);
}

function sameHead(left, right) {
  const a = String(left ?? '').trim().toLowerCase();
  const b = String(right ?? '').trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function prBelongsTo(entry, pr) {
  const branch = branchOf(entry);
  const prBranch = branchOf(pr);
  if (branch && prBranch) return branch === prBranch;
  const number = ticketNumber(pr);
  return number != null && number === Number(entry?.ticket);
}

function openOrMerged(pr) {
  if (pr?.merged === true || pr?.mergedAt) return true;
  const state = String(pr?.state ?? '').toUpperCase();
  if (state === 'MERGED') return true;
  if (state === 'CLOSED' || pr?.open === false) return false;
  // The live open-PR source does not add a state field. Presence in that
  // source is therefore open unless it explicitly says otherwise.
  return true;
}

function verdictOn(entry, prs) {
  for (const pr of prs) {
    if (!prBelongsTo(entry, pr)) continue;
    const verdicts = [
      pr?.verdictOnHead,
      ...(Array.isArray(pr?.verdicts) ? pr.verdicts : []),
      pr?.verdict,
    ].filter(Boolean);
    const verdict = verdicts.find(item => typeof item?.go === 'boolean' && sameHead(item.head, entry.head));
    if (verdict) return verdict;
  }
  return null;
}

function ticketClosed(ticket) {
  if (!ticket) return false;
  if (ticket.closedAt || ticket.open === false) return true;
  return String(ticket.state ?? '').toUpperCase() === 'CLOSED';
}

function isQaRun(entry, ticket) {
  return entry?.qaRun === true
    || String(entry?.role ?? '').toLowerCase() === 'qa'
    || labelsOf(entry).includes('qa-run')
    || labelsOf(ticket).includes('qa-run');
}

function proofFor(entry, prs, ticket) {
  if (isQaRun(entry, ticket)) {
    return ticketClosed(ticket)
      ? { ok: true, reason: `qa-run ticket #${entry.ticket} is closed` }
      : { ok: false, reason: `qa-run ticket #${entry.ticket} is still open` };
  }

  const matching = prs.filter(pr => prBelongsTo(entry, pr));
  switch (String(entry?.kind || 'develop')) {
    case 'develop': {
      const pr = matching.find(openOrMerged);
      return pr
        ? { ok: true, reason: `open or merged PR on ${branchOf(entry)}` }
        : { ok: false, reason: `no open or merged PR on ${branchOf(entry)}` };
    }
    case 'review': {
      const verdict = verdictOn(entry, matching);
      return verdict
        ? { ok: true, reason: `countable verdict on ${entry.head}` }
        : { ok: false, reason: `no countable verdict on ${entry.head}` };
    }
    case 'fix': {
      const changed = matching.find(pr => pr?.headSha && !sameHead(pr.headSha, entry.head));
      return changed
        ? { ok: true, reason: `PR head changed from ${entry.head} to ${changed.headSha}` }
        : { ok: false, reason: `no new PR head after ${entry.head}` };
    }
    default:
      return { ok: false, reason: `unknown lane kind ${entry?.kind}` };
  }
}

function hostOf(entry) {
  if (entry?.host) return String(entry.host);
  const lane = String(entry?.lane ?? '');
  const slash = lane.indexOf('/');
  return slash < 0 ? null : lane.slice(0, slash);
}

function roundOf(entry) {
  const round = Number(entry?.round);
  return Number.isInteger(round) && round > 0 ? round : 1;
}

// journal: { dispatched: { key: entry } }
// lanes: an array, or { at, items }; a timestamped free snapshot must be newer
//   than the launch so a cached pre-launch probe cannot finish a task.
// prs/tickets: { at, items } snapshots. Both timestamps must be strictly newer
//   than firstSeenFree before absence is evidence. When `items` combines open
//   and merged PR sources, `at` must be the older of those source timestamps.
// Returns an immutable journal update and effects for the caller:
//   judgments: completed decisions; failures: failCard inputs; retries: queue
//   identities with the previous host explicitly de-preferred.
export function judgeLanes({ journal = {}, lanes = [], prs = {}, tickets = {}, now = null } = {}) {
  const nowMs = Number.isFinite(timeOf(now)) ? timeOf(now) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const laneFacts = snapshot(lanes);
  const prFacts = snapshot(prs);
  const ticketFacts = snapshot(tickets);
  const dispatched = { ...(journal?.dispatched ?? {}) };
  const judgments = [];
  const failures = [];
  const retries = [];

  const free = new Set(laneFacts.items.filter(laneIsFree).map(laneNameOf));
  const ticketsByNumber = new Map(ticketFacts.items.map(ticket => [ticketNumber(ticket), ticket]));

  for (const [key, original] of Object.entries(journal?.dispatched ?? {})) {
    if (!original || original.result !== 'launched' || original.judged != null) continue;
    if (!free.has(String(original.lane ?? ''))) continue;

    const launchedAt = timeOf(original.at);
    if (Number.isFinite(laneFacts.at) && Number.isFinite(launchedAt) && laneFacts.at <= launchedAt) continue;

    const seenMs = timeOf(original.firstSeenFree);
    if (!Number.isFinite(seenMs)) {
      dispatched[key] = { ...original, firstSeenFree: nowIso };
      continue;
    }
    // Source refresh times, not a PR's/ticket's updatedAt, make a missing fact
    // meaningful. Equal timestamps still belong to the sweep that saw free.
    if (!(prFacts.at > seenMs && ticketFacts.at > seenMs)) continue;

    const proof = proofFor(original, prFacts.items, ticketsByNumber.get(Number(original.ticket)));
    const judged = proof.ok ? 'ok' : 'no-proof';
    const reason = proof.ok ? proof.reason : `${proof.reason} after ${original.lane} freed`;
    const decision = {
      key,
      card: original.card ?? null,
      ticket: original.ticket,
      kind: String(original.kind || 'develop'),
      round: roundOf(original),
      lane: original.lane,
      host: hostOf(original),
      judged,
      judgedAt: nowIso,
      reason,
    };
    dispatched[key] = { ...original, judged, judgedAt: nowIso, judgeReason: reason };
    judgments.push(decision);

    if (!proof.ok) {
      failures.push(decision);
      const round = roundOf(original) + 1;
      const kind = String(original.kind || 'develop');
      retries.push({
        key: `${original.ticket}:${kind}:${round}`,
        previousKey: key,
        card: original.card ?? null,
        unit: original.unit ?? '',
        ticket: original.ticket,
        branch: original.branch ?? '',
        kind,
        round,
        head: original.head ?? null,
        previousLane: original.lane,
        avoidHost: hostOf(original),
        preferAnotherHost: true,
      });
    }
  }

  return { journal: { ...journal, dispatched }, judgments, failures, retries };
}
