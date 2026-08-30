// Auto-dispatch (decision 16): a free assigned lane and a startable unit meet
// on the board itself. The same facts that raise the idle-lanes alarm
// (decision 15) now carry the unit to the lane: the board writes the task
// file — the full ticket text, the committed rules for its role, the base to
// start from — ships it with the spec bundle to the lane's host, and starts the
// lane through the launcher the fleet registry names (`hzlane N`, `maclane N`).
// One unit per lane, one launch per lane per sweep, never twice for a unit:
// the journal (state/auto-dispatch.json) remembers what went where.
//
// Pure parts — the planner, the base, the task text, the launch plan, the
// journal — take fixtures. The board (watchtower.mjs) feeds them the live
// sprint facts, the journal and the fleet launch config; the settings decide
// whether it runs the plan or only says what it would do (the log, /api/pipeline).

import path from 'node:path';
import { startableOnBoard } from './idle-lanes.mjs';

const ACTIVE = new Set(['ticketed', 'development', 'local_check', 'ci_pr', 'merged']);
// A failed or held launch is not tried again sooner than this.
export const RETRY_MS = 10 * 60 * 1000;
// A process can die between journalling its intent and recording the launch.
// Until this expires, another sweep must not start the same task.
export const LAUNCHING_HOLD_MS = 15 * 60 * 1000;
// A lane the board just launched counts as taken until the probe agrees —
// the lane source refreshes slower than the sweep runs.
export const LANE_HOLD_MS = 10 * 60 * 1000;
// Journal entries older than this are dropped; a unit dispatched a week ago
// has long since bound itself to a branch or a PR.
export const JOURNAL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PROMPT = 'Прочитай {taskFile} и выполни целиком';
export const DEFAULT_CHECK = 'bash ../ci-local-and-stamp.sh';

function laneNo(name) {
  const m = /(\d+)/.exec(String(name ?? ''));
  return m ? Number(m[1]) : 999;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 8) : '';
}

function sameHead(a, b) {
  const x = String(a ?? '').toLowerCase();
  const y = String(b ?? '').toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(x) && /^[0-9a-f]{7,40}$/.test(y)
    && (x.startsWith(y) || y.startsWith(x));
}

function kindOf(pair) {
  return String(pair?.kind || 'develop');
}

