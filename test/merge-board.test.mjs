// The real board process owns the merge side effect: exact-head facts enter
// the journal before a portable fake gh receives the squash command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, getJson, journalUntil, postJson, startBoard, until } from './helpers.mjs';

const HEAD = 'abc12345abcdef0123456789abcdef0123456789';
const OTHER = 'def12345abcdef0123456789abcdef0123456789';
const UMBRELLA = 'https://github.com/acme/web/issues/1600';
const OWNER_TELEGRAM = {
  dryRun: true,
  chatId: '-1',
  ownerChatId: '1',
  founders: [{ name: 'Owner', tgUserId: 1, tag: '@owner', owner: true }],
};

function facts(verdictHead = 'abc12345') {
  const verdict = {
    round: 1,
    go: true,
    head: verdictHead,
    at: '2026-08-30T10:00:00.000Z',
    body: `R1 — GO\nhead ${verdictHead}`,
  };
  return {
    lanes: [],
    prs: [{
      number: 1632,
      url: 'https://github.com/acme/web/pull/1632',
      branch: 'feat/1624',
      headSha: HEAD,
      title: 'Board merge fixture #3',
      // Long on purpose: a real PR body ran to 61 KB on 30.08 and an argument
      // that size is an OS error, not a merge.
      body: 'Summary & details\n\nTicket: #1624\n' + 'x'.repeat(5000),
      draft: false,
      mergeable: 'MERGEABLE',
      labels: [],
      ci: { color: 'green', text: 'CI green (1)', headSha: HEAD },
      verdict,
      verdicts: [verdict],
      verdictOnHead: verdictHead === 'abc12345' ? verdict : null,
      verdictRounds: 1,
    }],
    mergedPrs: [],
    openIssues: [],
    unitIssues: {
      1600: [{
        number: 1624,
        title: 'UNIT-U1: board merge fixture',
        url: 'https://github.com/acme/web/issues/1624',
        state: 'OPEN',
        branch: 'feat/1624',
        labels: [],
      }],
    },
    ciJobs: {},
    ciRunners: [],
    umbrellaStates: { 1600: 'OPEN' },
    staleSources: [],
  };
}

async function createTicketed(board) {
  const made = await postJson(board.base, '/pipeline/card/create', { title: 'MERGE sprint', spec: 'fixture' });
  const id = made.body.card.id;
  await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
  await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
  await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
  return id;
}

