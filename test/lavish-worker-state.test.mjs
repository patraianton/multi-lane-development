// GET /api/state on the artifact instance: a running count of founder
// answers that a poll never drains, so the board can mark a card answered
// while the CTO's poll still receives every prompt.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorker } from '../deploy/lavish-worker/worker.mjs';
import { createMemoryKv } from '../deploy/lavish-worker/memory-kv.mjs';
import { stubAssets } from '../deploy/lavish-worker/stub-assets.mjs';

const TOKEN = 'test-api-token';
const BASE = 'https://artifacts.example.com';
const auth = { authorization: `Bearer ${TOKEN}` };

async function call(w, env, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await w.fetch(new Request(BASE + path, init), env);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed };
}

test('/api/state counts every queued answer and survives the poll that drains them', async () => {
  const w = createWorker(stubAssets);
  const env = { LAVISH_KV: createMemoryKv(), LAVISH_API_TOKEN: TOKEN };

  const anon = await call(w, env, 'GET', '/api/state?key=0123456789abcdef');
  assert.equal(anon.status, 401);
  const badKey = await call(w, env, 'GET', '/api/state?key=nope', { headers: auth });
  assert.equal(badKey.status, 400);
  const missing = await call(w, env, 'GET', '/api/state?key=0123456789abcdef', { headers: auth });
  assert.deepEqual(missing.body, { status: 'missing' });

  const published = await call(w, env, 'POST', '/api/publish', {
    headers: auth, body: { html: '<html><body><h2 id="q1">Q1</h2></body></html>', title: 'Grill' },
  });
  assert.equal(published.status, 200);
  const key = published.body.key;

  const fresh = await call(w, env, 'GET', `/api/state?key=${key}`, { headers: auth });
  assert.deepEqual(fresh.body, { status: 'open', answers: 0, lastAnswerAt: null, pending: 0 });

  // Two founders answer, one send each.
  const first = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [
      { uid: 'a1', prompt: 'Option A', selector: '#q1', tag: 'h2', text: 'Q1' },
      { uid: 'a2', prompt: 'Option C', selector: '#q1', tag: 'h2', text: 'Q1' },
    ] },
  });
  assert.equal(first.status, 200);
  const second = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'b1', prompt: 'Agree with A', tag: 'message', text: 'Agree with A' }] },
  });
  assert.equal(second.status, 200);

  const queued = await call(w, env, 'GET', `/api/state?key=${key}`, { headers: auth });
  assert.equal(queued.body.status, 'open');
  assert.equal(queued.body.answers, 3);
  assert.equal(queued.body.pending, 2);
  assert.match(queued.body.lastAnswerAt, /^\d{4}-\d{2}-\d{2}T/);

  // The poll drains the queue; the count stays.
  const polled = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.equal(polled.body.status, 'feedback');
  assert.equal(polled.body.prompts.length, 3);
  const drained = await call(w, env, 'GET', `/api/state?key=${key}`, { headers: auth });
  assert.equal(drained.body.answers, 3);
  assert.equal(drained.body.pending, 0);
  assert.equal(drained.body.lastAnswerAt, queued.body.lastAnswerAt);

  // Ending the session shows in the status, the count is untouched.
  await call(w, env, 'POST', '/api/end', { headers: auth, body: { key } });
  const ended = await call(w, env, 'GET', `/api/state?key=${key}`, { headers: auth });
  assert.equal(ended.body.status, 'ended');
  assert.equal(ended.body.answers, 3);
});