function roundOf(pair) {
  const n = Number(pair?.round);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function labelsOf(unit) {
  return Array.isArray(unit?.labels) ? unit.labels.map(x => String(x).toLowerCase()) : [];
}

function branchOf(unit) {
  return String(unit?.branch || `feat/${unit?.ticket}`);
}

function isQaRun(unit) {
  return Boolean(unit?.qaRun) || labelsOf(unit).includes('qa-run');
}

const DISPATCH_PRIORITY = new Map([['review', 0], ['fix', 1], ['develop', 2]]);

// All task producers feed one stable queue. Producers already walk cards in
// board order and units in umbrella order, so equal-kind entries deliberately
// keep their input order.
export function sortDispatchQueue(queue = []) {
  return [...queue].sort((a, b) =>
    (DISPATCH_PRIORITY.get(kindOf(a)) ?? 99) - (DISPATCH_PRIORITY.get(kindOf(b)) ?? 99));
}

// Initial review/fix work is tied to the PR head. A judged no-proof retry is
// explicitly tied to its next round instead, while develop always uses round.
export function dispatchKey(pair) {
  if (typeof pair?.journalKey === 'string' && pair.journalKey) return pair.journalKey;
  const ticket = pair?.unit?.ticket;
  const kind = kindOf(pair);
  if ((kind === 'review' || kind === 'fix') && pair?.head && !pair?.retryOf) {
    return `${ticket}:${kind}:${shortSha(pair.head)}`;
  }
  return `${ticket}:${kind}:${roundOf(pair)}`;
}

export function taskFileName(pair) {
  const ticket = pair?.unit?.ticket;
  const round = roundOf(pair);
  switch (kindOf(pair)) {
    case 'develop': return `TASK-${ticket}.md`;
    case 'review': return `TASK-${ticket}-REVIEW-R${round}.md`;
    case 'fix': return `TASK-${ticket}-FIX-R${round}.md`;
    default: throw new Error(`unknown dispatch kind "${kindOf(pair)}"`);
  }
}

// ------------------------------------------------------------ the fleet

// state/fleet-launch.json (docs/fleet-launch.example.json is the template):
//   { prompt: 'Прочитай {taskFile} и выполни целиком',
//     hosts: { 'lanes-01': { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' },
//              mac: { kitchen: '~/kitchens/autopase.lv', shell: 'export PATH=…;', launch: 'maclane {n} "{prompt}"' } },
//     lanes: { 'lane-1': { host: 'lanes-01', n: 1 }, 'lane-3': { host: 'lanes-01', n: 3, noBuilds: true }, … } }
// Host keys are the board's own host names (`hosts` in the settings), so the
// ssh target and key come from there unless the launch config overrides them.
// A free lane is named "host/lane-N" by the sprint facts.
export function laneLauncher(fleet, freeName) {
  const s = String(freeName ?? '');
  const i = s.indexOf('/');
  if (i < 0) return null;
  const host = s.slice(0, i); const lane = s.slice(i + 1);
  const entry = fleet?.lanes?.[lane];
  if (!entry || (entry.host && entry.host !== host)) return null;
  const hostCfg = fleet?.hosts?.[entry.host ?? host];
  if (!hostCfg?.launch) return null;
  return {
    name: s, host, lane,
    n: Number.isFinite(Number(entry.n)) ? Number(entry.n) : laneNo(lane),
    noBuilds: Boolean(entry.noBuilds),
    reserved: Boolean(entry.reserved),
    browser: Boolean(hostCfg.browser),
  };
}

// ------------------------------------------------------------ the base

// Where the unit starts from (MANDATE.md §2): the head of its dependency's
// open PR — the facts carry the PR number and head SHA — or main when every
// dependency is merged or closed. Two dependencies on open PRs cannot be one
// base: that unit waits for a hand-made brief.
export function baseFor(unit, sprint) {
  if (isQaRun(unit)) return { ref: 'main', sha: null, pr: null, ticket: null, unit: null };
  const open = (unit?.deps ?? []).filter(d => !d.met && typeof d.state === 'string' && d.state.startsWith('pr'));
  if (!open.length) return { ref: 'main', sha: null, pr: null, ticket: null, unit: null };
  if (open.length > 1) {
    return { error: `two dependencies on open PRs (${open.map(d => `${d.unit || '#' + d.ticket} #${d.ticket}`).join(', ')}) — one base cannot carry both` };
  }
  const d = open[0];
  const dep = (sprint?.units ?? []).find(x => x.ticket === d.ticket);
  return { ref: branchOf(dep ?? { ticket: d.ticket }), sha: dep?.pr?.headSha ?? null, pr: dep?.pr?.number ?? null, ticket: d.ticket, unit: d.unit || dep?.unit || '' };
}

// "main" / "feat/fin-u3a@b34d212d (PR #1602 of U3a)".
export function baseLine(b) {
  if (!b || b.error) return '-';
  if (b.ref === 'main') return 'main';
  return `${b.ref}${b.sha ? '@' + shortSha(b.sha) : ''}${b.pr ? ` (PR #${b.pr}${b.unit ? ' of ' + b.unit : ''})` : ''}`;
}

// ------------------------------------------------------------ the planner

const RED_CHECK = new Set([
  'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED',
  'STARTUP_FAILURE', 'ERROR',
]);

function journalParts(key, entry) {
  const bits = String(key ?? '').split(':');
  const kind = entry?.kind ?? (bits.length >= 2 ? bits[1] : 'develop');
  const suffix = bits[2] ?? '';
  const headKey = (kind === 'review' || kind === 'fix') && /^[0-9a-f]{7,40}$/i.test(suffix);
  const parsedRound = headKey ? NaN : Number(suffix);
  return {
    ticket: entry?.ticket ?? (bits[0] && /^\d+$/.test(bits[0]) ? Number(bits[0]) : null),
    kind,
    round: Number.isInteger(Number(entry?.round)) && Number(entry.round) > 0
      ? Number(entry.round)
      : (Number.isInteger(parsedRound) && parsedRound > 0 ? parsedRound : 1),
    head: entry?.head ?? (headKey ? suffix : null),
  };
}

function entriesFor(journal, ticket, kind = null) {
  const out = [];
  let order = 0;
  for (const [key, entry] of Object.entries(journal ?? {})) {
    const p = journalParts(key, entry);
    if (String(p.ticket) !== String(ticket) || (kind && p.kind !== kind)) { order++; continue; }
    out.push({ key, entry: entry ?? {}, ...p, order: order++ });
  }
  return out;
}

function entryForHead(journal, ticket, kind, head) {
  const matches = entriesFor(journal, ticket, kind)
    .filter(x => sameHead(x.head, head));
  matches.sort((a, b) => {
    const ta = Date.parse(a.entry?.at ?? '') || 0;
    const tb = Date.parse(b.entry?.at ?? '') || 0;
    return ta - tb || a.order - b.order;
  });
  return matches.at(-1)?.entry ?? null;
}

// A judged task is retried under the next round key. This is shared by
// develop/fix now and by the parallel review planner when it lands.
export function noProofRetry(ledger, ticket, kind, head = null) {
  const failed = entriesFor(ledger?.dispatched ?? ledger ?? {}, ticket, kind)
    .filter(x => x.entry?.judged === 'no-proof')
    .filter(x => !head || (kind !== 'review' && kind !== 'fix') || sameHead(x.head, head))
    .sort((a, b) => a.round - b.round || a.order - b.order);
  const last = failed.at(-1);
  if (!last) return null;
  return {
    round: last.round + 1,
    previousKey: last.key,
    previousLane: last.entry?.lane ?? null,
    avoidHost: last.entry?.host || String(last.entry?.lane ?? '').split('/')[0] || null,
  };
}

function latestAttemptHost(journal, ticket) {
  const attempts = entriesFor(journal, ticket)
    .filter(x => ['develop', 'review', 'fix'].includes(x.kind))
    .filter(x => x.entry?.host || x.entry?.lane);
  attempts.sort((a, b) => {
    const ta = Date.parse(a.entry?.at ?? '') || 0;
    const tb = Date.parse(b.entry?.at ?? '') || 0;
    return ta - tb || a.order - b.order;
  });
  const last = attempts.at(-1)?.entry;
  return last?.host || String(last?.lane ?? '').split('/')[0] || null;
}

function heldLaneNames(journal, now, holdMs, launchingMs) {
  return new Set(Object.values(journal ?? {})
    .filter(e => {
      const age = now - (Date.parse(e?.at ?? '') || 0);
      return (e?.result === 'launched' && !e?.judged && age < holdMs)
        || (e?.result === 'launching' && age < launchingMs);
    })
    .map(e => e?.lane)
    .filter(Boolean));
}

// sprint.free intentionally omits an idle lane still bound to an unmerged
// branch. Once that lane's launch has been judged no-proof it is nevertheless
// valid retry capacity, as long as the lane-table probe says it is healthy,
// idle and part of the fleet.
function laneNamesFor(sprint, retry = false) {
  const names = new Set(Array.isArray(sprint?.free) ? sprint.free : []);
  if (retry) {
    for (const lane of sprint?.laneTable ?? []) {
      if (!lane?.hostOk || lane.busy || !lane.fleet || !lane.host || !lane.lane) continue;
      names.add(`${lane.host}/${lane.lane}`);
    }
  }
  return [...names];
}

function unitCardFor(cards, cardId, ticket) {
  return (cards ?? []).find(candidate => candidate?.parent === cardId
    && Number(candidate.ticket) === Number(ticket));
}

function failedCheckNames(pr) {
  if (Array.isArray(pr?.ci?.failedNames) && pr.ci.failedNames.length) {
    return pr.ci.failedNames.map(String);
  }
  const rollup = [pr?.statusCheckRollup, pr?.checkRollup, pr?.rollup, pr?.checks, pr?.ci?.rollup]
    .find(Array.isArray) ?? [];
  const names = [];
  for (const item of rollup) {
    const state = String(item?.conclusion ?? item?.state ?? item?.status ?? '').toUpperCase();
    if (!RED_CHECK.has(state)) continue;
    const name = item?.name ?? item?.context ?? item?.workflowName;
    if (name != null && String(name)) names.push(String(name));
  }
  return names;
}

function redOnHead(pr, head) {
  const color = String(pr?.ci?.color ?? pr?.ciColor ?? '').toLowerCase();
  if (color !== 'red') return false;
  const ciHead = pr?.ci?.headSha ?? pr?.rollupHeadSha ?? null;
  return !ciHead || sameHead(ciHead, head);
}

function fixNeed(unit, fixEntries) {
  const pr = unit?.pr;
  const head = String(pr?.headSha ?? '');
  const verdict = pr?.verdictOnHead;
  if (verdict?.go === false) {
    const n = Number(verdict.round);
    const round = Number.isInteger(n) && n > 0 ? n : 1;
    return {
      round,
      sections: [{ title: `VERDICT R${round} — verbatim`, body: String(verdict.body ?? '') }],
    };
  }
  const round = fixEntries.length + 1;
  if (redOnHead(pr, head)) {
    const names = failedCheckNames(pr);
    return {
      round,
      sections: [{ title: `CI — red checks on ${head}: ${names.join(', ') || 'failed checks'}`, body: '' }],
    };
  }
  if (String(pr?.mergeable ?? '').toUpperCase() === 'CONFLICTING') {
    return {
      round,
      sections: [{ title: `CONFLICT — merge origin/main into ${branchOf(unit)}`, body: '' }],
    };
  }
  return null;
}

// Fixes are planned independently so the review planner can feed the same
// queue without coupling the two parallel tickets. `taken` is an integration
// seam for higher-priority review pairs. The public ticket arguments remain
// cards/sprints/ledger/fleet; the remaining options mirror planDispatchFull.
export function planFixes({
  cards = [], sprints = new Map(), ledger = null, fleet = null, at = null,
  needsBuild = null, retryMs = RETRY_MS, holdMs = LANE_HOLD_MS,
  launchingMs = LAUNCHING_HOLD_MS, taken = [],
} = {}) {
  const now = Date.parse(at ?? '') || Date.now();
  const journal = ledger?.dispatched ?? {};
  const heldLanes = heldLaneNames(journal, now, holdMs, launchingMs);
  const occupied = new Set(taken);
  const pairs = [];
  for (const card of cards ?? []) {
    if (card?.parent || !ACTIVE.has(card?.stage)) continue;
    const sprint = sprints?.get?.(card.id);
    if (!sprint || (Array.isArray(sprint.stale) && sprint.stale.length)) continue;
    const cardRef = { id: card.id, title: String(card.title ?? '') };
    for (const unit of [...(sprint.units ?? []), ...(sprint.qaTickets ?? [])]) {
      if (unitCardFor(cards, card.id, unit?.ticket)?.stage === 'stuck') continue;
      const pr = unit?.pr;
      const head = String(pr?.headSha ?? '');
      if (!head || unit?.merged || ['CLOSED', 'MERGED'].includes(String(pr?.state ?? '').toUpperCase())) continue;
      const fixEntries = entriesFor(journal, unit.ticket, 'fix');
      const retry = noProofRetry(journal, unit.ticket, 'fix', head);
      const retryEntry = retry ? journal[retry.previousKey] : null;
      const savedSections = Array.isArray(retryEntry?.sections)
        ? retryEntry.sections.map(section => ({
          title: String(section?.title ?? ''), body: String(section?.body ?? ''),
        }))
        : [];
      // Once a lane was judged no-proof, the retry is owed even if a flaky CI
      // fact turns green or a comment disappears before the next sweep. Its
      // original verbatim task context is part of the durable launch record.
      const need = retry && savedSections.length
        ? { round: retry.round, sections: savedSections }
        : fixNeed(unit, fixEntries);
      if (!need) continue;

      const previous = entryForHead(journal, unit.ticket, 'fix', head);
      const headGuard = journal[`${unit.ticket}:fix:${shortSha(head)}`];
      // no-proof is explicitly re-queued as another round; every other live
      // launch on this head is the ticket's head-key guard.
      if (headGuard && headGuard.judged !== 'no-proof') continue;
      if (previous && previous !== headGuard && previous.judged !== 'no-proof') {
        const age = now - (Date.parse(previous.at ?? '') || 0);
        if (previous.result === 'launched') continue;
        if (previous.result === 'launching' && age < launchingMs) continue;
        if (age < retryMs) continue;
      }

      const build = needsBuild ? needsBuild(unit) !== false : true;
      const lanes = [];
      for (const name of laneNamesFor(sprint, Boolean(retry))) {
        const lane = laneLauncher(fleet, name);
        if (!lane || lane.reserved || heldLanes.has(lane.name) || occupied.has(lane.name)) continue;
        if (lane.noBuilds && build) continue;
        lanes.push(lane);
      }
      lanes.sort((a, b) => laneNo(a.lane) - laneNo(b.lane) || a.host.localeCompare(b.host));
      const lastHost = retry?.avoidHost ?? latestAttemptHost(journal, unit.ticket);
      const lane = lanes.find(candidate => candidate.host !== lastHost) ?? lanes[0];
      if (!lane) continue;
      occupied.add(lane.name);
      pairs.push({
        card: cardRef,
        umbrella: sprint.umbrella ?? null,
        unit: {
          unit: unit.unit || '', ticket: unit.ticket, title: unit.title || '', url: unit.url || '', branch: branchOf(unit),
          qa: Boolean(unit.qa), qaRun: isQaRun(unit), labels: labelsOf(unit),
        },
        lane: lane.name, host: lane.host, laneName: lane.lane, n: lane.n,
        base: baseFor(unit, sprint), kind: 'fix', round: retry?.round ?? need.round, head,
        role: 'fixer', sections: need.sections,
        ...(retry ? { retryOf: retry.previousKey } : {}),
      });
    }
  }
  return pairs;
}

// cards: the pipeline's cards; sprints: Map(card id -> sprint facts);
// ledger: the journal ({ dispatched: { ticket: entry } }); fleet: the launch
// config; needsBuild(unit): false for a unit a light lane may take (default:
// every unit needs a build, so a `noBuilds` lane is never chosen by itself).
// Returns { pairs, holds }: pairs = { card, umbrella, unit, lane, host,
// laneName, n, base } one per lane; holds = why a startable unit was not paired.
export function planDispatchFull(cards, sprints, { ledger = null, at = null, fleet = null, needsBuild = null, takenLanes = null, retryMs = RETRY_MS, holdMs = LANE_HOLD_MS, launchingMs = LAUNCHING_HOLD_MS } = {}) {
  const now = Date.parse(at ?? '') || Date.now();
  const journal = ledger?.dispatched ?? {};
  const higherPriority = new Set(takenLanes ?? []);
  const fixes = planFixes({
    cards, sprints, ledger, fleet, at, needsBuild, retryMs, holdMs, launchingMs,
    taken: higherPriority,
  });
  const fixLanes = new Set(fixes.map(pair => pair.lane));
  const developSprints = new Map();
  for (const [id, sprint] of sprints?.entries?.() ?? []) {
    developSprints.set(id, { ...sprint, free: (sprint?.free ?? []).filter(name => !fixLanes.has(name)) });
  }
  const pairs = [];
  const holds = [];
  const heldLanes = heldLaneNames(journal, now, holdMs, launchingMs);
  // Higher-priority planners (review, then fix) reserve their lanes before
  // develop work is paired.
  const taken = new Set([...higherPriority, ...fixLanes]);
  for (const card of cards ?? []) {
    if (card?.parent || !ACTIVE.has(card?.stage)) continue;
    const s = developSprints.get(card.id);
    if (!s) continue;
    if (Array.isArray(s.stale) && s.stale.length) continue; // unknown is not free
    const cardRef = { id: card.id, title: String(card.title ?? '') };
    const waiting = [...(s.units ?? []), ...(s.qaTickets ?? [])]
      .filter(u => {
        if (unitCardFor(cards, card.id, u?.ticket)?.stage === 'stuck') return false;
        if (startableOnBoard(u, card.id, cards)) return true;
        const retry = noProofRetry(journal, u.ticket, 'develop');
        if (!retry) return false;
        return isQaRun(u) ? Boolean(u.open) : !u.pr && !u.merged;
      })
      .filter(u => !isQaRun(u) || (u.deps ?? []).every(d => d.met === true));
    if (!waiting.length) continue;
    const free = Array.isArray(s.free) ? s.free : [];
    const lanes = [];
    for (const name of free) {
      const l = laneLauncher(fleet, name);
      if (!l) { holds.push({ card: cardRef, unit: '', ticket: null, lane: name, reason: 'no launcher for this lane in fleet-launch.json' }); continue; }
      if (l.reserved) continue;
      if (heldLanes.has(l.name)) continue;
      lanes.push(l);
    }
    lanes.sort((a, b) => laneNo(a.lane) - laneNo(b.lane) || a.host.localeCompare(b.host));
    const retryLanes = [...lanes];
    const regularNames = new Set(free);
    for (const name of laneNamesFor(s, true)) {
      if (regularNames.has(name)) continue;
      const lane = laneLauncher(fleet, name);
      if (!lane || lane.reserved || heldLanes.has(lane.name)) continue;
      retryLanes.push(lane);
    }
    retryLanes.sort((a, b) => laneNo(a.lane) - laneNo(b.lane) || a.host.localeCompare(b.host));
    for (const u of waiting) {
      const hold = reason => holds.push({ card: cardRef, unit: u.unit || '', ticket: u.ticket, lane: '', reason });
      const retry = noProofRetry(journal, u.ticket, 'develop');
      const pairIdentity = { unit: u, kind: 'develop', round: retry?.round ?? 1 };
      const key = dispatchKey(pairIdentity);
      // A plain-number entry is the pre-T1 spelling of develop round 1.
      const prev = journal[key] ?? journal[String(u.ticket)];
      if (prev?.result === 'launched') continue; // the journal is final for a launched unit
      const prevAge = prev ? now - (Date.parse(prev.at ?? '') || 0) : Infinity;
      if (prev?.result === 'launching' && prevAge < launchingMs) continue;
      if (prev && prevAge < retryMs) {
        const result = prev.result === 'launching' ? 'failed' : prev.result;
        hold(`${result} at ${prev.at}${prev.error ? ': ' + prev.error : ''} — retry after ${Math.round(retryMs / 60000)} min`);
        continue;
      }
      const base = baseFor(u, s);
      if (base.error) { hold(base.error); continue; }
      const qaRun = isQaRun(u);
      const build = qaRun ? false : (needsBuild ? needsBuild(u) !== false : true);
      const lanePool = retry ? retryLanes : lanes;
      const eligible = l => !taken.has(l.name) && (!l.noBuilds || !build) && (!qaRun || l.browser);
      const lane = (retry?.avoidHost ? lanePool.find(l => eligible(l) && l.host !== retry.avoidHost) : null)
        ?? lanePool.find(eligible);
      if (!lane) {
        const left = lanePool.filter(l => !taken.has(l.name));
        if (qaRun && left.length && !left.some(l => l.browser)) {
          hold(`qa-run needs a browser: true host; free lanes: ${left.map(l => l.name).join(', ')}`);
        } else {
          hold(left.length ? `only light lanes (no builds) are free: ${left.map(l => l.name).join(', ')}` : 'no free lane with a launcher');
        }
        continue;
      }
      taken.add(lane.name);
      pairs.push({
        card: cardRef,
        umbrella: s.umbrella ?? null,
        unit: {
          unit: u.unit || '', ticket: u.ticket, title: u.title || '', url: u.url || '', branch: branchOf(u),
          qa: Boolean(u.qa), qaRun, labels: labelsOf(u),
        },
        lane: lane.name, host: lane.host, laneName: lane.lane, n: lane.n,
        base, kind: 'develop', round: retry?.round ?? 1, head: null, role: qaRun ? 'qa' : 'lane',
      });
    }
  }
  return { pairs: sortDispatchQueue([...fixes, ...pairs]), holds };
}

export function planDispatch(cards, sprints, opts = {}) {
  return planDispatchFull(cards, sprints, opts).pairs;
}

function entryTicket(key, entry) {
  if (entry?.ticket != null) return String(entry.ticket);
  return String(key).split(':', 1)[0];
}

function entryKind(key, entry) {
  if (entry?.kind) return String(entry.kind);
  const bits = String(key).split(':');
  return bits.length > 1 ? bits[1] : 'develop';
}

// The author lane is the most recently journalled develop/fix lane for this
// ticket. Review entries are deliberately ignored: a later review must avoid
// the lane that last wrote the code, not necessarily the previous reviewer.
function lastWriterLane(journal, ticket) {
  let lane = null;
  let latest = -Infinity;
  let order = 0;
  let latestOrder = -1;
  for (const [key, entry] of Object.entries(journal ?? {})) {
    order += 1;
    if (entryTicket(key, entry) !== String(ticket)) continue;
    if (!['develop', 'fix'].includes(entryKind(key, entry))) continue;
    if (!entry?.lane) continue;
    const at = Date.parse(entry.at ?? '');
    const stamp = Number.isFinite(at) ? at : -Infinity;
    if (stamp > latest || (stamp === latest && order > latestOrder)) {
      lane = String(entry.lane);
      latest = stamp;
      latestOrder = order;
    }
  }
  return lane;
}

// Reviews are pure/light work, so every launchable free lane is eligible. One
// review is planned per lane, in sprint/card and unit order, before develop
// work. The caller passes the resulting lane names to planDispatchFull as
// `takenLanes` when composing the complete queue.
export function planReviews({
  cards = [], sprints = null, ledger = null, fleet = null, at = null,
  retryMs = RETRY_MS, holdMs = LANE_HOLD_MS, launchingMs = LAUNCHING_HOLD_MS,
} = {}) {
  const now = Date.parse(at ?? '') || Date.now();
  const journal = ledger?.dispatched ?? {};
  const heldLanes = heldLaneNames(journal, now, holdMs, launchingMs);
  const taken = new Set();
  const pairs = [];

  for (const card of cards) {
    if (card?.parent || !ACTIVE.has(card?.stage)) continue;
    const sprint = sprints?.get?.(card.id);
    if (!sprint || (Array.isArray(sprint.stale) && sprint.stale.length)) continue;
    const cardRef = { id: card.id, title: String(card.title ?? '') };

    for (const unit of [...(sprint.units ?? []), ...(sprint.qaTickets ?? [])]) {
      const pr = unit?.pr;
      const head = String(pr?.headSha ?? '');
      const unitCard = unitCardFor(cards, card.id, unit?.ticket);
      // A parked child remains parked. The pure planner does not otherwise
      // require pipeline children: its input contract is the sprint PR facts.
      if (unitCard?.stage === 'stuck') continue;
      if (!pr || unit?.merged || pr.open === false || pr.draft || !head || sameHead(pr.verdictOnHead?.head, head)) continue;
      const retry = noProofRetry(journal, unit.ticket, 'review', head);
      const headGuard = journal[`${unit.ticket}:review:${shortSha(head)}`];
      const previous = entryForHead(journal, unit.ticket, 'review', head);
      if (headGuard && headGuard.judged !== 'no-proof') continue;
      if (previous && previous !== headGuard && previous.judged !== 'no-proof') {
        const age = now - (Date.parse(previous.at ?? '') || 0);
        if (previous.result === 'launched') continue;
        if (previous.result === 'launching' && age < launchingMs) continue;
        if (age < retryMs) continue;
      }

      const lanes = [];
      for (const name of laneNamesFor(sprint, Boolean(retry))) {
        const lane = laneLauncher(fleet, name);
        if (!lane || lane.reserved || heldLanes.has(lane.name) || taken.has(lane.name)) continue;
        lanes.push(lane);
      }
      lanes.sort((a, b) => laneNo(a.lane) - laneNo(b.lane) || a.host.localeCompare(b.host));
      const authorLane = lastWriterLane(journal, unit.ticket);
      const eligible = candidate => candidate.name !== authorLane;
      const lane = (retry?.avoidHost ? lanes.find(candidate => eligible(candidate) && candidate.host !== retry.avoidHost) : null)
        ?? lanes.find(eligible);
      if (!lane) continue;

      const rawRound = Number(pr.verdictRounds);
      const firstRound = (Number.isInteger(rawRound) && rawRound >= 0 ? rawRound : 0) + 1;
      const round = retry?.round ?? firstRound;
      const base = baseFor(unit, sprint);
      taken.add(lane.name);
      pairs.push({
        card: cardRef,
        umbrella: sprint.umbrella ?? null,
        unit: {
          unit: unit.unit || '', ticket: unit.ticket, title: unit.title || '', url: unit.url || '', branch: branchOf(unit),
          qa: Boolean(unit.qa), qaRun: isQaRun(unit), labels: labelsOf(unit),
        },
        lane: lane.name, host: lane.host, laneName: lane.lane, n: lane.n,
        base: base.error ? { ref: 'main', sha: null, pr: null, ticket: null, unit: null } : base,
        kind: 'review', round, head, role: 'reviewer',
        ...(retry ? { retryOf: retry.previousKey } : {}),
      });
    }
  }
  return pairs;
}

// ------------------------------------------------------------ the journal

// Initial review/fix attempts are keyed by head8; develop attempts and
// judged-no-proof retries are keyed by round. A pre-T1 plain ticket key reads
// as develop round 1. Result is launching | launched | failed | held.
export function recordDispatch(ledger, pair, outcome, at) {
  const now = Date.parse(at ?? '') || Date.now();
  const dispatched = {};
  for (const [k, e] of Object.entries(ledger?.dispatched ?? {})) {
    const t = Date.parse(e?.at ?? '') || 0;
    const kind = entryKind(k, e);
    const suffix = String(k).split(':')[2] ?? '';
    const fixHeadGuard = kind === 'fix' && /^[0-9a-f]{7,40}$/i.test(suffix);
    // Head guards remain authoritative for as long as that head can stay
    // open. Time-pruning one would permit a duplicate review/fix; merge also
    // retains its retry ceiling after unrelated launches.
    if (kind === 'review' || kind === 'merge' || fixHeadGuard || now - t <= JOURNAL_KEEP_MS) dispatched[k] = e;
  }
  dispatched[dispatchKey(pair)] = {
    card: pair.card.id, title: pair.card.title, unit: pair.unit.unit, ticket: pair.unit.ticket,
    branch: pair.unit.branch, lane: pair.lane, host: pair.host ?? null, base: baseLine(pair.base),
    kind: kindOf(pair), round: roundOf(pair), head: pair.head ?? null,
    role: pair.role ?? null, qaRun: Boolean(pair.unit.qaRun), labels: [...(pair.unit.labels ?? [])],
    sections: (pair.sections ?? []).map(section => ({
      title: String(section?.title ?? ''), body: String(section?.body ?? ''),
    })),
    ...(pair.retryOf ? { retryOf: pair.retryOf } : {}),
    at: new Date(now).toISOString(), result: outcome.result, error: outcome.error ?? null,
  };
  return { dispatched };
}

// The rows of the auto-dispatch table (page, /api/pipeline): what is about to
// be dispatched (or would be, off), what the journal says happened lately,
// and why a startable unit is held.
export function dispatchRows({ pairs = [], holds = [], ledger = null, at = null, state = 'would dispatch', recentMs = 24 * 60 * 60 * 1000 } = {}) {
  const now = Date.parse(at ?? '') || Date.now();
  const rows = [];
  const kindLabel = value => {
    const kind = kindOf(value);
    return kind === 'review' ? `review R${roundOf(value)}` : kind;
  };
  for (const p of pairs) {
    rows.push({
      kind: kindLabel(p), card: p.card.title || p.card.id,
      unit: `${p.unit.unit ? p.unit.unit + ' ' : ''}#${p.unit.ticket}`,
      lane: p.lane, base: baseLine(p.base), state,
    });
  }
  const seen = new Set(pairs.map(p => dispatchKey(p)));
  const entries = Object.entries(ledger?.dispatched ?? {})
    .filter(([, e]) => e && (
      (e.kind === 'merge' && e.result === 'merge-failed' && Number(e.attempts) >= 3)
      || now - (Date.parse(e.at ?? '') || 0) <= recentMs
    ))
    .sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)));
  for (const [key, e] of entries) {
    if (e.kind === 'merge') {
      const identity = `merge:${e.pr ?? e.ticket}:${shortSha(e.head)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      let mergeState;
      if (e.result === 'merged') mergeState = `merged at ${shortSha(e.head)}`;
      else if (e.result === 'merging') mergeState = `merging at ${shortSha(e.head)}`;
      else mergeState = `merge failed ${Number(e.attempts) || 1}/${3}${e.error ? ' — ' + e.error : ''}`;
      rows.push({
        kind: 'merge', card: e.title || e.card || '-', unit: `PR #${e.pr ?? '-'}`,
        lane: '-', base: shortSha(e.head) || e.base || '-', state: mergeState,
      });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      kind: kindLabel(e), card: e.title || e.card || '-', unit: `${e.unit ? e.unit + ' ' : ''}#${e.ticket}`,
      lane: e.lane || '-', base: e.base || '-',
      state: `${e.result} ${String(e.at).slice(11, 16)}Z${e.error ? ' — ' + e.error : ''}`,
    });
  }
  for (const h of holds) {
    const identity = `${h.ticket ?? '-'}:${h.kind ?? 'develop'}:${h.round ?? 1}`;
    if (h.ticket != null && seen.has(identity)) continue;
    rows.push({
      kind: kindLabel(h), card: h.card.title || h.card.id,
      unit: h.ticket != null ? `${h.unit ? h.unit + ' ' : ''}#${h.ticket}` : '-',
      lane: h.lane || '-', base: '-', state: `held: ${h.reason}`,
    });
  }
  return rows;
}

