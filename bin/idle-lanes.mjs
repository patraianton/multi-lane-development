// Idle lanes (decision 15): a lane assigned to a sprint sits free while a unit
// of that sprint waits with nothing in its way. That is never a state to sit
// in — the board says so itself: a line on the page and in /api/pipeline at
// once, and after a short grace an alarm to the owner. Lanes are for writing
// code; the CI/PR queue never holds one.
//
// Pure: watchtower.mjs feeds it the sprint facts and the ledger; tests feed
// fixtures.

const ACTIVE = new Set(['ticketed', 'development', 'local_check', 'ci_pr', 'merged']);
const FIX_DEBT_STAGES = new Set(['development', 'local_check', 'ci_pr']);

function sameHead(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(x) && /^[0-9a-f]{7,40}$/.test(y)
    && (x.startsWith(y) || y.startsWith(x));
}

function failureOnCurrentHead(pr, head) {
  const verdict = pr?.verdictOnHead;
  if (sameHead(verdict?.head, head)) return verdict.go === false;
  const ciHead = pr?.ci?.headSha ?? pr?.rollupHeadSha ?? null;
  const red = String(pr?.ci?.color ?? pr?.ciColor ?? '').toLowerCase() === 'red';
  if (red && (!ciHead || sameHead(ciHead, head))) return true;
  return String(pr?.mergeable ?? '').toUpperCase() === 'CONFLICTING';
}

function isQaRun(unit) {
  const labels = Array.isArray(unit?.labels) ? unit.labels.map(label => String(label).toLowerCase()) : [];
  return Boolean(unit?.qaRun) || labels.includes('qa-run');
}

// A queued unit can start when every dependency inside the sprint is merged,
// closed, or at least carries an open PR (a unit starts from the head of its
// dependency's open PR — MANDATE.md §2). A dependency still on a lane, or one
// outside the sprint, holds it.
export function startable(unit) {
  if (!unit) return false;
  if (isQaRun(unit)) {
    if (!unit.open || unit.merged || unit.pr || unit.lane) return false;
    return (unit.deps ?? []).every(d => d?.met === true);
  }
  if (unit.qa) {
    if (!unit.open || unit.merged || unit.pr || unit.lane) return false;
  } else if (unit.state !== 'queued') return false;
  for (const d of unit.deps ?? []) {
    if (d.met) continue;
    if (d.met === null) return false;
    if (unit.depsMerged) return false; // "depends on (merged)": a PR head is not enough
    if (typeof d.state === 'string' && d.state.startsWith('pr')) continue;
    return false;
  }
  return true;
}

// The unit's own card on the board, if spawned.
export function unitCardOf(cards, sprintCardId, unit) {
  return (cards ?? []).find(c => c?.parent === sprintCardId && Number(c.ticket) === Number(unit?.ticket)) ?? null;
}

// Startable by the facts AND by the board: right after a merge the live
// sources can lag one sweep — the open PR is gone, the merged PR and the
// closed ticket not yet seen — and the unit looks queued for a minute. The
// card remembers: a unit whose card has left `ticketed`, carries a PR, or (for
// a QA ticket) carries a lane has started and is never dispatched again. Both
// ordinary and QA unit cards wait in `ticketed` before their first dispatch.
export function startableOnBoard(unit, sprintCardId, cards) {
  if (!startable(unit)) return false;
  const uc = unitCardOf(cards, sprintCardId, unit);
  if (!uc) return true;
  if (uc.links?.pr) return false;
  return uc.stage === 'ticketed' && (!(unit.qa || isQaRun(unit)) || !uc.lane);
}

// cards: the pipeline's cards; sprints: Map(card id -> sprint facts).
// One finding per active sprint card that has at least one free assigned lane
// and at least one startable unit.
export function idleLaneFindings(cards, sprints, { at = null, excludeTickets = [] } = {}) {
  const excluded = new Set([...excludeTickets].map(ticket => String(ticket)));
  const out = [];
  for (const card of cards ?? []) {
    if (card?.parent || !ACTIVE.has(card?.stage)) continue;
    const s = sprints?.get?.(card.id);
    if (!s) continue;
    if (Array.isArray(s.stale) && s.stale.length) continue; // unknown is not idle
    const free = Array.isArray(s.free) ? s.free : [];
    if (!free.length) continue;
    const waiting = [...(s.units ?? []), ...(s.qaTickets ?? [])]
      .filter(u => !excluded.has(String(u?.ticket)) && startableOnBoard(u, card.id, cards))
      .map(u => ({ unit: u.unit || '', ticket: u.ticket, title: u.title || '' }));
    if (!waiting.length) continue;
    out.push({
      key: `idle:${card.id}`,
      card: { id: card.id, title: String(card.title ?? ''), stage: card.stage },
      free: free.slice(),
      startable: waiting,
      at,
    });
  }
  return out;
}

