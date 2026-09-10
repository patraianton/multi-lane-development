// The spec-check (owner, 2026-09-08): an auditor reads every PR head against
// the sprint's spec BEFORE the reviewer, the `full-ci` label and the merge —
// no test round is spent on code that is not what the spec says. Pure
// fixtures; no ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planSpecChecks, planReviews, planFixes, sortDispatchQueue, dispatchKey, taskFileName, dispatchRows, taskText,
} from '../bin/auto-dispatch.mjs';
import { prVerdictFacts, canMerge, needsFullCiLabel, specGoOnHead } from '../bin/merge.mjs';

const HEAD = 'aefd5925e0000000000000000000000000000000';
const NEXT = 'bbbb111100000000000000000000000000000000';
const AT = '2026-09-08T15:00:00.000Z';
const FLEET = {
  prompt: 'Read {taskFile} and do it whole.',
  hosts: { 'lanes-01': { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' } },
  lanes: { 'lane-1': { host: 'lanes-01', n: 1 }, 'lane-2': { host: 'lanes-01', n: 2 } },
};
const cards = [
  { id: 'cs', title: 'AUTO-FEEDBACK-FIX-001', stage: 'development', links: { ticket: 'https://github.com/acme/web/issues/2092' } },
  { id: 'u1', title: '#2093', stage: 'ci_pr', parent: 'cs', ticket: 2093 },
];
const SPEC_NO_GO = { round: 1, go: false, head: 'aefd5925', at: '2026-09-08T14:50:00.000Z', body: 'S1 — NO-GO\nhead aefd5925\nHIGH — §9.1-b — recipient is info@ — any override accepted — lib/feedback/email-copy.ts:88' };
const SPEC_GO = { round: 2, go: true, head: 'aefd5925', at: '2026-09-08T14:55:00.000Z', body: 'S2 — GO\nhead aefd5925' };

function pr(over = {}) {
  return { number: 2101, headSha: HEAD, open: true, draft: false, verdictOnHead: null, verdictRounds: 0, specVerdictOnHead: null, specRounds: 0, ...over };
}
function sprints(prFacts) {
  return new Map([['cs', {
    umbrella: 2092, free: ['lanes-01/lane-1', 'lanes-01/lane-2'], stale: [],
    units: [{ unit: '', ticket: 2093, title: 'the fix', url: 'https://github.com/acme/web/issues/2093', branch: 'feat/2093', state: 'pr open', deps: [], pr: prFacts }],
    qaTickets: [],
  }]]);
}

test('prVerdictFacts keeps the S-family and the R-family apart, each with its own head verdict and round count', () => {
  const comments = [
    { body: 'S1 — NO-GO\nhead aefd5925\nHIGH — §9.1-b — …', createdAt: '2026-09-08T14:50:00.000Z' },
    { body: 'fix R1 pushed, head bbbb1111', createdAt: '2026-09-08T15:10:00.000Z' },
    { body: 'S2 — GO\nhead bbbb1111', createdAt: '2026-09-08T15:20:00.000Z' },
    { body: 'R1 — GO\nhead bbbb1111', createdAt: '2026-09-08T15:40:00.000Z' },
  ];
  const facts = prVerdictFacts(comments, NEXT);
  assert.equal(facts.specVerdicts.length, 2);
  assert.equal(facts.verdicts.length, 1);
  assert.deepEqual([facts.specVerdictOnHead.round, facts.specVerdictOnHead.go], [2, true]);
  assert.deepEqual([facts.verdictOnHead.round, facts.verdictOnHead.go], [1, true]);
  assert.equal(facts.specRounds, 2);
  assert.equal(facts.verdictRounds, 1, 'the fix comment counts a review round, never a spec round');
  assert.equal(specGoOnHead({ headSha: NEXT, specVerdictOnHead: facts.specVerdictOnHead }), true);
  assert.equal(specGoOnHead({ headSha: HEAD, specVerdictOnHead: facts.specVerdictOnHead }), false, 'a GO on another head is not a GO');
});

test('a PR head without a spec verdict gets the spec-check first: kind spec, role spec-check, S1, keyed by head', () => {
  const pairs = planSpecChecks({ cards, sprints: sprints(pr()), fleet: FLEET, at: AT });
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  assert.deepEqual([p.kind, p.role, p.round, p.head, p.lane, p.unit.ticket], ['spec', 'spec-check', 1, HEAD, 'lanes-01/lane-1', 2093]);
  assert.equal(dispatchKey(p), '2093:spec:aefd5925');
  assert.equal(taskFileName(p), 'TASK-2093-SPEC-S1.md');
  assert.equal(dispatchRows({ pairs, at: AT })[0].kind, 'spec-check S1');
  const text = taskText({ pair: p, ticket: { title: 'the fix', body: 'Part of #2092' }, rules: { sha: 'e0a1078', text: '<!-- role: common -->\ncommon\n<!-- role: spec-check -->\nspec\n' } });
  assert.match(text, /Round: S1/);
  assert.match(text, /Role: spec-check/);
});

test('a head that already has its spec verdict is not spec-checked again; the next round numbers from specRounds', () => {
  assert.equal(planSpecChecks({ cards, sprints: sprints(pr({ specVerdictOnHead: SPEC_GO, specRounds: 2 })), fleet: FLEET, at: AT }).length, 0);
  const moved = planSpecChecks({ cards, sprints: sprints(pr({ headSha: NEXT, specVerdictOnHead: null, specRounds: 2 })), fleet: FLEET, at: AT });
  assert.deepEqual([moved[0].round, moved[0].head], [3, NEXT]);
});

test('with specCheck on, the reviewer waits for the S-GO on the head and never reads a head under a spec NO-GO', () => {
  const holds = [];
  assert.equal(planReviews({ cards, sprints: sprints(pr()), fleet: FLEET, at: AT, holds, specCheck: true }).length, 0);
  assert.match(holds[0].reason, /spec-check of head aefd5925 first/);
  const noGoHolds = [];
  assert.equal(planReviews({ cards, sprints: sprints(pr({ specVerdictOnHead: SPEC_NO_GO, specRounds: 1 })), fleet: FLEET, at: AT, holds: noGoHolds, specCheck: true }).length, 0);
  assert.equal(noGoHolds.length, 0, 'a spec NO-GO is the fixer\'s, not a review hold');
  const reviews = planReviews({ cards, sprints: sprints(pr({ specVerdictOnHead: SPEC_GO, specRounds: 2 })), fleet: FLEET, at: AT, specCheck: true });
  assert.deepEqual([reviews[0].kind, reviews[0].role, reviews[0].round], ['review', 'reviewer', 1]);
  assert.equal(planReviews({ cards, sprints: sprints(pr()), fleet: FLEET, at: AT }).length, 1, 'specCheck off: the pre-2026-09-08 road, review at once');
});

test('the spec-check reserves its lane before the reviewer takes one', () => {
  const specs = planSpecChecks({ cards, sprints: sprints(pr()), fleet: FLEET, at: AT });
  const reviews = planReviews({
    cards, sprints: sprints(pr({ specVerdictOnHead: SPEC_GO, specRounds: 2 })), fleet: FLEET, at: AT, specCheck: true,
    taken: specs.map(p => p.lane), takenTickets: specs.map(p => p.unit.ticket),
  });
  assert.equal(reviews.length, 0, 'the same ticket is not read twice in one sweep');
  const queue = sortDispatchQueue([{ kind: 'develop' }, { kind: 'fix' }, { kind: 'review' }, { kind: 'spec' }]);
  assert.deepEqual(queue.map(p => p.kind), ['spec', 'review', 'fix', 'develop']);
});

test('a spec NO-GO on the head is a fix round carrying the verdict verbatim as SPEC-CHECK', () => {
  const pairs = planFixes({ cards, sprints: sprints(pr({ specVerdictOnHead: SPEC_NO_GO, specRounds: 1 })), fleet: FLEET, at: AT });
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].kind, pairs[0].role, pairs[0].round, pairs[0].head], ['fix', 'fixer', 1, HEAD]);
  assert.equal(pairs[0].sections[0].title, 'SPEC-CHECK S1 — verbatim');
  assert.equal(pairs[0].sections[0].body, SPEC_NO_GO.body);
});

