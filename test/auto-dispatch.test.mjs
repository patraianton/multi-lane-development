// Auto-dispatch (decision 16): the planner pairs startable units with free
// launchable lanes, the base is the dependency's open-PR head, the task file
// is ticket + brief + base, the launch plan is commands and nothing runs.
// Pure fixtures; no ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  planDispatch, planDispatchFull, baseFor, baseLine, recordDispatch, dispatchRows, laneLauncher,
  taskText, specDirFor, loadBrief, launchPlan, runLaunch, commentLine, COMMON_BRIEF, RETRY_MS,
} from '../bin/auto-dispatch.mjs';

const FLEET = {
  prompt: 'Прочитай {taskFile} и выполни целиком',
  hosts: {
    'lanes-01': { kitchen: '/root/kitchens/autopase.lv', launch: 'hzlane {n} "{prompt}"' },
    mac: { kitchen: '~/kitchens/autopase.lv', shell: 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH;', launch: 'maclane {n} "{prompt}"' },
  },
  lanes: {
    'lane-1': { host: 'lanes-01', n: 1 }, 'lane-2': { host: 'lanes-01', n: 2 }, 'lane-3': { host: 'lanes-01', n: 3, noBuilds: true },
    'lane-6': { host: 'mac', n: 6 }, 'lane-7': { host: 'mac', n: 7 }, 'lane-8': { host: 'mac', n: 8 },
  },
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
      { unit: 'U9', ticket: 1584, title: 'FIN-U9', branch: '', state: 'queued', deps: [] },
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
  ], 'U7 waits for U6 on a lane, U9 has no branch, the done sprint and the unit card are skipped');
  assert.equal(pairs[0].card.id, 'cs');
  assert.equal(pairs[0].umbrella, 1569);
  assert.equal(pairs[0].host, 'mac');
  assert.equal(pairs[0].laneName, 'lane-6');
  assert.equal(pairs[0].n, 6);
  assert.equal(pairs[0].unit.branch, 'feat/fin-u3b');
  const { holds } = planDispatchFull(cards, new Map([['cs', sprint()]]), { fleet: FLEET });
  assert.ok(holds.some(h => h.ticket === 1584 && /no pinned branch/.test(h.reason)), 'U9 is held for its missing branch');
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

test('the journal: a launched unit is never sent again, a failed one waits ten minutes, a launched lane is held', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const s = sprint();
  const pairs = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET, at });
  let ledger = recordDispatch({ dispatched: {} }, pairs[0], { result: 'launched', error: null }, at);
  assert.equal(ledger.dispatched['1583'].lane, 'mac/lane-6');
  assert.equal(ledger.dispatched['1583'].base, 'feat/fin-u3a@b34d212d (PR #1602 of U3a)');
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
  assert.deepEqual(Object.keys(pruned.dispatched), ['1599']);
});

test('the table rows: pairs as would-dispatch, the journal\'s recent word, and holds', () => {
  const at = '2026-08-29T12:00:00.000Z';
  const s = sprint();
  const { pairs, holds } = planDispatchFull(cards, new Map([['cs', s]]), { fleet: FLEET, at });
  const rows = dispatchRows({ pairs, holds, at, state: 'would dispatch' });
  assert.deepEqual(rows[0], { card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'would dispatch' });
  assert.ok(rows.some(r => r.unit === 'U9 #1584' && /^held: no pinned branch/.test(r.state)));
  const ledger = recordDispatch({ dispatched: {} }, pairs[0], { result: 'launched', error: null }, at);
  const later = dispatchRows({ pairs: [], holds: [], ledger, at: '2026-08-29T12:30:00.000Z' });
  assert.deepEqual(later, [{ card: 'FINANCE-CARDS', unit: 'U3b #1583', lane: 'mac/lane-6', base: 'feat/fin-u3a@b34d212d (PR #1602 of U3a)', state: 'launched 12:00Z' }]);
  assert.equal(dispatchRows({ ledger, at: '2026-09-05T12:00:00.000Z' }).length, 0, 'a day later the journal line is gone from the table');
});

