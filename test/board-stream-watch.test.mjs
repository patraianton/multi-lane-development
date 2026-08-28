// /api/board against a real server: whatever STREAM-WATCH.json holds, the
// board answers 200 — a bad record turns into a `stream-watch` problem row,
// never into "could not collect the board".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startBoard, getJson } from './helpers.mjs';

// `source: "probe"` keeps the server away from herdr, and no repo/hosts keeps
// it away from gh and ssh — the test needs nothing but the process itself.
const configFor = (dir) => ({
  allWindows: true,
  source: 'probe',
  streamWatch: path.join(dir, 'STREAM-WATCH.json'),
});

test('string and list branch_prefix: 200 and no stream-watch problem', async () => {
  const board = await startBoard({
    port: 14971,
    config: configFor,
    files: {
      'STREAM-WATCH.json': {
        streams: [
          { id: 'as-string', pane: 'w1:p1', branch_prefix: 'fix/one-' },
          { id: 'as-list', pane: 'w2:p1', branch_prefix: ['feat/two-'] },
        ],
      },
    },
  });
  try {
    const { status, body } = await getJson(board.base, '/api/board?format=json');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.problems));
    assert.deepEqual(body.problems.filter(p => p.source === 'stream-watch'), []);
  } finally {
    await board.stop();
  }
});

test('rubbish records: 200, each lost record is a stream-watch problem', async () => {
  const board = await startBoard({
    port: 14972,
    config: configFor,
    files: {
      'STREAM-WATCH.json': {
        streams: [
          { id: 'good', branch_prefix: 'ok-' },
          { id: 'bad', branch_prefix: 42 },
          'not-an-object',
        ],
      },
    },
  });
  try {
    const { status, body } = await getJson(board.base, '/api/board?format=json');
    assert.equal(status, 200);
    const rows = body.problems.filter(p => p.source === 'stream-watch');
    assert.equal(rows.length, 2);
    assert.ok(rows.some(r => r.error.includes('bad')));
    assert.ok(rows.some(r => r.error.includes('record #3')));
  } finally {
    await board.stop();
  }
});

test('a record bound to a live pane with rubbish lanes and state_file: still 200', async () => {
  const board = await startBoard({
    port: 14974,
    config: (dir) => ({ ...configFor(dir), probeToken: 'test-secret' }),
    files: {
      'STREAM-WATCH.json': {
        streams: [{
          id: 'demo',
          pane: 'w1:p1',
          branch_prefix: 'fix/x-',
          lanes: 'junk',
          state_file: 42,
        }],
      },
    },
  });
  try {
    // Bind the record: a probe snapshot with one live pane the stream points at.
    // Without it no record is ever read past the maps, and the rubbish above
    // would never be reached (that is exactly how the first cut slipped through).
    const snap = await fetch(board.base + '/probe/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' },
      body: JSON.stringify({
        windows: [{ workspace_id: 'w1', label: 'demo', tab_count: 1 }],
        tabs: [{ tab_id: 'w1:t1', label: 'demo' }],
        panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: 'C:\\demo\\proj' }],
        agents: [],
      }),
    });
    assert.equal(snap.status, 200);
    const { status, body } = await getJson(board.base, '/api/board?format=json');
    assert.equal(status, 200);
    assert.equal(body.cards.length, 1);
    const rows = body.problems.filter(p => p.source === 'stream-watch');
    assert.equal(rows.length, 2);
    assert.ok(rows.some(r => r.error.includes('lanes')));
    assert.ok(rows.some(r => r.error.includes('state_file')));
  } finally {
    await board.stop();
  }
});

test('a file that is not an object at all: still 200', async () => {
  const board = await startBoard({
    port: 14973,
    config: configFor,
    files: { 'STREAM-WATCH.json': '"just a string"' },
  });
  try {
    const { status, body } = await getJson(board.base, '/api/board?format=json');
    assert.equal(status, 200);
    const rows = body.problems.filter(p => p.source === 'stream-watch');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].error.includes('not an object'));
  } finally {
    await board.stop();
  }
});