test('while the spec-check reads a head, the fixer waits for its verdict', () => {
  const ledger = { dispatched: { '2093:spec:aefd5925': { kind: 'spec', ticket: 2093, head: HEAD, result: 'launched', at: AT, lane: 'lanes-01/lane-2', judged: null } } };
  const holds = [];
  const pairs = planFixes({ cards, sprints: sprints(pr({ mergeable: 'CONFLICTING' })), fleet: FLEET, at: AT, ledger, holds });
  assert.equal(pairs.length, 0);
  assert.match(holds[0].reason, /spec-check of head aefd5925 is running/);
});

test('with specCheck on, neither the merge nor the full-ci label happens before the S-GO on the head', () => {
  const base = { headSha: HEAD, ci: { color: 'green', headSha: HEAD }, verdictOnHead: { round: 1, go: true, head: 'aefd5925' }, draft: false, mergeable: 'MERGEABLE' };
  assert.deepEqual(canMerge({ pr: { ...base, specVerdictOnHead: null }, unit: { labels: [] }, specCheck: true }), { ok: false, why: 'spec-check' });
  assert.deepEqual(canMerge({ pr: { ...base, specVerdictOnHead: SPEC_NO_GO }, unit: { labels: [] }, specCheck: true }), { ok: false, why: 'SPEC NO-GO' });
  assert.deepEqual(canMerge({ pr: { ...base, specVerdictOnHead: SPEC_GO }, unit: { labels: [] }, specCheck: true }), { ok: true, why: '' });
  assert.deepEqual(canMerge({ pr: { ...base, specVerdictOnHead: null }, unit: { labels: [] } }), { ok: true, why: '' }, 'specCheck off: the pre-2026-09-08 gate');
  assert.equal(needsFullCiLabel({ pr: { ...base, specVerdictOnHead: null, labels: [] }, unit: { labels: [] }, specCheck: true }), false);
  assert.equal(needsFullCiLabel({ pr: { ...base, specVerdictOnHead: SPEC_GO, labels: [] }, unit: { labels: [] }, specCheck: true }), true);
  assert.deepEqual(canMerge({ pr: { ...base, verdictOnHead: null, specVerdictOnHead: null }, unit: { labels: ['no-review'] }, specCheck: true }), { ok: true, why: '' }, 'no-review keeps its road: no reader at all');
});

