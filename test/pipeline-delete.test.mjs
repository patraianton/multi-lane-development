// POST /pipeline/card/delete against a real server: the card leaves the store
// for good, the other cards keep their stage, clocks and spec; an unknown id
// answers 404 with the live ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startBoard, postJson, getJson } from './helpers.mjs';

test('create two cards, delete one — the other is untouched', async () => {
  const board = await startBoard({ config: { source: 'probe' } });
  try {
    const first = await postJson(board.base, '/pipeline/card/create',
      { title: 'first card', spec: 'spec one' });
    assert.equal(first.status, 200);
    const second = await postJson(board.base, '/pipeline/card/create',
      { title: 'second card', spec: 'spec two' });
    assert.equal(second.status, 200);
    const id1 = first.body.card.id;
    const id2 = second.body.card.id;

    // Walk the survivor one stage forward so the test can see its stage and
    // clock survive, not just its title.
    const moved = await postJson(board.base, '/pipeline/card/move', { id: id2, to: 'grilled' });
    assert.equal(moved.status, 200);

    const del = await postJson(board.base, '/pipeline/card/delete', { id: id1 });
    assert.equal(del.status, 200);
    assert.equal(del.body.ok, true);
    assert.equal(del.body.removed.id, id1);
    assert.equal(del.body.removed.title, 'first card');

    // The survivor, from the store: stage, clock segments and spec intact.
    const { status, body } = await getJson(board.base, '/pipeline/data');
    assert.equal(status, 200);
    assert.equal(body.cards.length, 1);
    const survivor = body.cards[0];
    assert.equal(survivor.id, id2);
    assert.equal(survivor.stage, 'grilled');
    assert.equal(survivor.spec, 'spec two');
    assert.equal(survivor.stageHistory.length, 2);
    assert.equal(survivor.stageHistory[0].stage, 'spec');
    assert.ok(survivor.stageHistory[0].leftAt);
    assert.equal(survivor.stageHistory[1].stage, 'grilled');
    assert.equal(survivor.stageHistory[1].leftAt, null);

    // And on disk, through the same atomic write as every other mutation.
    const onDisk = JSON.parse(await readFile(path.join(board.dir, 'pipeline-cards.json'), 'utf8'));
    assert.deepEqual(onDisk.cards.map(c => c.id), [id2]);

    // Deleting a card that is not there (any more): 404 with the live ids.
    const missing = await postJson(board.base, '/pipeline/card/delete', { id: 'no-such-card' });
    assert.equal(missing.status, 404);
    assert.ok(missing.body.error.includes('no-such-card'));
    assert.deepEqual(missing.body.cards, [id2]);

    const again = await postJson(board.base, '/pipeline/card/delete', { id: id1 });
    assert.equal(again.status, 404);
    assert.deepEqual(again.body.cards, [id2]);

    // No id at all is a 400, same words as the other mutations.
    const noId = await postJson(board.base, '/pipeline/card/delete', {});
    assert.equal(noId.status, 400);
    assert.equal(noId.body.error, 'a card id is required');
  } finally {
    await board.stop();
  }
});