async function calls(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function redMainFacts() {
  return {
    ...facts(),
    mainCi: {
      databaseId: 987,
      headSha: HEAD,
      url: 'https://github.com/acme/web/actions/runs/987',
      createdAt: '2026-08-30T12:00:00.000Z',
      red: true,
    },
  };
}

test('a red main alarm names the first failed jobs', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-red-main-tools-'));
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      'const a = process.argv.slice(2);',
      "if (a[0] === 'api' && a[1] === 'repos/acme/web/actions/runs/987/jobs?per_page=100') {",
      "  process.stdout.write(JSON.stringify([",
      "    { name: 'listing-photos-ui', failedSteps: ['photos render'] },",
      "    { name: 'listing-questionnaire-i18n', failedSteps: ['translations render'] },",
      "  ]));",
      '}',
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': redMainFacts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await until(() => board.output().includes('telegram: alarm sent (main:red:'));
    assert.match(board.output(), /telegram: alarm sent \(main:red:abc12345/);
    await until(() => /ALARM main is red.*listing-photos-ui, listing-questionnaire-i18n/.test(board.output()));
    const output = board.output();
    assert.doesNotMatch(output, /photos render|translations render/, 'job names take priority over their failed steps');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a failed red-main details lookup still fires the original alarm', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-red-main-failed-tools-'));
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', '#!/usr/bin/env node\nprocess.exit(1);\n');
    board = await startBoard({
      config: { source: 'probe', repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': redMainFacts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const original = 'main is red since 2026-08-30T12:00:00.000Z (https://github.com/acme/web/actions/runs/987) — the board holds every lane task based on main';
    await until(() => /ALARM main is red since 2026-08-30T12:00:00\.000Z \(https:\/\/github\.com\/acme\/web\/actions\/runs\/987\) — the board holds every lane task based on main/.test(board.output()));
    const output = board.output();
    assert.match(output, new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(output, /failing:/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a base-moved refusal retries the squash merge and journals its eventual success', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower merge tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync, readFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      `let old = ''; try { old = readFileSync(${JSON.stringify(callsFile)}, 'utf8'); } catch {}`,
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(a) + '\\n');`,
      "if (a[1] === 'merge' && !old.split(/\\r?\\n/).some(line => line.includes('\\\"merge\\\"'))) {",
      "  process.stderr.write('Base branch was modified. Review and try the merge again.\\n');",
      '  process.exit(1);',
      '}',
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sprintId = await createTicketed(board);
    const synced = await until(board.base,
      body => body.cards.some(card => card.parent === sprintId && card.ticket === 1624));
    const syncedUnit = synced.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    assert.equal(syncedUnit.stage, 'ci_pr');

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const journal = await journalUntil(journalFile,
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merged');
    assert.deepEqual(
      [journal.dispatched['1624:merge:abc12345'].pr, journal.dispatched['1624:merge:abc12345'].attempts],
      [1632, 2],
    );

    const api = await until(board.base,
      body => body.autoDispatch?.some(row => row.kind === 'merge' && row.state === 'merged at abc12345'));
    assert.deepEqual(api.autoDispatch.find(row => row.kind === 'merge'), {
      kind: 'merge', card: 'MERGE sprint', unit: 'PR #1632', lane: '-', base: 'abc12345', state: 'merged at abc12345',
    });

    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 2,
      'the base-moved refusal is retried once, then the stale open-PR fact cannot merge again');
    assert.equal(ghCalls.filter(args => args[1] === 'update-branch').length, 0);
    assert.deepEqual(ghCalls.map(args => args.slice(0, 2)), [
      ['pr', 'merge'], ['pr', 'merge'],
    ]);
    const merge = ghCalls[1];
    assert.ok(merge.includes('--squash'));
    assert.equal(merge[merge.indexOf('--match-head-commit') + 1], HEAD);
    const expectedBody = 'Summary & details\n\nTicket: #1624\n' + 'x'.repeat(5000);
    for (const args of [merge]) {
      assert.ok(args.includes('--body-file'), 'the squash body travels as a file');
      assert.ok(!args.includes('--body'), 'the PR body never reaches a command line again');
      assert.equal(await readFile(args[args.indexOf('--body-file') + 1], 'utf8'), expectedBody);
      assert.ok(Math.max(...args.map(a => a.length)) < 1000, 'no single argument can carry the body');
    }
    assert.match(board.output(), /merge: PR #1632 squash-merged at abc12345/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a GO naming another head does not call gh or create a merge journal key', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-wrong-head-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts(OTHER.slice(0, 8)) },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sprintId = await createTicketed(board);
    const api = await until(board.base, body => body.cards.some(card => card.parent === sprintId && card.ticket === 1624));
    const unitCard = api.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    const page = (await getJson(board.base, '/pipeline/data')).body;
    assert.equal(page.cards.find(card => card.id === unitCard.id).unitFacts.state, 'pr green',
      'the wrong-head GO is display history, not the current PR state');
    assert.equal(unitCard.fails, '-');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a no-review label merges one green check without any verdict', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-no-review-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const noReviewFacts = facts();
    noReviewFacts.prs[0].verdict = null;
    noReviewFacts.prs[0].verdicts = [];
    noReviewFacts.prs[0].verdictOnHead = null;
    noReviewFacts.prs[0].verdictRounds = 0;
    noReviewFacts.unitIssues[1600][0].labels = ['no-review'];
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': noReviewFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const journal = await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merged');
    assert.equal(journal.dispatched['1624:merge:abc12345'].pr, 1632);
    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    const merge = ghCalls.find(args => args[0] === 'pr' && args[1] === 'merge');
    assert.ok(merge, 'the squash merge ran with no verdict comment anywhere');
    assert.equal(merge[merge.indexOf('--match-head-commit') + 1], HEAD);
    assert.match(board.output(), /merge: PR #1632 squash-merged at abc12345/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('without the label the same verdict-free facts still wait for the verdict', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-verdict-gate-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const gatedFacts = facts();
    gatedFacts.prs[0].verdict = null;
    gatedFacts.prs[0].verdicts = [];
    gatedFacts.prs[0].verdictOnHead = null;
    gatedFacts.prs[0].verdictRounds = 0;
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': gatedFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sprintId = await createTicketed(board);
    await until(board.base, body => body.cards.some(card => card.parent === sprintId
      && card.ticket === 1624 && card.stage === 'ci_pr'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('merge-table rows explain UNKNOWN mergeability and a green-GO draft', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-merge-waits-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const cases = [
      {
        name: 'UNKNOWN mergeability',
        change: value => { value.prs[0].mergeable = 'UNKNOWN'; },
        state: 'GitHub has not computed mergeability yet',
      },
      {
        name: 'draft with green CI and GO',
        change: value => { value.prs[0].draft = true; },
        state: 'draft — waiting for the author',
      },
    ];

    for (const item of cases) {
      const waitingFacts = facts();
      item.change(waitingFacts);
      board = await startBoard({
        config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
        files: { 'sprint-facts.json': waitingFacts },
        env: dir => ({
          WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
          WATCHTOWER_SPRINT_SWEEP_MS: '200',
          WATCHTOWER_GH: fakeGh,
        }),
      });
      const sprintId = await createTicketed(board);
      const api = await until(board.base, body => {
        const row = body.autoDispatch?.find(candidate => candidate.kind === 'merge');
        const unit = body.cards.find(candidate => candidate.parent === sprintId && candidate.ticket === 1624);
        return row?.state === item.state && unit?.status?.text === `PR #1632 green + GO — ${item.state}`;
      });
      assert.deepEqual(api.autoDispatch.find(row => row.kind === 'merge'), {
        kind: 'merge', card: 'MERGE sprint', unit: 'PR #1632', lane: '-', base: 'abc12345', state: item.state,
      }, item.name);
      await board.stop();
      board = null;
    }
    assert.deepEqual(await calls(callsFile), []);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a PR-side hold-merge produces only the owner table line and skips every pre-merge action', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-held-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const heldFacts = facts();
    // The ticket's no-review path changes nothing: the PR-side hold always wins.
    heldFacts.unitIssues[1600][0].labels = ['no-review'];
    heldFacts.prs[0].labels = ['hold-merge'];
    heldFacts.prs[0].ci = { color: 'red', text: 'CI red (1)', headSha: HEAD };
    heldFacts.prs[0].mergeable = 'UNKNOWN';
    const previousFailure = {
      dispatched: {
        '1624:merge:abc12345': {
          card: 'old', title: 'MERGE sprint', unit: 'U1', ticket: 1624,
          branch: 'feat/1624', lane: null, host: null, base: 'abc12345',
          kind: 'merge', round: null, head: HEAD, pr: 1632,
          at: new Date().toISOString(), result: 'merge-failed', error: 'older failure', attempts: 1,
        },
      },
    };
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': heldFacts, 'auto-dispatch.json': previousFailure },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const api = await until(board.base, body => body.autoDispatch?.some(row => row.kind === 'merge'
      && row.state === 'hold-merge — the owner merges by hand'));
    assert.deepEqual(api.autoDispatch.find(row => row.kind === 'merge'), {
      kind: 'merge', card: 'MERGE sprint', unit: 'PR #1632', lane: '-', base: 'abc12345',
      state: 'hold-merge — the owner merges by hand',
    });
    assert.equal(api.autoDispatch.filter(row => row.kind === 'merge').length, 1,
      'the current hold row replaces an older journal row for the same PR head');
    assert.deepEqual(await calls(callsFile), []);
    assert.deepEqual(JSON.parse(await readFile(path.join(board.dir, 'auto-dispatch.json'), 'utf8')), previousFailure);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('an out-of-date merge refusal exhausts three attempts without branch mutation', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-out-of-date-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.stderr.write('Pull request acme/web#1632 is not mergeable: the head branch is not up to date with the base branch\\n');",
      'process.exit(1);',
    ].join('\n'));
    const failingFacts = facts();
    failingFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': failingFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sprintId = await createTicketed(board);
    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const journal = await journalUntil(journalFile, value => {
      const entry = value?.dispatched?.['1624:merge:abc12345'];
      return entry?.result === 'merge-failed' && entry.attempts === 3;
    });
    const refusal = 'Pull request acme/web#1632 is not mergeable: the head branch is not up to date with the base branch';
    assert.equal(journal.dispatched['1624:merge:abc12345'].error, refusal);
    const gaveUp = `gave up after 3 attempts — ${refusal}`;
    const api = await until(board.base, body => body.autoDispatch?.some(row => row.state === gaveUp)
      && body.cards.some(card => card.parent === sprintId && card.ticket === 1624
        && card.status?.text === `PR #1632 green + GO — ${gaveUp}`));
    assert.ok(api.autoDispatch.some(row => row.kind === 'merge' && row.unit === 'PR #1632'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.length, 3, 'the refusal spends only the bounded merge budget');
    assert.ok(ghCalls.every(args => args[0] === 'pr' && args[1] === 'merge'));
    assert.equal(ghCalls.filter(args => ['update-branch', 'view', 'comment'].includes(args[1])).length, 0);
    assert.equal((board.output().match(/merge: PR #1632 failed at abc12345 — .*not up to date/g) ?? []).length, 3);
    const alarm = /ALARM the board gave up merging PR #1632 after 3 attempts: .*not up to date/;
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.match(board.output(), alarm, 'the cap speaks — 45 minutes of silence cannot recur');
    assert.equal((board.output().match(new RegExp(alarm.source, 'g')) ?? []).length, 1,
      'one line per PR head, however many sweeps follow');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('autoDispatch off prints would merge without a GitHub mutation or journal write', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-dry-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: false, repo: 'acme/web' },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const api = await until(board.base, body => body.autoDispatch?.some(row => row.kind === 'merge'
      && row.state === 'would merge PR #1632'));
    assert.equal(api.summary.autoDispatchOn, false);
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
    assert.match(board.output(), /merge: would merge PR #1632 at abc12345/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a merged fact wins over an overlapping stale open-PR fact', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-already-merged-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const overlappingFacts = facts();
    overlappingFacts.mergedPrs = [{
      number: 1632,
      url: 'https://github.com/acme/web/pull/1632',
      branch: 'feat/1624',
      mergedAt: '2026-08-30T10:00:01.000Z',
    }];
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': overlappingFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sprintId = await createTicketed(board);
    await until(board.base, body => body.cards.some(card => card.parent === sprintId && card.ticket === 1624));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('merge automation does not begin before the sprint is ticketed', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-pre-ticket-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const made = await postJson(board.base, '/pipeline/card/create', { title: 'MERGE sprint', spec: 'fixture' });
    const id = made.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
    await until(board.base, body => body.cards.some(card => card.id === id && card.sprint));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a hold on a pre-ticket sibling blocks their shared active PR', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-shared-pr-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const sharedFacts = facts();
    sharedFacts.unitIssues[1700] = [{
      number: 1724,
      title: 'UNIT-U2: pre-ticket sibling on the shared branch',
      url: 'https://github.com/acme/web/issues/1724',
      state: 'OPEN',
      branch: 'feat/1624',
      labels: ['hold-merge'],
    }];
    sharedFacts.umbrellaStates[1700] = 'OPEN';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': sharedFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });

    const held = await postJson(board.base, '/pipeline/card/create', { title: 'HELD sibling', spec: 'fixture' });
    await postJson(board.base, '/pipeline/card/move', { id: held.body.card.id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', {
      id: held.body.card.id,
      links: { ticket: 'https://github.com/acme/web/issues/1700' },
    });
    await until(board.base, body => body.cards.some(card => card.id === held.body.card.id && card.sprint));

    await createTicketed(board);
    const api = await until(board.base, body => body.autoDispatch?.some(row => row.kind === 'merge'
      && row.state === 'hold-merge — the owner merges by hand'));
    assert.equal(api.autoDispatch.filter(row => row.kind === 'merge').length, 1);
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('one sibling without no-review keeps the verdict gate on their shared PR', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-mixed-label-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const mixedFacts = facts();
    mixedFacts.prs[0].verdict = null;
    mixedFacts.prs[0].verdicts = [];
    mixedFacts.prs[0].verdictOnHead = null;
    mixedFacts.prs[0].verdictRounds = 0;
    mixedFacts.unitIssues[1600][0].labels = ['no-review'];
    mixedFacts.unitIssues[1700] = [{
      number: 1724,
      title: 'UNIT-U2: strict sibling on the shared branch',
      url: 'https://github.com/acme/web/issues/1724',
      state: 'OPEN',
      branch: 'feat/1624',
      labels: [],
    }];
    mixedFacts.umbrellaStates[1700] = 'OPEN';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': mixedFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const strict = await postJson(board.base, '/pipeline/card/create', { title: 'STRICT sibling', spec: 'fixture' });
    await postJson(board.base, '/pipeline/card/move', { id: strict.body.card.id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', {
      id: strict.body.card.id,
      links: { ticket: 'https://github.com/acme/web/issues/1700' },
    });
    await postJson(board.base, '/pipeline/card/move', { id: strict.body.card.id, to: 'ticketed' });
    const sprintId = await createTicketed(board);
    await until(board.base, body => [1624, 1724].every(ticket =>
      body.cards.some(card => card.ticket === ticket && card.stage === 'ci_pr')));
    void sprintId;
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await calls(callsFile), []);
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a shared PR merges without a verdict once every sibling carries no-review', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-all-labelled-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    const labelledFacts = facts();
    labelledFacts.prs[0].verdict = null;
    labelledFacts.prs[0].verdicts = [];
    labelledFacts.prs[0].verdictOnHead = null;
    labelledFacts.prs[0].verdictRounds = 0;
    labelledFacts.unitIssues[1600][0].labels = ['no-review'];
    labelledFacts.unitIssues[1700] = [{
      number: 1724,
      title: 'UNIT-U2: labelled sibling on the shared branch',
      url: 'https://github.com/acme/web/issues/1724',
      state: 'OPEN',
      branch: 'feat/1624',
      labels: ['no-review'],
    }];
    labelledFacts.umbrellaStates[1700] = 'OPEN';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': labelledFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    const sibling = await postJson(board.base, '/pipeline/card/create', { title: 'LABELLED sibling', spec: 'fixture' });
    await postJson(board.base, '/pipeline/card/move', { id: sibling.body.card.id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', {
      id: sibling.body.card.id,
      links: { ticket: 'https://github.com/acme/web/issues/1700' },
    });
    await postJson(board.base, '/pipeline/card/move', { id: sibling.body.card.id, to: 'ticketed' });
    await createTicketed(board);
    const journal = await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merged'
        && value?.dispatched?.['1724:merge:abc12345']?.result === 'merged');
    assert.equal(journal.dispatched['1624:merge:abc12345'].pr, 1632);
    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 1,
      'one shared PR is one squash merge, journalled under both tickets');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a moved PR head closes its budget without branch mutation or a gave-up alarm', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-head-moved-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again.\\n');",
      'process.exit(1);',
    ].join('\n'));
    const movedFacts = facts();
    movedFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': movedFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);

    const journal = await journalUntil(path.join(board.dir, 'auto-dispatch.json'), value => {
      const entry = value?.dispatched?.['1624:merge:abc12345'];
      return entry?.attempts === 3 && entry?.error === 'superseded — the PR head moved past this snapshot';
    });
    assert.equal(journal.dispatched['1624:merge:abc12345'].result, 'merge-failed');
    await new Promise(resolve => setTimeout(resolve, 700));
    const ghCalls = await calls(callsFile);
    assert.deepEqual(ghCalls.map(args => args.slice(0, 2)), [['pr', 'merge']]);
    assert.equal(ghCalls.filter(args => args[1] === 'update-branch').length, 0);
    assert.doesNotMatch(board.output(), /gave up merging PR #1632/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a stale merging entry is re-judged from GitHub facts: merged PR → merged, open PR → merge-failed', async () => {
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const freshAt = new Date(Date.now() - 60 * 1000).toISOString();
  const entry = (pr, head, at, attempts) => ({
    card: 'cm', title: 'MERGE sprint', unit: 'U1', ticket: 1624, branch: 'feat/1624',
    lane: null, host: null, base: head.slice(0, 8), kind: 'merge', round: null,
    head, pr, at, result: 'merging', error: null, attempts,
  });
  const rejudgeFacts = facts();
  rejudgeFacts.prs = [{ ...rejudgeFacts.prs[0], number: 1633, headSha: OTHER }];
  rejudgeFacts.mergedPrs = [{ number: 1632, branch: 'feat/1624', headSha: HEAD }];
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: {
      'sprint-facts.json': rejudgeFacts,
      'auto-dispatch.json': { dispatched: {
        '1624:merge:abc12345': entry(1632, HEAD, staleAt, 3),
        '1625:merge:def12345': entry(1633, OTHER, staleAt, 1),
        '1626:merge:aaa12345': entry(1634, HEAD, freshAt, 1),
      } },
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '200',
    }),
  });
  try {
    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const journal = await journalUntil(journalFile, value =>
      value?.dispatched?.['1624:merge:abc12345']?.result === 'merged'
      && value?.dispatched?.['1625:merge:def12345']?.result === 'merge-failed');
    assert.equal(journal.dispatched['1625:merge:def12345'].error,
      'no outcome recorded — re-judged from GitHub facts');
    assert.equal(journal.dispatched['1625:merge:def12345'].attempts, 1,
      'the attempt was already counted — re-judging adds none');
    assert.equal(journal.dispatched['1626:merge:aaa12345'].result, 'merging',
      'a young merging entry may still be a live gh call — left alone');
  } finally {
    await board.stop();
  }
});

