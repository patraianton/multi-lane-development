// Auto-dispatch (decision 16): the planner pairs startable units with free
// launchable lanes, the base is the dependency's open-PR head, the task file
// is ticket + committed role rules + base, and launch plans are pure commands.
// Pure fixtures; no ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  planDispatch, planDispatchFull, baseFor, baseLine, recordDispatch, dispatchRows, laneLauncher,
  taskText, specDirFor, launchPlan, runLaunch, commentLine, dispatchKey, taskFileName,
  RETRY_MS, LAUNCHING_HOLD_MS,
} from '../bin/auto-dispatch.mjs';

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
  { id: 'u1', title: 'U1 #1575', stage: 'ci_pr', parent: 'cs' },
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

test('the journal uses per-kind round keys; launched is final and failed waits ten minutes', () => {
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
  const reviewPair = { ...pairs[0], kind: 'review', round: 2, head: 'abcdef123456', role: 'reviewer' };
  const reviewed = recordDispatch({ dispatched: {} }, reviewPair, { result: 'launched' }, at);
  assert.deepEqual(Object.keys(reviewed.dispatched), ['1583:review:2']);
  assert.deepEqual(
    [reviewed.dispatched['1583:review:2'].kind, reviewed.dispatched['1583:review:2'].round, reviewed.dispatched['1583:review:2'].head, reviewed.dispatched['1583:review:2'].host],
    ['review', 2, 'abcdef123456', 'mac'],
  );
  // The probe still says lane-6 is free: the lane is held, U3b is not resent, QA takes lane-7.
  let again = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: '2026-08-29T12:01:00.000Z' });
  assert.deepEqual(again.map(p => [p.unit.unit, p.lane]), [['QA', 'mac/lane-7']]);
  // An hour later lane-6 is free again by the probe; U3b still never goes twice.
  again = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: '2026-08-29T13:00:00.000Z' });
  assert.deepEqual(again.map(p => [p.unit.unit, p.lane]), [['QA', 'mac/lane-6']]);
  // A failed launch is retried only after RETRY_MS.
  ledger = recordDispatch(ledger, pairs[1], { result: 'failed', error: 'ssh did not answer' }, at);
  const soon = planDispatchFull(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: '2026-08-29T12:05:00.000Z' });
  assert.equal(soon.pairs.length, 0);
  assert.ok(soon.holds.some(h => h.ticket === 1599 && /failed at .* ssh did not answer — retry after 10 min/.test(h.reason)));
  const later = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, ledger, at: new Date(Date.parse(at) + RETRY_MS + 1000).toISOString() });
  assert.deepEqual(later.map(p => [p.unit.unit, p.lane]), [['QA', 'mac/lane-6']]);
  // Old entries are dropped.
  const pruned = recordDispatch(ledger, pairs[1], { result: 'launched' }, '2026-09-30T12:00:00.000Z');
  assert.deepEqual(Object.keys(pruned.dispatched), ['1599:develop:1']);
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
});

test('the table rows: pairs as would-dispatch, the journal\'s recent word, and holds', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const s = sprint();
  const { pairs, holds } = planDispatchFull(cards, new Map([['cs', s]]), { fleet: FLEET, at });
  const rows = dispatchRows({ pairs, holds, at, state: 'would dispatch' });
  assert.deepEqual(rows[0], { card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'would dispatch' });
  assert.equal(holds.length, 0);
  const ledger = recordDispatch({ dispatched: {} }, pairs[0], { result: 'launched', error: null }, at);
  const later = dispatchRows({ pairs: [], holds: [], ledger, at: '2026-08-29T12:30:00.000Z' });
  assert.deepEqual(later, [{ card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'launched 12:00Z' }]);
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
  assert.match(out.error, /task-copy failed \(exit 255\)/);
  assert.deepEqual(r.calls, ['task-copy']);

  r = script({ 'bundle-check': { code: 0, out: 'HAVE' }, comment: { code: 1, out: 'gh: rate limited' } });
  out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error], ['launched', 'umbrella comment failed: gh: rate limited']);

  out = await runLaunch({ error: 'no ssh target', steps: [] }, r.exec);
  assert.deepEqual([out.result, out.error], ['failed', 'no ssh target']);
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
