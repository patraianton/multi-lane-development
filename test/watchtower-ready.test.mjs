import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { executable, postJson, startBoard, until as waitUntil } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';
const REPO = 'acme/web';
const TELEGRAM = {
  dryRun: true,
  chatId: '-100123',
  ownerChatId: '4242',
  founders: [{ name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true }],
};

function readyFacts() {
  return {
    lanes: [], prs: [],
    mergedPrs: [
      { number: 1600, branch: 'feat/1516', url: 'https://github.com/acme/web/pull/1600', mergedAt: '2026-08-30T09:00:00Z' },
      { number: 1601, branch: 'feat/1517', url: 'https://github.com/acme/web/pull/1601', mergedAt: '2026-08-30T09:01:00Z' },
      { number: 1602, branch: 'feat/1590', url: 'https://github.com/acme/web/pull/1602', mergedAt: '2026-08-30T09:30:00Z' },
    ],
    unitIssues: {
      1515: [
        { number: 1516, title: 'PAY-U1: shipped', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: 'feat/1516', labels: [], createdAt: '2026-08-30T08:00:00Z' },
        { number: 1517, title: 'PAY-U2: shipped', url: 'https://github.com/acme/web/issues/1517', state: 'CLOSED', closedAt: '2026-08-30T09:01:01Z', branch: 'feat/1517', labels: [], createdAt: '2026-08-30T08:01:00Z' },
        { number: 1590, title: 'QA: merged finding', url: 'https://github.com/acme/web/issues/1590', state: 'OPEN', branch: 'feat/1590', labels: ['qa'], qa: true, createdAt: '2026-08-30T08:30:00Z' },
        { number: 1591, title: 'QA R1 — Payments', url: 'https://github.com/acme/web/issues/1591', state: 'CLOSED', closedAt: '2026-08-30T10:10:00Z', branch: 'feat/1591', labels: ['qa-run'], qa: true, createdAt: '2026-08-30T10:00:00Z' },
      ],
    },
    ciJobs: {}, ciRunners: [], umbrellaStates: { 1515: 'OPEN' }, staleSources: [],
  };
}

const until = (base, ready) => waitUntil(base, ready, { pathName: '/pipeline/data' });
const count = (text, needle) => text.split(needle).length - 1;

async function sprintCard(board) {
  const created = await postJson(board.base, '/pipeline/card/create', { title: 'Payments sprint', spec: 'the spec' });
  const id = created.body.card.id;
  await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
  await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
  await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
  return id;
}

function closingGh(callsFile, factsFile, { fail = false } = {}) {
  return [
    '#!/usr/bin/env node',
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');`,
    fail ? 'process.exit(1);' : '',
    `const factsFile = ${JSON.stringify(factsFile)};`,
    "if (args[0] === 'issue' && args[1] === 'close') {",
    '  const number = Number(args[2]);',
    '  const facts = JSON.parse(readFileSync(factsFile, "utf8"));',
    '  const issue = facts.unitIssues[1515].find(item => item.number === number);',
    '  if (issue) { issue.state = "CLOSED"; issue.closedAt = "2026-08-30T10:11:00Z"; }',
    '  if (number === 1515) facts.umbrellaStates[1515] = "CLOSED";',
    '  writeFileSync(factsFile, JSON.stringify(facts, null, 2));',
    '}',
  ].filter(Boolean).join('\n');
}

