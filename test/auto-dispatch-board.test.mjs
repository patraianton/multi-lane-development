// Auto-dispatch on the real board process: settings own the switch, ticketed
// and merged cards both schedule work, and a live launch persists its intent
// before any remote command can finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, getJson, postJson, startBoard, until } from './helpers.mjs';

const TICKETED_UMBRELLA = 'https://github.com/acme/web/issues/1515';
const MERGED_UMBRELLA = 'https://github.com/acme/web/issues/2600';
const OWNER_TELEGRAM = {
  dryRun: true,
  chatId: '-1',
  ownerChatId: '1',
  founders: [{ name: 'Owner', tgUserId: 1, tag: '@owner', owner: true }],
};

const FLEET = {
  prompt: 'Read {taskFile} and do it whole',
  hosts: {
    mac: { kitchen: '~/kitchens/web', browser: true, shell: 'export PATH=/opt/homebrew/bin:$PATH;', launch: 'maclane {n} "{prompt}"' },
    'lanes-01': { kitchen: '/root/kitchens/web', launch: 'hzlane {n} "{prompt}"' },
  },
  lanes: {
    'lane-1': { host: 'lanes-01', n: 1 },
    'lane-3': { host: 'lanes-01', n: 3, noBuilds: true },
    'lane-6': { host: 'mac', n: 6 },
  },
};

