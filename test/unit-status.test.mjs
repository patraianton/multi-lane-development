import test from 'node:test';
import assert from 'node:assert/strict';
import { unitStatus } from '../bin/pipeline.mjs';

const ticket = 1850;
const headSha = '18faeb2700000000000000000000000000000000';
const card = {
  stage: 'ci_pr', stageHistory: [{ stage: 'ci_pr', enteredAt: '2026-09-02T10:00:00Z' }],
  links: { pr: '' }, review: null,
};
const openPr = {
  number: 1854, ci: { color: 'green' }, draft: false, headSha,
  mergeable: 'MERGEABLE', verdictOnHead: null, verdictRounds: 0,
};
const row = (kind, state, extra = {}) => ({
  kind, card: 'TAIL sprint', unit: `U1 #${ticket}`, lane: 'lanes-01/lane-2',
  base: '-', state, ticket, judged: null, ...extra,
});

test('unitStatus: a card with a PR says the PR\'s state and what it waits for', () => {
  const noGo = { ...openPr, verdictOnHead: { go: false, round: 2 }, verdictRounds: 2 };
  const cases = [
    ['NO-GO with live fix', { ticket, pr: noGo }, card, [row('fix', 'launched 12:00Z')], 'PR #1854 NO-GO R2 — fix on lanes-01/lane-2'],
    ['NO-GO with judged fix and hold', { ticket, pr: noGo }, card, [
      row('fix', 'launched 11:00Z', { judged: 'ok' }),
      row('fix', 'held: fix of head 18faeb27 was already dispatched'),
    ], 'PR #1854 NO-GO R2 — fix of head 18faeb27 was already dispatched'],
    ['NO-GO waiting', { ticket, pr: noGo }, card, [], 'PR #1854 NO-GO R2 — waiting for a fixer'],
    ['NO-GO fallback round', { ticket, pr: { ...noGo, verdictOnHead: { go: false }, verdictRounds: 3 } }, card, [], 'PR #1854 NO-GO R3 — waiting for a fixer'],
    ['red checks', { ticket, pr: { ...openPr, ci: { color: 'red', failedNames: ['lint', 'test'] } } }, card, [], 'PR #1854 red checks (lint, test) — waiting for a fixer'],
    ['conflict', { ticket, pr: { ...openPr, ci: { color: 'yellow' }, mergeable: 'CONFLICTING' } }, card, [], 'PR #1854 conflicts with main — waiting for a fixer'],
    ['green GO', { ticket, pr: { ...openPr, verdictOnHead: { go: true, round: 1 } } }, card, [], 'PR #1854 green + GO — waiting for the merge sweep'],
    ['green GO merge word', { ticket, pr: { ...openPr, verdictOnHead: { go: true, round: 1 } } }, card, [
      { kind: 'merge', card: 'TAIL sprint', unit: 'PR #1854', lane: '-', base: '18faeb27', state: 'hold-merge — the owner merges by hand' },
    ], 'PR #1854 green + GO — hold-merge — the owner merges by hand'],
    ['green GO draft uses the merge decision', { ticket, pr: { ...openPr, draft: true, verdictOnHead: { go: true, round: 1 } } }, card, [
      { kind: 'merge', card: 'TAIL sprint', unit: 'PR #1854', lane: '-', base: '18faeb27', state: 'draft — waiting for the author' },
    ], 'PR #1854 green + GO — draft — waiting for the author'],
    ['green GO other head', { ticket, pr: { ...openPr, verdictOnHead: { go: true, round: 1 } } }, card, [
      { kind: 'merge', card: 'TAIL sprint', unit: 'PR #1854', lane: '-', base: 'ffffffff', state: 'merging at ffffffff' },
    ], 'PR #1854 green + GO — waiting for the merge sweep'],
    ['GO checks not green', { ticket, pr: { ...openPr, ci: { color: 'yellow' }, verdictOnHead: { go: true, round: 1 } } }, card, [], 'PR #1854 GO, checks not green — waiting for green checks'],
    ['draft', { ticket, pr: { ...openPr, draft: true } }, card, [], 'PR #1854 draft — waiting for the author'],
    ['review badge with lane', { ticket, pr: openPr }, { ...card, review: { running: true, round: 2, by: 'mac/lane-7' } }, [], 'PR #1854 open — review R2 on mac/lane-7'],
    ['review badge without lane', { ticket, pr: openPr }, { ...card, review: { running: true, round: 2, by: '' } }, [], 'PR #1854 open — review R2'],
    ['live review', { ticket, pr: openPr }, card, [row('review R3', 'launched 12:00Z')], 'PR #1854 open — review R3 on lanes-01/lane-2'],
    ['would review', { ticket, pr: openPr }, card, [row('review R1', 'would dispatch')], 'PR #1854 open — review R1 would dispatch to lanes-01/lane-2 (auto-dispatch is off)'],
    ['waiting review', { ticket, pr: openPr }, card, [], 'PR #1854 open — waiting for a review'],
    ['local check', { ticket, pr: openPr, lane: { host: 'mac', lane: 'lane-6', busy: true, check: true } }, card, [], 'PR #1854 open — local check on mac/lane-6'],
    ['busy lane', { ticket, pr: openPr, lane: { host: 'mac', lane: 'lane-6', busy: true, check: false } }, card, [], 'PR #1854 open — busy on mac/lane-6'],
    ['accepted open PR', { ticket, accepted: true, pr: openPr }, card, [], 'ticket closed — PR #1854 is still open: close it by hand'],
    ['merged with blocker', { ticket, merged: { number: 1854 } }, card, [], 'merged in PR #1854 — sprint waits for finding #1885 open', { blocker: 'finding #1885 open' }],
    ['merged while close runs', { ticket, merged: { number: 1854 } }, card, [], 'merged in PR #1854 — sprint closing', {}],
  ];
  for (const [name, unit, current, rows, expected, options = {}] of cases) {
    assert.equal(unitStatus(unit, current, { rows, ...options }), expected, name);
  }
});