// ---- the staging walk (owner, 2026-09-10): a PR head is deployed to one
// staging before any check; the spec-check waits for the deploy receipt and
// walks it on a browser lane. Pure fixtures; no ssh, no gh.
const STAGING = { enabled: true, url: 'http://89.167.116.229:18090', user: 'staging', password: 'pw-1', waitMinutes: 25 };
const FLEET_BROWSER = {
  ...FLEET,
  hosts: { ...FLEET.hosts, mac: { kitchen: '~/kitchens/autopase.lv', launch: 'maclane {n} "{prompt}"', browser: true } },
  lanes: { ...FLEET.lanes, 'lane-6': { host: 'mac', n: 6 } },
};
const RULES_MIN = { sha: 'abc1234', text: '## common\n1. x\n## spec-check\n1. y' };
function sprintsWith(prFacts, free) {
  const m = sprints(prFacts);
  m.get('cs').free = free;
  return m;
}
const minutesBefore = (n) => new Date(Date.parse(AT) - n * 60000).toISOString();

test('prVerdictFacts reads the staging receipt: head, address, data line, and a FAILED step', () => {
  const ok = prVerdictFacts([
    { body: 'STAGING head aefd5925\nhttp://89.167.116.229:18090\ndata: copy of production from 2026-09-10 03:40 UTC\nserved aefd5925 at 2026-09-10T15:00:00Z', createdAt: AT },
  ], HEAD);
  assert.equal(ok.stagingOnHead?.head, 'aefd5925');
  assert.equal(ok.stagingOnHead?.url, 'http://89.167.116.229:18090');
  assert.equal(ok.stagingOnHead?.data, 'copy of production from 2026-09-10 03:40 UTC');
  assert.equal(ok.stagingOnHead?.failed, false);
  assert.equal(ok.specVerdicts.length, 0, 'a receipt is not a verdict');
  const failed = prVerdictFacts([{ body: 'STAGING head bbbb1111 FAILED — migrate\nhttp://89.167.116.229:18090', createdAt: AT }], NEXT);
  assert.equal(failed.stagingOnHead?.failed, true);
  assert.equal(failed.stagingOnHead?.step, 'migrate');
  const other = prVerdictFacts([{ body: 'STAGING head bbbb1111\nhttp://89.167.116.229:18090', createdAt: AT }], HEAD);
  assert.equal(other.stagingOnHead, null, 'a receipt for another head is not this head\'s');
  assert.equal(other.staging?.head, 'bbbb1111');
});

