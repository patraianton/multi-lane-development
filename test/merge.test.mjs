import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMerge, ciColor, isEvidenceCheck, needsFullCiLabel, prVerdict, prVerdictFacts } from '../bin/merge.mjs';

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
    ['draft', { pr: { draft: true } }, 'draft — waiting for the author'],
    ['unknown mergeability', { pr: { mergeable: 'UNKNOWN' } }, 'GitHub has not computed mergeability yet'],
    ['conflict', { pr: { mergeable: 'CONFLICTING' } }, 'GitHub says the PR is not mergeable'],
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
    ['draft', { pr: { ...noVerdict, draft: true }, unit: { labels: ['no-review'] } }, 'draft — waiting for the author'],
    ['red check', { pr: { ...noVerdict, ci: { color: 'red', headSha: HEAD } }, unit: { labels: ['no-review'] } }, 'check green'],
    ['check on an old head', { pr: { ...noVerdict, ci: { color: 'green', headSha: 'def12345abcdef0123456789abcdef0123456789' } }, unit: { labels: ['no-review'] } }, 'check head'],
    ['unknown mergeability', { pr: { ...noVerdict, mergeable: 'UNKNOWN' }, unit: { labels: ['no-review'] } }, 'GitHub has not computed mergeability yet'],
  ];
  for (const [name, overrides, why] of gates) {
    assert.deepEqual(canMerge(candidate(overrides)), { ok: false, why }, name);
  }
});

test('canMerge accepts the flat CI fact shape', () => {
  const value = candidate({ pr: { ci: undefined, ciColor: 'green', ciHeadSha: HEAD } });
  assert.deepEqual(canMerge(value), { ok: true, why: '' });
});

