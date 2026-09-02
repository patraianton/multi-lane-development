function isQaRun(ticket) {
  const labels = Array.isArray(ticket?.labels) ? ticket.labels.map(label => String(label).toLowerCase()) : [];
  return Boolean(ticket?.qaRun) || labels.includes('qa-run');
}

function isClosed(ticket) {
  return ticket?.open === false || Boolean(ticket?.closedAt)
    || String(ticket?.state ?? '').toUpperCase() === 'CLOSED';
}

function qaRound(ticket) {
  const match = /\bQA\s+R(\d+)\b/i.exec(String(ticket?.title ?? ''));
  return match ? Number(match[1]) : 1;
}

function parts(sprint) {
  const units = Array.isArray(sprint?.units) ? sprint.units : [];
  const qa = Array.isArray(sprint?.qaTickets) ? sprint.qaTickets : [];
  const runs = qa.filter(isQaRun);
  const findings = qa.filter(ticket => !isQaRun(ticket));
  const walk = runs.filter(run => Number.isFinite(Date.parse(run?.closedAt ?? '')))
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))[0] ?? null;
  return { units, runs, findings, walk };
}

export function readyBlocker(sprint) {
  const { units, runs, findings, walk } = parts(sprint);
  const unit = units.find(item => !item?.merged);
  if (unit) return `unit #${unit.ticket} not merged`;
  const finding = findings.find(item => !item?.merged && !isClosed(item));
  if (finding) return `finding #${finding.ticket} open`;
  const openRun = runs.find(run => !isClosed(run) || !run.closedAt);
  if (openRun) return `QA run #${openRun.ticket} open`;
  if (!walk) return 'no closed QA run';
  const late = findings.find(item => item?.merged?.mergedAt
    && Date.parse(item.merged.mergedAt) > Date.parse(walk.closedAt));
  if (late) {
    const round = qaRound(walk);
    return `finding #${late.ticket} merged after QA R${round} closed — no QA R${round + 1} ticket: cut it`;
  }
  return null;
}

export function readyForAcceptance(sprint) {
  return readyBlocker(sprint) === null;
}