const TICKETED_FACTS = {
  lanes: [
    { host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' },
    { host: 'lanes-01', lane: 'lane-3', busy: false, since: null, branch: 'main' },
  ],
  prs: [],
  mergedPrs: [],
  openIssues: [],
  unitIssues: {
    1515: [
      { number: 1516, title: 'SALON-U1: first unit', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: '', labels: [] },
      { number: 1517, title: 'SALON-U2: documentation only', url: 'https://github.com/acme/web/issues/1517', state: 'OPEN', branch: '', labels: ['no-build'] },
    ],
  },
  ciJobs: {},
  ciRunners: [],
  umbrellaStates: { 1515: 'OPEN' },
  staleSources: [],
};

function mergedFacts({ dependencyMerged = false } = {}) {
  return {
    lanes: [
      { host: 'lanes-01', lane: 'lane-1', busy: false, since: null, branch: 'main' },
      { host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' },
    ],
    prs: dependencyMerged ? [] : [
      { number: 2703, url: 'https://github.com/acme/web/pull/2703', branch: 'feat/2603', headSha: 'abcdeffedcba0000000000000000000000000000' },
    ],
    mergedPrs: [
      { number: 2701, url: 'https://github.com/acme/web/pull/2701', branch: 'feat/2601', mergedAt: '2026-08-30T08:00:00Z' },
      ...(dependencyMerged ? [{ number: 2703, url: 'https://github.com/acme/web/pull/2703', branch: 'feat/2603', mergedAt: '2026-08-30T08:10:00Z' }] : []),
    ],
    openIssues: [],
    unitIssues: {
      2600: [
        { number: 2601, title: 'SHOP-U1: delivered unit', url: 'https://github.com/acme/web/issues/2601', state: 'OPEN', branch: 'feat/2601', labels: [] },
        { number: 2602, title: 'QA SHOP: ordinary finding', url: 'https://github.com/acme/web/issues/2602', state: 'OPEN', branch: '', labels: ['qa'], qa: true },
        { number: 2603, title: 'QA SHOP: dependency finding', url: 'https://github.com/acme/web/issues/2603', state: 'OPEN', branch: 'feat/2603', labels: ['qa'], qa: true },
        {
          number: 2604, title: 'QA R1 — SHOP', url: 'https://github.com/acme/web/issues/2604', state: 'OPEN', branch: '',
          labels: ['qa-run'], qa: true, deps: [2603], depsMerged: true,
        },
      ],
    },
    ciJobs: {},
    ciRunners: [],
    umbrellaStates: { 2600: 'OPEN' },
    staleSources: [],
  };
}

async function dataUntil(base, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    const data = await getJson(base, '/pipeline/data');
    last = data.body;
    if (ready(last)) return last;
    if (Date.now() > deadline) throw new Error(`board data condition was not met in ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function readJsonUntil(file, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value = null;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet */ }
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`${file} did not reach the expected state in ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function readTextUntil(file, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value = '';
    try { value = await readFile(file, 'utf8'); } catch { /* not written yet */ }
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`${file} was not written in ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function createTicketed(board, { title, umbrella }) {
  const created = await postJson(board.base, '/pipeline/card/create', { title, spec: 'the spec' });
  const id = created.body.card.id;
  assert.equal((await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' })).status, 200);
  assert.equal((await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: umbrella } })).status, 200);
  assert.equal((await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' })).status, 200);
  return id;
}

test('off by default: a ticketed sprint only plans its first units', async () => {
  const board = await startBoard({
    config: { source: 'probe' },
    files: { 'sprint-facts.json': TICKETED_FACTS, 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  try {
    const id = await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });
    const api = await until(board.base, body => (body.autoDispatch ?? []).filter(row => row.state === 'would dispatch').length === 2);
    assert.equal(api.cards.find(card => card.id === id).stage, 'ticketed', 'no unit was already started, so this proves dispatch begins in ticketed');
    assert.deepEqual(api.autoDispatch.filter(row => row.state === 'would dispatch'), [
      { kind: 'develop', card: 'AUTO-SALON sprint', unit: 'U1 #1516', lane: 'mac/lane-6', base: 'main', state: 'would dispatch' },
      { kind: 'develop', card: 'AUTO-SALON sprint', unit: 'U2 #1517', lane: 'lanes-01/lane-3', base: 'main', state: 'would dispatch' },
    ], 'the build goes to a full lane; label no-build lets the default-branch unit use the light lane');
    assert.equal(api.summary.autoDispatchOn, false, 'only autoDispatch:true in settings enables sends');

    const text = await (await fetch(board.base + '/api/pipeline')).text();
    assert.match(text, /develop,AUTO-SALON sprint,U1 #1516,mac\/lane-6,main,would dispatch/);
    assert.match(board.output(), /auto-dispatch: would dispatch U1 #1516 -> mac\/lane-6 from main \(autoDispatch: true in the settings to send\)/);
    assert.equal((board.output().match(/would dispatch U1 #1516/g) ?? []).length, 1, 'the dry-run hint is logged once, not every sweep');
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')), 'dry-run never creates the journal');
  } finally {
    await board.stop();
  }
});

test('a merged sprint dispatches QA; qa-run waits for merged dependencies and uses a browser host from main', async () => {
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false },
    files: { 'sprint-facts.json': mergedFacts(), 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  try {
    const id = await createTicketed(board, { title: 'AUTO-SHOP sprint', umbrella: MERGED_UMBRELLA });
    const before = await until(board.base, body => body.cards.find(card => card.id === id)?.stage === 'merged'
      && (body.autoDispatch ?? []).some(row => row.unit === 'QA #2602' && row.state === 'would dispatch'));
    assert.equal(before.cards.find(card => card.id === id).stage, 'merged');
    assert.ok(!before.autoDispatch.some(row => row.unit === 'QA #2604' && row.state === 'would dispatch'), 'an open dependency PR is not enough for qa-run');

    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(mergedFacts({ dependencyMerged: true }), null, 2));
    let after;
    try {
      after = await until(board.base, body => (body.autoDispatch ?? []).some(row => row.unit === 'QA #2604' && row.state === 'would dispatch'));
    } catch (error) {
      throw new Error(`${error.message}\nboard output:\n${board.output()}`);
    }
    assert.deepEqual(after.autoDispatch.find(row => row.unit === 'QA #2604'), {
      kind: 'develop', card: 'AUTO-SHOP sprint', unit: 'QA #2604', lane: 'mac/lane-6', base: 'main', state: 'would dispatch',
    }, 'qa-run ignores the dependency head as a base and selects the browser host');
    assert.equal(after.autoDispatch.find(row => row.unit === 'QA #2602').lane, 'lanes-01/lane-1', 'ordinary QA work in merged still uses ordinary capacity');
  } finally {
    await board.stop();
  }
});

test('autoDispatch:true writes launching first, then a rules-backed task and kind-round journal entry', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-dispatch-tools-'));
  let board;
  try {
    const ticket = {
      number: 1516,
      title: 'SALON-U1: first unit',
      url: 'https://github.com/acme/web/issues/1516',
      body: 'Part of #1515.\n\nBuild the first unit exactly as ticketed.',
    };
    const fakeGh = await executable(toolsDir, 'gh', `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === 'issue' && a[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});\n`);
    const slowSsh = await executable(toolsDir, 'ssh', '#!/usr/bin/env node\nsetTimeout(() => {}, 1000);\n');
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const fleet = {
      prompt: FLEET.prompt,
      hosts: { mac: { ...FLEET.hosts.mac, check: 'npm run host-check' } },
      lanes: { 'lane-6': FLEET.lanes['lane-6'] },
    };
    const facts = {
      ...TICKETED_FACTS,
      lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
      unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', check: 'npm run config-check',
        telegram: OWNER_TELEGRAM,
        hosts: { mac: { target: 'mock-mac' } },
      },
      files: { 'sprint-facts.json': facts, 'fleet-launch.json': fleet },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '300',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: slowSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
    await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const launching = await readJsonUntil(journalFile, value => value?.dispatched?.['1516:develop:1']?.result === 'launching');
    assert.equal(launching.dispatched['1516:develop:1'].lane, 'mac/lane-6', 'intent is durable while the fake launcher is still sleeping');

    const taskFile = path.join(board.dir, 'auto-dispatch', 'TASK-1516.md');
    const task = await readTextUntil(taskFile, value => value.includes('# TICKET #1516 — verbatim'));
    const firstTen = task.split('\n').slice(0, 10).join('\n');
    assert.match(firstTen, /^Role: lane$/m);
    assert.match(firstTen, /^Check: npm run host-check$/m, 'fleet host check overrides the board-wide check');
    assert.match(firstTen, /^Rules: docs\/RULES\.md @ [0-9a-f]{7,}$/m);
    assert.match(task, /Never write `Closes #`/);
    assert.match(task, /Branch: `feat\/1516`/, 'the source default branch reaches the constructed task');
    assert.match(task, /Build the first unit exactly as ticketed\./, 'the ticket body is verbatim');

    const launched = await readJsonUntil(journalFile, value => value?.dispatched?.['1516:develop:1']?.result === 'launched');
    assert.deepEqual({
      kind: launched.dispatched['1516:develop:1'].kind,
      round: launched.dispatched['1516:develop:1'].round,
      head: launched.dispatched['1516:develop:1'].head,
      host: launched.dispatched['1516:develop:1'].host,
    }, { kind: 'develop', round: 1, head: null, host: 'mac' });
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a failed launch retries on another host within two sweeps without an idle-lanes alarm', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-launch-retry-tools-'));
  let board;
  try {
    const ticket = {
      number: 1516,
      title: 'SALON-U1: first unit',
      url: 'https://github.com/acme/web/issues/1516',
      body: 'Part of #1515.\n\nBuild the first unit exactly as ticketed.',
    };
    const fakeGh = await executable(toolsDir, 'gh', `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === 'issue' && a[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});\n`);
    const release = path.join(toolsDir, 'release-host-b');
    const fakeSsh = await executable(toolsDir, 'ssh', `#!/usr/bin/env node
const args = process.argv.slice(2);
const release = ${JSON.stringify(release)};
const deadline = Date.now() + 8000;
import('node:fs').then(({ existsSync }) => {
  if (!args.includes('mock-a')) process.exit(0);
  const timer = setInterval(() => {
    if (existsSync(release)) {
      clearInterval(timer);
      process.stderr.write('ssh: connect to host A port 22: Connection timed out');
      process.exit(255);
    }
    if (Date.now() >= deadline) { clearInterval(timer); process.exit(124); }
  }, 20);
});
`);
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const fleet = {
      prompt: FLEET.prompt,
      hosts: {
        hostA: { kitchen: '/tmp/kitchens/web', launch: 'host-a-lane {n} "{prompt}"' },
        hostB: { kitchen: '/tmp/kitchens/web', launch: 'host-b-lane {n} "{prompt}"' },
      },
      lanes: {
        'lane-1': { host: 'hostA', n: 1 },
        'lane-2': { host: 'hostB', n: 2 },
      },
    };
    const facts = {
      ...TICKETED_FACTS,
      lanes: [
        { host: 'hostA', lane: 'lane-1', busy: false, since: null, branch: 'main' },
        { host: 'hostB', lane: 'lane-2', busy: false, since: null, branch: 'main' },
      ],
      unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        hosts: { hostA: { target: 'mock-a' }, hostB: { target: 'mock-b' } },
      },
      files: { 'sprint-facts.json': facts, 'fleet-launch.json': fleet },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '300',
        WATCHTOWER_IDLE_GRACE_MIN: '1',
        WATCHTOWER_IDLE_REPEAT_MIN: '1',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: fakeSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
    const cardId = await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });
    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    await readJsonUntil(journalFile, value => value?.dispatched?.['1516:develop:1']?.result === 'launching');

    const old = new Date(Date.now() - 2 * 60_000).toISOString();
    const idleFile = path.join(board.dir, 'idle-lanes.json');
    await writeFile(idleFile, JSON.stringify({
      seen: { [`idle:${cardId}`]: { first: old, last: old, alarmedAt: null } },
    }, null, 2));
    await writeFile(release, 'release');

    await readJsonUntil(journalFile, value => value?.dispatched?.['1516:develop:1']?.result === 'failed');
    const failedSweep = await dataUntil(board.base, value => value?.autoDispatch?.rows?.some(row =>
      row.unit === 'U1 #1516' && String(row.state).startsWith('failed ')));
    const sweepAts = new Set([failedSweep.autoDispatch.at]);
    let launched = null;
    const launchDeadline = Date.now() + 8000;
    while (!launched) {
      const [view, journalText] = await Promise.all([
        getJson(board.base, '/pipeline/data'),
        readFile(journalFile, 'utf8'),
      ]);
      if (view.body?.autoDispatch?.at) sweepAts.add(view.body.autoDispatch.at);
      const value = JSON.parse(journalText);
      if (value?.dispatched?.['1516:develop:2']?.result === 'launched') launched = value;
      if (Date.now() > launchDeadline) throw new Error('the retry was not launched within the board fixture timeout');
      if (!launched) await new Promise(resolve => setTimeout(resolve, 25));
    }
    const launchedSweep = await dataUntil(board.base, value => value?.autoDispatch?.at !== failedSweep.autoDispatch.at
      && value?.autoDispatch?.rows?.some(row => row.unit === 'U1 #1516' && String(row.state).startsWith('launched ')));
    sweepAts.add(launchedSweep.autoDispatch.at);
    assert.equal(sweepAts.size, 2, 'the failed sweep is followed directly by the retry sweep');
    await readJsonUntil(idleFile, value => value?.seen && Object.keys(value.seen).length === 0);
    assert.deepEqual(Object.keys(launched.dispatched), ['1516:develop:1', '1516:develop:2']);
    assert.deepEqual({
      first: launched.dispatched['1516:develop:1'].result,
      firstHost: launched.dispatched['1516:develop:1'].host,
      second: launched.dispatched['1516:develop:2'].result,
      secondHost: launched.dispatched['1516:develop:2'].host,
      retryOf: launched.dispatched['1516:develop:2'].retryOf,
    }, {
      first: 'failed', firstHost: 'hostA', second: 'launched', secondHost: 'hostB',
      retryOf: '1516:develop:1',
    });
    assert.match(
      board.output(),
      /auto-dispatch: FAILED U1 #1516 -> hostA\/lane-1[\s\S]*auto-dispatch: LAUNCHED U1 #1516 -> hostB\/lane-2/,
    );
    assert.doesNotMatch(board.output(), /idle lanes: ALARM[^\n]*U1 #1516/);
    const api = (await getJson(board.base, '/api/pipeline?format=json')).body;
    assert.equal(api.cards.find(card => Number(card.ticket) === 1516)?.consecutiveFails, 0);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a missing committed RULES.md holds the sweep before any launch is journalled', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-no-rules-tools-'));
  let board;
  try {
    const fakeGit = await executable(toolsDir, 'git', '#!/usr/bin/env node\nprocess.exit(1);\n');
    const facts = {
      ...TICKETED_FACTS,
      lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
      unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
    };
    const fleet = {
      prompt: FLEET.prompt,
      hosts: { mac: FLEET.hosts.mac },
      lanes: { 'lane-6': FLEET.lanes['lane-6'] },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, telegram: OWNER_TELEGRAM,
        hosts: { mac: { target: 'unused' } },
      },
      files: { 'sprint-facts.json': facts, 'fleet-launch.json': fleet },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '300',
        WATCHTOWER_GIT: fakeGit,
      }),
    });
    await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });
    const api = await until(board.base, body => (body.autoDispatch ?? []).some(row => row.unit === 'U1 #1516'
      && row.state === 'held: docs/RULES.md is not committed'));
    assert.equal(api.summary.autoDispatchOn, true);
    assert.deepEqual(api.autoDispatch.find(row => row.unit === 'U1 #1516'), {
      kind: 'develop', card: 'AUTO-SALON sprint', unit: 'U1 #1516', lane: 'mac/lane-6', base: '-',
      state: 'held: docs/RULES.md is not committed',
    });
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')), 'the rules hold happens before the launching write');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a held unit is not an idle lane', async () => {
  // The only free lane is the light one and the only queued unit needs a
  // build: the planner already says why, so the watch has nothing to alarm on.
  const facts = {
    ...TICKETED_FACTS,
    lanes: [{ host: 'lanes-01', lane: 'lane-3', busy: false, since: null, branch: 'main' }],
    unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: { 'sprint-facts.json': facts, 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
      WATCHTOWER_IDLE_GRACE_MIN: '1',
      WATCHTOWER_IDLE_REPEAT_MIN: '1',
    }),
  });
  try {
    const cardId = await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeFile(path.join(board.dir, 'idle-lanes.json'), JSON.stringify({
      seen: { [`idle:${cardId}`]: { first: old, last: old, alarmedAt: null } },
    }, null, 2));

    const api = await until(board.base, body => (body.autoDispatch ?? []).some(row => row.unit === 'U1 #1516'
      && row.state === 'held: only light lanes (no builds) are free: lanes-01/lane-3'));
    assert.deepEqual(api.idleLanes, [], 'a unit the planner holds is not waiting with nothing in the way');
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.doesNotMatch(board.output(), /idle lanes: ALARM/);
  } finally {
    await board.stop();
  }
});

