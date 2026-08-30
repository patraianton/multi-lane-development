// The real board process owns the merge side effect: exact-head facts enter
// the journal before a portable fake gh receives the squash command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
      // Long on purpose: a real PR body ran to 61 KB on 30.08 and an argument
      // that size is an OS error, not a merge.
      body: 'Summary & details\n\nCloses #1624\n' + 'x'.repeat(5000),
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
    assert.ok(merge.includes('--squash'));
    assert.equal(merge[merge.indexOf('--match-head-commit') + 1], HEAD);
    const expectedBody = 'Summary & details\n\nTicket: #1624\n' + 'x'.repeat(5000);
    for (const args of [edit, merge]) {
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
      port: 15024,
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
      port: 15025,
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
    // no-review beside it changes nothing: hold-merge always wins.
    heldFacts.unitIssues[1600][0].labels = ['hold-merge', 'no-review'];
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
    assert.equal(ghCalls.length, 3, 'a message the board cannot clear is never followed by update-branch');
    assert.ok(ghCalls.every(args => args[0] === 'pr' && args[1] === 'merge'));
    const alarm = /ALARM the board gave up merging PR #1632 after 3 attempts: merge rejected by fixture/;
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
      port: 15027,
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
      port: 15028,
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

test('a merge refused as out of date updates the branch, at most once a sweep', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-behind-main-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(a) + '\\n');`,
      "if (a[1] === 'merge') {",
      "  process.stderr.write('Pull request is not mergeable: Branch is not up to date with the base branch\\n');",
      '  process.exit(1);',
      '}',
    ].join('\n'));
    const behindFacts = facts();
    behindFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      port: 15019,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': behindFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const journal = await journalUntil(journalFile,
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merge-failed');
    assert.equal(journal.dispatched['1624:merge:abc12345'].error,
      'Pull request is not mergeable: Branch is not up to date with the base branch');

    // The transient row lives for one sweep, so every poll collects what it saw.
    const states = new Set();
    const deadline = Date.now() + 8000;
    for (;;) {
      const body = (await getJson(board.base, '/api/pipeline?format=json')).body;
      for (const row of body.autoDispatch ?? []) if (row.kind === 'merge') states.add(row.state);
      if (states.has('behind main — branch updated')) break;
      if (Date.now() > deadline) throw new Error(`no behind-main row in ${[...states].join(' | ')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    assert.match(board.output(), /merge: PR #1632 failed at abc12345 — Pull request is not mergeable/);
    assert.match(board.output(), /merge: PR #1632 is behind main — branch updated/);

    await journalUntil(journalFile, value => value?.dispatched?.['1624:merge:abc12345']?.attempts === 3);
    await new Promise(resolve => setTimeout(resolve, 900));
    const ghCalls = await calls(callsFile);
    const updates = ghCalls.filter(args => args[1] === 'update-branch');
    assert.deepEqual(updates, Array(3).fill(['pr', 'update-branch', '1632', '--repo', 'acme/web']),
      'one update a sweep, and the attempts cap ends them — never one update per sweep forever');
    assert.equal(ghCalls.filter(args => args[1] === 'merge').length, 3, 'the attempts cap still holds');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('an update-branch the board could not make says so, and is tried again', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-update-failed-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      'const a = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(a) + '\\n');`,
      "if (a[1] === 'merge') {",
      "  process.stderr.write('Pull request is not mergeable: Branch is not up to date with the base branch\\n');",
      '  process.exit(1);',
      '}',
      "if (a[1] === 'update-branch') {",
      "  process.stderr.write('HTTP 403: Resource not accessible by integration\\n');",
      '  process.exit(1);',
      '}',
    ].join('\n'));
    const behindFacts = facts();
    behindFacts.prs[0].body = 'Ticket: #1624';
    board = await startBoard({
      port: 15020,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': behindFacts },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);

    // The transient row lives for one sweep, so every poll collects what it saw.
    const states = new Set();
    const deadline = Date.now() + 8000;
    for (;;) {
      const body = (await getJson(board.base, '/api/pipeline?format=json')).body;
      for (const row of body.autoDispatch ?? []) if (row.kind === 'merge') states.add(row.state);
      if (states.has('behind main — update-branch failed')) break;
      if (Date.now() > deadline) throw new Error(`no failed-update row in ${[...states].join(' | ')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(!states.has('behind main — branch updated'),
      'the table never says the branch was updated when the update failed');
    assert.match(board.output(), /merge: PR #1632 is behind main — update-branch failed: HTTP 403/);

    await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.attempts === 3);
    // The last update follows its merge attempt, so let that sweep finish.
    await new Promise(resolve => setTimeout(resolve, 700));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(args => args[1] === 'update-branch').length, 3,
      'a failed update costs nothing and is tried again next sweep, until the attempts cap ends it');
    assert.equal(ghCalls.filter(args => args[1] === 'merge').length, 3, 'the attempts cap still holds');
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
      port: 15021,
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

test('a merge step that cannot write its journal says so and the sweep goes on', async () => {
  let board;
  try {
    board = await startBoard({
      port: 15022,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: process.execPath,
      }),
    });
    // A journal that cannot be written at all: the merge step throws where the
    // 30.08 exception did, before any outcome could be recorded.
    await mkdir(path.join(board.dir, 'auto-dispatch.json'), { recursive: true });
    await createTicketed(board);
    const deadline = Date.now() + 8000;
    for (;;) {
      if ((board.output().match(/merge: sweep failed/g) ?? []).length >= 2) break;
      if (Date.now() > deadline) throw new Error(`the failed sweep was not logged twice:\n${board.output()}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(board.output(), /source sprint-units:/,
      'the merge step is caught at its call site — the rest of the tick is not lost with it');
  } finally {
    if (board) await board.stop();
  }
});

test('a sweep that throws leaves one line in the log', async () => {
  let board;
  try {
    const brokenFacts = facts();
    brokenFacts.unitIssues[1600] = 5; // not a list of tickets: the sweep throws
    board = await startBoard({
      port: 15023,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
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
  } finally {
    if (board) await board.stop();
  }
});