// ------------------------------------------------------------ the task file

// The task file the lane reads: board header, the committed common + role
// rules, the ticket verbatim, then any round-specific verbatim sections.
export function taskText({
  pair, ticket, role = pair?.role || (isQaRun(pair?.unit) ? 'qa' : 'lane'),
  kind = kindOf(pair), round = roundOf(pair), head = pair?.head ?? null,
  rules, check = DEFAULT_CHECK, sections = pair?.sections ?? [], kitchen = '', taskFile = '',
  specRemote = null, repo = '', at = null,
}) {
  if (!rules?.sha || typeof rules?.text !== 'string') throw new Error('task rules with sha and text are required');
  const u = pair.unit;
  const b = pair.base;
  const title = ticket?.title || u.title || `ticket #${u.ticket}`;
  const namedPair = { ...pair, kind, round };
  const lines = [];
  lines.push(`# ${taskFileName(namedPair).replace(/\.md$/, '')} — ${title}`);
  lines.push('');
  lines.push(`Sprint **${pair.card.title || pair.card.id}**${pair.umbrella ? `, umbrella issue **#${pair.umbrella}**` : ''}, ticket **#${u.ticket}**${ticket?.url || u.url ? ` (${ticket?.url || u.url})` : ''}.`);
  lines.push(`Lane: \`${kitchen ? kitchen + '/' : ''}${pair.laneName}\` (${pair.lane}). Branch: \`${u.branch}\`.${repo ? ` Repository: \`${repo}\`.` : ''}`);
  if (b.ref === 'main') {
    lines.push('Base: `origin/main` — every dependency is merged or closed; branch from the current head of `origin/main`.');
  } else {
    lines.push(`Base: ${b.sha ? '`' + b.sha + '`' : '`origin/' + b.ref + '`'} — the head of \`${b.ref}\`${b.pr ? `, the open PR #${b.pr}` : ''}${b.unit ? ` of ${b.unit}` : ''}${b.ticket ? ` (#${b.ticket})` : ''}. Start from it (MANDATE.md §2); rebase after that PR merges. Do not wait for the merge.`);
  }
  lines.push(`Role: ${role}`);
  if (head) lines.push(`Head: ${head}  Round: R${roundOf(namedPair)}`);
  lines.push(`Check: ${check}`);
  lines.push(`Rules: docs/RULES.md @ ${rules.sha}`);
  lines.push(specRemote
    ? `Spec bundle: \`${specRemote}\` — the spec, the grill outcome and the handoff live there; every § reference in the ticket is restated inline, and the inline text wins.`
    : 'Spec bundle: none shipped — the ticket reads standalone (TICKETING.md §2.7).');
  lines.push(`Dispatched by the board${at ? ' at ' + at : ''} (auto-dispatch, decision 16)${taskFile ? `; this file is \`${taskFile}\`` : ''}. Reports go to the umbrella issue only.`);
  lines.push('');
  lines.push('---');
  lines.push(rules.text.trimEnd());
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`# TICKET #${u.ticket} — verbatim`);
  lines.push('');
  lines.push(String(ticket?.body ?? '').trimEnd() || '(the ticket body could not be read — stop and report)');
  lines.push('');
  for (const section of sections ?? []) {
    lines.push('---');
    lines.push(`# ${section?.title ?? ''}`);
    lines.push('');
    lines.push(String(section?.body ?? ''));
    lines.push('');
  }
  return lines.join('\n');
}

