import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { qaWords as pipelineQaWords } from '../bin/pipeline.mjs';
import { getJson, startBoard } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = path.join(ROOT, 'bin', 'watchtower.html');
const HISTORY_HELP = 'history: finished sprints and hand cards, one row each — the record of how long a sprint took; the same cards still appear in cards';

function card({
  id, title = id, stage = 'development', parent = '', unit = '', ticket = 0,
  finished = '', counters = {}, started = '2026-08-30T08:00:00.000Z',
}) {
  const stageHistory = stage === 'done'
    ? [
        { stage: 'development', enteredAt: started, leftAt: finished },
        { stage: 'done', enteredAt: finished, leftAt: null },
      ]
    : [{ stage, enteredAt: started, leftAt: null }];
  return {
    id,
    title,
    spec: '',
    summary: '',
    stage,
    createdAt: started,
    stageHistory,
    counters: { localFails: 0, ciFails: 0, reviewFails: 0, ...counters },
    consecutiveFails: 0,
    links: { ticket: '', branch: '', pr: '', artifact: '' },
    lane: '',
    subscription: '',
    slot: '',
    window: '',
    parent,
    ticket,
    unit,
    status: { text: '', at: null },
    comments: [],
  };
}

const FINISHED_AT = '2026-08-30T09:30:00.000Z';

function apiCards() {
  return [
    card({ id: 'done-sprint', title: 'Finished sprint', stage: 'done', finished: FINISHED_AT }),
    card({ id: 'done-u1', title: 'First unit', stage: 'done', parent: 'done-sprint', unit: 'U1', ticket: 101, finished: FINISHED_AT, counters: { localFails: 1, ciFails: 2 } }),
    card({ id: 'done-u2', title: 'Second unit', stage: 'done', parent: 'done-sprint', unit: 'U2', ticket: 102, finished: FINISHED_AT, counters: { ciFails: 1, reviewFails: 2 } }),
    card({ id: 'done-u3', title: 'Third unit', stage: 'done', parent: 'done-sprint', unit: 'U3', ticket: 103, finished: FINISHED_AT, counters: { localFails: 2, reviewFails: 1 } }),
    card({ id: 'done-qa', title: 'QA finding', stage: 'done', parent: 'done-sprint', unit: 'QA', ticket: 104, finished: FINISHED_AT, counters: { localFails: 1, ciFails: 1, reviewFails: 1 } }),
    card({ id: 'live-sprint', title: 'Sprint in flight' }),
    card({ id: 'live-u1', title: 'Live first unit', parent: 'live-sprint', unit: 'U1', ticket: 201, counters: { localFails: 5 } }),
    card({ id: 'live-u2', title: 'Live second unit', stage: 'ci_pr', parent: 'live-sprint', unit: 'U2', ticket: 202 }),
  ];
}

async function historyBoard(cards) {
  return startBoard({
    config: { source: 'probe', autoDispatch: false },
    files: { 'pipeline-cards.json': { cards } },
  });
}

function extractMarked(html, startMarker, endMarker, exportName) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} exists`);
  assert.notEqual(end, -1, `${endMarker} exists`);
  const context = vm.createContext({});
  vm.runInContext(`${html.slice(start, end + endMarker.length)}\nglobalThis.extracted = ${exportName};`, context);
  return context.extracted;
}

class FakeClassList {
  constructor() { this.names = new Set(); }
  contains(name) { return this.names.has(name); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = { values: new Map(), setProperty: (key, value) => this.style.values.set(key, value) };
    this.dataset = {};
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
}

function pageClient(html) {
  const scriptStart = html.indexOf('<script>');
  assert.notEqual(scriptStart, -1, 'the page script exists');
  const script = html.slice(scriptStart + '<script>'.length);
  const boot = script.lastIndexOf('\npipePoll();');
  assert.notEqual(boot, -1, 'the page has its pipeline poll boot call');

  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const document = {
    activeElement: null,
    body: { insertBefore() {} },
    getElementById: element,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => new FakeElement(tag),
  };
  const context = vm.createContext({
    document,
    localStorage: { getItem: () => null, setItem() {} },
    location: { reload() {} },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async () => ({ json: async () => ({}) }),
  });
  vm.runInContext(`${script.slice(0, boot)}
    globalThis.historyPageTest = {
      render: renderPipeline,
      getView: () => view,
      setView: next => { view = next; },
      openHistoryRow: id => { openHistory.add(id); },
    };
  `, context);
  return { ...context.historyPageTest, element };
}

function visibleWords(markup) {
  return String(markup).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function pageFixture() {
  const roots = [
    ['sprint-oldest', 'Oldest sprint', '2026-08-29T10:00:00.000Z'],
    ['sprint-newest', 'Newest sprint', '2026-09-02T10:00:00.000Z'],
    ['sprint-third', 'Third sprint', '2026-08-30T10:00:00.000Z'],
    ['sprint-second', 'Second sprint', '2026-09-01T10:00:00.000Z'],
  ];
  const cards = [];
  for (const [id, title, finished] of roots) {
    cards.push(card({ id, title, stage: 'done', finished }));
    const unitTicket = cards.length + 300;
    cards.push(card({
      id: `${id}-unit`, title: `U1 #${unitTicket} — ${title} unit`, stage: 'done', parent: id, unit: 'U1',
      ticket: unitTicket, finished,
      counters: id === 'sprint-newest' ? { localFails: 1 } : {},
    }));
    // A finished root owns every child in History, even if a forced failure has
    // left the child somewhere other than Done.
    const qaTicket = cards.length + 300;
    cards.push(card({
      id: `${id}-qa`, title: `QA #${qaTicket} — ${title} QA`, stage: id === 'sprint-third' ? 'stuck' : 'done',
      parent: id, unit: 'QA', ticket: qaTicket, finished,
      counters: id === 'sprint-newest' ? { reviewFails: 2 } : {},
    }));
  }
  cards.splice(4, 0, card({ id: 'hand-card', title: 'Current hand card', stage: 'development' }));
  return cards;
}

