// The ticketed stage against a real server: it sits between grilled and
// development, entering it from grilled is free, and leaving it for
// development is refused until the card carries a ticket link. Cards written
// before the stage existed keep loading and keep moving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBoard, postJson, getJson } from './helpers.mjs';

test('ticketed sits between grilled and development; the ticket link gates the way out', async () => {
  const board = await startBoard({ config: { source: 'probe' } });
  try {
    // The stage list the page draws: ticketed right after grilled.
    const data = await getJson(board.base, '/pipeline/data');
    assert.equal(data.status, 200);
    const keys = data.body.stages.map(s => s.key);
    assert.ok(keys.includes('ticketed'));
    assert.equal(keys.indexOf('ticketed'), keys.indexOf('grilled') + 1);
    assert.equal(keys.indexOf('development'), keys.indexOf('ticketed') + 1);

    const created = await postJson(board.base, '/pipeline/card/create',
      { title: 'ticketed stage card', spec: 'prove the gate' });
    assert.equal(created.status, 200);
    const id = created.body.card.id;

    const grilled = await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    assert.equal(grilled.status, 200);

    // The old direct road is closed: grilled now leads to ticketed only.
    const skip = await postJson(board.base, '/pipeline/card/move', { id, to: 'development' });
    assert.equal(skip.status, 400);
    assert.ok(skip.body.error.includes('ticketed'));

    // Entering ticketed from grilled is free.
    const ticketed = await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    assert.equal(ticketed.status, 200);
    assert.equal(ticketed.body.card.stage, 'ticketed');

    // No ticket link yet — the way to development is refused, and the card
    // stays exactly where it was.
    const refused = await postJson(board.base, '/pipeline/card/move', { id, to: 'development' });
    assert.equal(refused.status, 400);
    assert.ok(refused.body.error.includes('links.ticket'));
    const after = await getJson(board.base, '/pipeline/data');
    assert.equal(after.body.cards.find(c => c.id === id).stage, 'ticketed');

    // With the link attached the same move passes.
    const linked = await postJson(board.base, '/pipeline/card/update',
      { id, links: { ticket: 'https://github.com/example/repo/issues/7' } });
    assert.equal(linked.status, 200);
    const moved = await postJson(board.base, '/pipeline/card/move', { id, to: 'development' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.card.stage, 'development');

    // The stage left its clock segment behind.
    const history = moved.body.card.stageHistory.map(h => h.stage);
    assert.deepEqual(history, ['spec', 'grilled', 'ticketed', 'development']);

    // Nothing was built in ticketed, so a failure reported there is a 400.
    const back = await postJson(board.base, '/pipeline/card/create',
      { title: 'fail from ticketed', spec: '' });
    const id2 = back.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id: id2, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/move', { id: id2, to: 'ticketed' });
    const failed = await postJson(board.base, '/pipeline/card/fail', { id: id2, kind: 'local' });
    assert.equal(failed.status, 400);

    // The /api/pipeline help names the stage.
    const toon = await fetch(board.base + '/api/pipeline');
    const text = await toon.text();
    assert.ok(text.includes('spec, grilled, ticketed, development'));
  } finally {
    await board.stop();
  }
});

test('a state file from before the ticketed stage keeps loading and keeps moving', async () => {
  const old = {
    cards: [{
      id: 'c-old-dev',
      title: 'card already in development',
      spec: 'written before the ticketed stage existed',
      stage: 'development',
      createdAt: '2026-08-01T10:00:00.000Z',
      stageHistory: [
        { stage: 'spec', enteredAt: '2026-08-01T10:00:00.000Z', leftAt: '2026-08-01T11:00:00.000Z' },
        { stage: 'grilled', enteredAt: '2026-08-01T11:00:00.000Z', leftAt: '2026-08-01T12:00:00.000Z' },
        { stage: 'development', enteredAt: '2026-08-01T12:00:00.000Z', leftAt: null },
      ],
      counters: { localFails: 1, ciFails: 0, acceptanceFails: 0 },
      consecutiveFails: 0,
      links: { ticket: '', branch: 'feat/old', pr: '', artifact: '' },
      comments: [],
    }],
  };
  const board = await startBoard({
    config: { source: 'probe' },
    files: { 'pipeline-cards.json': old },
  });
  try {
    // The card loads untouched: same stage, same history, no migration.
    const data = await getJson(board.base, '/pipeline/data');
    assert.equal(data.status, 200);
    const card = data.body.cards.find(c => c.id === 'c-old-dev');
    assert.equal(card.stage, 'development');
    assert.deepEqual(card.stageHistory.map(h => h.stage), ['spec', 'grilled', 'development']);
    assert.equal(card.counters.localFails, 1);

    // And its road onward is not blocked by the new gate: development is
    // already past ticketed.
    const moved = await postJson(board.base, '/pipeline/card/move',
      { id: 'c-old-dev', to: 'local_check' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.card.stage, 'local_check');
  } finally {
    await board.stop();
  }
});