// The sprint's spec folder: the program under specsDir whose PROGRAM-STATE.md
// names the sprint's umbrella (programs: Map(name -> { file, umbrella })),
// else a `spec: <path>` / `spec dir: <path>` line in the card's spec text.
export function specDirFor({ card = null, umbrella = null, programs = null, specsDir = '' } = {}) {
  if (umbrella && programs instanceof Map) {
    for (const p of programs.values()) {
      if (p?.umbrella === umbrella && p.file) return path.dirname(p.file);
    }
  }
  const m = /^\s*spec(?:[ -]?dir)?\s*:\s*(.+?)\s*$/im.exec(String(card?.spec ?? ''));
  if (m) {
    const p = m[1].replace(/^`|`$/g, '');
    return path.isAbsolute(p) || !specsDir ? p : path.join(specsDir, p);
  }
  return null;
}

// ------------------------------------------------------------ the launch plan

function sshOpts(host) {
  const n = Number(host?.connectTimeoutSec);
  const t = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
  return ['-o', `ConnectTimeout=${t}`, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
}

// A remote path for scp: `~/x` is `x` relative to the remote home.
function scpPath(p) {
  return String(p).replace(/^~\//, '');
}

// A remote path inside a double-quoted shell string: `~/x` becomes `$HOME/x`
// so the lane's codex gets an absolute path, not a literal tilde.
function shellPath(p) {
  return String(p).replace(/^~\//, '$HOME/');
}

function dq(s) {
  return String(s).replace(/[\\"`]/g, c => '\\' + c);
}

// Everything a launch runs, as commands (bin + args) in order, with nothing
// executed: the task file copy, the spec bundle check and copy, the launcher.
// hosts: the board's `hosts` settings (ssh target, key); fleet: the launch
// config; localTask / localSpec: the files on this machine; home: ~/.ssh root.
export function launchPlan(pair, { fleet, hosts = {}, localTask, localSpec = null, home = '', repo = '' } = {}) {
  const hostCfg = fleet?.hosts?.[pair.host] ?? {};
  const board = hosts?.[pair.host] ?? {};
  const target = hostCfg.ssh || board.target || '';
  const key = hostCfg.key || board.key || '';
  const kitchen = String(hostCfg.kitchen || board.kitchen || '~/kitchens').replace(/\/+$/, '');
  const shell = hostCfg.shell ? String(hostCfg.shell).trim().replace(/;?$/, ';') + ' ' : '';
  const prompt = String(fleet?.prompt || hostCfg.prompt || DEFAULT_PROMPT);
  const taskFile = `${kitchen}/${taskFileName(pair)}`;
  const bundle = localSpec ? `${kitchen}/${String(localSpec).replace(/[\\/]+$/, '').split(/[\\/]/).pop()}` : null;
  const opts = sshOpts(board);
  const keyArgs = key ? ['-i', path.join(home, '.ssh', key)] : [];
  const laneCmd = String(hostCfg.launch)
    .replaceAll('{n}', String(pair.n))
    .replaceAll('{lane}', pair.laneName)
    .replaceAll('{prompt}', dq(prompt.replaceAll('{taskFile}', shellPath(taskFile))))
    .replaceAll('{taskFile}', shellPath(taskFile));
  const steps = [];
  if (!target) return { error: `no ssh target for host ${pair.host} (hosts.${pair.host}.target in the board settings, or fleet-launch.json hosts.${pair.host}.ssh)`, steps, taskFile, bundle, kitchen, laneCmd };
  steps.push({ kind: 'task-copy', bin: 'scp', args: [...opts, ...keyArgs, localTask, `${target}:${scpPath(taskFile)}`], timeout: 60_000 });
  if (bundle) {
    steps.push({ kind: 'bundle-check', bin: 'ssh', args: [...opts, ...keyArgs, target, `${shell}test -d "${shellPath(bundle)}" && echo HAVE || echo MISSING`], timeout: 60_000 });
    steps.push({ kind: 'bundle-copy', bin: 'scp', args: [...opts, ...keyArgs, '-r', localSpec, `${target}:${scpPath(bundle)}`], timeout: 300_000, onlyIf: 'MISSING' });
  }
  steps.push({ kind: 'launch', bin: 'ssh', args: [...opts, ...keyArgs, target, `${shell}${laneCmd}`], timeout: 90_000 });
  if (repo && pair.umbrella) {
    steps.push({ kind: 'comment', bin: 'gh', args: ['issue', 'comment', String(pair.umbrella), '--repo', repo, '--body', commentLine(pair)], timeout: 60_000 });
  }
  return { error: null, steps, taskFile, bundle, kitchen, laneCmd };
}

// The one line the board writes into the umbrella once the lane runs.
export function commentLine(pair) {
  return `board: ${pair.unit.unit ? pair.unit.unit + ' ' : ''}#${pair.unit.ticket} dispatched to ${pair.lane} from ${baseLine(pair.base)}`;
}

// Run a plan. exec(bin, args, timeout) -> { code, out } and never throws.
// Returns { result: 'launched' | 'held' | 'failed', error, ran: [{kind, code, out}] }.
// A launcher that answers "busy" (exit 2) or "reserved" (exit 3) is a hold —
// the probe was behind; anything else that fails is a failure.
// The umbrella comment is best effort: the lane is running either way.
export async function runLaunch(plan, exec) {
  const ran = [];
  if (plan.error) return { result: 'failed', error: plan.error, ran };
  let bundleMissing = false;
  for (const step of plan.steps) {
    if (step.onlyIf === 'MISSING' && !bundleMissing) continue;
    let r;
    try { r = await exec(step.bin, step.args, step.timeout); }
    catch (e) { r = { code: -1, out: String(e?.message || e) }; }
    const out = String(r?.out ?? '');
    ran.push({ kind: step.kind, code: r?.code, out: out.slice(0, 400) });
    switch (step.kind) {
      case 'bundle-check':
        if (r.code !== 0) return { result: 'failed', error: `bundle check failed: ${out.trim().slice(0, 120)}`, ran };
        bundleMissing = /\bMISSING\b/.test(out);
        break;
      case 'launch':
        if (r.code === 2 || r.code === 3) return { result: 'held', error: `launcher refused: ${out.trim().slice(0, 120)}`, ran };
        if (r.code !== 0) return { result: 'failed', error: `launch failed (exit ${r.code}): ${out.trim().slice(0, 160)}`, ran };
        break;
      case 'comment':
        if (r.code !== 0) return { result: 'launched', error: `umbrella comment failed: ${out.trim().slice(0, 120)}`, ran };
        break;
      default:
        if (r.code !== 0) return { result: 'failed', error: `${step.kind} failed (exit ${r.code}): ${out.trim().slice(0, 160)}`, ran };
    }
  }
  return { result: 'launched', error: null, ran };
}
