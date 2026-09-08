// A round's findings are fixed by ONE ticket on one lane, cut by the cutter
// after the walk closes (RULES cutter 4; owner 2026-09-04). On 2026-09-08 the
// board put finding #2101 on a lane one minute after the walker filed it —
// the heap the owner forbids. While a walk of the sprint is on a lane, a
// `qa` unit waits. Pure fixtures; no ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDispatchFull } from '../bin/auto-dispatch.mjs';

const AT = '2026-09-08T20:00:00.000Z';
const FLEET = {
  prompt: 'Read {taskFile} and do it whole.',
  hosts: { 'lanes-01': { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"', browser: true } },
  lanes: { 'lane-1': { host: 'lanes-01', n: 1 }, 'lane-2': { host: 'lanes-01', n: 2 } },
};
function cardsWith(walkStage) {
  return [
    { id: 'cs', title: 'NINE-DELTAS', stage: 'merged', links: { ticket: 'https://github.com/acme/web/issues/2063' } },
    { id: 'walk', title: 'QA #2097', stage: walkStage, parent: 'cs', ticket: 2097 },
    { id: 'f1', title: 'QA #2099', stage: 'ticketed', parent: 'cs', ticket: 2099 },
    { id: 'next', title: 'QA #2103', stage: 'ticketed', parent: 'cs', ticket: 2103 },
  ];
}
const finding = { unit: 'QA', ticket: 2099, title: 'finding: broken photos', qa: true, labels: ['qa'], open: true, state: 'queued', branch: 'feat/2099', deps: [] };
function sprint(qaTickets) {
  return {
    umbrella: 2063, free: ['lanes-01/lane-1', 'lanes-01/lane-2'], stale: [],
    units: [{ unit: '', ticket: 2064, title: 'the work', branch: 'feat/2064', state: 'merged', deps: [], merged: { number: 2071 } }],
    qaTickets,
  };
}

test('a qa finding waits while the sprint\'s QA walk is on a lane, with the reason on the dispatch table', () => {
  const walk = { unit: 'QA', ticket: 2097, title: 'QA R2 — walk', qa: true, labels: ['qa-run'], open: true, state: 'on lane', deps: [{ ticket: 2082, state: 'merged', met: true }], lane: { host: 'mac', lane: 'lane-8', busy: true } };
  const { pairs, holds } = planDispatchFull(cardsWith('development'), new Map([['cs', sprint([walk, finding])]]), { fleet: FLEET, at: AT });
  assert.equal(pairs.filter(p => p.unit.ticket === 2099).length, 0);
  assert.match(holds.find(h => h.ticket === 2099).reason, /QA walk #2097 is in progress — its findings fold into one fix ticket/);
  // The card alone (no lane fact yet, the launch is seconds old) is enough.
  const walkNoLane = { ...walk, lane: null };
  const second = planDispatchFull(cardsWith('development'), new Map([['cs', sprint([walkNoLane, finding])]]), { fleet: FLEET, at: AT });
  assert.equal(second.pairs.filter(p => p.unit.ticket === 2099).length, 0);
});

test('once the walk is closed the (folded) qa ticket dispatches as before', () => {
  const closed = { unit: 'QA', ticket: 2097, title: 'QA R2 — walk', qa: true, labels: ['qa-run'], open: false, state: 'closed', deps: [], lane: null };
  const { pairs } = planDispatchFull(cardsWith('done'), new Map([['cs', sprint([closed, finding])]]), { fleet: FLEET, at: AT });
  assert.deepEqual(pairs.map(p => [p.unit.ticket, p.kind]), [[2099, 'develop']]);
});

test('the next round\'s walk, queued behind the fold ticket, holds nothing', () => {
  const closed = { unit: 'QA', ticket: 2097, title: 'QA R2 — walk', qa: true, labels: ['qa-run'], open: false, state: 'closed', deps: [], lane: null };
  const next = { unit: 'QA', ticket: 2103, title: 'QA R3 — walk', qa: true, labels: ['qa-run'], open: true, state: 'queued', deps: [{ ticket: 2099, state: 'queued', met: false }], lane: null };
  const { pairs } = planDispatchFull(cardsWith('done'), new Map([['cs', sprint([closed, next, finding])]]), { fleet: FLEET, at: AT });
  assert.deepEqual(pairs.map(p => p.unit.ticket), [2099], 'the fold ticket runs; the R3 walk waits for it');
});