test('with the staging enabled the spec-check waits for the receipt, up to waitMinutes from the PR change, then goes code-only', () => {
  const holds = [];
  const fresh = planSpecChecks({ cards, sprints: sprints(pr({ updatedAt: minutesBefore(5) })), fleet: FLEET, at: AT, holds, staging: STAGING });
  assert.equal(fresh.length, 0);
  assert.match(holds.map(h => h.reason).join('\n'), /staging of head aefd5925 not ready/);
  const stale = planSpecChecks({ cards, sprints: sprints(pr({ updatedAt: minutesBefore(40) })), fleet: FLEET, at: AT, staging: STAGING });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].staging?.state, 'missing');
  const text = taskText({ pair: stale[0], ticket: { number: 2093, title: 't', body: 'b' }, rules: RULES_MIN, staging: STAGING });
  assert.match(text, /^Staging: no receipt for head aefd5925/m);
});

test('a ready receipt sends the spec-check to a browser lane and the task carries the address and the password', () => {
  const receipt = { head: 'aefd5925', failed: false, url: 'http://89.167.116.229:18090', data: 'copy of production from 2026-09-10 03:40 UTC' };
  const holds = [];
  const noBrowser = planSpecChecks({
    cards, sprints: sprintsWith(pr({ stagingOnHead: receipt }), ['lanes-01/lane-1', 'lanes-01/lane-2']),
    fleet: FLEET_BROWSER, at: AT, holds, staging: STAGING,
  });
  assert.equal(noBrowser.length, 0);
  assert.match(holds.map(h => h.reason).join('\n'), /needs a free browser: true lane/);
  const pairs = planSpecChecks({
    cards, sprints: sprintsWith(pr({ stagingOnHead: receipt }), ['lanes-01/lane-1', 'mac/lane-6']),
    fleet: FLEET_BROWSER, at: AT, staging: STAGING,
  });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].lane, 'mac/lane-6');
  assert.equal(pairs[0].staging?.state, 'ready');
  const text = taskText({ pair: pairs[0], ticket: { number: 2093, title: 't', body: 'b' }, rules: RULES_MIN, staging: STAGING });
  assert.match(text, /^Staging: http:\/\/89\.167\.116\.229:18090 — HTTP basic auth user `staging`, password `pw-1`; it serves head aefd5925; data: copy of production from 2026-09-10 03:40 UTC\./m);
});

test('a FAILED receipt is read at once on any lane: the head does not deploy', () => {
  const receipt = { head: 'aefd5925', failed: true, step: 'migrate', url: 'http://89.167.116.229:18090' };
  const pairs = planSpecChecks({ cards, sprints: sprints(pr({ stagingOnHead: receipt })), fleet: FLEET, at: AT, staging: STAGING });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].lane, 'lanes-01/lane-1');
  assert.equal(pairs[0].staging?.state, 'failed');
  const text = taskText({ pair: pairs[0], ticket: { number: 2093, title: 't', body: 'b' }, rules: RULES_MIN, staging: STAGING });
  assert.match(text, /^Staging: FAILED on head aefd5925 — migrate\./m);
});

test('with the staging disabled the road is unchanged: no wait, any lane, no Staging line', () => {
  const pairs = planSpecChecks({ cards, sprints: sprints(pr({ updatedAt: minutesBefore(1) })), fleet: FLEET, at: AT, staging: { ...STAGING, enabled: false } });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].staging, undefined);
  const text = taskText({ pair: pairs[0], ticket: { number: 2093, title: 't', body: 'b' }, rules: RULES_MIN, staging: STAGING });
  assert.doesNotMatch(text, /^Staging:/m);
});
