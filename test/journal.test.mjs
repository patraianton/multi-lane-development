import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { getJson, startBoard } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logFile = board => path.join(board.dir, 'board.log');

function journalClient(html, overrides = {}) {
  const start = html.indexOf('const JOURNAL_FILTERS');
  const end = html.indexOf('// Each sprint owns', start);
  assert.notEqual(start, -1, 'the Journal client block exists');
  assert.notEqual(end, -1, 'the Journal client block has its expected boundary');

  const zone = {
    classList: { toggle() {} },
    innerHTML: '',
    querySelector: () => ({}),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    folds: { journal: true },
    saveFolds() {},
    toggleJournalFold() {},
    $: () => zone,
    esc: value => String(value),
    fetch: overrides.fetch,
    AbortController,
    setTimeout: overrides.setTimeout ?? setTimeout,
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
  });
  vm.runInContext(html.slice(start, end) + `
    globalThis.journalTest = {
      refresh: refreshJournal,
      setFilter: value => { journalFilter = value; },
      lines: () => journalLines,
      error: () => journalError,
    };
  `, context);
  return context.journalTest;
}

function pipelinePollClient(html, refreshJournal) {
  const match = html.match(/async function pipePoll\(\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'the pipeline poll function exists');

  let scheduled = 0;
  let ticks = 0;
  const context = vm.createContext({
    pipeTimer: null,
    pipeSeen: '',
    lastPipe: null,
    refreshJournal,
    fetch: async () => ({ json: async () => ({ cards: [] }) }),
    renderPipeline() {},
    tickClocks() { ticks++; },
    showError() {},
    clearTimeout() {},
    setTimeout() { scheduled++; return 1; },
    getScheduled: () => scheduled,
    getTicks: () => ticks,
  });
  vm.runInContext(match[0] + `
    globalThis.pipelinePollTest = {
      run: pipePoll,
      scheduled: getScheduled,
      ticks: getTicks,
    };
  `, context);
  return context.pipelinePollTest;
}

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
  assert.match(html, /refreshJournal\(\);[\s\S]*setTimeout\(pipePoll, 3000\)/);
  assert.match(html, /journalLines\.map\(line => '<div class="journal-line">' \+ esc\(line\)/,
    'log text is escaped before it reaches the page');
});

test('an older Journal response cannot overwrite a newer active filter', async () => {
  const html = await readFile(path.join(ROOT, 'bin', 'watchtower.html'), 'utf8');
  const requests = [];
  const client = journalClient(html, {
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
  });

  client.setFilter('all');
  const older = client.refresh();
  client.setFilter('errors');
  const newer = client.refresh();
  assert.deepEqual(requests.map(request => request.url), [
    '/api/log?lines=200',
    '/api/log?lines=200&filter=error',
  ]);

  requests[1].resolve({ ok: true, json: async () => ({ lines: ['error newer'] }) });
  await newer;
  requests[0].resolve({ ok: true, json: async () => ({ lines: ['dispatch older'] }) });
  await older;

  assert.deepEqual([...client.lines()], ['error newer']);
});

test('a stalled Journal request is aborted before the next refresh interval', async () => {
  const html = await readFile(path.join(ROOT, 'bin', 'watchtower.html'), 'utf8');
  let timeoutCallback = null;
  let timeoutMs = null;
  let signal = null;
  const client = journalClient(html, {
    setTimeout(callback, ms) {
      timeoutCallback = callback;
      timeoutMs = ms;
      return 1;
    },
    clearTimeout() {},
    fetch: (_url, options = {}) => new Promise((_resolve, reject) => {
      signal = options.signal;
      if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  const request = client.refresh();
  assert.ok(timeoutMs > 0 && timeoutMs < 3000, `expected a sub-cycle timeout, got ${timeoutMs}`);
  assert.equal(signal.aborted, false);
  timeoutCallback();
  await request;

  assert.equal(signal.aborted, true);
  assert.match(client.error(), /^the journal did not answer:/);
});

test('a stalled Journal request never delays the main pipeline cycle', async () => {
  const html = await readFile(path.join(ROOT, 'bin', 'watchtower.html'), 'utf8');
  let releaseJournal;
  const stalledJournal = new Promise(resolve => { releaseJournal = resolve; });
  const client = pipelinePollClient(html, () => stalledJournal);
  const poll = client.run();

  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(client.ticks(), 1, 'the pipeline response is rendered');
    assert.equal(client.scheduled(), 1, 'the next pipeline cycle is already scheduled');
  } finally {
    releaseJournal();
    await poll;
  }
});