// An open PR can carry fix debt while no free-lane finding exists. This second
// finding is deliberately unit-card scoped: only work already on the road can
// be stuck, and a planner hold/attempt or a busy lane means it was dispatched.
export function fixDebtFindings(cards, sprints, { at = null, excludeTickets = [] } = {}) {
  const excluded = new Set([...excludeTickets].map(ticket => String(ticket)));
  const out = [];
  for (const card of cards ?? []) {
    if (card?.parent || !ACTIVE.has(card?.stage)) continue;
    const sprint = sprints?.get?.(card.id);
    if (!sprint || sprint.umbrellaOpen !== true) continue;
    if (Array.isArray(sprint.stale) && sprint.stale.length) continue;
    for (const unit of [...(sprint.units ?? []), ...(sprint.qaTickets ?? [])]) {
      if (excluded.has(String(unit?.ticket))) continue;
      const unitCard = unitCardOf(cards, card.id, unit);
      if (!unitCard || !FIX_DEBT_STAGES.has(unitCard.stage)) continue;
      const pr = unit?.pr;
      const head = String(pr?.headSha ?? '');
      const closed = pr?.open === false || ['CLOSED', 'MERGED'].includes(String(pr?.state ?? '').toUpperCase());
      if (!head || !pr || unit?.merged || closed || !failureOnCurrentHead(pr, head)) continue;
      const busy = unit?.lane?.busy === true || (sprint.laneTable ?? []).some(lane =>
        lane?.busy === true && Number(lane.ticket) === Number(unit.ticket));
      if (busy) continue;
      out.push({
        key: `fix-debt:${card.id}:${unit.ticket}:${head.slice(0, 8)}`,
        card: { id: unitCard.id, title: String(unitCard.title ?? `${unit.unit || ''} #${unit.ticket}`).trim() },
        ticket: unit.ticket, unit: unit.unit || '', head, at,
      });
    }
  }
  return out;
}

// The ledger remembers when each finding was first seen and when it last
// alarmed. A finding alarms once it is older than the grace, and again after
// every repeat interval while it persists. A finding that is gone is dropped.
//   ledger: { seen: { key: { first, last, alarmedAt } } }
// Returns { ledger, active: [finding + since (ISO) + ageMs], alarms: [finding + ageMs] }.
export function idleLedger(ledger, findings, at, { graceMs = 5 * 60 * 1000, repeatMs = 20 * 60 * 1000 } = {}) {
  const now = Date.parse(at ?? '') || Date.now();
  const nowIso = new Date(now).toISOString();
  const seen = {};
  const active = [];
  const alarms = [];
  for (const f of findings ?? []) {
    const prev = ledger?.seen?.[f.key];
    const first = prev?.first ?? nowIso;
    const firstMs = Date.parse(first) || now;
    const ageMs = Math.max(0, now - firstMs);
    let alarmedAt = prev?.alarmedAt ?? null;
    const lastAlarmMs = alarmedAt ? Date.parse(alarmedAt) : null;
    const due = ageMs >= graceMs && (lastAlarmMs == null || now - lastAlarmMs >= repeatMs);
    if (due) { alarmedAt = nowIso; alarms.push({ ...f, since: first, ageMs }); }
    seen[f.key] = { first, last: nowIso, alarmedAt };
    active.push({ ...f, since: first, ageMs });
  }
  return { ledger: { seen }, active, alarms };
}

function fmtMin(ms) {
  const m = Math.round((ms ?? 0) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The one-line reading of a finding, for the page, the API and the alarm.
export function idleLine(f) {
  const queued = (f.startable ?? []).map(u => `${u.unit ? u.unit + ' ' : ''}#${u.ticket}`).join(', ');
  return `${f.free.join(', ')} free for ${fmtMin(f.ageMs)} while ${queued} ${f.startable.length === 1 ? 'waits' : 'wait'} with nothing in the way`;
}
