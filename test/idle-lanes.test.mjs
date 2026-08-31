// Idle lanes (decision 15): a free assigned lane while a startable unit waits
// is a finding at once and an alarm after the grace. Pure fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixDebtFindings, idleLaneFindings, idleLedger, startable, startableOnBoard, idleLine,
} from '../bin/idle-lanes.mjs';

const cards = [
  { id: 'cs', title: 'FINANCE-CARDS', stage: 'development', links: { ticket: 'https://github.com/acme/web/issues/1569' } },
  { id: 'u1', title: 'U1 #1575', stage: 'ci_pr', parent: 'cs' },
  { id: 'cd', title: 'a done sprint', stage: 'done', links: { ticket: 'https://github.com/acme/web/issues/1515' } },
];

function sprint(over = {}) {
  return {
    free: ['mac/lane-6', 'mac/lane-7'],
    stale: [],
    units: [
      { unit: 'U1', ticket: 1575, state: 'pr green', deps: [] },
      { unit: 'U3b', ticket: 1583, state: 'queued', deps: [{ ticket: 1577, unit: 'U3a', state: 'pr green', met: false }] },
      { unit: 'U7', ticket: 1581, state: 'queued', deps: [{ ticket: 1575, unit: 'U1', state: 'pr green', met: false }, { ticket: 1580, unit: 'U6', state: 'on lane', met: false }] },
    ],
    qaTickets: [{ unit: 'QA', ticket: 1599, qa: true, open: true, state: 'open', deps: [] }],
    ...over,
  };
}

test('startable: queued with every dependency merged, closed, or at least on an open PR', () => {
  assert.equal(startable({ state: 'queued', deps: [] }), true);
  assert.equal(startable({ state: 'queued', deps: [{ met: true }] }), true);
  assert.equal(startable({ state: 'queued', deps: [{ met: false, state: 'pr red' }] }), true, 'an open PR is a head to start from');
  assert.equal(startable({ state: 'queued', deps: [{ met: false, state: 'on lane' }] }), false, 'a dependency still on a lane holds it');
  assert.equal(startable({ state: 'queued', deps: [{ met: null, state: 'outside the sprint' }] }), false);
  assert.equal(startable({ state: 'queued', depsMerged: true, deps: [{ met: false, state: 'pr green' }] }), false, '"depends on (merged)": a PR head is not enough');
  assert.equal(startable({ state: 'queued', depsMerged: true, deps: [{ met: true }] }), true);
  assert.equal(startable({ state: 'on lane', deps: [] }), false);
  assert.equal(startable({ qa: true, open: true, deps: [] }), true);
  assert.equal(startable({ qa: true, open: true, deps: [{ met: false, state: 'pr green' }] }), true, 'a QA finding is an ordinary develop ticket');
  assert.equal(startable({ qa: true, open: true, pr: { number: 1 }, deps: [] }), false);
});

test('qa-run is startable only while open and after every dependency is merged or closed', () => {
  const ready = {
    labels: ['QA-RUN'], qa: true, open: true, state: 'open', deps: [{ met: true, state: 'merged' }],
  };
  assert.equal(startable(ready), true, 'the label comparison is case-normalized');
  assert.equal(startable({ ...ready, deps: [{ met: false, state: 'pr green' }] }), false, 'an open PR is not enough');
  assert.equal(startable({ ...ready, open: false }), false);
  assert.equal(startable({ ...ready, merged: { number: 1 } }), false);
  assert.equal(startable({ ...ready, pr: { number: 2 } }), false);
  assert.equal(startable({ ...ready, lane: { lane: 'lane-6' } }), false);
  assert.equal(startableOnBoard({ ...ready, ticket: 1605 }, 'cs', [
    { parent: 'cs', ticket: 1605, stage: 'ticketed', links: {}, lane: 'mac/lane-6' },
  ]), false, 'a lane recorded on the unit card also means the run has started');
});

