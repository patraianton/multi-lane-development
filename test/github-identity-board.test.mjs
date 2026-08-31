// The board's own GitHub identity (31.08): every gh the board spawns must act
// as the pinned account from the settings, never as whatever the keyring
// holds. Fail closed: a missing token or a login mismatch holds every gh
// sweep and alarms the owner; no github block keeps today's keyring behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, getJson, postJson, startBoard } from './helpers.mjs';

const HEAD = 'abc12345abcdef0123456789abcdef0123456789';
const UMBRELLA = 'https://github.com/acme/web/issues/1600';
const ACCOUNT = 'legalpanda-test';
const TOKEN = 'tok-from-file-not-keyring';
const OWNER_TELEGRAM = {
  dryRun: true,
  chatId: '-1',
  ownerChatId: '1',
  founders: [{ name: 'Owner', tgUserId: 1, tag: '@owner', owner: true }],
};

// The same ready-to-merge facts as merge-board.test.mjs: green CI, GO on the
// current head. If the board is willing to merge at all, it will merge these.
function facts() {
  const verdict = {
    round: 1,
    go: true,
    head: 'abc12345',
    at: '2026-08-30T10:00:00.000Z',
    body: 'R1 — GO\nhead abc12345',
  };
  return {
    lanes: [],
    prs: [{
      number: 1632,
      url: 'https://github.com/acme/web/pull/1632',
      branch: 'feat/1624',
      headSha: HEAD,
      title: 'Board merge fixture #3',
      body: 'Ticket: #1624',
      draft: false,
      mergeable: 'MERGEABLE',
      labels: [],
      ci: { color: 'green', text: 'CI green (1)', headSha: HEAD },
      verdict,
      verdicts: [verdict],
      verdictOnHead: verdict,
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

// A fake gh that records every call WITH the GH_TOKEN it received, and
// answers `gh api user` with the given login.
function fakeGhScript(callsFile, login) {
  return [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const a = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args: a, token: process.env.GH_TOKEN || null }) + '\\n');`,
    `if (a[0] === 'api' && a[1] === 'user') process.stdout.write(${JSON.stringify(login)} + '\\n');`,
  ].join('\n');
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
    if (Date.now() > deadline) throw new Error(`fixture did not settle in ${ms}ms: ${JSON.stringify(last?.autoDispatch ?? [])}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function outputUntil(board, rx, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (rx.test(board.output())) return;
    if (Date.now() > deadline) throw new Error(`no ${rx} in output:\n${board.output()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function journalUntil(file, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let value = null;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet */ }
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`journal did not settle in ${ms}ms`);
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

test('a pinned identity puts the token from tokenFile into every gh call', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-gh-identity-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', fakeGhScript(callsFile, ACCOUNT));
    board = await startBoard({
      port: 15050,
      config: dir => ({
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        github: { account: ACCOUNT, tokenFile: path.join(dir, 'github-token.txt') },
      }),
      files: { 'sprint-facts.json': facts(), 'github-token.txt': TOKEN + '\n' },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merged');
    const ghCalls = await calls(callsFile);
    const identity = ghCalls.find(c => c.args[0] === 'api' && c.args[1] === 'user');
    assert.ok(identity, 'the identity is verified before the first merge');
    const merge = ghCalls.find(c => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.ok(merge, 'the mergeable facts merged once the identity was confirmed');
    for (const call of ghCalls) {
      assert.equal(call.token, TOKEN,
        `gh ${call.args.slice(0, 2).join(' ')} must carry the token from tokenFile, not the keyring`);
    }
    assert.match(board.output(), new RegExp(`github identity: gh acts as ${ACCOUNT} \\(pinned\\)`));
    assert.doesNotMatch(board.output(), new RegExp(TOKEN), 'the token itself is never printed');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a login mismatch alarms the owner and holds the merge of ready facts', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-gh-mismatch-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', fakeGhScript(callsFile, 'intruder-account'));
    board = await startBoard({
      port: 15051,
      config: dir => ({
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        github: { account: ACCOUNT, tokenFile: path.join(dir, 'github-token.txt') },
      }),
      files: { 'sprint-facts.json': facts(), 'github-token.txt': TOKEN },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    const alarm = new RegExp(`ALARM github identity: gh api user answers as "intruder-account" while the settings pin "${ACCOUNT}"`);
    await outputUntil(board, alarm);
    await until(board.base, body => body.cards.some(card => card.ticket === 1624 && card.stage === 'ci_pr'));
    await new Promise(resolve => setTimeout(resolve, 700));
    const ghCalls = await calls(callsFile);
    assert.equal(ghCalls.filter(c => c.args[0] === 'pr' && c.args[1] === 'merge').length, 0,
      'ready-to-merge facts must not merge as the wrong account');
    assert.ok(ghCalls.every(c => c.args[0] === 'api' && c.args[1] === 'user'),
      'the identity check is the only gh call the held board makes');
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')),
      'a held merge sweep never writes the journal');
    assert.equal((board.output().match(new RegExp(alarm.source, 'g')) ?? []).length, 1,
      'one owner alarm a day, however many sweeps hold');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a missing token file holds every gh sweep without a single gh call', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-gh-no-token-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', fakeGhScript(callsFile, ACCOUNT));
    board = await startBoard({
      port: 15052,
      config: dir => ({
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        github: { account: ACCOUNT, tokenFile: path.join(dir, 'no-such-token.txt') },
      }),
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
      }),
    });
    await createTicketed(board);
    await outputUntil(board, /ALARM github identity: the github token file is missing or empty/);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(await calls(callsFile), [],
      'no token — no gh at all: nothing may fall back to the keyring');
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')),
      'a held merge sweep never writes the journal');
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('without a github block the board works as before and says the identity is not pinned', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-gh-unpinned-tools-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  let board;
  try {
    const fakeGh = await executable(toolsDir, 'gh', fakeGhScript(callsFile, ACCOUNT));
    board = await startBoard({
      port: 15053,
      config: { source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM },
      files: { 'sprint-facts.json': facts() },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
        // The test machine's own GH_TOKEN must not leak into the assertion.
        GH_TOKEN: '',
      }),
    });
    await createTicketed(board);
    await journalUntil(path.join(board.dir, 'auto-dispatch.json'),
      value => value?.dispatched?.['1624:merge:abc12345']?.result === 'merged');
    const ghCalls = await calls(callsFile);
    const merge = ghCalls.find(c => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.ok(merge, 'other installs keep merging exactly as today');
    assert.equal(merge.token, null, 'no pinned token reaches gh — the keyring account is used');
    assert.equal(ghCalls.filter(c => c.args[0] === 'api' && c.args[1] === 'user').length, 0,
      'nothing is verified when nothing is pinned');
    assert.match(board.output(), /github identity is not pinned/);
    assert.doesNotMatch(board.output(), /ALARM github identity/);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});
