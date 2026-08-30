import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLanes } from '../bin/lane-judge.mjs';

const HEAD = 'abc1234500000000000000000000000000000000';
const NOW = '2026-08-30T12:03:00.000Z';

function entry(over = {}) {
  return {
    card: 'sprint-1',
    unit: 'U1',
    ticket: 101,
    branch: 'feat/101',
    lane: 'host-a/lane-1',
    host: 'host-a',
    kind: 'develop',
    round: 1,
    head: null,
    at: '2026-08-30T12:00:00.000Z',
    result: 'launched',
    firstSeenFree: '2026-08-30T12:01:00.000Z',
    ...over,
  };
}

function facts({ record = entry(), prs = [], tickets = [], prAt = '2026-08-30T12:02:00.000Z', ticketAt = '2026-08-30T12:02:00.000Z' } = {}) {
  return {
    journal: { version: 1, dispatched: { '101:develop:1': record } },
    lanes: { at: '2026-08-30T12:02:00.000Z', items: [{ host: 'host-a', lane: 'lane-1', busy: false }] },
    prs: { at: prAt, items: prs },
    tickets: { at: ticketAt, items: tickets },
    now: NOW,
  };
}

test('develop with an open or merged PR on its branch is judged ok', () => {
  for (const pr of [
    { number: 5, branch: 'feat/101', headSha: HEAD, state: 'OPEN' },
    { number: 5, branch: 'feat/101', headSha: HEAD, mergedAt: '2026-08-30T12:01:30.000Z' },
  ]) {
    const input = facts({ prs: [pr] });
    const result = judgeLanes(input);

    assert.equal(result.journal.dispatched['101:develop:1'].judged, 'ok');
    assert.deepEqual(result.judgments.map(item => [item.key, item.judged]), [['101:develop:1', 'ok']]);
    assert.deepEqual(result.failures, []);
    assert.equal(input.journal.dispatched['101:develop:1'].judged, undefined, 'the input journal stays untouched');
  }
});

test('develop on a freed lane waits while PR or ticket facts are stale', () => {
  const first = facts({
    record: entry({ firstSeenFree: undefined }),
    prAt: '2026-08-30T12:00:30.000Z',
    ticketAt: '2026-08-30T12:00:30.000Z',
  });
  const busy = judgeLanes({
    ...first,
    lanes: { at: '2026-08-30T12:02:00.000Z', items: [{ host: 'host-a', lane: 'lane-1', busy: true }] },
  });
  assert.equal(busy.journal.dispatched['101:develop:1'].firstSeenFree, undefined, 'a busy lane is not marked');

  const result = judgeLanes(first);

  assert.equal(result.journal.dispatched['101:develop:1'].firstSeenFree, NOW);
  assert.equal(result.journal.dispatched['101:develop:1'].judged, undefined);
  assert.deepEqual(result.judgments, []);

  const stillStale = judgeLanes({
    ...first,
    journal: result.journal,
    now: '2026-08-30T12:04:00.000Z',
    prs: { at: NOW, items: [] },
    tickets: { at: '2026-08-30T12:04:00.000Z', items: [] },
  });
  assert.equal(stillStale.journal.dispatched['101:develop:1'].judged, undefined, 'equal is not newer');
});

test('develop with fresh facts and no PR is no-proof and yields its next-round host preference', () => {
  const result = judgeLanes(facts());

  assert.equal(result.journal.dispatched['101:develop:1'].judged, 'no-proof');
  assert.match(result.failures[0].reason, /no open or merged PR on feat\/101/);
  assert.deepEqual(result.retries, [{
    key: '101:develop:2',
    previousKey: '101:develop:1',
    card: 'sprint-1',
    unit: 'U1',
    ticket: 101,
    branch: 'feat/101',
    kind: 'develop',
    round: 2,
    head: null,
    previousLane: 'host-a/lane-1',
    avoidHost: 'host-a',
    preferAnotherHost: true,
  }]);
});

test('review with a countable verdict on the reviewed head is judged ok', () => {
  const record = entry({ kind: 'review', round: 2, head: HEAD });
  const input = facts({
    record,
    prs: [{
      branch: 'feat/101',
      headSha: HEAD,
      verdictOnHead: { round: 2, go: false, head: HEAD, body: 'R2 — NO-GO\nhead abc12345' },
    }],
  });
  input.journal.dispatched = { '101:review:abc12345': record };
  const result = judgeLanes(input);

  assert.equal(result.journal.dispatched['101:review:abc12345'].judged, 'ok', 'GO and NO-GO both prove the review ran');
  assert.deepEqual(result.retries, []);
});

test('review proof remains countable after the PR moves to the merged snapshot', () => {
  const record = entry({ kind: 'review', head: HEAD });
  const input = facts({
    record,
    prs: [{
      branch: 'feat/101', headSha: HEAD, mergedAt: '2026-08-30T12:01:30.000Z',
      verdictOnHead: { round: 1, go: true, head: HEAD, body: `R1 — GO\nhead ${HEAD}` },
    }],
  });
  input.journal.dispatched = { '101:review:abc12345': record };

  const result = judgeLanes(input);
  assert.equal(result.journal.dispatched['101:review:abc12345'].judged, 'ok');
});