test('a finding per active sprint with a free lane and a startable unit; U7 behind a lane is not counted', () => {
  const f = idleLaneFindings(cards, new Map([['cs', sprint()], ['cd', sprint()]]), { at: 'T' });
  assert.equal(f.length, 1, 'the done sprint and the unit card are skipped');
  assert.equal(f[0].key, 'idle:cs');
  assert.deepEqual(f[0].free, ['mac/lane-6', 'mac/lane-7']);
  assert.deepEqual(f[0].startable.map(u => u.ticket), [1583, 1599]);
  const duringLaunch = idleLaneFindings(cards, new Map([['cs', sprint()]]), { excludeTickets: [1583] });
  assert.deepEqual(
    duringLaunch[0].startable.map(u => u.ticket),
    [1599],
    'only the unit being launched is excluded; another waiting unit still counts',
  );
});

test('ticketed and merged sprints expose ticketed unit cards for dispatch', () => {
  const board = [
    { id: 'early', title: 'ticketed sprint', stage: 'ticketed' },
    { id: 'early-unit', parent: 'early', ticket: 2001, stage: 'ticketed', links: {} },
    { id: 'late', title: 'merged sprint', stage: 'merged' },
    { id: 'late-qa', parent: 'late', ticket: 2002, stage: 'ticketed', links: {} },
  ];
  const sprints = new Map([
    ['early', sprint({ free: ['mac/lane-6'], units: [{ unit: 'U1', ticket: 2001, state: 'queued', deps: [] }], qaTickets: [] })],
    ['late', sprint({ free: ['mac/lane-7'], units: [], qaTickets: [{ unit: 'QA', ticket: 2002, qa: true, open: true, deps: [] }] })],
  ]);

  const findings = idleLaneFindings(board, sprints);
  assert.deepEqual(findings.map(f => [f.card.stage, f.startable.map(u => u.ticket)]), [
    ['ticketed', [2001]],
    ['merged', [2002]],
  ]);
});

test('no free lane, no startable unit, or a stale source → no finding', () => {
  assert.equal(idleLaneFindings(cards, new Map([['cs', sprint({ free: [] })]])).length, 0);
  assert.equal(idleLaneFindings(cards, new Map([['cs', sprint({ units: [], qaTickets: [] })]])).length, 0);
  assert.equal(idleLaneFindings(cards, new Map([['cs', sprint({ stale: ['lanes:mac'] })]])).length, 0, 'unknown is not idle');
});

test('the ledger alarms after the grace, repeats after the interval, forgets what is gone', () => {
  const f = idleLaneFindings(cards, new Map([['cs', sprint()]]), { at: '2026-08-29T12:00:00.000Z' });
  const opts = { graceMs: 5 * 60000, repeatMs: 20 * 60000 };
  let r = idleLedger({ seen: {} }, f, '2026-08-29T12:00:00.000Z', opts);
  assert.equal(r.alarms.length, 0, 'inside the grace: a line, no alarm');
  assert.equal(r.active[0].since, '2026-08-29T12:00:00.000Z');
  r = idleLedger(r.ledger, f, '2026-08-29T12:06:00.000Z', opts);
  assert.equal(r.alarms.length, 1, 'past the grace: alarm');
  assert.equal(r.alarms[0].ageMs, 6 * 60000);
  r = idleLedger(r.ledger, f, '2026-08-29T12:10:00.000Z', opts);
  assert.equal(r.alarms.length, 0, 'not yet time to repeat');
  r = idleLedger(r.ledger, f, '2026-08-29T12:27:00.000Z', opts);
  assert.equal(r.alarms.length, 1, 'repeated after the interval');
  r = idleLedger(r.ledger, [], '2026-08-29T12:30:00.000Z', opts);
  assert.deepEqual(r.ledger.seen, {}, 'gone is forgotten');
  assert.equal(r.active.length, 0);
});

test('the line names the lanes, the wait, and the units', () => {
  const f = { card: { title: 'FINANCE-CARDS' }, free: ['mac/lane-6'], startable: [{ unit: 'U3b', ticket: 1583 }], ageMs: 12 * 60000 };
  assert.equal(idleLine(f), 'mac/lane-6 free for 12m while U3b #1583 waits with nothing in the way');
});

