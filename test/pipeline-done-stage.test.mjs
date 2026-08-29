// Decision 10: the road ends at done. A state file from before it — cards in
// "acceptance" or "accepted", an "acceptanceFails" counter — loads as done
// cards with a review counter; "accept" is gone. Decision 11 put QA before
// done: ci_pr → review → qa → done are plain moves, ci_pr → done is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBoard, postJson, getJson } from './helpers.mjs';

const card = (id, title, stage, history, counters) => ({
  id, title, spec: '', stage,
  createdAt: history[0].enteredAt,
  stageHistory: history,
  counters, consecutiveFails: 0,
  links: { ticket: '', branch: '', pr: '', artifact: '' },
  comments: [],
});

const OLD = {
  cards: [
    card('c-old-finished', 'finished before decision 10', 'accepted', [
      { stage: 'ci_pr', enteredAt: '2026-08-20T10:00:00.000Z', leftAt: '2026-08-20T12:00:00.000Z' },
      { stage: 'acceptance', enteredAt: '2026-08-20T12:00:00.000Z', leftAt: '2026-08-21T12:00:00.000Z' },
      { stage: 'accepted', enteredAt: '2026-08-21T12:00:00.000Z', leftAt: null },
    ], { localFails: 0, ciFails: 1, acceptanceFails: 2 }),
    card('c-old-waiting', 'waiting before decision 10', 'acceptance', [
      { stage: 'acceptance', enteredAt: '2026-08-22T10:00:00.000Z', leftAt: null },
    ], { localFails: 0, ciFails: 0, acceptanceFails: 0 }),
    card('c-ci', 'in CI/PR', 'ci_pr', [
      { stage: 'ci_pr', enteredAt: '2026-08-23T10:00:00.000Z', leftAt: null },
    ], { localFails: 0, ciFails: 0, reviewFails: 0 }),
  ],
};

test('acceptance and accepted from an older state file load as done; ci_pr moves to done through qa', async () => {
  const board = await startBoard({ port: 14975, config: { source: 'probe' }, files: { 'pipeline-cards.json': OLD } });
  try {
    const data = await getJson(board.base, '/pipeline/data');
    const by = Object.fromEntries(data.body.cards.map(c => [c.id, c]));
    assert.equal(by['c-old-finished'].stage, 'done');
    assert.deepEqual(by['c-old-finished'].stageHistory.map(h => h.stage), ['ci_pr', 'done', 'done']);
    assert.equal(by['c-old-finished'].counters.reviewFails, 2, 'the old acceptance counter is the review counter');
    assert.equal(by['c-old-finished'].counters.acceptanceFails, undefined);
    assert.equal(by['c-old-waiting'].stage, 'done');
    assert.equal(by['c-ci'].stage, 'ci_pr');

    // The list view counts done cards and stops their clock.
    const list = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(list.body.summary.done, 2);
    assert.equal(list.body.summary.waitingForAcceptance, undefined);
    assert.equal(list.body.summary.failures, 3);
    assert.ok(list.body.cards.find(c => c.id === 'c-old-finished').clock.endsWith('(stopped)'));
    const toon = await fetch(`${board.base}/api/pipeline`).then(r => r.text());
    assert.ok(toon.includes('stages: spec, grilled, ticketed, development, local_check, ci_pr, review, merged, done;'), toon);
    assert.ok(!/acceptance|accepted/.test(toon), toon);
    assert.ok(!/\bqa —/.test(toon), 'QA is not a stage any more (decision 19)');

    // ci_pr → review → merged → done are plain moves, ci_pr → done is not; accept is not
    // an action any more.
    const skip = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'done' });
    assert.equal(skip.status, 400);
    assert.match(JSON.stringify(skip.body), /can only move to review/);
    const rv = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'review' });
    assert.equal(rv.body.card.stage, 'review');
    const early = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'done' });
    assert.equal(early.status, 400, 'review goes to merged first');
    const noQa = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'qa' });
    assert.equal(noQa.status, 400, 'there is no QA stage');
    const mg = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'merged' });
    assert.equal(mg.body.card.stage, 'merged');
    const moved = await postJson(board.base, '/pipeline/card/move', { id: 'c-ci', to: 'done' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.card.stage, 'done');
    const accept = await postJson(board.base, '/pipeline/card/accept', { id: 'c-ci' });
    assert.equal(accept.status, 404);

    // A done card cannot fail, "acceptance" is no longer a failure kind, and
    // "review" is.
    const done = await postJson(board.base, '/pipeline/card/fail', { id: 'c-ci', kind: 'ci' });
    assert.equal(done.status, 400);
    const stale = await postJson(board.base, '/pipeline/card/fail', { id: 'c-old-waiting', kind: 'acceptance' });
    assert.equal(stale.status, 400);
    assert.match(JSON.stringify(stale.body), /local, ci or review/);
    const fresh = await postJson(board.base, '/pipeline/card/create', { title: 'reviewed', spec: 'x' });
    const id = fresh.body.card.id;
    for (const to of ['grilled', 'ticketed']) await postJson(board.base, '/pipeline/card/move', { id, to });
    await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: 'https://github.com/acme/web/issues/7' } });
    for (const to of ['development', 'local_check', 'ci_pr']) await postJson(board.base, '/pipeline/card/move', { id, to });
    const nogo = await postJson(board.base, '/pipeline/card/fail', { id, kind: 'review' });
    assert.equal(nogo.status, 200);
    assert.equal(nogo.body.card.stage, 'development');
    assert.equal(nogo.body.card.counters.reviewFails, 1);
    // A review can also say no in review itself: back to development, same
    // counter. Merged is past the reviews: no failure is reported from there.
    for (const to of ['local_check', 'ci_pr', 'review']) await postJson(board.base, '/pipeline/card/move', { id, to });
    const rvNogo = await postJson(board.base, '/pipeline/card/fail', { id, kind: 'review' });
    assert.equal(rvNogo.status, 200);
    assert.equal(rvNogo.body.card.stage, 'development');
    assert.equal(rvNogo.body.card.counters.reviewFails, 2);
    for (const to of ['local_check', 'ci_pr', 'review', 'merged']) await postJson(board.base, '/pipeline/card/move', { id, to });
    const past = await postJson(board.base, '/pipeline/card/fail', { id, kind: 'review' });
    assert.equal(past.status, 400, 'merged cannot fail');
  } finally {
    await board.stop();
  }
});
