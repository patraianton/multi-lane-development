// The review artifact's answers as a fact on the card: an agent marks them
// (artifact-answered), a new artifact link clears the mark, nothing enters
// ticketed while a linked artifact is unanswered, and the board's own sweep
// finds the answers in the desktop Lavish state file without draining them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBoard, postJson, getJson } from './helpers.mjs';

const KEY = '0123456789abcdef';
const ARTIFACT = `https://tunnel.example.test/session/${KEY}`;

async function cardAtGrilled(base, title) {
  const created = await postJson(base, '/pipeline/card/create', { title, spec: 'x' });
  assert.equal(created.status, 200);
  const id = created.body.card.id;
  assert.equal((await postJson(base, '/pipeline/card/move', { id, to: 'grilled' })).status, 200);
  return id;
}

test('artifact-answered marks the card once, gates ticketed, and a new link resets it', async () => {
  const board = await startBoard({ port: 14998, config: { source: 'probe', subscriptions: ['cx1'] } });
  try {
    const id = await cardAtGrilled(board.base, 'artifact answers card');

    // No artifact link — nothing to mark.
    const early = await postJson(board.base, '/pipeline/card/artifact-answered', { id, answers: 1 });
    assert.equal(early.status, 400);
    assert.ok(early.body.error.includes('links.artifact'));

    const linked = await postJson(board.base, '/pipeline/card/update', { id, links: { artifact: ARTIFACT } });
    assert.equal(linked.status, 200);

    // Unanswered: the way into ticketed is closed, by move and by subscription.
    const refused = await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    assert.equal(refused.status, 400);
    assert.ok(refused.body.error.includes('answered'), refused.body.error);
    const assign = await postJson(board.base, '/pipeline/assign-subscription',
      { cardId: id, subscription: 'cx1', by: 'owner' });
    assert.equal(assign.status, 400);
    assert.ok(assign.body.error.includes('answered'), assign.body.error);
    const still = await getJson(board.base, `/api/pipeline/card/${id}?format=json`);
    assert.equal(still.body.stage, 'grilled');
    assert.equal(still.body.subscription, '-');
    assert.equal(still.body.artifact, 'awaiting answers');

    // The mark: time, count, who saw it, one comment.
    const marked = await postJson(board.base, '/pipeline/card/artifact-answered',
      { id, answers: 2, by: 'CTO', at: '2026-08-28T16:31:00.000Z' });
    assert.equal(marked.status, 200);
    assert.deepEqual(marked.body.card.artifactAnswered, { at: '2026-08-28T16:31:00.000Z', answers: 2, by: 'CTO' });
    const commentsAfterMark = marked.body.card.comments.filter(c => c.text.startsWith('review artifact answered'));
    assert.equal(commentsAfterMark.length, 1);
    assert.ok(commentsAfterMark[0].text.includes('2 answers'));

    // Idempotent: a second mark keeps the first time, raises the count only
    // upwards, adds no comment.
    const again = await postJson(board.base, '/pipeline/card/artifact-answered', { id, answers: 1, by: 'sweep' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.card.artifactAnswered, { at: '2026-08-28T16:31:00.000Z', answers: 2, by: 'CTO' });
    assert.equal(again.body.card.comments.filter(c => c.text.startsWith('review artifact answered')).length, 1);
    const more = await postJson(board.base, '/pipeline/card/artifact-answered', { id, answers: 5 });
    assert.equal(more.body.card.artifactAnswered.answers, 5);

    // The agent views carry the fact.
    const view = await getJson(board.base, `/api/pipeline/card/${id}?format=json`);
    assert.equal(view.body.artifact, 'answered 2026-08-28T16:31:00.000Z (5 answers, by CTO)');
    const toon = await fetch(`${board.base}/api/pipeline/card/${id}`).then(r => r.text());
    assert.ok(toon.includes('artifact: answered 2026-08-28T16:31:00.000Z (5 answers, by CTO)'), toon);
    const list = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(list.body.cards.find(c => c.id === id).artifactAnswered.answers, 5);
    const page = await getJson(board.base, '/pipeline/data');
    assert.equal(page.body.cards.find(c => c.id === id).artifactAnswered.by, 'CTO');

    // Answered: the subscription answer walks the card into ticketed.
    const assigned = await postJson(board.base, '/pipeline/assign-subscription',
      { cardId: id, subscription: 'cx1', by: 'owner' });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.card.stage, 'ticketed');

    // A new review page is a new round: the mark is gone, the cell says so.
    const relinked = await postJson(board.base, '/pipeline/card/update',
      { id, links: { artifact: 'https://tunnel.example.test/session/fedcba9876543210' } });
    assert.equal(relinked.status, 200);
    assert.equal(relinked.body.card.artifactAnswered, undefined);
    const reset = await getJson(board.base, `/api/pipeline/card/${id}?format=json`);
    assert.equal(reset.body.artifact, 'awaiting answers');
    // Re-sending the same link keeps whatever mark exists.
    await postJson(board.base, '/pipeline/card/artifact-answered', { id, answers: 1 });
    const same = await postJson(board.base, '/pipeline/card/update',
      { id, links: { artifact: 'https://tunnel.example.test/session/fedcba9876543210' } });
    assert.equal(same.body.card.artifactAnswered.answers, 1);

    // A card with no artifact link moves into ticketed as before.
    const plain = await cardAtGrilled(board.base, 'no artifact card');
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id: plain, to: 'ticketed' })).status, 200);
    const plainView = await getJson(board.base, `/api/pipeline/card/${plain}?format=json`);
    assert.equal(plainView.body.artifact, '-');
  } finally {
    await board.stop();
  }
});