async function callsOf(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

test('a clean QA walk closes merged open tickets and the umbrella once, then facts finish the sprint', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-close-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  const factsFile = path.join(toolsDir, 'facts.json');
  await writeFile(factsFile, JSON.stringify(readyFacts(), null, 2));
  const fakeGh = await executable(toolsDir, 'gh', closingGh(callsFile, factsFile));
  const board = await startBoard({
    config: { source: 'probe', repo: REPO, telegram: TELEGRAM },
    env: {
      WATCHTOWER_GH: fakeGh,
      WATCHTOWER_SPRINT_FACTS_FILE: factsFile,
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    },
  });

  try {
    const id = await sprintCard(board);
    const done = await until(board.base, data => data.cards.find(card => card.id === id)?.stage === 'done');
    assert.equal(done.cards.find(card => card.id === id).stage, 'done');
    await new Promise(resolve => setTimeout(resolve, 600));

    const calls = await callsOf(callsFile);
    assert.deepEqual(calls.map(args => args.slice(0, 3)), [
      ['issue', 'close', '1516'],
      ['issue', 'close', '1590'],
      ['issue', 'close', '1515'],
    ], 'the already-closed unit and clean QA-run ticket are not reopened');
    assert.deepEqual(calls.map(args => args[args.indexOf('--comment') + 1]), [
      'Closed by the board: merged in PR #1600; QA R1 clean',
      'Closed by the board: merged in PR #1602; QA R1 clean',
      calls[2][calls[2].indexOf('--comment') + 1],
    ]);
    assert.match(calls[2][calls[2].indexOf('--comment') + 1],
      /^Sprint Payments sprint closed by the board: 2 units merged, QA R1 clean, /);
    assert.equal(count(board.output(), 'sprint close: ticket #1516 closed'), 1);
    assert.equal(count(board.output(), 'sprint close: ticket #1590 closed'), 1);
    assert.equal(count(board.output(), 'sprint close: umbrella #1515 closed'), 1);
    assert.equal(count(board.output(), '--- notifyReady ---'), 0);
    assert.equal(count(board.output(), '--- notifyOwner ---'), 1);
    assert.equal(count(board.output(), '--- notifyDone ---'), 1);
  } finally {
    await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a successful close pass refreshes stale unit and umbrella facts before the next sweep', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-close-refresh-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  const unitClosedFile = path.join(toolsDir, 'unit-closed');
  const umbrellaClosedFile = path.join(toolsDir, 'umbrella-closed');
  const mergedPr = {
    number: 1600,
    title: 'Merged unit',
    body: 'Ticket: #1516',
    headRefName: 'feat/1516',
    headRefOid: 'a'.repeat(40),
    url: 'https://github.com/acme/web/pull/1600',
    createdAt: '2026-08-30T08:00:00Z',
    mergedAt: '2026-08-30T09:00:00Z',
    comments: [],
  };
  const issues = [{
    number: 1515, title: 'Payments sprint', body: '', url: UMBRELLA,
    labels: [{ name: 'umbrella' }], createdAt: '2026-08-30T08:00:00Z',
    state: 'OPEN', closedAt: null, comments: [],
  }, {
    number: 1516, title: 'PAY-U1: shipped', body: 'Part of #1515.',
    url: 'https://github.com/acme/web/issues/1516', labels: [],
    createdAt: '2026-08-30T08:01:00Z', state: 'OPEN', closedAt: null, comments: [],
  }, {
    number: 1591, title: 'QA R1 — Payments', body: 'Part of #1515.',
    url: 'https://github.com/acme/web/issues/1591', labels: [{ name: 'qa-run' }],
    createdAt: '2026-08-30T10:00:00Z', state: 'CLOSED',
    closedAt: '2026-08-30T10:10:00Z', comments: [],
  }];
  const fakeGh = await executable(toolsDir, 'gh', [
    '#!/usr/bin/env node',
    "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    `const callsFile = ${JSON.stringify(callsFile)};`,
    `const unitClosedFile = ${JSON.stringify(unitClosedFile)};`,
    `const umbrellaClosedFile = ${JSON.stringify(umbrellaClosedFile)};`,
    `const mergedPr = ${JSON.stringify(mergedPr)};`,
    `const issues = ${JSON.stringify(issues)};`,
    "appendFileSync(callsFile, JSON.stringify(args) + '\\n');",
    'if (existsSync(unitClosedFile)) {',
    '  const unit = issues.find(issue => issue.number === 1516);',
    '  unit.state = "CLOSED"; unit.closedAt = "2026-08-30T10:11:00Z";',
    '}',
    'if (existsSync(umbrellaClosedFile)) {',
    '  const umbrella = issues.find(issue => issue.number === 1515);',
    '  umbrella.state = "CLOSED"; umbrella.closedAt = "2026-08-30T10:11:01Z";',
    '}',
    "if (args[0] === 'pr' && args[1] === 'list') {",
    "  process.stdout.write(JSON.stringify(args.includes('merged') ? [mergedPr] : []));",
    "} else if (args[0] === 'issue' && args[1] === 'list') {",
    '  process.stdout.write(JSON.stringify(issues));',
    "} else if (args[0] === 'issue' && args[1] === 'view') {",
    '  process.stdout.write(JSON.stringify(issues.find(issue => String(issue.number) === args[2]) || {}));',
    "} else if (args[0] === 'issue' && args[1] === 'close') {",
    "  writeFileSync(Number(args[2]) === 1515 ? umbrellaClosedFile : unitClosedFile, 'closed');",
    '} else {',
    "  process.stdout.write('[]');",
    '}',
  ].join('\n'));
  const board = await startBoard({
    config: { source: 'probe', repo: REPO },
    env: { WATCHTOWER_GH: fakeGh, WATCHTOWER_SPRINT_SWEEP_MS: '250' },
  });

  try {
    await sprintCard(board);
    await waitUntil(async () => (await callsOf(callsFile))
      .filter(args => args[0] === 'issue' && args[1] === 'close').length >= 2);
    await new Promise(resolve => setTimeout(resolve, 600));

    const calls = await callsOf(callsFile);
    const closes = calls.filter(args => args[0] === 'issue' && args[1] === 'close');
    const unitIssueReads = calls.filter(args => args[0] === 'issue' && args[1] === 'list'
      && args[args.indexOf('--state') + 1] === 'all');
    assert.deepEqual(closes.map(args => args.slice(0, 3)), [
      ['issue', 'close', '1516'],
      ['issue', 'close', '1515'],
    ]);
    assert.ok(unitIssueReads.length >= 2, 'the close pass forces the 180-second unit source to re-read');
  } finally {
    await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a failed ticket close retries, keeps the sprint closing, and alarms once after three sweeps', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-close-fail-'));
  const callsFile = path.join(toolsDir, 'calls.jsonl');
  const factsFile = path.join(toolsDir, 'facts.json');
  const facts = readyFacts();
  facts.unitIssues[1515] = facts.unitIssues[1515].filter(issue => ![1517, 1590].includes(issue.number));
  facts.mergedPrs = facts.mergedPrs.filter(pr => pr.number === 1600);
  await writeFile(factsFile, JSON.stringify(facts, null, 2));
  const fakeGh = await executable(toolsDir, 'gh', closingGh(callsFile, factsFile, { fail: true }));
  const board = await startBoard({
    config: { source: 'probe', repo: REPO },
    env: {
      WATCHTOWER_GH: fakeGh,
      WATCHTOWER_SPRINT_FACTS_FILE: factsFile,
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    },
  });

  try {
    const id = await sprintCard(board);
    await waitUntil(async () => board.output().includes('ALARM could not close sprint #1515 after 3 sweeps'));
    const data = await until(board.base, value => value.cards.some(card => card.parent === id && card.ticket === 1516));
    const unit = data.cards.find(card => card.parent === id && card.ticket === 1516);
    assert.equal(unit.stage, 'merged');
    assert.equal(unit.status.text, 'merged in PR #1600 — sprint closing');
    await new Promise(resolve => setTimeout(resolve, 600));

    const calls = await callsOf(callsFile);
    assert.ok(calls.length >= 3, 'the close keeps retrying after the alarm');
    assert.ok(calls.every(args => args.slice(0, 3).join(' ') === 'issue close 1516'), 'the umbrella is never closed after a ticket failure');
    assert.equal(count(board.output(), 'ALARM could not close sprint #1515'), 1);
  } finally {
    await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});
