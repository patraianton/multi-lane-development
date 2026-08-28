// The publish CLI against a real local artifact instance (the worker on
// node:http with an in-memory KV) — the VERIFY path from the task: a dry-run
// and a live publish work end to end without Cloudflare, and --card rings the
// board's Telegram doorbell.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createWorker } from '../deploy/lavish-worker/worker.mjs';
import { createMemoryKv } from '../deploy/lavish-worker/memory-kv.mjs';
import { stubAssets } from '../deploy/lavish-worker/stub-assets.mjs';
import { serveWorker } from '../deploy/lavish-worker/serve-local.mjs';
import { startBoard, postJson } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'lavish-publish.mjs');
const run = promisify(execFile);

const TOKEN = 'local-test-token';
const PORT = 14993;
const BASE = `http://127.0.0.1:${PORT}`;

async function withInstance(fn) {
  const env = { LAVISH_KV: createMemoryKv(), LAVISH_API_TOKEN: TOKEN };
  const server = serveWorker(createWorker(stubAssets), env, PORT);
  await new Promise(r => server.once('listening', r));
  try { return await fn(); }
  finally { await new Promise(r => server.close(r)); }
}

async function cli(cliArgs, stateDir) {
  return run(process.execPath, [CLI, ...cliArgs], {
    env: { ...process.env, WATCHTOWER_STATE_DIR: stateDir ?? path.join(ROOT, 'no-such-state') },
  });
}

test('publish dry-run against a local instance prints the plan and sends nothing', async () => {
  await withInstance(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lavish-publish-test-'));
    try {
      const file = path.join(dir, 'grill.html');
      await writeFile(file, '<html><head><title>Grill round 1</title></head><body>q</body></html>');
      const { stdout } = await cli(
        ['publish', file, '--base', BASE, '--token', TOKEN, '--card', 'c-x', '--dry-run'], dir);
      assert.ok(stdout.includes('dry-run: POST'), stdout);
      assert.ok(stdout.includes('/api/publish'));
      assert.ok(stdout.includes('would publish'));
      assert.ok(stdout.includes('Grill round 1'), 'title read from the file');
      assert.ok(stdout.includes('/pipeline/card/update'));
      // Nothing was actually published.
      const poll = await fetch(`${BASE}/api/poll?key=0123456789abcdef`,
        { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal((await poll.json()).status, 'missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('publish, annotate, poll, reply — the full round against the local instance', async () => {
  await withInstance(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lavish-publish-test-'));
    try {
      const file = path.join(dir, 'grill.html');
      await writeFile(file, '<html><head><title>Grill</title></head><body><h2 id="q1">Q1</h2></body></html>');
      // The config-file path: base and token read from the lavish block.
      await writeFile(path.join(dir, 'autopase-board.json'), JSON.stringify({
        lavish: { publicBaseUrl: BASE, apiToken: TOKEN },
      }));
      const { stdout } = await cli(['publish', file], dir);
      const url = /published: (\S+)/.exec(stdout)[1];
      const key = /\/session\/([0-9a-f]{16})/.exec(url)[1];

      // The published page is live and carries the review chrome.
      const page = await fetch(url);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes('lavish-session'));

      // A founder annotates on the page…
      const send = await fetch(`${BASE}/api/${key}/prompts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompts: [{ uid: 'a1', prompt: 'Is Q1 in scope?', selector: '#q1', tag: 'h2', text: 'Q1' }],
        }),
      });
      assert.equal(send.status, 200);

      // …the CTO polls it in (accepting the full URL as the argument)…
      const polled = await cli(['poll', url], dir);
      const answer = JSON.parse(polled.stdout);
      assert.equal(answer.status, 'feedback');
      assert.equal(answer.prompts[0].prompt, 'Is Q1 in scope?');

      // …answers, and the reply is visible on the session page.
      await cli(['reply', key, '--text', 'Yes, Q1 stays in scope.'], dir);
      const pageAfter = await (await fetch(url)).text();
      assert.ok(pageAfter.includes('Yes, Q1 stays in scope.'));

      await cli(['end', key], dir);
      const afterEnd = await fetch(`${BASE}/api/poll?key=${key}`,
        { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.deepEqual(await afterEnd.json(), { status: 'ended', ended_by: 'agent' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('publish --card sets links.artifact on the board and rings the doorbell', async () => {
  await withInstance(async () => {
    const board = await startBoard({
      port: 14994,
      config: {
        source: 'probe',
        telegram: {
          dryRun: true, chatId: '-1', boardUrl: 'https://board.example', apiToken: 't',
          founders: [
            { name: 'Anton', tgUserId: 1, tag: '@anton', owner: true },
            { name: 'Partner', tgUserId: 2, tag: '@partner', owner: false },
          ],
        },
      },
    });
    const dir = await mkdtemp(path.join(tmpdir(), 'lavish-publish-test-'));
    try {
      const created = await postJson(board.base, '/pipeline/card/create', { title: 'Grilled card' });
      const id = created.body.card.id;
      await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });

      const file = path.join(dir, 'grill.html');
      await writeFile(file, '<html><head><title>Grill</title></head><body>q</body></html>');
      const { stdout } = await cli(
        ['publish', file, '--base', BASE, '--token', TOKEN, '--card', id, '--board', board.base], dir);
      assert.ok(stdout.includes(`card ${id}: links.artifact set`), stdout);

      const deadline = Date.now() + 5000;
      while (!board.output().includes('--- notifyArtifactReady ---')) {
        if (Date.now() > deadline) assert.fail(`doorbell never rang:\n${board.output()}`);
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(board.output().includes(`${BASE}/session/`), 'the notification carries the artifact URL');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await board.stop();
    }
  });
});