test('the sweep reads the desktop Lavish state and marks the card without draining anything', async () => {
  const state = {
    sessions: {
      [KEY]: {
        key: KEY,
        file: 'C:/somewhere/.lavish/grill.html',
        status: 'open',
        pending_prompts: 0,
        prompts: [],
        // Two form answers were queued and already drained by the CTO's poll
        // (the fork counts them at queue time); one chat message is still in
        // `chat`. The count wins over what the poll left behind.
        answers_total: 3,
        last_answer_at: '2026-08-28T16:33:35.512Z',
        chat: [
          { role: 'agent', text: 'Here are the questions.', at: '2026-08-28T15:14:57.419Z' },
          { role: 'user', text: 'Option A for question 1.', at: '2026-08-28T16:31:16.000Z' },
        ],
        updated_at: '2026-08-28T16:33:35.512Z',
      },
      abcdefabcdefabcd: {
        key: 'abcdefabcdefabcd', status: 'open', prompts: [],
        chat: [{ role: 'agent', text: 'nothing answered yet', at: '2026-08-28T15:00:00.000Z' }],
        updated_at: '2026-08-28T15:00:00.000Z',
      },
    },
  };
  const board = await startBoard({
    port: 14999,
    config: { source: 'probe' },
    files: { 'state.json': state },
    env: dir => ({ LAVISH_AXI_STATE_DIR: dir, WATCHTOWER_ARTIFACT_SWEEP_MS: '300' }),
  });
  try {
    const answered = await cardAtGrilled(board.base, 'answered on the desktop');
    await postJson(board.base, '/pipeline/card/update', { id: answered, links: { artifact: ARTIFACT } });
    const silent = await cardAtGrilled(board.base, 'nobody answered');
    await postJson(board.base, '/pipeline/card/update',
      { id: silent, links: { artifact: 'https://tunnel.example.test/session/abcdefabcdefabcd' } });
    const unknown = await cardAtGrilled(board.base, 'unknown session');
    await postJson(board.base, '/pipeline/card/update',
      { id: unknown, links: { artifact: 'https://elsewhere.example.test/session/1111111111111111' } });

    // The sweep runs on its own timer: wait for the mark, at most a few seconds.
    let card = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const res = await getJson(board.base, `/api/pipeline/card/${answered}?format=json`);
      if (res.body.artifact.startsWith('answered')) { card = res.body; break; }
      await new Promise(r => setTimeout(r, 150));
    }
    assert.ok(card, 'the sweep never marked the card');
    assert.equal(card.artifact, 'answered 2026-08-28T16:33:35.512Z (3 answers, by lavish-local)');
    assert.equal(card.comments.filter(c => c.text.startsWith('review artifact answered')).length, 1);

    // The state file was only read: the session is byte-identical.
    const after = await getJson(board.base, `/api/pipeline/card/${silent}?format=json`);
    assert.equal(after.body.artifact, 'awaiting answers');
    const none = await getJson(board.base, `/api/pipeline/card/${unknown}?format=json`);
    assert.equal(none.body.artifact, 'awaiting answers');

    // With the mark in place the card walks into ticketed.
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id: answered, to: 'ticketed' })).status, 200);
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id: silent, to: 'ticketed' })).status, 400);
  } finally {
    await board.stop();
  }
});
