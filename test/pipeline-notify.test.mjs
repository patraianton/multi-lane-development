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

import { getJson, startBoard, postJson } from './helpers.mjs';
import {
  configureTelegram,
  notifyArtifactReady,
  notifyDone,
  notifyIdleLanes,
  notifyStuck,
} from '../bin/telegram-bot.mjs';

const TELEGRAM = {
  dryRun: true,
  chatId: '-100123',
  ownerChatId: '1001',
  founders: [
    { name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true },
    { name: 'Partner', tgUserId: 1002, tag: '@partner', owner: false },
  ],
};

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(r => setTimeout(r, 50));
  }
}

function countMatches(text, needle) {
  return text.split(needle).length - 1;
}

test('senders need no board credentials and route group and owner messages', async () => {
  const originalFetch = globalThis.fetch;
  const sends = [];
  globalThis.fetch = async (_url, options) => {
    sends.push(JSON.parse(options.body));
    return {
      status: 200,
      async json() { return { ok: true, result: { message_id: sends.length } }; },
    };
  };

  try {
    const configured = configureTelegram({
      botToken: 'test-token',
      chatId: '-100123',
      founders: TELEGRAM.founders,
    });
    assert.equal('boardUrl' in configured, false);
    assert.equal('apiToken' in configured, false);

    const card = {
      id: 'c-routing',
      title: 'Routing proof',
      links: {
        artifact: 'https://artifacts.example/routing-proof',
        ticket: 'https://github.com/acme/web/issues/42',
      },
    };
    await notifyArtifactReady(card);
    await notifyDone(card);
    await assert.rejects(
      notifyStuck(card, 'three failures'),
      /no ownerChatId/,
      'a missing owner destination does not disable group sending');

    configureTelegram({
      botToken: 'test-token',
      chatId: '-100123',
      ownerChatId: '1001',
      founders: TELEGRAM.founders,
    });
    await notifyStuck(card, 'three failures');
    await notifyIdleLanes(card, {
      free: ['lane-2'],
      ageMs: 5 * 60_000,
      startable: [{ unit: 'T2', ticket: 42 }],
    });
    assert.deepEqual(
      sends.map(send => send.chat_id),
      ['-100123', '-100123', '1001', '1001']);
    for (const send of [sends[0], sends[1]]) {
      assert.ok(!send.text.includes('Card:'), 'group message has no Card link');
      assert.ok(!send.text.includes('#pipeline/'), 'group message has no board deep link');
    }
    assert.ok(!sends[3].text.includes('The CTO window has been told to dispatch'));
  } finally {
    configureTelegram(null);
    globalThis.fetch = originalFetch;
  }
});

test('autoDispatch stays off without an owner chat and mirrors timestamped logs', async () => {
  const head = 'abc12345abcdef0123456789abcdef0123456789';
  const verdict = {
    round: 1, go: true, head: head.slice(0, 8), at: '2026-08-30T10:00:00.000Z',
    body: `R1 — GO\nhead ${head.slice(0, 8)}`,
  };
  const facts = {
    lanes: [],
    prs: [{
      number: 1616, url: 'https://github.com/acme/web/pull/1616', branch: 'feat/1516',
      headSha: head, title: 'Missing-owner merge proof', body: 'Ticket: #1516',
      draft: false, mergeable: 'MERGEABLE', labels: [],
      ci: { color: 'green', text: 'CI green (1)', headSha: head },
      verdict, verdicts: [verdict], verdictOnHead: verdict, verdictRounds: 1,
    }],
    mergedPrs: [], openIssues: [], ciJobs: {}, ciRunners: [], staleSources: [],
    unitIssues: {
      1515: [{
        number: 1516, title: 'SAFE-U1: mergeable unit',
        url: 'https://github.com/acme/web/issues/1516', state: 'OPEN',
        branch: 'feat/1516', labels: [],
      }],
    },
    umbrellaStates: { 1515: 'OPEN' },
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: true, repo: 'acme/web' },
    files: { 'sprint-facts.json': facts },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '200',
      // If the owner gate regresses, this harmless executable fails the would-be
      // gh call and the merge journal assertion below catches the side effect.
      WATCHTOWER_GH: process.execPath,
    }),
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', {
      title: 'SAFE sprint', spec: 'the spec',
    });
    const id = created.body.card.id;
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' })).status, 200);
    assert.equal((await postJson(board.base, '/pipeline/card/update', {
      id, links: { ticket: 'https://github.com/acme/web/issues/1515' },
    })).status, 200);
    assert.equal((await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' })).status, 200);

    const reason = 'auto-dispatch: off — telegram.ownerChatId missing';
    await waitFor(() => board.output().includes(reason));
    await waitFor(async () => {
      const api = await getJson(board.base, '/api/pipeline?format=json');
      return api.body.cards.some(card => card.parent === id && card.stage === 'ci_pr');
    });
    await new Promise(resolve => setTimeout(resolve, 300));

    const output = board.output();
    const log = await readFile(path.join(board.dir, 'board.log'), 'utf8');
    assert.equal(countMatches(output, reason), 1, 'the reason is printed once');
    assert.equal(countMatches(log, reason), 1, 'the same reason is appended once');
    assert.equal(log, output, 'the process-owned log mirrors the captured output');
    for (const line of output.trimEnd().split(/\r?\n/)) {
      assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    }

    const removed = await fetch(board.base + '/api/slots');
    assert.equal(removed.status, 404);
    assert.deepEqual(await removed.json(), { error: 'no such path' });
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')),
      'the effective-off board creates no dispatch journal');
  } finally {
    await board.stop();
  }
});

test('links.artifact first set on a grilled card sends the doorbell once', async () => {
  const board = await startBoard({
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
    assert.ok(!out.includes('Card:'), 'group message has no board card link');

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

test('links.artifact first set on a merged card sends the doorbell', async () => {
  const board = await startBoard({
    config: { source: 'probe', telegram: TELEGRAM },
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Ready for acceptance' });
    const id = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    await postJson(board.base, '/pipeline/card/update', {
      id, links: { ticket: 'https://github.com/acme/web/issues/12' },
    });
    for (const to of ['development', 'local_check', 'ci_pr', 'merged']) {
      const moved = await postJson(board.base, '/pipeline/card/move', { id, to });
      assert.equal(moved.status, 200);
    }

    const url = 'https://artifacts.example/acceptance-1';
    const updated = await postJson(board.base, '/pipeline/card/update', {
      id, links: { artifact: url },
    });
    assert.equal(updated.status, 200);
    await waitFor(() => board.output().includes('--- notifyArtifactReady ---'));
    assert.equal(countMatches(board.output(), '--- notifyArtifactReady ---'), 1);
    assert.ok(board.output().includes(url));
    assert.ok(updated.body.card.notified?.artifact);
  } finally {
    await board.stop();
  }
});

test('no telegram config means the update still works and nothing is sent', async () => {
  const board = await startBoard({ config: { source: 'probe' } });
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
