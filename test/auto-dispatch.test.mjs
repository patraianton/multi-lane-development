// Auto-dispatch (decision 16): the planner pairs startable units with free
// launchable lanes, the base is the dependency's open-PR head, the task file
// is ticket + committed role rules + base, and launch plans are pure commands.
// Pure fixtures; no ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  planDispatch, planDispatchFull, planReviews, planFixes, sortDispatchQueue,
  baseFor, baseLine, recordDispatch, dispatchRows, laneLauncher,
  taskText, specDirFor, launchPlan, runLaunch, commentLine, dispatchKey, taskFileName,
  launchFailureHoldLine, quarantinedLanes, RETRY_MS, LAUNCHING_HOLD_MS,
} from '../bin/auto-dispatch.mjs';
import { judgeLanes } from '../bin/lane-judge.mjs';

const FLEET = {
  prompt: 'Прочитай {taskFile} и выполни целиком',
  hosts: {
    'lanes-01': { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' },
    mac: { kitchen: '~/kitchens/autopase.lv', shell: 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH;', launch: 'maclane {n} "{prompt}"', browser: true },
  },
  lanes: {
    'lane-1': { host: 'lanes-01', n: 1 }, 'lane-2': { host: 'lanes-01', n: 2 }, 'lane-3': { host: 'lanes-01', n: 3, noBuilds: true },
    'lane-6': { host: 'mac', n: 6 }, 'lane-7': { host: 'mac', n: 7 }, 'lane-8': { host: 'mac', n: 8 },
  },
};
const RULES = {
  sha: '508cb21',
  text: '<!-- role: common -->\n## common — everyone\n5. Never write `Closes #`, `Fixes #` or `Resolves #` anywhere.\n\n<!-- role: lane -->\n## lane — writes one ticket\n1. Work on the ticket.\n',
};
const HOSTS = {
  'lanes-01': { target: 'root@203.0.113.10', key: 'id_ed25519', kind: 'hzlane' },
  mac: { target: 'mac', kind: 'mac', kitchen: '~/kitchens/autopase.lv', connectTimeoutSec: 30 },
};

const cards = [
  { id: 'cs', title: 'FINANCE-CARDS', stage: 'development', links: { ticket: 'https://github.com/acme/web/issues/1569' } },
  { id: 'u1', title: 'U1 #1575', stage: 'ci_pr', parent: 'cs', ticket: 1575 },
  { id: 'cd', title: 'a done sprint', stage: 'done', links: { ticket: 'https://github.com/acme/web/issues/1515' } },
];

function sprint(over = {}) {
  return {
    umbrella: 1569,
    free: ['mac/lane-6', 'mac/lane-7', 'lanes-01/lane-3'],
    stale: [],
    units: [
      { unit: 'U1', ticket: 1575, title: 'FIN-U1: last name', url: 'https://github.com/acme/web/issues/1575', branch: 'feat/fin-u1', state: 'pr green', deps: [], pr: { number: 1589, headSha: 'aefd5925e0000000000000000000000000000000' } },
      { unit: 'U3a', ticket: 1577, title: 'FIN-U3a', branch: 'feat/fin-u3a', state: 'pr open', deps: [], pr: { number: 1602, headSha: 'b34d212d00000000000000000000000000000000' } },
      { unit: 'U3b', ticket: 1583, title: 'FIN-U3b: card v2 tail', url: 'https://github.com/acme/web/issues/1583', branch: 'feat/fin-u3b', state: 'queued', deps: [{ ticket: 1577, unit: 'U3a', state: 'pr open', met: false }] },
      { unit: 'U6', ticket: 1580, title: 'FIN-U6', branch: 'feat/fin-u6', state: 'on lane', deps: [], lane: { host: 'lanes-01', lane: 'lane-2', busy: true } },
      { unit: 'U7', ticket: 1581, title: 'FIN-U7: browser sweep', branch: 'feat/fin-u7', state: 'queued', deps: [{ ticket: 1575, unit: 'U1', state: 'pr green', met: false }, { ticket: 1580, unit: 'U6', state: 'on lane', met: false }] },
      { unit: 'U9', ticket: 1584, title: 'FIN-U9', branch: '', state: 'blocked', deps: [] },
    ],
    qaTickets: [{ unit: 'QA', ticket: 1599, title: 'DealCard ownership hole', qa: true, open: true, state: 'open', branch: 'feat/fin-1599', deps: [] }],
    ...over,
  };
}

test('the base is the head of the dependency\'s open PR, or main when nothing is open', () => {
  const s = sprint();
  const u3b = s.units.find(u => u.unit === 'U3b');
  assert.deepEqual(baseFor(u3b, s), { ref: 'feat/fin-u3a', sha: 'b34d212d00000000000000000000000000000000', pr: 1602, ticket: 1577, unit: 'U3a' });
  assert.equal(baseLine(baseFor(u3b, s)), 'feat/fin-u3a@b34d212d (PR #1602 of U3a)');
  assert.deepEqual(baseFor({ deps: [{ met: true }] }, s), { ref: 'main', sha: null, pr: null, ticket: null, unit: null });
  assert.equal(baseLine(baseFor({ deps: [] }, s)), 'main');
  assert.match(baseFor({ deps: [{ ticket: 1575, unit: 'U1', state: 'pr green', met: false }, { ticket: 1577, unit: 'U3a', state: 'pr open', met: false }] }, s).error,
    /two dependencies on open PRs/);
});

test('the planner pairs startable units with free launchable lanes, one unit per lane, in lane order', () => {
  const pairs = planDispatch(cards, new Map([['cs', sprint()], ['cd', sprint()]]), { fleet: FLEET, at: '2026-08-29T12:00:00.000Z' });
  assert.deepEqual(pairs.map(p => [p.unit.unit, p.unit.ticket, p.lane, baseLine(p.base)]), [
    ['U3b', 1583, 'mac/lane-6', 'feat/fin-u3a@b34d212d (PR #1602 of U3a)'],
    ['QA', 1599, 'mac/lane-7', 'main'],
  ], 'U7 waits for U6 on a lane, U9 is blocked, and non-active cards are skipped');
  assert.equal(pairs[0].card.id, 'cs');
  assert.equal(pairs[0].umbrella, 1569);
  assert.equal(pairs[0].host, 'mac');
  assert.equal(pairs[0].laneName, 'lane-6');
  assert.equal(pairs[0].n, 6);
  assert.equal(pairs[0].unit.branch, 'feat/fin-u3b');
  assert.deepEqual(pairs[0].unit.labels, []);
});

test('ticketed and merged sprints dispatch, and a missing branch defaults to feat/<ticket>', () => {
  const one = sprint({
    free: ['mac/lane-6'],
    units: [{ unit: 'U9', ticket: 1584, title: 'FIN-U9', branch: '', state: 'queued', deps: [] }],
    qaTickets: [],
  });
  for (const stage of ['ticketed', 'merged']) {
    const card = { ...cards[0], stage };
    const [pair] = planDispatch([card], new Map([['cs', one]]), { fleet: FLEET });
    assert.equal(pair.unit.branch, 'feat/1584');
    assert.deepEqual([pair.kind, pair.round, pair.head, pair.role], ['develop', 1, null, 'lane']);
  }
});

test('a NO-GO fix carries the verdict verbatim and prefers another host', () => {
  const head = 'abc12345def0000000000000000000000000000000';
  const body = `R1 — NO-GO\nhead ${head}\n\nKeep this paragraph exactly.\n`;
  const one = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'],
    units: [{
      unit: 'U2', ticket: 2002, title: 'FIN-U2', branch: 'feat/fin-u2', state: 'pr no-go', deps: [],
      pr: {
        number: 2102, headSha: head, ci: { color: 'green' }, mergeable: 'MERGEABLE', verdictRounds: 1,
        verdictOnHead: { round: 1, go: false, head, body },
      },
    }],
    qaTickets: [],
  });
  const ledger = { dispatched: {
    '2002:review:1': {
      ticket: 2002, kind: 'review', round: 1, head, host: 'lanes-01', lane: 'lanes-01/lane-2',
      result: 'launched', at: '2026-08-29T11:00:00.000Z',
    },
  } };
  const [pair] = planFixes({ cards, sprints: new Map([['cs', one]]), ledger, fleet: FLEET, at: '2026-08-29T12:00:00.000Z' });
  assert.deepEqual([pair.kind, pair.role, pair.round, pair.head, pair.lane], ['fix', 'fixer', 1, head, 'mac/lane-6']);
  assert.equal(dispatchKey(pair), '2002:fix:abc12345', 'the initial fix guard is the PR head');
  assert.equal(taskFileName(pair), 'TASK-2002-FIX-R1.md');
  assert.deepEqual(pair.sections, [{ title: 'VERDICT R1 — verbatim', body }]);
  const text = taskText({ pair, ticket: { number: 2002, title: 'FIN-U2', body: 'ticket body' }, rules: RULES });
  assert.match(text, new RegExp(`\\n# VERDICT R1 — verbatim\\n\\n${body.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
});

test('a no-proof fix retries under the next round key and keeps the verdict section round', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const head = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1';
  const body = `R1 — NO-GO\nhead ${head}\n\nPlease correct it.`;
  const one = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'],
    units: [{
      unit: 'U8', ticket: 2008, title: 'FIN-U8', branch: 'feat/fin-u8', state: 'pr no-go', deps: [],
      pr: {
        number: 2108, headSha: head, ci: { color: 'green' }, mergeable: 'MERGEABLE',
        verdictOnHead: { round: 1, go: false, head, body },
      },
    }],
    qaTickets: [],
  });
  const source = new Map([['cs', one]]);
  const [initial] = planFixes({ cards, sprints: source, fleet: FLEET, at });
  const initialKey = dispatchKey(initial);
  assert.equal(initialKey, '2008:fix:f1f1f1f1');
  const launched = recordDispatch({ dispatched: {} }, initial, { result: 'launched' }, at);
  launched.dispatched[initialKey] = { ...launched.dispatched[initialKey], judged: 'no-proof' };

  const [retry] = planFixes({
    cards, sprints: source, ledger: launched, fleet: FLEET, at: '2026-08-29T12:01:00.000Z',
  });
  assert.deepEqual(
    [retry.round, retry.retryOf, retry.sections[0].title, dispatchKey(retry)],
    [2, initialKey, 'VERDICT R1 — verbatim', '2008:fix:2'],
  );
  const heldRetry = recordDispatch(launched, retry, { result: 'held', error: 'launcher busy' }, '2026-08-29T12:01:00.000Z');
  const [heldAgain] = planFixes({
    cards, sprints: source, ledger: heldRetry, fleet: FLEET, at: '2026-08-29T12:01:30.000Z',
  });
  assert.deepEqual(
    [heldAgain.round, heldAgain.retryOf, dispatchKey(heldAgain)],
    [2, initialKey, '2008:fix:2'],
    'a held no-proof retry is re-evaluated under the same journal key',
  );
  const retried = recordDispatch(launched, retry, { result: 'launched' }, '2026-08-29T12:01:00.000Z');
  assert.deepEqual(Object.keys(retried.dispatched), ['2008:fix:f1f1f1f1', '2008:fix:2']);

  const triggerGone = new Map([['cs', sprint({
    ...one,
    units: [{
      ...one.units[0],
      state: 'pr green',
      pr: { ...one.units[0].pr, verdictOnHead: null, ci: { color: 'green' }, mergeable: 'MERGEABLE' },
    }],
  })]]);
  const [stillOwed] = planFixes({
    cards, sprints: triggerGone, ledger: launched, fleet: FLEET, at: '2026-08-29T12:01:00.000Z',
  });
  assert.deepEqual(
    [stillOwed.round, stillOwed.retryOf, stillOwed.sections],
    [2, initialKey, initial.sections],
    'a no-proof fix retry survives transient disappearance of its original trigger',
  );

  const failed = recordDispatch(launched, retry, {
    result: 'failed', launchFailure: true, error: 'launch failed (exit 255): ssh timed out',
  }, '2026-08-29T12:01:00.000Z');
  const retryCapacitySource = new Map([['cs', sprint({
    ...one,
    free: [],
    laneTable: [
      { host: 'lanes-01', lane: 'lane-1', hostOk: true, busy: false, fleet: true },
      { host: 'mac', lane: 'lane-6', hostOk: true, busy: false, fleet: true },
    ],
  })]]);
  const [retryAfterFailure] = planFixes({
    cards, sprints: retryCapacitySource, ledger: failed, fleet: FLEET, at: '2026-08-29T12:01:30.000Z',
  });
  assert.deepEqual(
    [retryAfterFailure.round, retryAfterFailure.retryOf, retryAfterFailure.lane, dispatchKey(retryAfterFailure)],
    [3, '2008:fix:2', 'lanes-01/lane-1', '2008:fix:3'],
    'a failed launch of retry R2 is immediately owed as R3 on another host, including no-proof lane-table capacity',
  );
  const retained = recordDispatch(launched, retry, {
    result: 'failed', launchFailure: true, error: 'launch failed (exit 255): ssh timed out',
  }, '2026-09-30T12:00:00.000Z');
  assert.ok(retained.dispatched[initialKey], 'the initial fix head guard is not time-pruned while that head may remain open');
  const other = {
    ...initial,
    unit: { ...initial.unit, ticket: 2999, unit: 'OTHER', branch: 'feat/2999' },
    kind: 'develop', round: 1, head: null,
  };
  const afterAging = recordDispatch(retried, other, { result: 'launched' }, '2026-09-30T12:00:00.000Z');
  assert.equal(afterAging.dispatched['2008:fix:2'].result, 'launched', 'a successful numeric fix retry is durable with its head guard');
  assert.equal(
    planFixes({ cards, sprints: source, ledger: afterAging, fleet: FLEET, at: '2026-09-30T12:01:00.000Z' }).length,
    0,
    'aging the journal cannot resurrect a successful fix retry',
  );
});

test('a no-proof fix on an old head does not turn the new head into a retry', () => {
  const oldHead = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
  const one = sprint({
    free: ['mac/lane-6'],
    units: [{
      unit: 'U9', ticket: 2009, title: 'FIN-U9', branch: 'feat/fin-u9', state: 'pr no-go', deps: [],
      pr: {
        number: 2109, headSha: head, ci: { color: 'green' }, mergeable: 'MERGEABLE',
        verdictOnHead: { round: 2, go: false, head, body: `R2 — NO-GO\nhead ${head}` },
      },
    }],
    qaTickets: [],
  });
  const ledger = { dispatched: {
    '2009:fix:a1a1a1a1': {
      ticket: 2009, kind: 'fix', round: 1, head: oldHead, host: 'lanes-01', lane: 'lanes-01/lane-1',
      result: 'launched', judged: 'no-proof', at: '2026-08-29T12:00:00.000Z',
    },
  } };
  const [pair] = planFixes({
    cards, sprints: new Map([['cs', one]]), ledger, fleet: FLEET, at: '2026-08-29T12:01:00.000Z',
  });
  assert.equal(pair.retryOf, undefined);
  assert.deepEqual([pair.round, pair.sections[0].title, dispatchKey(pair)], [2, 'VERDICT R2 — verbatim', '2009:fix:b2b2b2b2']);
});

test('a red check on the current head makes a CI fix section with failed names', () => {
  const head = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const one = sprint({
    free: ['mac/lane-6'],
    units: [{
      unit: 'U4', ticket: 2004, title: 'FIN-U4', branch: 'feat/fin-u4', state: 'pr red', deps: [],
      pr: { number: 2104, headSha: head, verdictOnHead: null, ci: { color: 'red', failedNames: ['lint', 'node 22'] }, mergeable: 'MERGEABLE' },
    }],
    qaTickets: [],
  });
  const [pair] = planFixes({ cards, sprints: new Map([['cs', one]]), fleet: FLEET });
  assert.deepEqual([pair.kind, pair.round, pair.sections[0].body], ['fix', 1, '']);
  assert.equal(pair.sections[0].title, `CI — red checks on ${head}: lint, node 22`);
});

test('a conflicting PR makes a CONFLICT fix section', () => {
  const head = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
  const one = sprint({
    free: ['mac/lane-6'],
    units: [{
      unit: 'U5', ticket: 2005, title: 'FIN-U5', branch: 'feat/fin-u5', state: 'pr open', deps: [],
      pr: { number: 2105, headSha: head, verdictOnHead: null, ci: { color: 'green' }, mergeable: 'CONFLICTING' },
    }],
    qaTickets: [],
  });
  const [pair] = planFixes({ cards, sprints: new Map([['cs', one]]), fleet: FLEET });
  assert.deepEqual(pair.sections, [{ title: 'CONFLICT — merge origin/main into feat/fin-u5', body: '' }]);
  assert.deepEqual([pair.kind, pair.role, pair.head], ['fix', 'fixer', head]);
});

test('the dispatch queue sorts review, then fix, then develop', () => {
  const queue = sortDispatchQueue([
    { kind: 'develop', unit: { ticket: 3 } },
    { kind: 'fix', unit: { ticket: 2 } },
    { kind: 'review', unit: { ticket: 1 } },
  ]);
  assert.deepEqual(queue.map(pair => [pair.kind, pair.unit.ticket]), [
    ['review', 1], ['fix', 2], ['develop', 3],
  ]);
});

test('scarce lanes are assigned in review, fix, develop priority before pairing', () => {
  const reviewHead = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
  const fixHead = 'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2';
  const reviewUnit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, headSha: reviewHead, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const fixUnit = {
    ...sprint().units[1],
    pr: {
      ...sprint().units[1].pr, headSha: fixHead, draft: false, ci: { color: 'green' }, mergeable: 'MERGEABLE',
      verdictOnHead: { round: 1, go: false, head: fixHead, body: `R1 — NO-GO\nhead ${fixHead}` }, verdictRounds: 1,
    },
  };
  const developUnit = sprint().units.find(unit => unit.ticket === 1583);
  const source = new Map([['cs', sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6', 'mac/lane-7'],
    units: [reviewUnit, fixUnit, developUnit], qaTickets: [],
  })]]);
  const reviews = planReviews({ cards, sprints: source, fleet: FLEET });
  const rest = planDispatchFull(cards, source, { fleet: FLEET, takenLanes: reviews.map(pair => pair.lane) }).pairs;
  const queue = sortDispatchQueue([...reviews, ...rest]);
  assert.deepEqual(queue.map(pair => pair.kind), ['review', 'fix', 'develop']);
  assert.deepEqual(queue.map(pair => pair.lane), ['lanes-01/lane-1', 'mac/lane-6', 'mac/lane-7']);
});

test('a NO-GO fix on H1 leads to review R2 on changed head H2', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const h1 = 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3';
  const h2 = 'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4';
  const body = `R1 — NO-GO\nhead ${h1}\n\nPreserve this exact review comment.`;
  const unit = {
    unit: 'U10', ticket: 2010, title: 'FIN-U10', branch: 'feat/fin-u10', state: 'pr no-go', deps: [],
    pr: {
      number: 2110, headSha: h1, draft: false, ci: { color: 'green' }, mergeable: 'MERGEABLE', verdictRounds: 1,
      verdictOnHead: { round: 1, go: false, head: h1, body },
    },
  };
  const firstSprint = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'], units: [unit], qaTickets: [],
  });
  const [fix] = planFixes({ cards, sprints: new Map([['cs', firstSprint]]), fleet: FLEET, at });
  assert.equal(dispatchKey(fix), '2010:fix:a3a3a3a3');
  assert.equal(taskFileName(fix), 'TASK-2010-FIX-R1.md');
  const fixText = taskText({ pair: fix, ticket: { number: 2010, title: 'FIN-U10', body: 'ticket body' }, rules: RULES });
  assert.match(fixText, /# VERDICT R1 — verbatim\n\nR1 — NO-GO[\s\S]*Preserve this exact review comment\./);
  const changed = {
    ...unit,
    state: 'pr green',
    pr: { ...unit.pr, branch: unit.branch, headSha: h2, verdictOnHead: null, verdictRounds: 1 },
  };
  const launched = recordDispatch({ dispatched: {} }, fix, { result: 'launched' }, at);
  const firstFree = judgeLanes({
    journal: launched,
    lanes: { at: '2026-08-29T12:00:30.000Z', items: [{ host: fix.host, lane: fix.laneName, busy: false }] },
    prs: { at: '2026-08-29T12:00:30.000Z', items: [changed.pr] },
    tickets: { at: '2026-08-29T12:00:30.000Z', items: [{ number: unit.ticket, state: 'OPEN' }] },
    now: '2026-08-29T12:01:00.000Z',
  });
  assert.equal(firstFree.journal.dispatched[dispatchKey(fix)].judged, null, 'free is observed before absence or proof is judged');
  const judged = judgeLanes({
    journal: firstFree.journal,
    lanes: { at: '2026-08-29T12:01:30.000Z', items: [{ host: fix.host, lane: fix.laneName, busy: false }] },
    prs: { at: '2026-08-29T12:01:30.000Z', items: [changed.pr] },
    tickets: { at: '2026-08-29T12:01:30.000Z', items: [{ number: unit.ticket, state: 'OPEN' }] },
    now: '2026-08-29T12:02:00.000Z',
  });
  assert.equal(judged.journal.dispatched[dispatchKey(fix)].judged, 'ok', 'the changed head is the fix proof');
  assert.deepEqual(judged.failures, []);

  const nextSprint = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'], units: [changed], qaTickets: [],
  });
  const [review] = planReviews({
    cards, sprints: new Map([['cs', nextSprint]]), ledger: judged.journal, fleet: FLEET, at: '2026-08-29T12:02:00.000Z',
  });
  assert.deepEqual(
    [review.round, review.head, dispatchKey(review), review.lane !== fix.lane],
    [2, h2, '2010:review:b4b4b4b4', true],
  );
});

test('a fix waits while a review of the same head is running; a NO-GO releases it at once', () => {
  const at = '2026-08-31T06:00:00.000Z';
  const head = 'f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5f5';
  const unit = {
    unit: 'U11', ticket: 2011, title: 'FIN-U11', branch: 'feat/fin-u11', state: 'pr red', deps: [],
    pr: {
      number: 2111, headSha: head, draft: false, verdictOnHead: null, verdictRounds: 0,
      ci: { color: 'red', failedNames: ['lint'] }, mergeable: 'MERGEABLE',
    },
  };
  const s = sprint({ free: ['lanes-01/lane-1', 'mac/lane-6'], units: [unit], qaTickets: [] });
  const liveReview = { dispatched: {
    '2011:review:f5f5f5f5': {
      ticket: 2011, kind: 'review', round: 1, head, host: 'lanes-01', lane: 'lanes-01/lane-2',
      result: 'launched', at: '2026-08-31T05:58:00.000Z',
    },
  } };

  // (а) red check + live unjudged review of the same head → the fix is held.
  const holds = [];
  const heldPairs = planFixes({
    cards, sprints: new Map([['cs', s]]), ledger: liveReview, fleet: FLEET, at, holds,
  });
  assert.equal(heldPairs.length, 0);
  assert.ok(holds.some(h => h.ticket === 2011 && /review of head f5f5f5f5 is running/.test(h.reason)));

  // (б) a NO-GO verdict on the same head means the review is over — the fix goes.
  const noGo = {
    ...unit,
    pr: { ...unit.pr, verdictOnHead: { round: 1, go: false, head, body: `R1 — NO-GO\nhead ${head}` }, verdictRounds: 1 },
  };
  const goSprint = sprint({ free: ['lanes-01/lane-1', 'mac/lane-6'], units: [noGo], qaTickets: [] });
  const [fix] = planFixes({
    cards, sprints: new Map([['cs', goSprint]]), ledger: liveReview, fleet: FLEET, at,
  });
  assert.equal(dispatchKey(fix), '2011:fix:f5f5f5f5');

  // (г) a judged review entry does not block the fix.
  const judgedReview = { dispatched: {
    '2011:review:f5f5f5f5': {
      ...liveReview.dispatched['2011:review:f5f5f5f5'],
      judged: 'ok', judgedAt: '2026-08-31T05:59:00.000Z',
    },
  } };
  const afterJudged = planFixes({
    cards, sprints: new Map([['cs', s]]), ledger: judgedReview, fleet: FLEET, at,
  });
  assert.equal(afterJudged.length, 1, 'a judged review releases the fix');
});

test('a review is not planned while a fix of the same head is running', () => {
  const at = '2026-08-31T06:00:00.000Z';
  const h1 = 'e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7';
  const h2 = 'e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8';
  const unit = {
    unit: 'U12', ticket: 2012, title: 'FIN-U12', branch: 'feat/fin-u12', state: 'pr open', deps: [],
    pr: { number: 2112, headSha: h1, draft: false, verdictOnHead: null, verdictRounds: 0, ci: { color: 'green' } },
  };
  const s = sprint({ free: ['lanes-01/lane-1', 'mac/lane-6'], units: [unit], qaTickets: [] });
  const liveFix = { dispatched: {
    '2012:fix:e7e7e7e7': {
      ticket: 2012, kind: 'fix', round: 1, head: h1, host: 'lanes-01', lane: 'lanes-01/lane-2',
      result: 'launched', at: '2026-08-31T05:58:00.000Z',
    },
  } };
  const held = planReviews({ cards, sprints: new Map([['cs', s]]), ledger: liveFix, fleet: FLEET, at });
  assert.equal(held.length, 0, 'the head is about to move — no review on it');

  // The fixer pushed h2: its entry keeps h1, so the new head reviews freely.
  const moved = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'],
    units: [{ ...unit, pr: { ...unit.pr, headSha: h2 } }],
    qaTickets: [],
  });
  const [review] = planReviews({ cards, sprints: new Map([['cs', moved]]), ledger: liveFix, fleet: FLEET, at });
  assert.equal(dispatchKey(review), '2012:review:e8e8e8e8');
});

test('a launcher refusal rests the lane; work is spread to the least-recently-launched lane', () => {
  const at = '2026-08-31T06:00:00.000Z';
  const head = 'c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9';
  const unit = {
    unit: 'U13', ticket: 2013, title: 'FIN-U13', branch: 'feat/fin-u13', state: 'pr open', deps: [],
    pr: { number: 2113, headSha: head, draft: false, verdictOnHead: null, verdictRounds: 0, ci: { color: 'green' } },
  };
  const s = sprint({ free: ['lanes-01/lane-1', 'mac/lane-6', 'mac/lane-7'], units: [unit], qaTickets: [] });

  // The launcher said "reserved" (exit 3) three minutes ago: the lane rests
  // for LANE_HOLD_MS instead of eating an scp+ssh every sweep.
  const refused = { dispatched: {
    '2099:develop:1': {
      ticket: 2099, kind: 'develop', round: 1, host: 'lanes-01', lane: 'lanes-01/lane-1',
      result: 'held', heldCode: 3, error: 'launcher refused: lane-1 забронирована под VX-SMOKE', at: '2026-08-31T05:57:00.000Z',
    },
  } };
  const [pair] = planReviews({ cards, sprints: new Map([['cs', s]]), ledger: refused, fleet: FLEET, at });
  assert.notEqual(pair.lane, 'lanes-01/lane-1', 'the refused lane rests');

  // Eleven minutes later the hold has expired and lane-1 serves again —
  // unless another lane has been idle longer: work goes to the
  // least-recently-launched lane first.
  const later = '2026-08-31T06:09:00.000Z';
  const [spread] = planReviews({ cards, sprints: new Map([['cs', s]]), ledger: refused, fleet: FLEET, at: later });
  assert.equal(spread.lane, 'mac/lane-6', 'a lane never launched on outranks a recently-touched one');
});

test('three fast no-proof deaths on one lane within an hour quarantine it; takeovers do not count', () => {
  const death = (key, lane, minute) => [key, {
    ticket: 2000 + minute, kind: 'develop', round: 1, host: lane.split('/')[0], lane,
    result: 'launched', judged: 'no-proof', judgeReason: 'no open or merged PR after ' + lane + ' freed',
    at: `2026-08-31T05:${String(minute).padStart(2, '0')}:00.000Z`,
    judgedAt: `2026-08-31T05:${String(minute + 4).padStart(2, '0')}:00.000Z`,
  }];
  const ledger = { dispatched: Object.fromEntries([
    death('2001:develop:1', 'mac/lane-6', 1),
    death('2002:develop:1', 'mac/lane-6', 10),
    death('2003:develop:1', 'mac/lane-6', 20),
    death('2004:develop:1', 'mac/lane-7', 30),
  ]) };
  const at = '2026-08-31T05:40:00.000Z';
  assert.deepEqual(quarantinedLanes(ledger, at), [{ lane: 'mac/lane-6', deaths: 3 }]);

  // The planner refuses the quarantined lane and serves the healthy one.
  const head = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
  const unit = {
    unit: 'U14', ticket: 2014, title: 'FIN-U14', branch: 'feat/fin-u14', state: 'pr open', deps: [],
    pr: { number: 2114, headSha: head, draft: false, verdictOnHead: null, verdictRounds: 0, ci: { color: 'green' } },
  };
  const s = sprint({ free: ['mac/lane-6', 'mac/lane-7'], units: [unit], qaTickets: [] });
  const [pair] = planReviews({ cards, sprints: new Map([['cs', s]]), ledger, fleet: FLEET, at });
  assert.equal(pair.lane, 'mac/lane-7');

  // A takeover is not the lane's fault.
  const taken = { dispatched: Object.fromEntries([
    death('2001:develop:1', 'mac/lane-6', 1),
    death('2002:develop:1', 'mac/lane-6', 10),
    death('2003:develop:1', 'mac/lane-6', 20),
  ].map(([key, entry]) => [key, { ...entry, judgeReason: 'no PR after mac/lane-6 was taken over by feat/vx' }])) };
  assert.deepEqual(quarantinedLanes(taken, at), []);
});

test('a light lane (no builds) is never chosen for a unit that needs a build', () => {
  const s = sprint({ free: ['lanes-01/lane-3'] });
  const { pairs, holds } = planDispatchFull(cards, new Map([['cs', s]]), { fleet: FLEET });
  assert.equal(pairs.length, 0);
  assert.ok(holds.some(h => h.ticket === 1583 && /only light lanes/.test(h.reason)));
  const light = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, needsBuild: u => u.unit !== 'U3b' });
  assert.deepEqual(light.map(p => [p.unit.unit, p.lane]), [['U3b', 'lanes-01/lane-3']], 'a unit that needs no build may take it');
});

test('no launcher for a lane, a reserved lane, a stale source → nothing is sent', () => {
  assert.equal(planDispatch(cards, new Map([['cs', sprint({ free: ['hostinger/lane-4'] })]]), { fleet: FLEET }).length, 0, 'hostinger is not in this fleet config');
  const { holds } = planDispatchFull(cards, new Map([['cs', sprint({ free: ['hostinger/lane-4'] })]]), { fleet: FLEET });
  assert.ok(holds.some(h => h.lane === 'hostinger/lane-4' && /no launcher/.test(h.reason)));
  const reserved = { ...FLEET, lanes: { ...FLEET.lanes, 'lane-6': { host: 'mac', n: 6, reserved: true } } };
  assert.deepEqual(planDispatch(cards, new Map([['cs', sprint()]]), { fleet: reserved }).map(p => p.lane), ['mac/lane-7']);
  assert.equal(planDispatch(cards, new Map([['cs', sprint({ stale: ['lanes:mac'] })]]), { fleet: FLEET }).length, 0, 'unknown is not free');
  assert.equal(planDispatch(cards, new Map([['cs', sprint()]]), { fleet: null }).length, 0, 'no fleet config, no launch');
});

test('the journal uses develop round keys and review head keys; launched is final', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const s = sprint();
  const pairs = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, at });
  let ledger = recordDispatch({ dispatched: {} }, pairs[0], { result: 'launched', error: null }, at);
  assert.equal(dispatchKey(pairs[0]), '1583:develop:1');
  assert.equal(ledger.dispatched['1583:develop:1'].lane, 'mac/lane-6');
  assert.equal(ledger.dispatched['1583:develop:1'].host, 'mac');
  assert.equal(ledger.dispatched['1583:develop:1'].base, 'feat/fin-u3a@b34d212d (PR #1602 of U3a)');
  assert.deepEqual(
    [ledger.dispatched['1583:develop:1'].kind, ledger.dispatched['1583:develop:1'].round, ledger.dispatched['1583:develop:1'].head],
    ['develop', 1, null],
  );
  const delayedFailure = recordDispatch(ledger, pairs[0], { result: 'failed', error: 'late duplicate' }, '2026-08-29T12:00:01.000Z');
  assert.equal(delayedFailure.dispatched['1583:develop:1'].result, 'launched', 'a launched key is final');
  const reviewPair = { ...pairs[0], kind: 'review', round: 2, head: 'abcdef123456', role: 'reviewer' };
  const reviewed = recordDispatch({ dispatched: {} }, reviewPair, { result: 'launched' }, at);
  assert.deepEqual(Object.keys(reviewed.dispatched), ['1583:review:abcdef12']);
  assert.deepEqual(
    [reviewed.dispatched['1583:review:abcdef12'].kind, reviewed.dispatched['1583:review:abcdef12'].round, reviewed.dispatched['1583:review:abcdef12'].head, reviewed.dispatched['1583:review:abcdef12'].host],
    ['review', 2, 'abcdef123456', 'mac'],
  );
  // The probe still says lane-6 is free: the lane is held, U3b is not resent, QA takes lane-7.
  let again = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: '2026-08-29T12:01:00.000Z' });
  assert.deepEqual(again.map(p => [p.unit.unit, p.lane]), [['QA', 'mac/lane-7']]);
  // An hour later lane-6 is free again by the probe; U3b still never goes
  // twice — and untouched lane-7 outranks lane-6, which launched an hour ago.
  again = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: '2026-08-29T13:00:00.000Z' });
  assert.deepEqual(again.map(p => [p.unit.unit, p.lane]), [['QA', 'mac/lane-7']]);
  // Old entries are dropped.
  const pruned = recordDispatch(ledger, pairs[1], { result: 'launched' }, '2026-09-30T12:00:00.000Z');
  assert.deepEqual(Object.keys(pruned.dispatched), ['1599:develop:1']);
});

test('recording an outcome preserves fresh hand fields and clears stale judgment fields', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const [pair] = planDispatch(cards, new Map([['cs', sprint()]]), { fleet: FLEET, at });
  const key = dispatchKey(pair);
  const launching = recordDispatch({ dispatched: {} }, pair, { result: 'launching' }, at);
  const concurrentlyEdited = {
    dispatched: {
      ...launching.dispatched,
      [key]: {
        ...launching.dispatched[key],
        note: 'keep this hand note',
        judged: 'no-proof',
        judgedAt: '2026-08-29T12:00:00.500Z',
        judgeReason: 'stale judgment on the launch intent',
        error: 'stale error',
      },
    },
  };

  const launched = recordDispatch(concurrentlyEdited, pair, { result: 'launched' }, '2026-08-29T12:00:01.000Z');
  assert.equal(launched.dispatched[key].note, 'keep this hand note');
  assert.deepEqual({
    result: launched.dispatched[key].result,
    error: launched.dispatched[key].error,
    judged: launched.dispatched[key].judged,
    judgedAt: launched.dispatched[key].judgedAt,
    judgeReason: launched.dispatched[key].judgeReason,
  }, { result: 'launched', error: null, judged: null, judgedAt: null, judgeReason: null });
});

test('a failed launch retries on another host next sweep with a new round key and retryOf', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const one = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'],
    units: [sprint().units.find(unit => unit.ticket === 1583)],
    qaTickets: [],
  });
  const source = new Map([['cs', one]]);
  const [first] = planDispatch(cards, source, { fleet: FLEET, at });
  assert.equal(first.lane, 'lanes-01/lane-1');
  const failed = recordDispatch({ dispatched: {} }, first, {
    result: 'failed', launchFailure: true, error: 'launch failed (exit 255): ssh timed out',
  }, at);

  const [retry] = planDispatch(cards, source, {
    fleet: FLEET, ledger: failed, at: '2026-08-29T12:00:30.000Z',
  });
  assert.deepEqual(
    [retry.lane, retry.round, retry.retryOf, dispatchKey(retry)],
    ['mac/lane-6', 2, '1583:develop:1', '1583:develop:2'],
  );
  const held = recordDispatch(failed, retry, { result: 'held', error: 'launcher busy' }, '2026-08-29T12:00:30.000Z');
  const [heldAgain] = planDispatch(cards, source, {
    fleet: FLEET, ledger: held, at: '2026-08-29T12:01:00.000Z',
  });
  assert.deepEqual(
    [heldAgain.round, heldAgain.retryOf, dispatchKey(heldAgain)],
    [2, '1583:develop:1', '1583:develop:2'],
    'a held launch retry is re-evaluated under the same journal key',
  );
  const launching = recordDispatch(failed, retry, { result: 'launching' }, '2026-08-29T12:00:30.000Z');
  assert.equal(
    planDispatch(cards, source, { fleet: FLEET, ledger: launching, at: '2026-08-29T12:01:00.000Z' }).length,
    0,
    'a live retry intent still blocks the same key',
  );
  const staleAt = new Date(Date.parse('2026-08-29T12:00:30.000Z') + LAUNCHING_HOLD_MS + 1).toISOString();
  const [staleRetry] = planDispatch(cards, source, { fleet: FLEET, ledger: launching, at: staleAt });
  assert.deepEqual(
    [staleRetry.round, staleRetry.retryOf, dispatchKey(staleRetry)],
    [2, '1583:develop:1', '1583:develop:2'],
    'a stale retry intent recovers under the same journal key',
  );
  const launched = recordDispatch(failed, retry, { result: 'launched' }, '2026-08-29T12:00:30.000Z');
  assert.deepEqual(Object.keys(launched.dispatched), ['1583:develop:1', '1583:develop:2']);
  assert.equal(launched.dispatched['1583:develop:2'].retryOf, '1583:develop:1');
  assert.equal(
    planDispatch(cards, source, { fleet: FLEET, ledger: launched, at: '2026-08-29T12:01:00.000Z' }).length,
    0,
    'the successful retry is final for the unit even though the lane facts still look free',
  );
  const judged = { dispatched: {
    ...launched.dispatched,
    '1583:develop:2': { ...launched.dispatched['1583:develop:2'], judged: 'no-proof' },
  } };
  const [afterNoProof] = planDispatch(cards, source, {
    fleet: FLEET, ledger: judged, at: '2026-08-29T12:01:30.000Z',
  });
  assert.deepEqual(
    [afterNoProof.round, afterNoProof.host, dispatchKey(afterNoProof)],
    [3, 'mac', '1583:develop:3'],
    'a later successful launch resets the failure streak but not host A\'s ten-minute cooldown',
  );
});

test('a failed host is excluded until RETRY_MS and becomes eligible at the boundary', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const one = sprint({
    free: ['lanes-01/lane-1', 'lanes-01/lane-2'],
    units: [sprint().units.find(unit => unit.ticket === 1583)],
    qaTickets: [],
  });
  const source = new Map([['cs', one]]);
  const [first] = planDispatch(cards, source, { fleet: FLEET, at });
  const failed = recordDispatch({ dispatched: {} }, first, {
    result: 'failed', launchFailure: true, error: 'launch failed (exit 255): ssh timed out',
  }, at);
  const before = new Date(Date.parse(at) + RETRY_MS - 1).toISOString();
  assert.equal(
    planDispatch(cards, source, { fleet: FLEET, ledger: failed, at: before }).length,
    0,
    'the cooldown covers every lane on the failed host',
  );

  const boundary = new Date(Date.parse(at) + RETRY_MS).toISOString();
  const [retry] = planDispatch(cards, source, { fleet: FLEET, ledger: failed, at: boundary });
  assert.deepEqual(
    [retry.lane, retry.round, retry.retryOf, dispatchKey(retry)],
    // lane-2 outranks lane-1 at the boundary: work spreads to the
    // least-recently-launched lane first, and lane-1 failed ten minutes ago.
    ['lanes-01/lane-2', 2, '1583:develop:1', '1583:develop:2'],
  );

  const reviewHead = 'd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3';
  const reviewUnit = {
    ...one.units[0],
    state: 'pr open',
    pr: { number: 1700, headSha: reviewHead, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const reviewSource = new Map([['cs', sprint({
    free: ['lanes-01/lane-1', 'lanes-01/lane-2', 'mac/lane-6'],
    units: [reviewUnit], qaTickets: [],
  })]]);
  const [review] = planReviews({
    cards, sprints: reviewSource, fleet: FLEET, ledger: failed, at: '2026-08-29T12:00:30.000Z',
  });
  assert.equal(review.host, 'mac', 'the failed-host cooldown follows the unit across task kinds');
});

test('three consecutive launch failures hold every host for RETRY_MS and name the hosts tried', () => {
  const at = Date.parse('2026-08-29T12:00:00.000Z');
  const fleet = {
    ...FLEET,
    hosts: {
      ...FLEET.hosts,
      hostinger: { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' },
    },
    lanes: {
      ...FLEET.lanes,
      'lane-4': { host: 'hostinger', n: 4 },
    },
  };
  const one = sprint({
    free: ['lanes-01/lane-1', 'hostinger/lane-4', 'mac/lane-6'],
    units: [{
      ...sprint().units.find(unit => unit.ticket === 1583),
      unit: 'U1', ticket: 1680, branch: 'feat/1680', deps: [],
    }],
    qaTickets: [],
  });
  const source = new Map([['cs', one]]);
  const firstSource = new Map([['cs', { ...one, free: ['hostinger/lane-4'] }]]);
  let ledger = { dispatched: {} };
  const tried = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const attemptAt = new Date(at + attempt * 1000).toISOString();
    const [pair] = planDispatch(cards, attempt === 0 ? firstSource : source, { fleet, ledger, at: attemptAt });
    tried.push(pair.host);
    ledger = recordDispatch(ledger, pair, {
      result: 'failed', launchFailure: true, error: 'launch failed (exit 255): ssh timed out',
    }, attemptAt);
  }
  assert.deepEqual(tried, ['hostinger', 'lanes-01', 'mac']);

  const heldAt = new Date(at + 3000).toISOString();
  const held = planDispatchFull(cards, source, { fleet, ledger, at: heldAt });
  assert.equal(held.pairs.length, 0, 'there is no fourth launch inside the all-host hold');
  const hold = held.holds.find(item => item.ticket === 1680);
  assert.equal(hold.reason, 'launch failed on hostinger, lanes-01, mac; retry in 10m');
  assert.equal(
    launchFailureHoldLine(hold),
    'auto-dispatch: HELD U1 #1680 — launch failed on hostinger, lanes-01, mac; retry in 10m',
  );
  const reviewHead = 'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4';
  const reviewSource = new Map([['cs', { ...one, units: [{
    ...one.units[0], state: 'pr open',
    pr: { number: 1800, headSha: reviewHead, draft: false, verdictOnHead: null, verdictRounds: 0 },
  }] }]]);
  assert.equal(
    planReviews({ cards, sprints: reviewSource, fleet, ledger, at: heldAt }).length,
    0,
    'the all-host circuit follows the unit across task kinds and heads',
  );
  const before = new Date(at + 2000 + RETRY_MS - 1).toISOString();
  assert.equal(planDispatch(cards, source, { fleet, ledger, at: before }).length, 0);
  const boundary = new Date(at + 2000 + RETRY_MS).toISOString();
  const [fourth] = planDispatch(cards, source, { fleet, ledger, at: boundary });
  assert.deepEqual([fourth.round, fourth.retryOf, dispatchKey(fourth)], [4, '1680:develop:3', '1680:develop:4']);
});

test('a legacy plain-number journal key is develop round 1, and launching recovers after 15 minutes', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const one = sprint({
    free: ['mac/lane-6'],
    units: [sprint().units.find(u => u.ticket === 1583)],
    qaTickets: [],
  });
  const source = new Map([['cs', one]]);
  const legacy = { dispatched: { 1583: { ticket: 1583, lane: 'mac/lane-6', result: 'launched', at } } };
  assert.equal(planDispatch(cards, source, { fleet: FLEET, ledger: legacy, at: '2026-08-29T13:00:00.000Z' }).length, 0);

  const [pair] = planDispatch(cards, source, { fleet: FLEET, at });
  const launching = recordDispatch({ dispatched: {} }, pair, { result: 'launching' }, at);
  assert.equal(launching.dispatched['1583:develop:1'].result, 'launching');
  const young = new Date(Date.parse(at) + LAUNCHING_HOLD_MS - 1000).toISOString();
  assert.equal(planDispatch(cards, source, { fleet: FLEET, ledger: launching, at: young }).length, 0);
  const stale = new Date(Date.parse(at) + LAUNCHING_HOLD_MS + 1000).toISOString();
  assert.deepEqual(planDispatch(cards, source, { fleet: FLEET, ledger: launching, at: stale }).map(p => p.unit.ticket), [1583]);
  const malformed = { dispatched: {
    '1583:develop:1': { ...launching.dispatched['1583:develop:1'], at: 'not-a-timestamp' },
  } };
  assert.deepEqual(
    planDispatch(cards, source, { fleet: FLEET, ledger: malformed, at }).map(p => p.unit.ticket),
    [1583],
    'a malformed crash-journal timestamp is stale rather than a permanent hold',
  );

  // A lane judged no-proof is a new develop round even when the unit facts do
  // not look ordinarily startable any more; another host is preferred.
  const noProofUnit = { ...one.units[0], state: 'on lane' };
  const retrySource = new Map([['cs', sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'], units: [noProofUnit], qaTickets: [],
  })]]);
  const judged = { dispatched: {
    '1583:develop:1': {
      ticket: 1583, kind: 'develop', round: 1, branch: 'feat/fin-u3b',
      host: 'lanes-01', lane: 'lanes-01/lane-2', result: 'launched', judged: 'no-proof', at,
    },
  } };
  const [retry] = planDispatch(cards, retrySource, { fleet: FLEET, ledger: judged, at: '2026-08-29T12:01:00.000Z' });
  assert.deepEqual([retry.round, retry.lane, dispatchKey(retry)], [2, 'mac/lane-6', '1583:develop:2']);
  const recorded = recordDispatch(judged, retry, { result: 'launched' }, '2026-08-29T12:01:00.000Z');
  assert.deepEqual(Object.keys(recorded.dispatched), ['1583:develop:1', '1583:develop:2']);

  const sameLaneSource = new Map([['cs', sprint({
    free: [],
    laneTable: [{ host: 'lanes-01', lane: 'lane-2', hostOk: true, busy: false, fleet: true }],
    units: [noProofUnit], qaTickets: [],
  })]]);
  const [sameLaneRetry] = planDispatch(cards, sameLaneSource, {
    fleet: FLEET, ledger: judged, at: '2026-08-29T12:01:00.000Z',
  });
  assert.deepEqual(
    [sameLaneRetry.round, sameLaneRetry.lane, dispatchKey(sameLaneRetry)],
    [2, 'lanes-01/lane-2', '1583:develop:2'],
    'when no other host is free, the now-idle original lane can retry the next round',
  );
});

test('a stuck unit card cannot receive develop or fix R4 after three no-proof rounds', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const stuckCards = [...cards, { id: 'u3b', parent: 'cs', ticket: 1583, title: 'U3b #1583', stage: 'stuck' }];
  const developUnit = { ...sprint().units.find(unit => unit.ticket === 1583), state: 'on lane' };
  const developLedger = { dispatched: Object.fromEntries([1, 2, 3].map(round => [
    `1583:develop:${round}`,
    {
      ticket: 1583, kind: 'develop', round, host: 'lanes-01', lane: 'lanes-01/lane-2',
      result: 'launched', judged: 'no-proof', at,
    },
  ])) };
  const developSource = new Map([['cs', sprint({
    free: ['mac/lane-6'], units: [developUnit], qaTickets: [],
  })]]);
  assert.deepEqual(planDispatch(stuckCards, developSource, { fleet: FLEET, ledger: developLedger }), []);

  const head = 'c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5';
  const fixUnit = {
    ...developUnit,
    pr: {
      number: 2200, headSha: head, ci: { color: 'green' }, mergeable: 'MERGEABLE',
      verdictOnHead: { round: 1, go: false, head, body: `R1 — NO-GO\nhead ${head}` },
    },
  };
  const fixLedger = { dispatched: {
    '1583:fix:c5c5c5c5': { ticket: 1583, kind: 'fix', round: 1, head, result: 'launched', judged: 'no-proof', at },
    '1583:fix:2': { ticket: 1583, kind: 'fix', round: 2, head, result: 'launched', judged: 'no-proof', at },
    '1583:fix:3': { ticket: 1583, kind: 'fix', round: 3, head, result: 'launched', judged: 'no-proof', at },
  } };
  const fixSource = new Map([['cs', sprint({ free: ['mac/lane-6'], units: [fixUnit], qaTickets: [] })]]);
  assert.deepEqual(planFixes({ cards: stuckCards, sprints: fixSource, ledger: fixLedger, fleet: FLEET }), []);
});

test('a verdict on the current PR head suppresses review planning', () => {
  const unit = {
    ...sprint().units[0],
    pr: {
      ...sprint().units[0].pr,
      draft: false,
      verdictOnHead: { round: 1, go: true, head: 'aefd5925e0000000000000000000000000000000' },
      verdictRounds: 1,
    },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  assert.deepEqual(planReviews({ cards, sprints: source, fleet: FLEET }), []);
});

test('a no-review label suppresses review planning like a verdict on the head', () => {
  const unit = {
    ...sprint().units[0],
    labels: ['No-Review'],
    pr: { ...sprint().units[0].pr, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  assert.deepEqual(planReviews({ cards, sprints: source, fleet: FLEET }), []);
});

test('a legacy headless verdict stays history and does not suppress a review', () => {
  const unit = {
    ...sprint().units[0],
    pr: {
      ...sprint().units[0].pr,
      draft: false,
      verdictOnHead: { round: 1, go: true, head: null },
      verdictRounds: 1,
    },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  const [pair] = planReviews({ cards, sprints: source, fleet: FLEET });
  assert.deepEqual([pair.kind, pair.round, pair.head], ['review', 2, unit.pr.headSha]);
});

test('a stuck unit card cannot receive a review task', () => {
  const unit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  const stuckCards = cards.map(card => card.id === 'u1' ? { ...card, stage: 'stuck' } : card);
  assert.deepEqual(planReviews({ cards: stuckCards, sprints: source, fleet: FLEET }), []);
});

test('a PR without a verdict gets the next review round on a lane other than its last writer', () => {
  const head = 'aefd5925e0000000000000000000000000000000';
  const unit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, draft: false, headSha: head, verdictOnHead: null, verdictRounds: 2 },
  };
  const writerFleet = {
    ...FLEET,
    hosts: {
      ...FLEET.hosts,
      hostinger: { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' },
    },
    lanes: { ...FLEET.lanes, 'lane-4': { host: 'hostinger', n: 4 } },
  };
  const source = new Map([['cs', sprint({
    units: [unit], qaTickets: [], free: ['lanes-01/lane-1', 'hostinger/lane-4', 'mac/lane-6'],
  })]]);
  const ledger = {
    dispatched: {
      '1575:develop:1': {
        ticket: 1575, kind: 'develop', lane: 'lanes-01/lane-1', host: 'lanes-01',
        at: '2026-08-01T12:00:00.000Z', result: 'launched',
      },
      '1575:fix:2': {
        ticket: 1575, kind: 'fix', round: 2, head, lane: 'mac/lane-6', host: 'mac',
        at: '2026-08-29T11:59:00.000Z', result: 'failed', launchFailure: true,
        error: 'launch failed (exit 255): ssh timed out',
      },
    },
  };
  const [pair] = planReviews({ cards, sprints: source, ledger, fleet: writerFleet, at: '2026-08-29T12:00:00.000Z' });
  assert.deepEqual(
    [pair.kind, pair.role, pair.head, pair.round, pair.lane],
    ['review', 'reviewer', head, 3, 'hostinger/lane-4'],
    'a failed fix neither becomes the writer nor permits review on the actual author lane',
  );
  assert.equal(dispatchKey(pair), '1575:review:aefd5925');
});

test('the pure review planner does not require spawned pipeline child cards', () => {
  const unit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  const rootCards = cards.filter(card => !card.parent);
  assert.deepEqual(planReviews({ cards: rootCards, sprints: source, fleet: FLEET }).map(pair => pair.unit.ticket), [1575]);
});

test('live review journal entries are final; held retries the same key and failed advances the round', () => {
  const head = 'aefd5925e0000000000000000000000000000000';
  const unit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, draft: false, headSha: head, verdictOnHead: null, verdictRounds: 0 },
  };
  const source = new Map([['cs', sprint({ units: [unit], qaTickets: [], free: ['mac/lane-6'] })]]);
  for (const result of ['launching', 'launched']) {
    const ledger = { dispatched: { '1575:review:aefd5925': {
      ticket: 1575, kind: 'review', head, result, at: '2026-08-29T12:00:00.000Z',
    } } };
    assert.equal(planReviews({
      cards, sprints: source, ledger, fleet: FLEET, at: '2026-08-29T12:00:30.000Z',
    }).length, 0, result);
  }
  const heldLedger = { dispatched: {
    '1575:review:aefd5925': {
      ticket: 1575, kind: 'review', round: 1, head, host: 'mac', lane: 'mac/lane-6',
      result: 'held', error: 'launcher refused: busy', at: '2026-08-29T12:00:00.000Z',
    },
  } };
  const [heldRetry] = planReviews({
    cards, sprints: source, ledger: heldLedger, fleet: FLEET, at: '2026-08-29T12:00:30.000Z',
  });
  assert.deepEqual([heldRetry.round, heldRetry.retryOf, dispatchKey(heldRetry)], [1, undefined, '1575:review:aefd5925']);

  const failedLedger = { dispatched: {
    '1575:review:aefd5925': {
      ticket: 1575, kind: 'review', round: 1, head, host: 'lanes-01', lane: 'lanes-01/lane-1',
      result: 'failed', error: 'launch failed (exit 255): ssh timed out', at: '2026-08-29T12:00:00.000Z',
    },
  } };
  const failedSource = new Map([['cs', sprint({
    units: [unit], qaTickets: [], free: ['lanes-01/lane-1', 'mac/lane-6'],
  })]]);
  const [failedRetry] = planReviews({
    cards, sprints: failedSource, ledger: failedLedger, fleet: FLEET, at: '2026-08-29T12:00:30.000Z',
  });
  assert.deepEqual(
    [failedRetry.round, failedRetry.retryOf, failedRetry.lane, dispatchKey(failedRetry)],
    [2, '1575:review:aefd5925', 'mac/lane-6', '1575:review:2'],
  );
  const preflightLedger = { dispatched: {
    '1575:review:aefd5925': {
      ...failedLedger.dispatched['1575:review:aefd5925'],
      error: 'the ticket body could not be read (gh issue view)',
    },
  } };
  const [preflightAgain] = planReviews({
    cards, sprints: failedSource, ledger: preflightLedger, fleet: FLEET, at: '2026-08-29T12:00:30.000Z',
  });
  assert.deepEqual(
    [preflightAgain.round, preflightAgain.retryOf, dispatchKey(preflightAgain)],
    [1, undefined, '1575:review:aefd5925'],
    'a legacy preflight failure remains a same-key planning hold, not a host failure',
  );
  const collisionLedger = { dispatched: {
    '1575:review:2': {
      ticket: 1575, kind: 'review', round: 2, head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      host: 'mac', lane: 'mac/lane-7', result: 'launched', at: '2026-08-29T11:00:00.000Z',
    },
    '1575:review:aefd5925': failedLedger.dispatched['1575:review:aefd5925'],
  } };
  const [collisionRetry] = planReviews({
    cards, sprints: failedSource, ledger: collisionLedger, fleet: FLEET, at: '2026-08-29T12:00:30.000Z',
  });
  assert.deepEqual(
    [collisionRetry.round, dispatchKey(collisionRetry)],
    [3, '1575:review:3'],
    'a retry never collides with a numeric round key retained from an older head',
  );
  const previousKey = '1575:review:aefd5925';
  const judged = { dispatched: {
    [previousKey]: {
      ticket: 1575, kind: 'review', round: 1, head, host: 'lanes-01', lane: 'lanes-01/lane-1',
      result: 'launched', judged: 'no-proof', at: '2026-08-29T12:00:00.000Z',
    },
  } };
  const retrySource = new Map([['cs', sprint({
    units: [unit], qaTickets: [], free: ['lanes-01/lane-1', 'mac/lane-6'],
  })]]);
  const [retry] = planReviews({
    cards, sprints: retrySource, ledger: judged, fleet: FLEET, at: '2026-08-29T12:01:00.000Z',
  });
  assert.deepEqual(
    [retry.round, retry.retryOf, retry.lane, dispatchKey(retry)],
    [2, previousKey, 'mac/lane-6', '1575:review:2'],
  );
});

test('review pairs precede develop pairs and reserve their lanes', () => {
  const reviewUnit = {
    ...sprint().units[0],
    pr: { ...sprint().units[0].pr, draft: false, verdictOnHead: null, verdictRounds: 0 },
  };
  const developUnit = sprint().units.find(unit => unit.ticket === 1583);
  const source = new Map([['cs', sprint({ units: [reviewUnit, developUnit], qaTickets: [], free: ['mac/lane-6', 'mac/lane-7'] })]]);
  const reviews = planReviews({ cards, sprints: source, fleet: FLEET });
  const develops = planDispatchFull(cards, source, { fleet: FLEET, takenLanes: reviews.map(pair => pair.lane) }).pairs;
  const queue = [...reviews, ...develops];
  assert.deepEqual(queue.map(pair => pair.kind), ['review', 'develop']);
  assert.deepEqual(queue.map(pair => pair.lane), ['mac/lane-6', 'mac/lane-7']);
});

test('the table rows: pairs as would-dispatch, the journal\'s recent word, and holds', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const s = sprint();
  const { pairs, holds } = planDispatchFull(cards, new Map([['cs', s]]), { fleet: FLEET, at });
  const rows = dispatchRows({ pairs, holds, at, state: 'would dispatch' });
  assert.deepEqual(rows[0], { kind: 'develop', card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'would dispatch' });
  assert.equal(holds.length, 0);
  const ledger = recordDispatch({ dispatched: {} }, pairs[0], { result: 'launched', error: null }, at);
  const later = dispatchRows({ pairs: [], holds: [], ledger, at: '2026-08-29T12:30:00.000Z' });
  assert.deepEqual(later, [{ kind: 'develop', card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'launched 12:00Z' }]);
  assert.equal(dispatchRows({ ledger, at: '2026-09-05T12:00:00.000Z' }).length, 0, 'a day later the journal line is gone from the table');
});

test('the task file carries the role, check and committed rules, then ticket and extra sections', () => {
  const s = sprint();
  const [pair] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const ticket = { number: 1583, title: 'FIN-U3b: card v2 tail', url: 'https://github.com/acme/web/issues/1583', body: '**Branch:** `feat/fin-u3b`\n**Depends on:** #1577 (its geometry)\n\n## Work\n- the tail' };
  const text = taskText({
    pair, ticket, role: 'lane', kind: 'develop', round: 1, head: null, rules: RULES,
    check: 'npm test', sections: [{ title: 'CI — red checks', body: 'lint\nunit' }],
    kitchen: '$HOME/kitchens/autopase.lv', taskFile: '$HOME/kitchens/autopase.lv/TASK-1583.md',
    specRemote: '$HOME/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1', repo: 'acme/web', at: '2026-08-29T12:00:00.000Z',
  });
  assert.match(text, /^# TASK-1583 — FIN-U3b: card v2 tail\n/);
  assert.match(text, /Sprint \*\*FINANCE-CARDS\*\*, umbrella issue \*\*#1569\*\*, ticket \*\*#1583\*\* \(https:\/\/github.com\/acme\/web\/issues\/1583\)\./);
  assert.match(text, /Lane: `\$HOME\/kitchens\/autopase.lv\/lane-6` \(mac\/lane-6\)\. Branch: `feat\/fin-u3b`\. Repository: `acme\/web`\./);
  assert.match(text, /^Base: `b34d212d00000000000000000000000000000000` — the head of `feat\/fin-u3a`, the open PR #1602 of U3a \(#1577\)\./m);
  assert.match(text, /^Role: lane$/m);
  assert.match(text, /^Check: npm test$/m);
  assert.match(text, /^Rules: docs\/RULES\.md @ 508cb21$/m);
  assert.match(text, /Spec bundle: `\$HOME\/kitchens\/autopase.lv\/AUTO-DETAIL-FINANCE-CARDS-R1`/);
  assert.deepEqual(text.split('\n').slice(0, 10), [
    '# TASK-1583 — FIN-U3b: card v2 tail',
    '',
    'Sprint **FINANCE-CARDS**, umbrella issue **#1569**, ticket **#1583** (https://github.com/acme/web/issues/1583).',
    'Lane: `$HOME/kitchens/autopase.lv/lane-6` (mac/lane-6). Branch: `feat/fin-u3b`. Repository: `acme/web`.',
    'Base: `b34d212d00000000000000000000000000000000` — the head of `feat/fin-u3a`, the open PR #1602 of U3a (#1577). Start from it (MANDATE.md §2); rebase after that PR merges. Do not wait for the merge.',
    'Role: lane',
    'Check: npm test',
    'Rules: docs/RULES.md @ 508cb21',
    'Spec bundle: `$HOME/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1` — the spec, the grill outcome and the handoff live there; every § reference in the ticket is restated inline, and the inline text wins.',
    'Dispatched by the board at 2026-08-29T12:00:00.000Z (auto-dispatch, decision 16); this file is `$HOME/kitchens/autopase.lv/TASK-1583.md`. Reports go to the umbrella issue only.',
  ]);
  assert.match(text, /\n---\n<!-- role: common -->[\s\S]*Never write `Closes #`[\s\S]*\n---\n\n# TICKET #1583 — verbatim\n\n\*\*Branch:\*\* `feat\/fin-u3b`\n/);
  assert.match(text, /- the tail\n\n---\n# CI — red checks\n\nlint\nunit\n$/);
  assert.doesNotMatch(text, /BRIEF-COMMON/);

  const review = { ...pair, kind: 'review', round: 2, head: 'abcdef123456', role: 'reviewer' };
  const reviewText = taskText({ pair: review, ticket, role: 'reviewer', kind: 'review', round: 2, head: review.head, rules: { sha: '508cb21', text: 'review rules' }, check: 'npm test' });
  assert.match(reviewText, /^# TASK-1583-REVIEW-R2 —/m);
  assert.match(reviewText, /^Head: abcdef123456  Round: R2$/m);

  // No spec bundle and a main base still use the same committed-rules shape.
  const [, qa] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const plain = taskText({ pair: qa, ticket: { number: 1599, title: 'DealCard', body: 'fix it' }, rules: RULES });
  assert.match(plain, /^Base: `origin\/main` — every dependency is merged or closed/m);
  assert.match(plain, /Spec bundle: none shipped/);
});

test('the spec folder comes from the program whose state names the umbrella, else from the card', () => {
  const dir = path.join('/tmp', 'wt-dispatch');
  const specDir = path.join(dir, 'FIN-R1');
  const programs = new Map([['fin-r1', { program: 'FIN-R1', file: path.join(specDir, 'PROGRAM-STATE.md'), umbrella: 1569 }]]);
  assert.equal(specDirFor({ umbrella: 1569, programs }), specDir);
  assert.equal(specDirFor({ umbrella: 1515, programs }), null);
  assert.equal(specDirFor({ card: { spec: 'goal\nspec dir: `C:\\specs\\X`\n' } }), 'C:\\specs\\X');
  assert.equal(specDirFor({ card: { spec: 'spec: X-R1' }, specsDir: dir }), path.join(dir, 'X-R1'));
});

test('the launch plan is commands and nothing runs: copy the task, ship the bundle once, start the launcher, comment', () => {
  const s = sprint();
  const [pair] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const plan = launchPlan(pair, { fleet: FLEET, hosts: HOSTS, localTask: 'C:\\wt\\state\\auto-dispatch\\TASK-1583.md', localSpec: 'C:\\specs\\AUTO-DETAIL-FINANCE-CARDS-R1', home: 'C:\\Users\\me', repo: 'acme/web' });
  assert.equal(plan.error, null);
  assert.equal(plan.taskFile, '~/kitchens/autopase.lv/TASK-1583.md');
  assert.equal(plan.bundle, '~/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1');
  assert.equal(plan.laneCmd, 'maclane 6 "Прочитай $HOME/kitchens/autopase.lv/TASK-1583.md и выполни целиком"');
  assert.deepEqual(plan.steps.map(st => st.kind), ['task-copy', 'bundle-check', 'bundle-copy', 'launch', 'comment']);
  const by = Object.fromEntries(plan.steps.map(st => [st.kind, st]));
  assert.deepEqual(by['task-copy'].args.slice(-2), ['C:\\wt\\state\\auto-dispatch\\TASK-1583.md', 'mac:kitchens/autopase.lv/TASK-1583.md'], 'a ~/ kitchen is home-relative for scp');
  assert.ok(by['task-copy'].args.includes('ConnectTimeout=30'), 'the host\'s own connect timeout');
  assert.ok(!by['task-copy'].args.includes('-i'), 'no key for a Host alias');
  assert.equal(by['bundle-check'].args.at(-1), 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH; test -d "$HOME/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1" && echo HAVE || echo MISSING');
  assert.deepEqual(by['bundle-copy'].args.slice(-3), ['-r', 'C:\\specs\\AUTO-DETAIL-FINANCE-CARDS-R1', 'mac:kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1']);
  assert.equal(by['bundle-copy'].onlyIf, 'MISSING');
  assert.equal(by.launch.args.at(-1), 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH; maclane 6 "Прочитай $HOME/kitchens/autopase.lv/TASK-1583.md и выполни целиком"');
  assert.equal(by.launch.args.at(-2), 'mac');
  assert.deepEqual(by.comment.args, ['issue', 'comment', '1569', '--repo', 'acme/web', '--body', 'board: U3b #1583 dispatched to mac/lane-6 from feat/fin-u3a@b34d212d (PR #1602 of U3a)']);
  assert.equal(commentLine(pair), 'board: U3b #1583 dispatched to mac/lane-6 from feat/fin-u3a@b34d212d (PR #1602 of U3a)');
  assert.equal(taskFileName(pair), 'TASK-1583.md');
  const review = { ...pair, kind: 'review', round: 3, head: 'abcdef', role: 'reviewer' };
  const fix = { ...pair, kind: 'fix', round: 4, head: 'fedcba', role: 'fixer' };
  assert.equal(taskFileName(review), 'TASK-1583-REVIEW-R3.md');
  assert.equal(taskFileName(fix), 'TASK-1583-FIX-R4.md');
  assert.equal(launchPlan(review, { fleet: FLEET, hosts: HOSTS, localTask: 'review.md' }).taskFile, '~/kitchens/autopase.lv/TASK-1583-REVIEW-R3.md');
  assert.equal(launchPlan(fix, { fleet: FLEET, hosts: HOSTS, localTask: 'fix.md' }).taskFile, '~/kitchens/autopase.lv/TASK-1583-FIX-R4.md');

  // A Linux lane: key from the board's hosts, absolute kitchen, no shell prefix, no bundle, no repo.
  const lx = planDispatch(cards, new Map([['cs', sprint({ free: ['lanes-01/lane-1'] })]]), { fleet: FLEET })[0];
  const p2 = launchPlan(lx, { fleet: FLEET, hosts: HOSTS, localTask: '/tmp/TASK-1583.md', home: '/home/me' });
  assert.deepEqual(p2.steps.map(st => st.kind), ['task-copy', 'launch']);
  assert.deepEqual(p2.steps[0].args, ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-i', path.join('/home/me', '.ssh', 'id_ed25519'), '/tmp/TASK-1583.md', 'root@203.0.113.10:/root/kitchens/autopase.lv/TASK-1583.md']);
  assert.equal(p2.steps[1].args.at(-1), 'hzlane 1 "Прочитай /root/kitchens/autopase.lv/TASK-1583.md и выполни целиком"');
  // No ssh target anywhere: an error, no steps.
  const p3 = launchPlan({ ...lx, host: 'nowhere' }, { fleet: { ...FLEET, hosts: { ...FLEET.hosts, nowhere: { launch: 'x {n}' } } }, hosts: {}, localTask: 't' });
  assert.match(p3.error, /no ssh target for host nowhere/);
});

test('running a plan: a busy launcher holds, ssh trouble fails, and a lost comment is still launched', async () => {
  const s = sprint();
  const [pair] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const plan = launchPlan(pair, { fleet: FLEET, hosts: HOSTS, localTask: 't.md', localSpec: 'C:\\specs\\S', home: 'h', repo: 'acme/web' });
  const script = answers => {
    const calls = [];
    const exec = async (bin, args) => {
      const kind = plan.steps.find(st => st.bin === bin && st.args === args)?.kind;
      calls.push(kind);
      return answers[kind] ?? { code: 0, out: '' };
    };
    return { calls, exec };
  };
  let r = script({ 'bundle-check': { code: 0, out: 'MISSING' }, launch: { code: 0, out: 'lane-6 started' } });
  let out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error], ['launched', null]);
  assert.deepEqual(r.calls, ['task-copy', 'bundle-check', 'bundle-copy', 'launch', 'comment'], 'the bundle is copied because it was missing');

  r = script({ 'bundle-check': { code: 0, out: 'HAVE' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'launched');
  assert.deepEqual(r.calls, ['task-copy', 'bundle-check', 'launch', 'comment'], 'a bundle already there is not copied again');

  r = script({ 'bundle-check': { code: 0, out: 'HAVE' }, launch: { code: 2, out: 'lane-6 занята' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'held');
  assert.match(out.error, /launcher refused: lane-6/);

  r = script({ 'task-copy': { code: 255, out: 'ssh: connect to host mac port 22: Connection refused' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'failed');
  assert.equal(out.launchFailure, true);
  assert.match(out.error, /task-copy failed \(exit 255\)/);
  assert.deepEqual(r.calls, ['task-copy']);

  r = script({ 'bundle-check': { code: 0, out: 'HAVE' }, comment: { code: 1, out: 'gh: rate limited' } });
  out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error], ['launched', 'umbrella comment failed: gh: rate limited']);

  out = await runLaunch({ error: 'no ssh target', steps: [] }, r.exec);
  assert.deepEqual([out.result, out.error], ['held', 'no ssh target']);
});

test('qa-run waits for merged or closed dependencies, uses origin/main, and needs a browser host', () => {
  const qaRun = {
    unit: 'QA R1', ticket: 1605, title: 'QA R1 — FINANCE-CARDS', branch: 'feat/1605',
    labels: ['qa-run'], qa: true, open: true, state: 'open',
    deps: [{ ticket: 1583, unit: 'U3b', state: 'pr green', met: false }],
  };
  const card = { ...cards[0], stage: 'merged' };
  const waiting = sprint({ free: ['lanes-01/lane-1', 'mac/lane-6'], units: [], qaTickets: [qaRun] });
  assert.equal(planDispatch([card], new Map([['cs', waiting]]), { fleet: FLEET }).length, 0, 'an open PR does not meet a qa-run dependency');

  const ready = sprint({
    free: ['lanes-01/lane-1', 'mac/lane-6'],
    units: [],
    qaTickets: [{ ...qaRun, deps: [{ ...qaRun.deps[0], state: 'merged', met: true }] }],
  });
  const [pair] = planDispatch([card], new Map([['cs', ready]]), { fleet: FLEET });
  assert.equal(pair.lane, 'mac/lane-6');
  assert.deepEqual([pair.role, pair.kind, pair.round, pair.head], ['qa', 'develop', 1, null]);
  assert.deepEqual(pair.base, { ref: 'main', sha: null, pr: null, ticket: null, unit: null });
  const qaLedger = recordDispatch({ dispatched: {} }, pair, { result: 'launched' }, '2026-08-29T12:00:00.000Z');
  assert.deepEqual(
    [qaLedger.dispatched['1605:develop:1'].role, qaLedger.dispatched['1605:develop:1'].qaRun, qaLedger.dispatched['1605:develop:1'].labels],
    ['qa', true, ['qa-run']],
    'qa-run proof identity survives the journal round-trip',
  );

  const noBrowser = { ...FLEET, hosts: { ...FLEET.hosts, mac: { ...FLEET.hosts.mac, browser: false } } };
  const held = planDispatchFull([card], new Map([['cs', ready]]), { fleet: noBrowser });
  assert.equal(held.pairs.length, 0);
  assert.match(held.holds.find(h => h.ticket === 1605)?.reason ?? '', /browser: true host/);
});

test('laneLauncher reads the fleet config for a free lane name', () => {
  assert.deepEqual(laneLauncher(FLEET, 'lanes-01/lane-3'), { name: 'lanes-01/lane-3', host: 'lanes-01', lane: 'lane-3', n: 3, noBuilds: true, reserved: false, browser: false });
  assert.equal(laneLauncher(FLEET, 'mac/lane-6').browser, true);
  assert.equal(laneLauncher(FLEET, 'mac/lane-3'), null, 'lane-3 is not on the Mac');
  assert.equal(laneLauncher(FLEET, 'lane-3'), null);
  assert.equal(laneLauncher({ hosts: {}, lanes: { 'lane-9': { host: 'x' } } }, 'x/lane-9'), null, 'a host without a launcher');
});

test('a red main holds every unit that branches from main', () => {
  const mainCi = {
    red: true,
    createdAt: '2026-08-30T14:34:15Z',
    url: 'https://github.com/acme/web/actions/runs/1',
    headSha: '339ca1e1339ca1e1',
  };
  const mainFix = {
    unit: 'U8', ticket: 1590, title: 'FIN-U8: repair main', branch: 'feat/fin-u8',
    state: 'queued', deps: [], labels: ['main-fix'],
  };
  const s = sprint({
    free: ['mac/lane-6', 'mac/lane-7', 'mac/lane-8'],
    units: [...sprint().units, mainFix],
  });
  const sprints = new Map([['cs', s]]);

  const red = planDispatchFull(cards, sprints, { fleet: FLEET, facts: { mainCi } });
  assert.deepEqual(red.pairs.map(p => [p.unit.ticket, baseLine(p.base)]), [
    [1583, 'feat/fin-u3a@b34d212d (PR #1602 of U3a)'],
    [1590, 'main'],
  ], 'a unit on a dependency PR head is untouched; a main-fix ticket repairs main from main');
  assert.deepEqual(red.holds.filter(h => h.ticket === 1599).map(h => h.reason), [
    'main is red since 2026-08-30T14:34:15Z (https://github.com/acme/web/actions/runs/1)',
  ]);

  const green = planDispatchFull(cards, sprints, { fleet: FLEET });
  assert.deepEqual(green.pairs.map(p => p.unit.ticket), [1583, 1590, 1599]);
  for (const facts of [{ mainCi: { red: false } }, { mainCi: null }, null]) {
    const open = planDispatchFull(cards, sprints, { fleet: FLEET, facts });
    assert.deepEqual(open.pairs.map(p => p.unit.ticket), [1583, 1590, 1599],
      'unknown or green is never red — one GitHub hiccup does not stop the board');
  }
});