test('fix with the same PR head is no-proof', () => {
  const record = entry({ kind: 'fix', head: HEAD });
  const input = facts({ record, prs: [{ branch: 'feat/101', headSha: HEAD }] });
  input.journal.dispatched = { '101:fix:1': record };
  const result = judgeLanes(input);

  assert.equal(result.journal.dispatched['101:fix:1'].judged, 'no-proof');
  assert.match(result.failures[0].reason, /no new PR head/);
  assert.deepEqual(
    [result.retries[0].key, result.retries[0].head, result.retries[0].avoidHost],
    ['101:fix:2', HEAD, 'host-a'],
  );
});

test('fix proof remains visible after the changed head is merged', () => {
  const changedHead = 'def6789000000000000000000000000000000000';
  const record = entry({ kind: 'fix', head: HEAD });
  const input = facts({
    record,
    prs: [{
      branch: 'feat/101', headSha: changedHead, mergedAt: '2026-08-30T12:01:30.000Z',
    }],
  });
  input.journal.dispatched = { '101:fix:abc12345': record };

  const result = judgeLanes(input);
  assert.equal(result.journal.dispatched['101:fix:abc12345'].judged, 'ok');
  assert.match(result.judgments[0].reason, new RegExp(changedHead));
});

test('qa-run is judged ok when its ticket is closed', () => {
  const record = entry({ role: 'qa', qaRun: true });
  const result = judgeLanes(facts({
    record,
    tickets: [{ number: 101, state: 'CLOSED', labels: ['qa-run'] }],
  }));

  assert.equal(result.journal.dispatched['101:develop:1'].judged, 'ok');
  assert.match(result.judgments[0].reason, /ticket #101 is closed/);
  assert.deepEqual(result.failures, []);
});

// A lane another window took over is the same evidence as a freed lane: the
// board's own run is gone. Incident 2026-08-30: lane-4 was stopped by number
// and stayed busy on a foreign branch for 1 h 40 min.
function takeover({ lane = { host: 'host-a', lane: 'lane-1', busy: true, branch: 'feat/vx-a10' }, record = {}, laneAt = '2026-08-30T12:25:00.000Z' } = {}) {
  return {
    journal: {
      version: 1,
      dispatched: {
        '101:develop:1': entry({
          base: 'feat/100@75507510 (PR #1730)',
          firstSeenFree: undefined,
          ...record,
        }),
      },
    },
    lanes: { at: laneAt, items: [lane] },
    prs: { at: '2026-08-30T12:24:00.000Z', items: [] },
    tickets: { at: '2026-08-30T12:24:00.000Z', items: [] },
    now: laneAt,
  };
}

test('a taken-over lane is judged like a freed one', () => {
  const first = judgeLanes(takeover());
  assert.equal(first.journal.dispatched['101:develop:1'].firstSeenFree, '2026-08-30T12:25:00.000Z',
    'the first sweep only stamps — the same two-sweep debounce a freed lane gets');
  assert.deepEqual(first.judgments, []);

  const second = judgeLanes({
    ...takeover(),
    journal: first.journal,
    prs: { at: '2026-08-30T12:25:30.000Z', items: [] },
    tickets: { at: '2026-08-30T12:25:30.000Z', items: [] },
    now: '2026-08-30T12:26:00.000Z',
  });
  assert.equal(second.journal.dispatched['101:develop:1'].judged, 'no-proof');
  assert.equal(second.journal.dispatched['101:develop:1'].judgeReason,
    'no open or merged PR on feat/101 after host-a/lane-1 was taken over by feat/vx-a10');
  assert.equal(second.failures.length, 1);
  assert.deepEqual(second.retries.map(r => [r.key, r.avoidHost]), [['101:develop:2', 'host-a']]);
});

test('a busy lane is only a takeover when the work is not ours', () => {
  const cases = [
    ['the trunk', { branch: 'main' }],
    ['a detached reviewer checkout', { branch: 'HEAD' }],
    ['our own branch', { branch: 'feat/101' }],
    ['our base branch', { branch: 'feat/100' }],
    ['our own TASK on a foreign branch', { branch: 'feat/vx-a10', task: 'TASK-101.md' }],
    ['a host that did not answer', { branch: 'feat/vx-a10', hostOk: false }],
    ['a remembered lane', { branch: 'feat/vx-a10', remembered: true }],
  ];
  for (const [why, over] of cases) {
    const result = judgeLanes(takeover({ lane: { host: 'host-a', lane: 'lane-1', busy: true, ...over } }));
    assert.equal(result.journal.dispatched['101:develop:1'].firstSeenFree, undefined, why);
    assert.equal(result.journal.dispatched['101:develop:1'].judged, undefined, why);
    assert.deepEqual(result.judgments, [], why);
  }
  const early = judgeLanes(takeover({ laneAt: '2026-08-30T12:12:00.000Z' }));
  assert.equal(early.journal.dispatched['101:develop:1'].firstSeenFree, undefined,
    'inside the 20-minute grace a slow checkout still shows the previous occupant');
});

test('the TASK file outranks the branch', () => {
  const busy = { host: 'host-a', lane: 'lane-1', busy: true, branch: 'feat/101', task: 'TASK-1701-R2.md' };
  const first = judgeLanes(takeover({ lane: busy }));
  const second = judgeLanes({
    ...takeover({ lane: busy }),
    journal: first.journal,
    prs: { at: '2026-08-30T12:25:30.000Z', items: [] },
    tickets: { at: '2026-08-30T12:25:30.000Z', items: [] },
    now: '2026-08-30T12:26:00.000Z',
  });
  assert.equal(second.journal.dispatched['101:develop:1'].judged, 'no-proof');
  assert.match(second.journal.dispatched['101:develop:1'].judgeReason, /was taken over by TASK-1701$/);
});
