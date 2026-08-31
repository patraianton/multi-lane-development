import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, startBoard } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logFile = board => path.join(board.dir, 'board.log');

test('GET /api/log serves only the requested tail, newest first', async () => {
  const board = await startBoard({ config: { source: 'probe' } });
  try {
    await writeFile(logFile(board), 'oldest\nmiddle — split-safe ✓\nnewest\n');
    const response = await getJson(board.base, '/api/log?lines=2');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { lines: ['newest', 'middle — split-safe ✓'] });
  } finally {
    await board.stop();
  }
});

test('GET /api/log defaults to 200 lines and hard-caps requests at 1000', async () => {
  const board = await startBoard({ config: { source: 'probe' } });
  try {
    const fixture = Array.from({ length: 1105 }, (_, i) => `row-${i}`).join('\n') + '\n';
    await writeFile(logFile(board), fixture);

    const defaultTail = await getJson(board.base, '/api/log');
    assert.equal(defaultTail.body.lines.length, 200);
    assert.deepEqual([defaultTail.body.lines[0], defaultTail.body.lines.at(-1)], ['row-1104', 'row-905']);

    const capped = await getJson(board.base, '/api/log?lines=5000');
    assert.equal(capped.body.lines.length, 1000);
    assert.deepEqual([capped.body.lines[0], capped.body.lines.at(-1)], ['row-1104', 'row-105']);
  } finally {
    await board.stop();
  }
});

test('GET /api/log filters case-insensitively while scanning newest first and redacts secrets', async () => {
  const secret = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_secret';
  const board = await startBoard({
    config: {
      source: 'probe',
      telegram: { dryRun: true, botToken: secret, chatId: '-1', ownerChatId: '1', founders: [] },
    },
  });
  try {
    await writeFile(logFile(board), [
      'merge older',
      `MERGE carried Authorization: Bearer ${secret}`,
      'alarm unrelated',
      `merge newest token=${secret}`,
    ].join('\n') + '\n');

    const response = await getJson(board.base, '/api/log?lines=2&filter=MeRgE');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.lines, [
      'merge newest token=[redacted]',
      'MERGE carried Authorization: Bearer [redacted]',
    ]);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
    assert.doesNotMatch(await readFile(logFile(board), 'utf8'), /telegram notifications:[^\n]*123456:/,
      'the configured Telegram credential is not emitted by normal logging');
  } finally {
    await board.stop();
  }
});

test('the board page wires the collapsible, filtered journal into the existing refresh cycle', async () => {
  const html = await readFile(path.join(ROOT, 'bin', 'watchtower.html'), 'utf8');
  assert.match(html, /id="journal-zone"/);
  assert.match(html, /const JOURNAL_FILTERS = \{ all: '', merge: 'merge', alarm: 'alarm', dispatch: 'dispatch', errors: 'error' \}/);
  assert.match(html, /journal: saved\.journal !== false/);
  assert.match(html, /localStorage\.setItem\('watchtower-folds', JSON\.stringify\(folds\)\)/);
  assert.match(html, /const journalRequest = refreshJournal\(\);[\s\S]*await journalRequest;[\s\S]*setTimeout\(pipePoll, 3000\)/);
  assert.match(html, /journalLines\.map\(line => '<div class="journal-line">' \+ esc\(line\)/,
    'log text is escaped before it reaches the page');
});