test('ciColor gates on the two required checks unless the caller explicitly asks for every check', () => {
  const full = { __typename: 'CheckRun', name: 'pr-ci-full', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const fixtures = {
    greenWhileImageRuns: [
      { __typename: 'CheckRun', name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      full,
      { __typename: 'CheckRun', name: 'coolify-image', status: 'IN_PROGRESS', conclusion: '' },
    ],
    queuedWhileImagePasses: [
      { __typename: 'CheckRun', name: 'pr-ci', status: 'QUEUED', conclusion: '' },
      full,
      { __typename: 'CheckRun', name: 'coolify-image', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    greenWhileImageFails: [
      { __typename: 'CheckRun', name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
      full,
      { __typename: 'CheckRun', name: 'coolify-image', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
    vercelOnly: [
      { __typename: 'StatusContext', context: 'Vercel – preview', state: 'SUCCESS' },
    ],
  };

  assert.deepEqual(ciColor(fixtures.greenWhileImageRuns), {
    color: 'green', text: 'CI green (2)', failedNames: [],
  });
  assert.deepEqual(ciColor(fixtures.queuedWhileImagePasses), {
    color: 'run', text: 'CI running (1)', failedNames: [],
  });
  assert.deepEqual(ciColor(fixtures.greenWhileImageFails), {
    color: 'green', text: 'CI green (2)', failedNames: [],
  });
  assert.deepEqual(ciColor(fixtures.vercelOnly), {
    color: 'none', text: 'no checks', failedNames: [],
  });
  assert.deepEqual(canMerge(candidate({
    pr: { ci: { ...ciColor(fixtures.vercelOnly), headSha: HEAD } },
  })), { ok: false, why: 'check green' });
  assert.deepEqual(ciColor(fixtures.greenWhileImageFails, []), {
    color: 'red', text: 'CI red (1)', failedNames: ['coolify-image'],
  });
  assert.deepEqual(canMerge(candidate({
    pr: { ci: { ...ciColor(fixtures.greenWhileImageRuns), headSha: HEAD } },
  })), { ok: true, why: '' });
});

test('the full-run receipt holds the merge yellow and never reads as a red check', () => {
  const scoped = { __typename: 'CheckRun', name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
  const cases = [
    ['no pr-ci-full run at all — the label is not on the PR yet', [scoped],
      { color: 'run', text: 'CI waiting for pr-ci-full', failedNames: [] }],
    ['the full run is in flight', [scoped, { name: 'pr-ci-full', status: 'IN_PROGRESS', conclusion: '' }],
      { color: 'run', text: 'CI waiting for pr-ci-full', failedNames: [] }],
    ['no full evidence on this head yet', [scoped, { name: 'pr-ci-full', conclusion: 'FAILURE' }],
      { color: 'run', text: 'CI waiting for pr-ci-full', failedNames: [] }],
    ['both green', [scoped, { name: 'pr-ci-full', conclusion: 'SUCCESS' }],
      { color: 'green', text: 'CI green (2)', failedNames: [] }],
    ['the scoped gate is red', [{ name: 'pr-ci', conclusion: 'FAILURE' }, { name: 'pr-ci-full', conclusion: 'FAILURE' }],
      { color: 'red', text: 'CI red (1)', failedNames: ['pr-ci'] }],
  ];
  for (const [name, rollup, expected] of cases) {
    const value = ciColor(rollup);
    assert.deepEqual(value, expected, name);
    assert.equal(canMerge(candidate({ pr: { ci: { ...value, headSha: HEAD } } })).ok, value.color === 'green', name);
  }
});

test('two runs of one check on a head — only the newest run is the check', () => {
  const scoped = { name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-11T06:05:13Z' };
  const gateBeforeLabel = { name: 'pr-ci-full', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-11T06:05:21Z' };
  const fullAfterLabel = { name: 'pr-ci-full', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-11T07:07:47Z' };
  const scopedAgain = { name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-11T07:07:38Z' };
  // PR #2203, 2026-09-11: the label re-ran the workflow on the same head.
  assert.deepEqual(ciColor([scoped, scopedAgain, gateBeforeLabel, fullAfterLabel]), {
    color: 'green', text: 'CI green (2)', failedNames: [],
  }, 'the fail-fast gate from before the label is history');
  assert.deepEqual(ciColor([scoped, fullAfterLabel, gateBeforeLabel]), {
    color: 'green', text: 'CI green (2)', failedNames: [],
  }, 'order in the rollup does not matter when both carry a time');
  assert.deepEqual(ciColor([scoped, gateBeforeLabel, { name: 'pr-ci-full', status: 'QUEUED', conclusion: '' }]), {
    color: 'run', text: 'CI waiting for pr-ci-full', failedNames: [],
  }, 'a queued re-run without a time is the newer entry');
  assert.deepEqual(ciColor([
    { name: 'pr-ci', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-11T06:05:13Z' },
    { name: 'pr-ci', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-11T07:07:38Z' },
    fullAfterLabel,
  ]), { color: 'red', text: 'CI red (1)', failedNames: ['pr-ci'] }, 'a newer red run is red, an older green does not hide it');
});

test('the board asks for the full run exactly when the card is ready to merge without it', () => {
  const waiting = { color: 'run', text: 'CI waiting for pr-ci-full', failedNames: [] };
  const ready = candidate({ pr: { ci: { ...waiting, headSha: HEAD } } });
  assert.equal(needsFullCiLabel(ready), true, 'GO on the head, mergeable, no label — label it');
  assert.equal(needsFullCiLabel(candidate({
    pr: { ci: { ...waiting, headSha: HEAD }, labels: [{ name: 'Full-CI' }] },
  })), false, 'the label is already there');
  assert.equal(needsFullCiLabel(candidate({
    pr: { ci: { color: 'red', text: 'CI red (1)', failedNames: ['pr-ci'], headSha: HEAD } },
  })), false, 'a red scoped gate belongs to a fixer first');
  assert.equal(needsFullCiLabel(candidate({
    pr: { ci: { ...waiting, headSha: HEAD }, verdictOnHead: null },
  })), false, 'no verdict on the head — nothing is ready to merge');
  assert.equal(needsFullCiLabel(candidate({
    pr: { ci: { ...waiting, headSha: HEAD }, verdictOnHead: null }, unit: { labels: ['no-review'] },
  })), true, 'a no-review ticket needs no verdict and still needs the full run');
  for (const [name, overrides] of [
    ['draft', { pr: { ci: { ...waiting, headSha: HEAD }, draft: true } }],
    ['conflicting', { pr: { ci: { ...waiting, headSha: HEAD }, mergeable: 'CONFLICTING' } }],
    ['hold-merge', { pr: { ci: { ...waiting, headSha: HEAD } }, unit: { labels: ['hold-merge'] } }],
  ]) {
    assert.equal(needsFullCiLabel(candidate(overrides)), false, name);
  }
});

test('the full-run receipt never reaches the fixer as a failed check name', () => {
  assert.equal(isEvidenceCheck('pr-ci-full'), true);
  assert.equal(isEvidenceCheck('PR-CI-FULL'), true);
  assert.equal(isEvidenceCheck('pr-ci'), false);
  const rollup = [
    { name: 'pr-ci', conclusion: 'FAILURE' },
    { name: 'pr-ci-full', conclusion: 'FAILURE' },
  ];
  assert.deepEqual(ciColor(rollup).failedNames, ['pr-ci']);
  assert.deepEqual(ciColor(rollup, []).failedNames, ['pr-ci'], 'even with every check asked for');
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

test('review rounds use the highest verdict number when a missing round leaves two R4 comments', () => {
  const comments = [
    { body: 'R1 — GO\nhead abc12345' },
    { body: 'R2 — NO-GO\nhead def12345' },
    { body: 'R4 — GO\nhead abc12345' },
    { body: 'R4 — NO-GO\nhead def12345' },
  ];

  const facts = prVerdictFacts(comments, HEAD);
  assert.equal(facts.verdictRounds, 4);
  assert.equal(facts.verdictRounds + 1, 5, 'the next review is R5, never a duplicate R4');
});

test('a fixer push contributes its round even though it is not a verdict', () => {
  const comments = [
    { body: 'R8 — NO-GO\nhead cd7140bf' },
    { body: 'fix R10 pushed, head ebb45493' },
  ];

  const facts = prVerdictFacts(comments, 'ebb45493abcdef0123456789abcdef0123456789');
  assert.equal(facts.verdictRounds, 10);
  assert.equal(facts.verdicts.length, 1);
  assert.equal(facts.verdictOnHead, null);
  assert.equal(facts.verdict.round, 8);
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
  assert.equal(facts.verdictRounds, 3);
});

test('a verdict flattened to one line with literal \n is still counted on its head (#90)', () => {
  const comments = [{ body: `R3 — NO-GO\nhead ${HEAD}\nqa-tests/foo.test.ts: fails`, createdAt: '2026-09-04T20:28:22Z' }];
  const facts = prVerdictFacts(comments, HEAD);
  assert.equal(facts.verdicts.length, 1);
  assert.equal(facts.verdicts[0].head, HEAD);
  assert.equal(facts.verdicts[0].go, false);
  assert.equal(facts.verdictOnHead?.round, 3);
  assert.equal(facts.verdicts[0].body, `R3 — NO-GO\nhead ${HEAD}\nqa-tests/foo.test.ts: fails`);
});

test('a real multi-line verdict that quotes a literal \n is left as written (#90)', () => {
  const comments = [{ body: `R1 — GO\nhead ${HEAD}\nnote: the log prints "a\nb" on one line`, createdAt: null }];
  const facts = prVerdictFacts(comments, HEAD);
  assert.equal(facts.verdictOnHead?.round, 1);
  assert.equal(facts.verdicts[0].body, comments[0].body);
});