test('the board remembers: a unit whose card left ticketed or carries a PR is never startable again (merge lag)', () => {
  const withCards = [
    ...cards,
    { id: 'u3b', title: 'U3b #1583', stage: 'ci_pr', parent: 'cs', ticket: 1583, links: { pr: 'https://github.com/acme/web/pull/1605' } },
    { id: 'q1599', title: 'QA #1599', stage: 'ticketed', parent: 'cs', ticket: 1599, links: { pr: '' }, lane: '' },
  ];
  // Facts lag: U3b looks queued (open PR gone, merge not yet seen) — the card says it has started.
  const f = idleLaneFindings(withCards, new Map([['cs', sprint()]]), { at: 'T' });
  assert.deepEqual(f[0].startable.map(u => u.ticket), [1599], 'U3b is out, the QA ticket with no PR and no lane stays in');
  assert.equal(startableOnBoard({ state: 'queued', deps: [], ticket: 1583 }, 'cs', withCards), false);
  assert.equal(startableOnBoard({ state: 'queued', deps: [], ticket: 9999 }, 'cs', withCards), true, 'no card yet: facts decide');
  assert.equal(startableOnBoard({ qa: true, open: true, deps: [], ticket: 1599 }, 'cs', [{ id: 'q', parent: 'cs', ticket: 1599, stage: 'qa', links: {}, lane: 'mac/lane-6' }]), false, 'a QA card with a lane has started');
  assert.equal(startableOnBoard({ qa: true, open: true, deps: [], ticket: 1599 }, 'cs', [{ id: 'q', parent: 'cs', ticket: 1599, stage: 'merged', links: {}, lane: '' }]), false, 'a QA card outside ticketed has already started');
});

test('fix debt findings require a fresh open sprint, an active unit card, and an unattempted failure on the open PR head', () => {
  const head = 'abc1234500000000000000000000000000000000';
  const unit = {
    unit: 'U1', ticket: 1575, state: 'pr no-go', open: true, deps: [],
    pr: {
      number: 1589, open: true, headSha: head, mergeable: 'MERGEABLE', ci: { color: 'green' },
      verdictOnHead: { round: 2, go: false, head, at: '2026-08-31T04:44:46.000Z' },
    },
  };
  const debtCards = cards.map(card => card.id === 'u1' ? { ...card, ticket: 1575 } : card);
  const openSprint = sprint({ umbrellaOpen: true, units: [unit], qaTickets: [], laneTable: [] });
  const source = new Map([['cs', openSprint]]);

  const findings = fixDebtFindings(debtCards, source, { at: '2026-08-31T05:00:00.000Z' });
  assert.deepEqual(findings.map(f => [f.key, f.ticket, f.head]), [[`fix-debt:cs:1575:${head.slice(0, 8)}`, 1575, head]]);
  assert.equal(fixDebtFindings(debtCards, source, { excludeTickets: [1575] }).length, 0, 'a planner hold or dispatch attempt suppresses the watchdog');

  const noFinding = over => fixDebtFindings(debtCards, new Map([['cs', { ...openSprint, ...over }]])).length;
  assert.equal(noFinding({ stale: ['prs'] }), 0, 'stale data');
  assert.equal(noFinding({ umbrellaOpen: false }), 0, 'closed sprint');
  assert.equal(noFinding({ units: [{ ...unit, merged: { number: 1589 } }] }), 0, 'merged unit');
  assert.equal(noFinding({ units: [{ ...unit, lane: { busy: true } }] }), 0, 'lane busy with unit');
  assert.equal(noFinding({ units: [{
    ...unit,
    pr: { ...unit.pr, ci: { color: 'red', headSha: head }, verdictOnHead: { ...unit.pr.verdictOnHead, go: true } },
  }] }), 0, 'GO on head wins even when a red check fact lingers');
  assert.equal(fixDebtFindings(debtCards.map(card => card.id === 'u1' ? { ...card, stage: 'ticketed' } : card), source).length, 0, 'ticketed unit card');
});

test('fix debt uses the idle ledger and becomes due at 30 minutes', () => {
  const finding = {
    key: 'fix-debt:cs:1575:abc12345', card: { id: 'u1', title: 'U1 #1575' },
    ticket: 1575, head: 'abc1234500000000000000000000000000000000', at: '2026-08-31T05:00:00.000Z',
  };
  let result = idleLedger({ seen: {} }, [finding], '2026-08-31T05:00:00.000Z', { graceMs: 30 * 60000, repeatMs: 30 * 60000 });
  assert.equal(result.alarms.length, 0);
  result = idleLedger(result.ledger, [finding], '2026-08-31T05:30:00.000Z', { graceMs: 30 * 60000, repeatMs: 30 * 60000 });
  assert.equal(result.alarms.length, 1);
});