test('an active stale merging entry is re-judged now and retried only on the next sweep', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-stale-active-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const storedCards = { cards: [
    { id: 'cm', title: 'MERGE sprint', stage: 'ticketed', links: { ticket: UMBRELLA } },
    { id: 'cu', title: 'UNIT-U1: board merge fixture', stage: 'ci_pr', parent: 'cm', ticket: 1624, unit: 'U1' },
  ] };
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(a) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: {
        'sprint-facts.json': facts(),
        'pipeline-cards.json': storedCards,
        'auto-dispatch.json': { dispatched: {
          '1624:merge:abc12345': {
            card: 'cm', title: 'MERGE sprint', unit: 'U1', ticket: 1624, branch: 'feat/1624',
            lane: null, host: null, base: 'abc12345', kind: 'merge', round: null,
            head: HEAD, pr: 1632, at: staleAt, result: 'merging', error: null, attempts: 1,
          },
        } },
      },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '1200',
        WATCHTOWER_GH: fakeGh,
      }),
    });

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const rejudged = await journalUntil(journalFile, value =>
      value?.dispatched?.['1624:merge:abc12345']?.result === 'merge-failed');
    assert.equal(rejudged.dispatched['1624:merge:abc12345'].attempts, 1);
    assert.equal((await calls(callsFile)).filter(args => args[1] === 'merge').length, 0,
      'the sweep that re-judges a live association does not also retry it');

    const retried = await journalUntil(journalFile, value =>
      value?.dispatched?.['1624:merge:abc12345']?.result === 'merged', 5000);
    assert.equal(retried.dispatched['1624:merge:abc12345'].attempts, 2,
      'the following tick owns the retry');
    assert.equal((await calls(callsFile)).filter(args => args[1] === 'merge').length, 1);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a concurrent hand field survives a merge outcome while board-owned fields win', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-merge-same-entry-tools-'));
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      'const a = process.argv.slice(2);',
      "if (a[1] === 'merge') {",
      "  const file = path.join(process.env.WATCHTOWER_STATE_DIR, 'auto-dispatch.json');",
      "  const journal = JSON.parse(readFileSync(file, 'utf8'));",
      "  journal.dispatched['1624:merge:abc12345'] = {",
      "    ...journal.dispatched['1624:merge:abc12345'],",
      "    note: 'keep this hand note', result: 'hand value', error: 'hand value', attempts: 99,",
      '  };',
      "  writeFileSync(file, JSON.stringify(journal, null, 2));",
      '}',
    ].join('\n'));
    const mergeFacts = facts();
    mergeFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': mergeFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);

    const journal = await journalUntil(path.join(board.dir, 'auto-dispatch.json'), value =>
      value?.dispatched?.['1624:merge:abc12345']?.result === 'merged');
    const entry = journal.dispatched['1624:merge:abc12345'];
    assert.equal(entry.note, 'keep this hand note');
    assert.deepEqual([entry.result, entry.error, entry.attempts], ['merged', null, 1],
      'fresh hand fields do not override the merge writer\'s owned outcome fields');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

