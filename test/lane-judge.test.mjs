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
