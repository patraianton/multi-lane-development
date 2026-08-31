import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyFix, canMerge, prVerdict, prVerdictFacts } from '../bin/merge.mjs';

const HEAD = 'abc12345abcdef0123456789abcdef0123456789';

function candidate(overrides = {}) {
  const base = {
    pr: {
      headSha: HEAD,
      ci: { color: 'green', headSha: HEAD },
      verdictOnHead: { round: 1, go: true, head: 'abc12345' },
      draft: false,
      mergeable: 'MERGEABLE',
    },
    unit: { labels: [] },
  };
  return {
    pr: { ...base.pr, ...(overrides.pr ?? {}) },
    unit: { ...base.unit, ...(overrides.unit ?? {}) },
  };
}

test('canMerge accepts green CI and a GO on the exact mergeable head', () => {
  assert.deepEqual(canMerge(candidate()), { ok: true, why: '' });
});

test('canMerge reports the first missing merge condition', () => {
  const cases = [
    ['red check', { pr: { ci: { color: 'red', headSha: HEAD } } }, 'check green'],
    ['abbreviated check head', { pr: { ci: { color: 'green', headSha: 'abc12345' } } }, 'check head'],
    ['check on an old head', { pr: { ci: { color: 'green', headSha: 'def12345abcdef0123456789abcdef0123456789' } } }, 'check head'],
    ['verdict on another head', { pr: { verdictOnHead: { round: 1, go: true, head: 'def12345' } } }, 'verdict head'],
    ['missing verdict', { pr: { verdictOnHead: null } }, 'verdict head'],
    ['NO-GO', { pr: { verdictOnHead: { round: 1, go: false, head: 'abc12345' } } }, 'NO-GO'],
    ['draft', { pr: { draft: true } }, 'draft'],
    ['unknown mergeability', { pr: { mergeable: 'UNKNOWN' } }, 'mergeable'],
    ['conflict', { pr: { mergeable: 'CONFLICTING' } }, 'mergeable'],
    ['hold label on the ticket', { unit: { labels: ['Hold-Merge'] } }, 'hold-merge'],
    ['hold label on the PR', { pr: { labels: [{ name: 'Hold-Merge' }] } }, 'hold-merge'],
    ['hold label on both', {
      pr: { labels: ['hold-merge'] },
      unit: { labels: ['hold-merge'] },
    }, 'hold-merge'],
  ];

  for (const [name, overrides, why] of cases) {
    assert.deepEqual(canMerge(candidate(overrides)), { ok: false, why }, name);
  }
});

test('canMerge on a no-review unit needs no verdict, and the other gates still hold', () => {
  const noVerdict = { verdictOnHead: null };
  assert.deepEqual(canMerge(candidate({ pr: noVerdict, unit: { labels: ['No-Review'] } })), { ok: true, why: '' });
  assert.deepEqual(canMerge(candidate({
    pr: { ...noVerdict, verdicts: [{ round: 1, go: false, head: 'abc12345' }] },
    unit: { labels: ['no-review'] },
  })), { ok: true, why: '' }, 'only the current-head verdict ever gated; history stays history');
  const gates = [
    ['a NO-GO on the head is a stop order the label never drops',
      { pr: { verdictOnHead: { round: 1, go: false, head: 'abc12345' } }, unit: { labels: ['no-review'] } }, 'NO-GO'],
    ['hold-merge beats no-review', { pr: noVerdict, unit: { labels: ['no-review', 'hold-merge'] } }, 'hold-merge'],
    ['a PR hold-merge beats the ticket no-review path', {
      pr: { ...noVerdict, labels: ['hold-merge'] },
      unit: { labels: ['no-review'] },
    }, 'hold-merge'],
    ['draft', { pr: { ...noVerdict, draft: true }, unit: { labels: ['no-review'] } }, 'draft'],
    ['red check', { pr: { ...noVerdict, ci: { color: 'red', headSha: HEAD } }, unit: { labels: ['no-review'] } }, 'check green'],
    ['check on an old head', { pr: { ...noVerdict, ci: { color: 'green', headSha: 'def12345abcdef0123456789abcdef0123456789' } }, unit: { labels: ['no-review'] } }, 'check head'],
    ['unknown mergeability', { pr: { ...noVerdict, mergeable: 'UNKNOWN' }, unit: { labels: ['no-review'] } }, 'mergeable'],
  ];
  for (const [name, overrides, why] of gates) {
    assert.deepEqual(canMerge(candidate(overrides)), { ok: false, why }, name);
  }
});

