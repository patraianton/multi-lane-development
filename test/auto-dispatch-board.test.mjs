// Auto-dispatch on the real board process: settings own the switch, ticketed
// and merged cards both schedule work, and a live launch persists its intent
// before any remote command can finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, getJson, postJson, startBoard, until } from './helpers.mjs';
import { sweepStuck } from '../bin/pipeline.mjs';

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

test('the stuck check requires a busy source with a real old start time', () => {
  const now = 10_000;
  const stuckMs = 5_000;
  assert.equal(sweepStuck({ busy: true, startedAt: 4_000 }, now, stuckMs), true);
  assert.equal(sweepStuck({ busy: true, startedAt: 0 }, now, stuckMs), false);
  assert.equal(sweepStuck({ busy: false, startedAt: 4_000 }, now, stuckMs), false);
});

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

test('a hung sweep leaves the API alive, ages the heartbeat, and alarms once', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-hung-sweep-tools-'));
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', '#!/usr/bin/env node\nsetTimeout(() => {}, 15000);\n');
    const facts = {
      ...TICKETED_FACTS,
      lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
      unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
      },
      files: { 'sprint-facts.json': facts, 'fleet-launch.json': FLEET },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });

    const before = await until(board.base, body => body.swept?.at ? body : null);
    await createTicketed(board, { title: 'HUNG-SWEEP sprint', umbrella: TICKETED_UMBRELLA });
    try {
      await until(() => /ALARM the board's sweep has not finished for \d+ min/.test(board.output()));
    } catch (error) {
      throw new Error(`${error.message}\nboard output:\n${board.output()}`);
    }

    const first = await until(board.base, body => body.swept?.stuck ? body : null);
    assert.ok(Date.parse(first.swept.at) >= Date.parse(before.swept.at));
    assert.equal(first.swept.stuck, true);
    assert.ok(first.swept.ageMs >= 20 * 200, 'the completed-sweep age keeps growing');
    const page = (await getJson(board.base, '/pipeline/data')).body;
    assert.equal(page.swept.at, first.swept.at, 'the page and agent API use the same heartbeat');
    assert.ok(Math.abs(page.swept.ageMs - first.swept.ageMs) < 1000);
    const text = await (await fetch(board.base + '/api/pipeline')).text();
    assert.match(text, /^swept: .* \(age /m);
    const html = await (await fetch(board.base + '/')).text();
    assert.match(html, /classList\.toggle\('stale', swept\.stuck === true\)/,
      'the header turns the shared heartbeat red at the stuck threshold');

    await new Promise(resolve => setTimeout(resolve, 700));
    const later = (await getJson(board.base, '/api/pipeline?format=json')).body;
    assert.equal(later.swept.at, first.swept.at, 'a hung sweep cannot refresh the completed-sweep heartbeat');
    assert.ok(later.swept.ageMs > first.swept.ageMs, 'the heartbeat age grows while the API keeps answering');
    assert.equal((board.output().match(/ALARM the board's sweep has not finished/g) ?? []).length, 1,
      'one stuck episode produces one alarm even though every timer sees it');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

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
      /auto-dispatch: FAILED develop R1 U1 #1516 -> hostA\/lane-1[\s\S]*auto-dispatch: LAUNCHED develop R2 U1 #1516 -> hostB\/lane-2/,
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
  const cardId = 'idle-watch-sprint';
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const facts = {
    ...TICKETED_FACTS,
    lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
    unitIssues: { 1515: [TICKETED_FACTS.unitIssues[1515][0]] },
  };
  const board = await startBoard({
    config: { source: 'probe' },
    files: {
      'sprint-facts.json': facts,
      'fleet-launch.json': FLEET,
      'pipeline-cards.json': { cards: [{
        id: cardId,
        title: 'AUTO-SALON sprint',
        spec: 'the spec',
        stage: 'ticketed',
        links: { ticket: TICKETED_UMBRELLA },
      }] },
      'idle-lanes.json': {
        seen: { [`idle:${cardId}`]: { first: old, last: old, alarmedAt: null } },
      },
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
      WATCHTOWER_IDLE_GRACE_MIN: '1',
      WATCHTOWER_IDLE_REPEAT_MIN: '1',
    }),
  });
  try {
    await until(() => /idle lanes: ALARM[^\n]*U1 #1516/.test(board.output()));
  } finally {
    await board.stop();
  }
});

test('fix debt not dispatched for 30 minutes forces the unit Stuck and notifies once', async () => {
  const sprintId = 'fix-debt-sprint';
  const unitId = 'fix-debt-unit';
  const head = 'abc1234500000000000000000000000000000000';
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  const facts = {
    ...TICKETED_FACTS,
    lanes: [{ host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' }],
    prs: [{
      number: 1616, url: 'https://github.com/acme/web/pull/1616', branch: 'feat/1516', headSha: head,
      ci: { color: 'green', headSha: head }, mergeable: 'MERGEABLE',
      verdictOnHead: { round: 2, go: false, head, at: new Date(Date.now() - 32 * 60_000).toISOString(), body: `R2 — NO-GO\nhead ${head}` },
      verdictRounds: 2,
    }],
    unitIssues: { 1515: [{ ...TICKETED_FACTS.unitIssues[1515][0], branch: 'feat/1516' }] },
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: {
      'sprint-facts.json': facts,
      'fleet-launch.json': FLEET,
      'pipeline-cards.json': { cards: [
        { id: sprintId, title: 'FIX-DEBT sprint', spec: 'the spec', stage: 'development', links: { ticket: TICKETED_UMBRELLA } },
        { id: unitId, title: 'U1 #1516', spec: '', stage: 'ci_pr', parent: sprintId, ticket: 1516, links: { ticket: 'https://github.com/acme/web/issues/1516', pr: 'https://github.com/acme/web/pull/1616', branch: 'feat/1516' } },
      ] },
      'auto-dispatch.json': { dispatched: { '1516:fix:abc12345': {
        ticket: 1516, kind: 'fix', round: 1, head, result: 'launched', judged: 'ok',
        at: new Date(Date.now() - 40 * 60_000).toISOString(), lane: 'lanes-01/lane-1', host: 'lanes-01',
      } } },
      'idle-lanes.json': { seen: { [`fix-debt:${sprintId}:1516:${head.slice(0, 8)}`]: { first: old, last: old, alarmedAt: null } } },
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  try {
    const api = await until(board.base, body => body.cards?.some(card => card.id === unitId && card.stage === 'stuck'));
    assert.equal(api.cards.find(card => card.id === unitId).stage, 'stuck');
    const stored = await readJsonUntil(path.join(board.dir, 'pipeline-cards.json'), value =>
      value?.cards?.some(card => card.id === unitId && card.stage === 'stuck'));
    assert.equal(stored.cards.find(card => card.id === unitId).stageHistory.at(-1).reason,
      'fix debt on head abc12345 not dispatched for 30 min');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((board.output().match(/--- notifyStuck ---/g) ?? []).length, 1);
    assert.match(board.output(), /fix debt: STUCK U1 #1516 — fix debt on head abc12345 not dispatched for 30 min/);
  } finally {
    await board.stop();
  }
});

test('the planner\'s holds and live rows reach the card sentence; a no-free-lane hold suppresses fix-debt Stuck', async () => {
  const sprintId = 'held-fix-debt-sprint';
  const head = ticket => `${ticket.toString(16).padStart(8, 'a')}${'0'.repeat(32)}`;
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  const tickets = [1516, 1517, 1518, 1519];
  const issues = tickets.map(ticket => ({
    number: ticket, title: `SALON-U${ticket - 1515}: unit`, url: `https://github.com/acme/web/issues/${ticket}`,
    state: 'OPEN', branch: `feat/${ticket}`, labels: [],
  }));
  const prs = tickets.map(ticket => ({
    number: ticket + 100, url: `https://github.com/acme/web/pull/${ticket + 100}`, branch: `feat/${ticket}`,
    headSha: head(ticket), mergeable: 'MERGEABLE', verdictRounds: ticket === 1516 ? 1 : 0,
    ci: { color: ticket >= 1518 ? 'red' : 'green', headSha: head(ticket), failedNames: ticket >= 1518 ? ['test'] : [] },
    verdictOnHead: ticket === 1516
      ? { round: 1, go: false, head: head(ticket), at: '2026-08-31T05:00:00.000Z' }
      : null,
  }));
  const journal = { dispatched: {
    [`1516:fix:${head(1516).slice(0, 8)}`]: { ticket: 1516, kind: 'fix', round: 1, head: head(1516), result: 'launched', judged: 'ok', at: '2026-08-31T05:30:00.000Z' },
    [`1517:review:${head(1517).slice(0, 8)}`]: { ticket: 1517, kind: 'review', round: 1, head: head(1517), result: 'launched', judged: 'ok', at: '2026-08-31T05:30:00.000Z' },
    [`1518:fix:${head(1518).slice(0, 8)}`]: {
      ticket: 1518, kind: 'fix', round: 1, head: head(1518), result: 'launched',
      lane: 'mac/lane-6', host: 'mac', at: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
  } };
  const facts = {
    ...TICKETED_FACTS, lanes: [], prs, unitIssues: { 1515: issues },
  };
  const cards = [
    { id: sprintId, title: 'HELD-FIX-DEBT sprint', spec: 'the spec', stage: 'development', links: { ticket: TICKETED_UMBRELLA } },
    ...tickets.map(ticket => ({
      id: `held-unit-${ticket}`, title: `U${ticket - 1515} #${ticket}`, spec: '', stage: 'ci_pr', parent: sprintId, ticket,
      links: { ticket: `https://github.com/acme/web/issues/${ticket}`, pr: `https://github.com/acme/web/pull/${ticket + 100}`, branch: `feat/${ticket}` },
    })),
  ];
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: {
      'sprint-facts.json': facts, 'fleet-launch.json': FLEET, 'pipeline-cards.json': { cards },
      'auto-dispatch.json': journal,
      'idle-lanes.json': { seen: { [`fix-debt:${sprintId}:1519:${head(1519).slice(0, 8)}`]: { first: old, last: old, alarmedAt: null } } },
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  try {
    {
      const api = await until(board.base, body => (body.autoDispatch ?? []).some(row => row.unit === 'U4 #1519' && row.state === 'held: no free lane'));
      const stateOf = unit => api.autoDispatch.find(row => row.unit === unit)?.state ?? '';
      assert.match(stateOf('U1 #1516'), /^held: fix of head [0-9a-f]{8} was already dispatched$/);
      assert.match(stateOf('U2 #1517'), /^held: review of head [0-9a-f]{8} was already dispatched$/);
      assert.match(stateOf('U3 #1518'), /^held: fix of head [0-9a-f]{8} is running — the review waits for a new head$/);
      assert.doesNotMatch(board.output(), /auto-dispatch: HELD/);
    }
    const page = await until(board.base, body => body.cards?.find(c => c.ticket === 1519)?.status?.text?.endsWith('— no free lane'), { pathName: '/pipeline/data' });
    const textOf = ticket => page.cards.find(c => c.ticket === ticket).status.text;
    assert.match(textOf(1516), /^PR #1616 NO-GO R1 — fix of head [0-9a-f]{8} was already dispatched$/);
    assert.match(textOf(1517), /^PR #1617 open — review of head [0-9a-f]{8} was already dispatched$/);
    assert.equal(textOf(1518), 'PR #1618 red checks (test) — fix on mac/lane-6');
    assert.equal(textOf(1519), 'PR #1619 red checks (test) — no free lane');
    await new Promise(resolve => setTimeout(resolve, 700));
    const api = (await getJson(board.base, '/pipeline/data')).body;
    assert.notEqual(api.cards.find(card => card.ticket === 1519)?.stage, 'stuck');
    assert.doesNotMatch(board.output(), /fix debt: STUCK U4 #1519/);
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

test('a dependency on a stuck unit is visible on the dispatch table', async () => {
  const umbrella = 'https://github.com/acme/web/issues/1685';
  const facts = {
    ...TICKETED_FACTS,
    unitIssues: {
      1685: [
        { number: 1686, title: 'TABLES-U1: parked tables', url: 'https://github.com/acme/web/issues/1686', state: 'OPEN', branch: '', labels: [] },
        { number: 1687, title: 'TABLES-U2: consumer', url: 'https://github.com/acme/web/issues/1687', state: 'OPEN', branch: '', labels: [], deps: [1686] },
      ],
    },
    umbrellaStates: { 1685: 'OPEN' },
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: { 'sprint-facts.json': facts, 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  try {
    const parent = await createTicketed(board, { title: 'AUTO-TABLES sprint', umbrella });
    const synced = await until(board.base, body => body.cards.filter(card => card.parent === parent).length === 2);
    const dependency = synced.cards.find(card => card.parent === parent && card.ticket === 1686);
    assert.ok(dependency);
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id: dependency.id, to: 'development' })).status, 200);
    for (let round = 1; round <= 3; round++) {
      const failed = await postJson(board.base, '/pipeline/card/fail', {
        id: dependency.id, kind: 'review', reason: `R${round} — NO-GO`,
      });
      assert.equal(failed.status, 200);
    }

    const api = await until(board.base, body => (body.autoDispatch ?? []).some(row =>
      row.unit === 'U2 #1687' && row.state === 'held: waits for #1686 (stuck)'));
    assert.equal(api.cards.find(card => card.id === dependency.id).stage, 'stuck');
    const u2 = await until(board.base, body => body.cards?.find(c => c.ticket === 1687)?.status?.text === 'queued — waits for #1686 (stuck)', { pathName: '/pipeline/data' });
    assert.ok(u2);
  } finally {
    await board.stop();
  }
});
