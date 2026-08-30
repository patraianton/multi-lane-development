// The real board process owns the merge side effect: exact-head facts enter
// the journal before a portable fake gh receives the squash command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, getJson, postJson, startBoard } from './helpers.mjs';

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
      body: 'Summary & details\n\nCloses #1624',
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

async function until(base, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    last = (await getJson(base, '/api/pipeline?format=json')).body;
    if (ready(last)) return last;
    if (Date.now() > deadline) throw new Error(`merge fixture did not settle in ${ms}ms: ${JSON.stringify(last?.autoDispatch ?? [])}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function journalUntil(file, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value = null;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet */ }
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`merge journal did not settle in ${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function calls(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

test('green CI and GO on the current head invokes one squash merge and journals that head', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower merge tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    ].join('\n'));
    board = await startBoard({
      port: 15001,
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
      [1632, 1],
    );

    const api = await until(board.base,
      body => body.autoDispatch?.some(row => row.kind === 'merge' && row.state === 'merged at abc12345'));
    assert.deepEqual(api.autoDispatch.find(row => row.kind === 'merge'), {
      kind: 'merge', card: 'MERGE sprint', unit: 'PR #1632', lane: '-', base: 'abc12345', state: 'merged at abc12345',
    });

    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(args => args[0] === 'pr' && args[1] === 'merge').length, 1, 'a stale open-PR fact cannot merge twice');
    assert.deepEqual(ghCalls.map(args => args.slice(0, 2)), [['pr', 'edit'], ['pr', 'merge']]);
    const edit = ghCalls[0];
    const merge = ghCalls[1];
    assert.equal(edit[edit.indexOf('--body') + 1], 'Summary & details\n\nTicket: #1624');
    assert.ok(merge.includes('--squash'));
    assert.equal(merge[merge.indexOf('--match-head-commit') + 1], HEAD);
    assert.equal(merge[merge.indexOf('--body') + 1], 'Summary & details\n\nTicket: #1624');
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
      port: 15002,
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

test('hold-merge produces only the owner table line, even while other merge facts are missing', async () => {
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
    heldFacts.unitIssues[1600][0].labels = ['hold-merge'];
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
      port: 15004,
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

test('a failed merge records stderr and stops after three attempts', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-failed-merge-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "process.stderr.write('merge rejected by fixture\\n');",
      'process.exit(1);',
    ].join('\n'));
    const failingFacts = facts();
    failingFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      port: 15005,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': failingFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const journal = await journalUntil(journalFile, value => {
      const entry = value?.dispatched?.['1624:merge:abc12345'];
      return entry?.result === 'merge-failed' && entry.attempts === 3;
    });
    assert.equal(journal.dispatched['1624:merge:abc12345'].error, 'merge rejected by fixture');
    const api = await until(board.base, body => body.autoDispatch?.some(row => row.state
      === 'merge failed 3/3 — merge rejected by fixture'));
    assert.ok(api.autoDispatch.some(row => row.kind === 'merge' && row.unit === 'PR #1632'));
    await new Promise(resolve => setTimeout(resolve, 500));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.length, 3);
    assert.ok(ghCalls.every(args => args[0] === 'pr' && args[1] === 'merge'));
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
      port: 15006,
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
      port: 15007,
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
      port: 15008,
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
      port: 15009,
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