test('the idle watch still alarms when the planner produced neither a pair nor a reason', async () => {
  const facts = {
    ...TICKETED_FACTS,
    lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
    unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
  };
  const board = await startBoard({
    config: { source: 'probe' },
    files: { 'sprint-facts.json': facts, 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
      WATCHTOWER_IDLE_GRACE_MIN: '1',
      WATCHTOWER_IDLE_REPEAT_MIN: '1',
    }),
  });
  try {
    const cardId = await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await writeFile(path.join(board.dir, 'idle-lanes.json'), JSON.stringify({
      seen: { [`idle:${cardId}`]: { first: old, last: old, alarmedAt: null } },
    }, null, 2));
    await until(board.base, () => /idle lanes: ALARM[^\n]*U1 #1516/.test(board.output()));
  } finally {
    await board.stop();
  }
});

test('main red holds develop, announces once, and resumes', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-main-red-tools-'));
  let board;
  try {
    const ticket = {
      number: 1516,
      title: 'SALON-U1: first unit',
      url: 'https://github.com/acme/web/issues/1516',
      body: 'Part of #1515.\n\nBuild the first unit exactly as ticketed.',
    };
    const fakeGh = await executable(toolsDir, 'gh', `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === 'issue' && a[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});\n`);
    const fakeSsh = await executable(toolsDir, 'ssh', '#!/usr/bin/env node\n');
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const fleet = {
      prompt: FLEET.prompt,
      hosts: { mac: FLEET.hosts.mac },
      lanes: { 'lane-6': FLEET.lanes['lane-6'] },
    };
    const mainCi = {
      conclusion: 'failure', red: true,
      createdAt: '2026-08-30T14:34:15Z',
      url: 'https://github.com/acme/web/actions/runs/1',
      headSha: '339ca1e1339ca1e1339ca1e1339ca1e1339ca1e1',
    };
    const redFacts = {
      ...TICKETED_FACTS,
      lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
      unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
      mainCi,
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        hosts: { mac: { target: 'mock-mac' } },
      },
      files: { 'sprint-facts.json': redFacts, 'fleet-launch.json': fleet },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '300',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: fakeSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
    await createTicketed(board, { title: 'AUTO-SALON sprint', umbrella: TICKETED_UMBRELLA });

    const held = 'held: main is red since 2026-08-30T14:34:15Z (https://github.com/acme/web/actions/runs/1)';
    await until(board.base, body => (body.autoDispatch ?? []).some(row => row.unit === 'U1 #1516' && row.state === held));
    await new Promise(resolve => setTimeout(resolve, 900));
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')), 'a red main sends no lane task');
    const redLine = /ALARM main is red since 2026-08-30T14:34:15Z/g;
    assert.equal((board.output().match(redLine) ?? []).length, 1, 'one line per transition, not one per sweep');
    assert.equal((board.output().match(/--- notifyOwner ---/g) ?? []).length, 1);

    await writeFile(path.join(board.dir, 'sprint-facts.json'),
      JSON.stringify({ ...redFacts, mainCi: { ...mainCi, conclusion: 'success', red: false } }, null, 2));
    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    await readJsonUntil(journalFile, value => value?.dispatched?.['1516:develop:1']?.result === 'launched');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((board.output().match(/ALARM main is green again at 339ca1e1/g) ?? []).length, 1);
    assert.equal((board.output().match(redLine) ?? []).length, 1);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});