// The next two are the 30.08 silence itself: an exception between
// writeResult('merging') and the outcome write left the entry at `merging` for
// 45 minutes with nothing in the log at all.
test('an argument the OS refuses is a failed merge, not an exception through the sweep', async () => {
  let board;
  try {
    const nullByteFacts = facts();
    nullByteFacts.prs[0].body = 'Ticket: #1624';
    // execFile refuses this argument synchronously, exactly as it refused the
    // 61 KB body on 30.08.
    nullByteFacts.prs[0].title = `Board merge fixture ${String.fromCharCode(0)} #3`;
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': nullByteFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        // A real binary: the argument reaches the OS instead of the portable
        // fake's environment channel.
        WATCHTOWER_GH: process.execPath,
      }),
    });
    await createTicketed(board);
    const journal = await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merge-failed');
    assert.match(journal.dispatched['1624:merge:abc12345'].error, /null byte/i);
    assert.match(board.output(), /merge: PR #1632 failed at abc12345 — .*null byte/i);
    assert.doesNotMatch(board.output(), /merge: sweep failed/,
      'execCmd answers with an exit code; nothing escapes the merge step');
  } finally {
    if (board) await board.stop();
  }
});

test('a journal that cannot be read at all holds the merge step, alarms, and the tick goes on', async () => {
  let board;
  try {
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: process.execPath,
      }),
    });
    // A journal that cannot be read or written at all (here: it is a
    // directory). Fail closed: no merge may run blind on a forgotten journal.
    await mkdir(path.join(board.dir, 'auto-dispatch.json'), { recursive: true });
    await createTicketed(board);
    const deadline = Date.now() + 8000;
    for (;;) {
      if (/ALARM state\/auto-dispatch\.json exists but cannot be parsed/.test(board.output())) break;
      if (Date.now() > deadline) throw new Error(`no corrupt-journal alarm:\n${board.output()}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.doesNotMatch(board.output(), /merge: PR #1632/,
      'the merge step holds while the journal is unreadable');
    assert.doesNotMatch(board.output(), /merge: sweep failed/,
      'a held merge step is not a crashed sweep');
    assert.doesNotMatch(board.output(), /source sprint-units:/,
      'the rest of the tick is not lost with it');
  } finally {
    if (board) await board.stop();
  }
});

test('a journal that exists but cannot be parsed holds dispatch and merges and alarms the owner', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-corrupt-journal-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: {
        'sprint-facts.json': facts(),
        // One typo in a hand edit must not read as an empty journal: an empty
        // journal would forget every guard and merge this PR a second time.
        'auto-dispatch.json': '{ "dispatched": { broken',
      },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const deadline = Date.now() + 8000;
    for (;;) {
      if (/ALARM state\/auto-dispatch\.json exists but cannot be parsed/.test(board.output())) break;
      if (Date.now() > deadline) throw new Error(`no corrupt-journal alarm:\n${board.output()}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(args => args[1] === 'merge').length, 0,
      'no merge may run on a journal the board cannot read');
    const raw = await readFile(path.join(board.dir, 'auto-dispatch.json'), 'utf8');
    assert.equal(raw, '{ "dispatched": { broken', 'the broken file is left for the owner to repair');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a source error is logged again after that source recovers', async () => {
  let board;
  try {
    const brokenFacts = facts();
    brokenFacts.unitIssues[1600] = 5; // not a list of tickets: the sweep throws
    board = await startBoard({
      config: { source: 'probe', autoDispatch: false, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': brokenFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
      }),
    });
    await createTicketed(board);
    const deadline = Date.now() + 8000;
    for (;;) {
      if (/source sprint-units: /.test(board.output())) break;
      if (Date.now() > deadline) throw new Error(`the swallowed sweep exception was not logged:\n${board.output()}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((board.output().match(/source sprint-units: /g) ?? []).length, 1,
      'one line per distinct message — a flapping source cannot flood the log');

    const beforeRecovery = (await getJson(board.base, '/pipeline/data')).body.swept?.at;
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(facts(), null, 2));
    await until(board.base, body => body.swept?.at && body.swept.at !== beforeRecovery ? body : null,
      { pathName: '/pipeline/data' });
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(brokenFacts, null, 2));
    await until(() => (board.output().match(/source sprint-units: /g) ?? []).length === 2);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal((board.output().match(/source sprint-units: /g) ?? []).length, 2,
      'success resets the notice, then the next failure is logged once again');
  } finally {
    if (board) await board.stop();
  }
});

test('live open and merged PR lists refresh together across the board-owned merge', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-coupled-pr-lists-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  const markerFile = path.join(toolsDir, 'merged');
  let board;
  try {
    const pr = {
      number: 1632,
      title: 'Coupled PR lists',
      body: 'Ticket: #1631',
      headRefName: 'feat/1631',
      headRefOid: HEAD,
      isDraft: false,
      mergeable: 'MERGEABLE',
      labels: [],
      url: 'https://github.com/acme/web/pull/1632',
      createdAt: '2026-08-30T10:00:00.000Z',
      updatedAt: '2026-08-30T10:00:01.000Z',
      mergedAt: '2026-08-30T10:00:02.000Z',
      statusCheckRollup: [{ name: 'pr-ci', conclusion: 'SUCCESS' }],
      author: { login: 'lane' },
      comments: [{ body: `R1 — GO\nhead ${HEAD}`, createdAt: '2026-08-30T10:00:01.000Z' }],
    };
    const issues = [{
      number: 1600, title: 'Sprint umbrella', body: '', url: UMBRELLA,
      labels: [{ name: 'umbrella' }], createdAt: '2026-08-30T09:00:00.000Z',
      updatedAt: '2026-08-30T09:00:00.000Z', state: 'OPEN', closedAt: null, comments: [],
    }, {
      number: 1631, title: 'UNIT-U1: coupled sources', body: 'Part of #1600.',
      url: 'https://github.com/acme/web/issues/1631', labels: [],
      createdAt: '2026-08-30T09:30:00.000Z', updatedAt: '2026-08-30T09:30:00.000Z',
      state: 'OPEN', closedAt: null, comments: [],
    }];
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      `const callsFile = ${JSON.stringify(callsFile)};`,
      `const markerFile = ${JSON.stringify(markerFile)};`,
      `const pr = ${JSON.stringify(pr)};`,
      `const issues = ${JSON.stringify(issues)};`,
      "appendFileSync(callsFile, JSON.stringify(a) + '\\n');",
      "if (a[0] === 'pr' && a[1] === 'list') {",
      "  const state = a[a.indexOf('--state') + 1];",
      "  const merged = existsSync(markerFile);",
      "  process.stdout.write(JSON.stringify(state === 'open' ? (merged ? [] : [pr]) : (merged ? [pr] : [])));",
      "} else if (a[0] === 'pr' && a[1] === 'merge') {",
      "  writeFileSync(markerFile, 'merged');",
      "} else if (a[0] === 'issue' && a[1] === 'list') {",
      "  process.stdout.write(JSON.stringify(issues));",
      "} else if (a[0] === 'issue' && a[1] === 'view') {",
      "  process.stdout.write(JSON.stringify(issues.find(issue => String(issue.number) === a[2]) || {}));",
      "} else {",
      "  process.stdout.write('[]');",
      '}',
    ].join('\n'));
    board = await startBoard({
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      env: { WATCHTOWER_SPRINT_SWEEP_MS: '200', WATCHTOWER_GH: fakeGh },
    });
    await createTicketed(board);

    const seen = [];
    const deadline = Date.now() + 8000;
    let mergedAt = null;
    for (;;) {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      const card = data.cards?.find(item => item.ticket === 1631);
      if (card) seen.push(`${card.stage} — ${card.status?.text ?? ''}`);
      if (!mergedAt && data.autoDispatch?.rows?.some(row => row.kind === 'merge' && String(row.state).startsWith('merged at '))) {
        mergedAt = Date.now();
      }
      if (mergedAt && Date.now() - mergedAt >= 3000) break;
      if (Date.now() > deadline) throw new Error(`merge did not settle:\n${board.output()}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.ok(seen.includes('merged — merged in PR #1632 — waiting for the ticket to close'), seen.join('\n'));
    assert.ok(!seen.includes('ci_pr — PR closed without a merge — close the ticket or reopen the PR'), seen.join('\n'));
    const ghCalls = await calls(callsFile);
    const openReads = ghCalls.filter(args => args[0] === 'pr' && args[1] === 'list' && args.includes('open')).length;
    const mergedReads = ghCalls.filter(args => args[0] === 'pr' && args[1] === 'list' && args.includes('merged')).length;
    assert.equal(mergedReads, openReads, 'each open-PR read has a merged-PR read in the same sweep');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});