test('agent pipeline keeps all cards and adds one complete History row in JSON and text', async () => {
  const cards = apiCards();
  const board = await historyBoard(cards);
  try {
    const response = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.cards, 8);
    assert.equal(response.body.summary.done, 5);
    assert.equal(response.body.summary.failures, 17);
    assert.equal(response.body.summary.units, 6);
    assert.equal(response.body.summary.history, 1);
    assert.equal(response.body.cards.length, 8);
    assert.deepEqual(response.body.cards.map(row => row.id).sort(), cards.map(row => row.id).sort(),
      'History is an additional view; no card leaves the existing cards table');
    for (const id of ['done-sprint', 'done-u1', 'done-u2', 'done-u3', 'done-qa']) {
      assert.ok(response.body.cards.some(row => row.id === id), `${id} remains in cards`);
    }

    assert.equal(response.body.history.length, 1);
    assert.deepEqual(response.body.history[0], {
      name: 'Finished sprint',
      finished: FINISHED_AT,
      total: '1h 30m',
      units: 3,
      qa: 'QA: 1 finding · all closed',
      failures: 12,
    });

    const textResponse = await fetch(`${board.base}/api/pipeline`);
    const text = await textResponse.text();
    assert.equal(textResponse.status, 200);
    assert.match(text, /^summary: cards 8, stuck 0, done 5, failures 17, history 1$/m);
    assert.match(text, /^history\[1\]\{name,finished,total,units,qa,failures\}:$/m);
    assert.match(text, /^  Finished sprint,"2026-08-30T09:30:00\.000Z",1h 30m,3,"QA: 1 finding · all closed",12$/m);
    assert.ok(text.indexOf('stuck: 0') < text.indexOf('history[1]'), 'History follows Stuck');
    assert.ok(text.indexOf('history[1]') < text.indexOf('off-board:'), 'existing later tables keep their order');
    assert.match(text, new RegExp(HISTORY_HELP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await board.stop();
  }
});

test('agent pipeline reports an explicit empty History without hiding in-flight cards', async () => {
  const cards = apiCards().slice(5);
  const board = await historyBoard(cards);
  try {
    const response = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.cards, 3);
    assert.equal(response.body.summary.history, 0);
    assert.deepEqual(response.body.history, []);
    assert.deepEqual(response.body.cards.map(row => row.id), cards.map(row => row.id));

    const textResponse = await fetch(`${board.base}/api/pipeline`);
    const text = await textResponse.text();
    assert.equal(textResponse.status, 200);
    assert.match(text, /^summary: cards 3, stuck 0, done 0, failures 5, history 0$/m);
    assert.match(text, /^history: 0 — no finished sprint yet$/m);
  } finally {
    await board.stop();
  }
});

test('a finished hand card reports its own failures in History', async () => {
  const hand = card({
    id: 'finished-hand',
    title: 'Finished hand card',
    stage: 'done',
    finished: FINISHED_AT,
    counters: { localFails: 2, ciFails: 1, reviewFails: 3 },
  });
  const board = await historyBoard([hand]);
  try {
    const response = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.cards, 1);
    assert.equal(response.body.summary.history, 1);
    assert.ok(response.body.cards.some(row => row.id === hand.id));
    assert.deepEqual(response.body.history, [{
      name: 'Finished hand card',
      finished: FINISHED_AT,
      total: '1h 30m',
      units: 0,
      qa: 'QA: none',
      failures: 6,
    }]);
  } finally {
    await board.stop();
  }
});

