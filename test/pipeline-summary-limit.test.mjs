// The summary cap: a card's short retelling may be at most 200 characters, on
// every write path that accepts one. Longer is a 400 naming the limit and the
// actual length — never a silent clip — and the stored card is not touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startBoard, postJson, getJson } from './helpers.mjs';

const AT_LIMIT = 'a'.repeat(200);
const OVER_LIMIT = 'b'.repeat(201);

test('POST /pipeline/card/summary: 200 characters pass, 201 are rejected', async () => {
  const board = await startBoard({ port: 14982, config: { source: 'probe' } });
  try {
    const created = await postJson(board.base, '/pipeline/card/create',
      { title: 'summary cap card', spec: 'the spec' });
    assert.equal(created.status, 200);
    const id = created.body.card.id;

    // Exactly at the limit: accepted and stored as sent.
    const ok = await postJson(board.base, '/pipeline/card/summary',
      { id, summary: AT_LIMIT });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.card.summary, AT_LIMIT);

    // One character over: 400, and the error names both numbers so the author
    // knows how much to cut without counting.
    const over = await postJson(board.base, '/pipeline/card/summary',
      { id, summary: OVER_LIMIT });
    assert.equal(over.status, 400);
    assert.ok(over.body.error.includes('201'), `error should name the actual length: ${over.body.error}`);
    assert.ok(over.body.error.includes('200'), `error should name the limit: ${over.body.error}`);

    // The rejected write changed nothing.
    const { status, body } = await getJson(board.base, '/pipeline/data');
    assert.equal(status, 200);
    assert.equal(body.cards[0].summary, AT_LIMIT);

    // An empty string still clears the summary.
    const cleared = await postJson(board.base, '/pipeline/card/summary',
      { id, summary: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.card.summary, '');
  } finally {
    await board.stop();
  }
});

test('POST /pipeline/card/create: the same cap guards the summary at birth', async () => {
  const board = await startBoard({ port: 14983, config: { source: 'probe' } });
  try {
    const over = await postJson(board.base, '/pipeline/card/create',
      { title: 'over-long at birth', spec: 'spec', summary: OVER_LIMIT });
    assert.equal(over.status, 400);
    assert.ok(over.body.error.includes('201'), `error should name the actual length: ${over.body.error}`);
    assert.ok(over.body.error.includes('200'), `error should name the limit: ${over.body.error}`);

    // The rejected card was not created.
    const empty = await getJson(board.base, '/pipeline/data');
    assert.equal(empty.body.cards.length, 0);

    const ok = await postJson(board.base, '/pipeline/card/create',
      { title: 'at the limit at birth', spec: 'spec', summary: AT_LIMIT });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.card.summary, AT_LIMIT);
  } finally {
    await board.stop();
  }
});

test('a summary stored before the cap survives load and unrelated writes as written', async () => {
  // Written when the limit was 1200 — legal at the time, over the cap now.
  const legacy = 'c'.repeat(500);
  const board = await startBoard({
    port: 14984,
    config: { source: 'probe' },
    files: {
      'pipeline-cards.json': { cards: [
        { id: 'legacy-card', title: 'written before the cap', spec: 'old spec', summary: legacy },
        { id: 'other-card', title: 'a neighbour', spec: 'other spec' },
      ]},
    },
  });
  try {
    // Served as written, not clipped to 200.
    const first = await getJson(board.base, '/pipeline/data');
    assert.equal(first.status, 200);
    const served = first.body.cards.find(c => c.id === 'legacy-card');
    assert.equal(served.summary, legacy);

    // An unrelated mutation persists the whole store — the legacy summary must
    // ride through it untouched, on the wire and on disk.
    const comment = await postJson(board.base, '/pipeline/card/comment',
      { id: 'other-card', author: 'test', text: 'an unrelated write' });
    assert.equal(comment.status, 200);
    const onDisk = JSON.parse(await readFile(path.join(board.dir, 'pipeline-cards.json'), 'utf8'));
    assert.equal(onDisk.cards.find(c => c.id === 'legacy-card').summary, legacy);

    // The cap still guards new writes to that same card.
    const over = await postJson(board.base, '/pipeline/card/summary',
      { id: 'legacy-card', summary: OVER_LIMIT });
    assert.equal(over.status, 400);
    const ok = await postJson(board.base, '/pipeline/card/summary',
      { id: 'legacy-card', summary: AT_LIMIT });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.card.summary, AT_LIMIT);
  } finally {
    await board.stop();
  }
});