test('canMerge accepts the flat CI fact shape', () => {
  const value = candidate({ pr: { ci: undefined, ciColor: 'green', ciHeadSha: HEAD } });
  assert.deepEqual(canMerge(value), { ok: true, why: '' });
});

test('prVerdictFacts parses the head from line two and counts every verdict comment', () => {
  const comments = [
    { body: 'not a verdict\nhead abc12345', createdAt: '2026-08-30T09:00:00.000Z' },
    { body: 'R1 — GO\nhead abc12345\nLooks good.', createdAt: '2026-08-30T10:00:00.000Z' },
    { body: 'R2 — NO-GO\nNo head was recorded.', createdAt: '2026-08-30T11:00:00.000Z' },
  ];

  const facts = prVerdictFacts(comments, HEAD);
  assert.equal(facts.verdictRounds, 2);
  assert.deepEqual(facts.verdicts.map(v => [v.round, v.go, v.head]), [
    [1, true, 'abc12345'],
    [2, false, null],
  ]);
  assert.equal(facts.verdict, facts.verdicts[0], 'a headless comment is displayed but is not the latest headed verdict');
  assert.equal(facts.verdictOnHead, facts.verdicts[0]);
  assert.deepEqual(prVerdict(comments), facts.verdicts[0]);
});

test('a newer verdict for another head does not displace the verdict on the current head', () => {
  const comments = [
    { body: 'R1 — GO\nhead abc12345', createdAt: '2026-08-30T10:00:00.000Z' },
    { body: 'R2 — NO-GO\nhead def12345', createdAt: '2026-08-30T11:00:00.000Z' },
  ];

  const facts = prVerdictFacts(comments, HEAD);
  assert.equal(facts.verdictRounds, 2);
  assert.deepEqual([facts.verdict.round, facts.verdict.go, facts.verdict.head], [2, false, 'def12345']);
  assert.deepEqual([facts.verdictOnHead.round, facts.verdictOnHead.go, facts.verdictOnHead.head], [1, true, 'abc12345']);
});

test('a fixture whose GO comment names another head is rejected as verdict head', () => {
  const comments = [{ body: 'R1 — GO\nhead def12345', createdAt: '2026-08-30T10:00:00.000Z' }];
  const verdictFacts = prVerdictFacts(comments, HEAD);
  const value = candidate({ pr: verdictFacts });
  assert.deepEqual(canMerge(value), { ok: false, why: 'verdict head' });
});

test('a verdict without a valid line-two head is never a verdict on the current head', () => {
  const comments = [{ body: 'R3 - GO\nhead abc12', createdAt: null }];
  const facts = prVerdictFacts(comments, HEAD);
  assert.deepEqual(facts.verdicts[0], {
    round: 3,
    go: true,
    head: null,
    at: null,
    body: comments[0].body,
  });
  assert.equal(facts.verdict, null);
  assert.equal(facts.verdictOnHead, null);
  assert.equal(facts.verdictRounds, 1);
});

test('bodyFix rewrites closing-keyword ticket references without changing other lines', () => {
  const input = [
    'Closes #1624',
    'fixes #1 after review',
    'Resolves: #7',
    'Resolves Baltic-OrangesLV/vincheck-latvia#5',
    'Ticket: #1624',
  ].join('\n');
  const expected = [
    'Ticket: #1624',
    'Ticket: #1 after review',
    'Resolves: #7',
    'Ticket: #5',
    'Ticket: #1624',
  ].join('\n');

  assert.deepEqual(bodyFix(input), { body: expected, changed: true });
});

test('bodyFix leaves an existing Ticket reference unchanged', () => {
  assert.deepEqual(bodyFix('Ticket: #1624'), { body: 'Ticket: #1624', changed: false });
});