test('the page partition is pure, keeps finished groups together, and sorts finished roots newest first', async () => {
  const html = await readFile(PAGE, 'utf8');
  const splitBoardHistory = extractMarked(
    html,
    '// history-partition start',
    '// history-partition end',
    'splitBoardHistory',
  );
  const cards = pageFixture();
  const before = JSON.stringify(cards);
  const result = splitBoardHistory(cards);

  assert.equal(JSON.stringify(cards), before, 'partitioning does not mutate cards or their histories');
  assert.deepEqual(Array.from(result.board, row => row.id), ['hand-card']);
  assert.equal(result.history.length, 12);
  assert.deepEqual(
    Array.from(result.history).slice(0, 4).map(row => row.id),
    ['sprint-newest', 'sprint-second', 'sprint-third', 'sprint-oldest'],
    'the flat History partition starts with its sorted root rows',
  );
  assert.ok(Array.from(result.history).slice(4).every(row => row.parent), 'children follow the root rows');
  assert.deepEqual(
    Array.from(result.history, row => row.id).sort(),
    cards.filter(row => row.id !== 'hand-card').map(row => row.id).sort(),
    'all unit and QA children follow their finished sprint, regardless of their own stage',
  );
});

test('the rendered Board derives counts, sprint band, dwell pool, and columns only from board cards', async () => {
  const html = await readFile(PAGE, 'utf8');
  const renderStart = html.indexOf('function renderPipeline(d) {');
  const renderEnd = html.indexOf('function wirePipeline(data) {', renderStart);
  assert.notEqual(renderStart, -1, 'renderPipeline exists');
  assert.notEqual(renderEnd, -1, 'renderPipeline keeps its wirePipeline boundary');
  const source = html.slice(renderStart, renderEnd);
  assert.match(source, /const\s+\{\s*board\s*,\s*history\s*\}\s*=\s*splitBoardHistory\(cards\)/);
  assert.match(source, /const\s+stuck\s*=\s*board\.filter/);
  assert.match(source, /const\s+moving\s*=\s*board\.filter/);
  assert.match(source, /const\s+bandIds\s*=\s*new Set\(board\.filter\([\s\S]*?board\.some/);
  assert.match(source, /const\s+dwellCards\s*=\s*board\.filter/);
  assert.match(source, /const\s+list\s*=\s*board\.filter/);

  const page = pageClient(html);
  assert.equal(page.getView(), 'board', 'every page load starts on Board');
  page.render({
    cards: pageFixture(),
    usesSubscriptions: false,
    stuckAfter: 3,
    swept: { age: '<1m', stuck: false },
    offBoard: { findings: [], skipped: null },
    autoDispatch: { on: false, rows: [] },
  });

  assert.equal(visibleWords(page.element('pipe-counts').innerHTML), '1 cards · 1 moving · 0 stuck · 0 done');
  assert.equal(page.element('sprint-band').innerHTML, '');
  assert.equal(page.element('sprint-band').classList.contains('on'), false);
  assert.doesNotMatch(page.element('sprint-band').innerHTML, /in flight/);
  assert.match(
    page.element('pboard').innerHTML,
    /<div class="pcol done"><h2>Done <span>0<\/span><\/h2><div class="empty">empty<\/div><\/div>/,
  );
  assert.equal(page.element('history-zone').hidden, true);
  assert.equal(page.element('pboard').hidden, false);
});

test('the rendered History view hides only board zones and expands a read-only sprint clock table', async () => {
  const html = await readFile(PAGE, 'utf8');
  const cards = pageFixture();
  cards.push(card({
    id: 'finished-hand',
    title: 'Finished hand card',
    stage: 'done',
    finished: '2026-08-28T10:00:00.000Z',
    counters: { localFails: 2, ciFails: 1, reviewFails: 3 },
  }));
  assert.ok(cards.every(row => !Object.hasOwn(row, 'sprint')), 'the fixture has no attached sprint facts');

  const data = {
    cards,
    usesSubscriptions: false,
    stuckAfter: 3,
    swept: { age: '<1m', stuck: false },
    offBoard: { findings: [], skipped: null },
    autoDispatch: { on: false, rows: [] },
  };
  const page = pageClient(html);
  page.setView('history');
  assert.doesNotThrow(() => page.render(data), 'History rows render before sprint facts are attached');

  assert.equal(visibleWords(page.element('pipe-counts').innerHTML), '5 finished sprints');
  for (const id of ['sprint-band', 'stuck-zone', 'offboard-zone', 'dispatch-zone', 'pboard']) {
    assert.equal(page.element(id).hidden, true, `${id} is hidden in History`);
  }
  assert.equal(page.element('history-zone').hidden, false);
  assert.equal(page.element('history-zone').classList.contains('on'), true);
  assert.equal(page.element('journal-zone').hidden, false, 'the journal remains available in History');

  const collapsed = page.element('history-zone').innerHTML;
  const newestStart = collapsed.indexOf('data-history-toggle="sprint-newest"');
  const secondStart = collapsed.indexOf('data-history-toggle="sprint-second"');
  assert.ok(newestStart >= 0 && secondStart > newestStart, 'finished sprint rows are newest first');
  const newest = collapsed.slice(newestStart, secondStart);
  assert.match(newest, /<b>1<\/b> units/);
  assert.match(newest, /QA: 1 finding · all closed/);
  assert.match(newest, /<b>3<\/b> failures on the way \(local\/ci\/review\)/);

  const handStart = collapsed.indexOf('class="history-item hand-card"');
  assert.ok(handStart >= 0, 'a finished hand card has its own History row');
  const hand = collapsed.slice(handStart);
  assert.doesNotMatch(hand, /data-history-toggle/, 'a hand card cannot expand');
  assert.match(hand, /<b>6<\/b> failures on the way/);
  assert.match(hand, /· hand card/);

  page.openHistoryRow('sprint-newest');
  page.render(data);
  const expandedMarkup = page.element('history-zone').innerHTML;
  const expandedStart = expandedMarkup.indexOf('data-history-toggle="sprint-newest"');
  const expandedEnd = expandedMarkup.indexOf('data-history-toggle="sprint-second"');
  const expanded = expandedMarkup.slice(expandedStart, expandedEnd);
  assert.match(expanded, /class="history-detail"/);
  assert.match(expanded, /<b>U1 #304<\/b> Newest sprint unit/);
  assert.match(expanded, /<b>QA #305<\/b> Newest sprint QA/);
  assert.doesNotMatch(expanded, /<\/b> (?:U1 #304|QA #305)/, 'the stored unit prefix is not repeated');
  assert.match(expanded, /class="history-sep">·<\/span>/, 'the row separates its title from the stage clocks');
  assert.match(expanded, /<span class="stage-name">Development<\/span><span class="clk stopped"/);
  assert.doesNotMatch(expanded, /<form|<button|data-act=|class="pcard"/,
    'expanded History is read-only and does not reuse an interactive card');
});

test('the page exposes the specified Board/History switch and both qaWords copies agree', async () => {
  const html = await readFile(PAGE, 'utf8');
  const pipeCounts = html.indexOf('<div class="num" id="pipe-counts"></div>');
  const viewSwitch = html.indexOf('<nav class="view-switch">');
  const boardWarn = html.indexOf('<div class="flag" id="board-warn"');
  assert.ok(pipeCounts < viewSwitch && viewSwitch < boardWarn, 'the view switch follows pipe-counts in the header');
  assert.match(html, /<nav class="view-switch">\s*<button data-view="board"[^>]*>Board<\/button>\s*<button data-view="history"[^>]*>History<\/button>\s*<\/nav>/);
  assert.match(html, /<div class="history-zone" id="history-zone"/);
  assert.ok(html.indexOf('id="pboard"') < html.indexOf('id="history-zone"'), 'History sits under the board columns');
  assert.match(html, /let view = 'board';/, 'view state defaults in memory on every page load');
  assert.match(html, /qaWords\(qa\.length, qaOpen\)/, 'the sprint band uses the shared QA wording rule');

  const pageQaWords = extractMarked(html, '// qa-words start', '// qa-words end', 'qaWords');
  const cases = [
    [0, 0, 'QA: none'],
    [1, 0, 'QA: 1 finding · all closed'],
    [4, 0, 'QA: 4 findings · all closed'],
    [4, 1, 'QA: 4 findings · 1 open'],
  ];
  for (const [n, open, expected] of cases) {
    assert.equal(pageQaWords(n, open), expected, `page qaWords(${n}, ${open})`);
    assert.equal(pipelineQaWords(n, open), expected, `pipeline qaWords(${n}, ${open})`);
    assert.equal(pageQaWords(n, open), pipelineQaWords(n, open), 'the page and API wording stay identical');
  }
});
