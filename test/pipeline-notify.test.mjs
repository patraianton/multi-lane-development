// The artifact doorbell (docs/GRILL.md §4, docs/TELEGRAM.md): when a card in
// `grilled` first gets links.artifact via POST /pipeline/card/update, the board
// sends the artifact-ready notification tagging both founders — exactly once.
//
// The board runs with telegram.dryRun, so "sending" is a stdout print the test
// can read back through the captured output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { startBoard, postJson } from './helpers.mjs';

const TELEGRAM = {
  dryRun: true,
  chatId: '-100123',
  boardUrl: 'https://board.example',
  apiToken: 'board-token',
  founders: [
    { name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true },
    { name: 'Partner', tgUserId: 1002, tag: '@partner', owner: false },
  ],
};

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(r => setTimeout(r, 50));
  }
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}

test('links.artifact first set on a grilled card sends the doorbell once', async () => {
  const board = await startBoard({
    port: 14991,
    config: { source: 'probe', telegram: TELEGRAM },
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Grill me' });
    assert.equal(created.status, 200);
    const id = created.body.card.id;

    // Not yet grilled: setting the artifact link must NOT notify.
    const early = await postJson(board.base, '/pipeline/card/update', {
      id, links: { artifact: 'https://artifacts.example/too-early' },
    });
    assert.equal(early.status, 200);
    // Clear it again so the grilled-stage set below is a genuine first set.
    await postJson(board.base, '/pipeline/card/update', { id, links: { artifact: '' } });

    const moved = await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    assert.equal(moved.status, 200);
    assert.equal(countMatches(board.output(), 'notifyArtifactReady'), 0);

    const url = 'https://artifacts.example/grill-1';
    const updated = await postJson(board.base, '/pipeline/card/update', {
      id, links: { artifact: url },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.card.links.artifact, url);

    // The notification is sent after the HTTP answer — wait for the dry-run print.
    await waitFor(() => board.output().includes('--- notifyArtifactReady ---'));
    const out = board.output();
    assert.ok(out.includes('@anton @partner'), 'tags both founders');
    assert.ok(out.includes(url), 'carries the artifact URL');
    assert.ok(out.includes(`https://board.example/#pipeline/${id}`), 'links the card');

    // The one-shot stamp is recorded in the same write and persisted to disk.
    assert.ok(updated.body.card.notified?.artifact, 'notified.artifact timestamp recorded');
    const onDisk = JSON.parse(await readFile(path.join(board.dir, 'pipeline-cards.json'), 'utf8'));
    assert.ok(onDisk.cards.find(c => c.id === id).notified.artifact);

    // A second update — same or different URL — must not send again.
    await postJson(board.base, '/pipeline/card/update', {
      id, links: { artifact: 'https://artifacts.example/grill-1-v2' },
    });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(countMatches(board.output(), '--- notifyArtifactReady ---'), 1);
  } finally {
    await board.stop();
  }
});

test('no telegram config means the update still works and nothing is sent', async () => {
  const board = await startBoard({ port: 14992, config: { source: 'probe' } });
  try {
    const { body } = await postJson(board.base, '/pipeline/card/create', { title: 'Quiet card' });
    const id = body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    const updated = await postJson(board.base, '/pipeline/card/update', {
      id, links: { artifact: 'https://artifacts.example/quiet' },
    });
    assert.equal(updated.status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(board.output().includes('telegram notifications skipped'));
    assert.ok(!board.output().includes('notifyArtifactReady'));
  } finally {
    await board.stop();
  }
});