test('unitStatus: a card without a PR says why it is queued, and the owner and sprint gates win', () => {
  const queued = { stage: 'ticketed', stageHistory: [{ stage: 'ticketed', enteredAt: '2026-09-02T10:00:00Z' }], links: { pr: '' } };
  const cases = [
    ['stuck reason', { ticket }, { ...queued, stage: 'stuck', stageHistory: [{ stage: 'stuck', reason: 'QUESTION #1850 choose' }] }, [], {}, 'waiting for the owner — QUESTION #1850 choose'],
    ['stuck no reason', { ticket }, { ...queued, stage: 'stuck', stageHistory: [{ stage: 'stuck' }] }, [], {}, 'waiting for the owner — no reason recorded'],
    ['done sprint', { ticket }, queued, [], { sprintStage: 'done' }, 'sprint is done — no scheduler serves this ticket'],
    ['accepted', { ticket, accepted: true }, queued, [], {}, ''],
    ['live develop', { ticket }, queued, [row('develop', 'launched 12:00Z', { lane: 'mac/lane-6' })], {}, 'building on mac/lane-6'],
    ['live QA', { ticket, qaRun: true }, queued, [row('develop', 'launched 12:00Z', { lane: 'mac/lane-6' })], {}, 'QA run on mac/lane-6'],
    ['busy lane', { ticket, lane: { host: 'mac', lane: 'lane-6', busy: true } }, queued, [], {}, 'building on mac/lane-6'],
    ['remembered PR', { ticket }, { ...queued, stage: 'development', links: { pr: 'https://github.com/acme/web/pull/1899' } }, [], {}, 'PR closed without a merge — close the ticket or reopen the PR'],
    ['closed ticket', { ticket, open: false }, queued, [], {}, 'ticket closed without a merge — nothing to do'],
    ['parked lane', { ticket, lane: { host: 'mac', lane: 'lane-6', busy: false } }, queued, [], {}, 'lane mac/lane-6 is parked on its branch — the planner will not start it: free the lane or open the PR'],
    ['development no proof', { ticket }, { ...queued, stage: 'development' }, [], {}, 'no lane and no PR — the board is not running this card'],
    ['planner hold', { ticket }, queued, [row('develop', 'held: waits for #1850 (pr green)')], {}, 'queued — waits for #1850 (pr green)'],
    ['judged history and hold', { ticket }, queued, [row('develop', 'launched 11:00Z', { judged: 'no-proof' }), row('develop', 'held: waits for #1850 (pr green)')], {}, 'queued — waits for #1850 (pr green)'],
    ['would develop', { ticket }, queued, [row('develop', 'would dispatch', { lane: 'mac/lane-7' })], {}, 'queued — would dispatch to mac/lane-7 (auto-dispatch is off)'],
    ['queued off', { ticket }, queued, [], {}, 'queued — auto-dispatch is off'],
    ['queued on', { ticket }, queued, [], { dispatchOn: true }, 'queued — no lane has taken it yet'],
    ['open dependency is not a hold', { ticket, deps: [{ ticket: 1849, state: 'pr green', met: false }] }, queued, [row('develop', 'would dispatch', { lane: 'mac/lane-7' })], {}, 'queued — would dispatch to mac/lane-7 (auto-dispatch is off)'],
    ['trimmed hold', { ticket }, queued, [row('develop', 'held: waits for #1850 (pr green)   ')], {}, 'queued — waits for #1850 (pr green)'],
  ];
  for (const [name, unit, current, rows, options, expected] of cases) {
    assert.equal(unitStatus(unit, current, { rows, ...options }), expected, name);
  }
});