test('the task file: header with lane, branch, base and bundle; the brief; the ticket verbatim', () => {
  const s = sprint();
  const [pair] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const ticket = { number: 1583, title: 'FIN-U3b: card v2 tail', url: 'https://github.com/acme/web/issues/1583', body: '**Branch:** `feat/fin-u3b`\n**Depends on:** #1577 (its geometry)\n\n## Work\n- the tail' };
  const text = taskText({ pair, ticket, brief: { file: 'x/BRIEF-COMMON-FIN.md', text: '# BRIEF-COMMON-FIN\n\nrules\n' }, kitchen: '$HOME/kitchens/autopase.lv', taskFile: '$HOME/kitchens/autopase.lv/TASK-1583.md', specRemote: '$HOME/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1', repo: 'acme/web', at: '2026-08-29T12:00:00.000Z' });
  assert.match(text, /^# TASK-1583 — FIN-U3b: card v2 tail\n/);
  assert.match(text, /Sprint \*\*FINANCE-CARDS\*\*, umbrella issue \*\*#1569\*\*, ticket \*\*#1583\*\* \(https:\/\/github.com\/acme\/web\/issues\/1583\)\./);
  assert.match(text, /Lane: `\$HOME\/kitchens\/autopase.lv\/lane-6` \(mac\/lane-6\)\. Branch: `feat\/fin-u3b`\. Repository: `acme\/web`\./);
  assert.match(text, /^Base: `b34d212d00000000000000000000000000000000` — the head of `feat\/fin-u3a`, the open PR #1602 of U3a \(#1577\)\./m);
  assert.match(text, /Spec bundle: `\$HOME\/kitchens\/autopase.lv\/AUTO-DETAIL-FINANCE-CARDS-R1`/);
  assert.match(text, /\n---\n# BRIEF-COMMON-FIN\n\nrules\n\n---\n\n# TICKET #1583 — verbatim\n\n\*\*Branch:\*\* `feat\/fin-u3b`\n/);
  assert.ok(text.trimEnd().endsWith('- the tail'), 'the ticket body closes the file, verbatim');
  // No brief in the spec folder: the common minimum, and a main base.
  const [, qa] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const plain = taskText({ pair: qa, ticket: { number: 1599, title: 'DealCard', body: 'fix it' } });
  assert.match(plain, /^Base: `origin\/main` — every dependency is merged or closed/m);
  assert.match(plain, /Spec bundle: none shipped/);
  assert.ok(plain.includes(COMMON_BRIEF.trimEnd()));
  assert.match(COMMON_BRIEF, /never `Closes #<n>`/, 'decision 13: the PR never closes the ticket');
});

test('the spec folder comes from the program whose state names the umbrella, else from the card; the brief from tasks/', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wt-dispatch-'));
  try {
    const specDir = path.join(dir, 'FIN-R1');
    await mkdir(path.join(specDir, 'tasks'), { recursive: true });
    await writeFile(path.join(specDir, 'tasks', 'BRIEF-COMMON-FIN.md'), '# BRIEF-COMMON-FIN\n');
    await writeFile(path.join(specDir, 'tasks', 'TASK-FIN-U8.md'), 'not a brief');
    const programs = new Map([['fin-r1', { program: 'FIN-R1', file: path.join(specDir, 'PROGRAM-STATE.md'), umbrella: 1569 }]]);
    assert.equal(specDirFor({ umbrella: 1569, programs }), specDir);
    assert.equal(specDirFor({ umbrella: 1515, programs }), null);
    assert.equal(specDirFor({ card: { spec: 'goal\nspec dir: `C:\\specs\\X`\n' } }), 'C:\\specs\\X');
    assert.equal(specDirFor({ card: { spec: 'spec: X-R1' }, specsDir: dir }), path.join(dir, 'X-R1'));
    const brief = await loadBrief(specDir);
    assert.equal(brief.file, path.join(specDir, 'tasks', 'BRIEF-COMMON-FIN.md'));
    assert.equal(brief.text, '# BRIEF-COMMON-FIN\n');
    assert.equal(await loadBrief(path.join(dir, 'nowhere')), null);
    assert.equal(await loadBrief(null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the launch plan is commands and nothing runs: copy the task, ship the bundle once, start the launcher, comment', () => {
  const s = sprint();
  const [pair] = planDispatch(cards, new Map([['cs', s]]), { fleet: FLEET });
  const plan = launchPlan(pair, { fleet: FLEET, hosts: HOSTS, localTask: 'C:\\wt\\state\\auto-dispatch\\TASK-1583.md', localSpec: 'C:\\specs\\AUTO-DETAIL-FINANCE-CARDS-R1', home: 'C:\\Users\\me', repo: 'acme/web' });
  assert.equal(plan.error, null);
  assert.equal(plan.taskFile, '~/kitchens/autopase.lv/TASK-1583.md');
  assert.equal(plan.bundle, '~/kitchens/autopase.lv/AUTO-DETAIL-FINANCE-CARDS-R1');
  assert.equal(plan.laneCmd, 'maclane 6 "Прочитай $HOME/kitchens/autopase.lv/TASK-1583.md и выполни целиком"');
  assert.deepEqual(plan.steps.map(st => st.kind), ['origin-check', 'task-copy', 'bundle-check', 'bundle-copy', 'launch', 'comment']);
  const by = Object.fromEntries(plan.steps.map(st => [st.kind, st]));
  assert.deepEqual(by['origin-check'].args, ['api', 'repos/acme/web/branches/feat/fin-u3b', '--jq', '.name']);
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

test('running a plan: the origin check holds, a busy launcher holds, ssh trouble fails, a lost comment is still launched', async () => {
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
  let r = script({ 'origin-check': { code: 1, out: 'gh: Not Found (HTTP 404)' }, 'bundle-check': { code: 0, out: 'MISSING' }, launch: { code: 0, out: 'lane-6 started' } });
  let out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error], ['launched', null]);
  assert.deepEqual(r.calls, ['origin-check', 'task-copy', 'bundle-check', 'bundle-copy', 'launch', 'comment'], 'the bundle is copied because it was missing');

  r = script({ 'origin-check': { code: 1, out: 'Not Found' }, 'bundle-check': { code: 0, out: 'HAVE' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'launched');
  assert.deepEqual(r.calls, ['origin-check', 'task-copy', 'bundle-check', 'launch', 'comment'], 'a bundle already there is not copied again');

  r = script({ 'origin-check': { code: 0, out: 'feat/fin-u3b' } });
  out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error, r.calls], ['held', 'branch feat/fin-u3b already exists on origin', ['origin-check']]);

  r = script({ 'origin-check': { code: 1, out: 'connect: timed out' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'held');
  assert.match(out.error, /gh api did not answer/);

  r = script({ 'origin-check': { code: 1, out: '404' }, 'bundle-check': { code: 0, out: 'HAVE' }, launch: { code: 2, out: 'lane-6 занята' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'held');
  assert.match(out.error, /launcher refused: lane-6/);

  r = script({ 'origin-check': { code: 1, out: '404' }, 'task-copy': { code: 255, out: 'ssh: connect to host mac port 22: Connection refused' } });
  out = await runLaunch(plan, r.exec);
  assert.equal(out.result, 'failed');
  assert.match(out.error, /task-copy failed \(exit 255\)/);
  assert.deepEqual(r.calls, ['origin-check', 'task-copy']);

  r = script({ 'origin-check': { code: 1, out: '404' }, 'bundle-check': { code: 0, out: 'HAVE' }, comment: { code: 1, out: 'gh: rate limited' } });
  out = await runLaunch(plan, r.exec);
  assert.deepEqual([out.result, out.error], ['launched', 'umbrella comment failed: gh: rate limited']);

  out = await runLaunch({ error: 'no ssh target', steps: [] }, r.exec);
  assert.deepEqual([out.result, out.error], ['failed', 'no ssh target']);
});

test('laneLauncher reads the fleet config for a free lane name', () => {
  assert.deepEqual(laneLauncher(FLEET, 'lanes-01/lane-3'), { name: 'lanes-01/lane-3', host: 'lanes-01', lane: 'lane-3', n: 3, noBuilds: true, reserved: false });
  assert.equal(laneLauncher(FLEET, 'mac/lane-3'), null, 'lane-3 is not on the Mac');
  assert.equal(laneLauncher(FLEET, 'lane-3'), null);
  assert.equal(laneLauncher({ hosts: {}, lanes: { 'lane-9': { host: 'x' } } }, 'x/lane-9'), null, 'a host without a launcher');
});
