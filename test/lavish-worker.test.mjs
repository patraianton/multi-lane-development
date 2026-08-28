// The Cloudflare artifact worker, exercised entirely in-process: real
// createWorker() code, in-memory KV, no Cloudflare and no network. This is the
// credential-free smoke path docs/ARTIFACT.md points at.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorker } from '../deploy/lavish-worker/worker.mjs';
import { createMemoryKv } from '../deploy/lavish-worker/memory-kv.mjs';
import { stubAssets } from '../deploy/lavish-worker/stub-assets.mjs';

const TOKEN = 'test-api-token';
const BASE = 'https://artifacts.example.com';

function makeEnv() {
  return { LAVISH_KV: createMemoryKv(), LAVISH_API_TOKEN: TOKEN };
}

function worker() {
  return createWorker(stubAssets);
}

async function call(w, env, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await w.fetch(new Request(BASE + path, init), env);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* html or js body */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function publish(w, env, html = '<html><body><h1>Grill</h1></body></html>', extra = {}) {
  const res = await call(w, env, 'POST', '/api/publish', {
    headers: auth,
    body: { html, title: 'Grill questions', file: 'grill.html', ...extra },
  });
  assert.equal(res.status, 200);
  return res.body;
}

test('publish requires the Bearer token', async () => {
  const w = worker(); const env = makeEnv();
  const anon = await call(w, env, 'POST', '/api/publish', { body: { html: '<p>x</p>' } });
  assert.equal(anon.status, 401);
  const wrong = await call(w, env, 'POST', '/api/publish', {
    headers: { authorization: 'Bearer nope' }, body: { html: '<p>x</p>' },
  });
  assert.equal(wrong.status, 401);
  const ok = await publish(w, env);
  assert.match(ok.key, /^[0-9a-f]{16}$/);
  assert.equal(ok.url, `${BASE}/session/${ok.key}`);
});

test('an unset worker token refuses every publish', async () => {
  const w = worker();
  const env = { LAVISH_KV: createMemoryKv(), LAVISH_API_TOKEN: '' };
  const res = await call(w, env, 'POST', '/api/publish', {
    headers: { authorization: 'Bearer ' }, body: { html: '<p>x</p>' },
  });
  assert.equal(res.status, 401);
});

test('the session page carries the substituted session JSON and artifact URL', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  const page = await call(w, env, 'GET', `/session/${key}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`data-artifact-src="/artifact/${key}/index.html"`));
  assert.ok(page.text.includes('<title>Grill questions</title>'));
  const block = /<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/.exec(page.text);
  const session = JSON.parse(block[1]);
  assert.equal(session.key, key);
  assert.equal(session.layoutGateEnabled, false);
  assert.equal(session.initialEnded, false);
  assert.equal(session.initialArtifactRevision, 1);
  assert.ok(session.chromeLoadToken);
  assert.ok(!page.text.includes('__LAVISH_'));
});

test('unknown sessions and bad keys are 404', async () => {
  const w = worker(); const env = makeEnv();
  assert.equal((await call(w, env, 'GET', '/session/0123456789abcdef')).status, 404);
  assert.equal((await call(w, env, 'GET', '/session/not-a-key')).status, 404);
  assert.equal((await call(w, env, 'GET', '/artifact/0123456789abcdef/index.html')).status, 404);
});

test('the artifact page gets the SDK injected before </body>', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env, '<html><body><p>content</p></body></html>');
  const page = await call(w, env, 'GET', `/artifact/${key}/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`<script src="/sdk.js\\?key=${key}[^"]*"></script></body>`));
  const sdk = await call(w, env, 'GET', `/sdk.js?key=${key}`);
  assert.equal(sdk.status, 200);
  assert.ok(sdk.text.includes(`const key="${key}";`));
  assert.ok(sdk.text.includes('const artifactRevision=1;'));
});

test('queued prompts from two founders both reach one poll, which drains', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  const p1 = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: {
      prompts: [{ uid: 'u1', prompt: 'Why is section 2 optional?', selector: '#s2', tag: 'h2', text: 'Section 2' }],
      domSnapshot: '<html>snap</html>',
    },
  });
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.body, { status: 'queued', pending_prompts: 1 });
  const p2 = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u2', prompt: 'Budget?', selector: '#s3', tag: 'text', text: 'the budget line' }] },
  });
  assert.equal(p2.status, 200);

  const noAuth = await call(w, env, 'GET', `/api/poll?key=${key}`);
  assert.equal(noAuth.status, 401);

  const poll = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.equal(poll.status, 200);
  assert.equal(poll.body.status, 'feedback');
  assert.deepEqual(poll.body.prompts.map(p => p.uid).sort(), ['u1', 'u2']);
  assert.equal(poll.body.dom_snapshot, '<html>snap</html>');

  const again = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.deepEqual(again.body, { status: 'waiting' });
});

test('polling an unpublished key answers missing', async () => {
  const w = worker(); const env = makeEnv();
  const res = await call(w, env, 'GET', '/api/poll?key=0123456789abcdef', { headers: auth });
  assert.deepEqual(res.body, { status: 'missing' });
});

test('ending from the page blocks further sends and reaches the poll', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u1', prompt: 'last question', tag: 'message', text: 'last question' }], endSession: true },
  });
  const after = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u2', prompt: 'too late', tag: 'message', text: 'too late' }] },
  });
  assert.equal(after.status, 409);
  assert.equal(after.body.status, 'ended');
  const poll = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.equal(poll.body.status, 'feedback');
  assert.equal(poll.body.session_ended, true);
  assert.equal(poll.body.ended_by, 'user');
  const emptyPoll = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.deepEqual(emptyPoll.body, { status: 'ended', ended_by: 'user' });
});

test('agent replies land in chat, the SSE snapshot and the session page', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u1', prompt: 'ping', tag: 'message', text: 'ping' }] },
  });
  const anon = await call(w, env, 'POST', `/api/${key}/agent-reply`, { body: { text: 'pong' } });
  assert.equal(anon.status, 401);
  const reply = await call(w, env, 'POST', `/api/${key}/agent-reply`, {
    headers: auth, body: { text: 'pong' },
  });
  assert.equal(reply.status, 200);

  const events = await call(w, env, 'GET', `/events/${key}`);
  assert.equal(events.status, 200);
  assert.ok(events.text.includes('event: chat-sync'));
  assert.ok(events.text.includes('pong'));
  assert.ok(events.text.includes('"state":"listening"'));

  const page = await call(w, env, 'GET', `/session/${key}`);
  const session = JSON.parse(
    /<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/.exec(page.text)[1],
  );
  assert.deepEqual(session.initialChat, [
    { role: 'user', text: 'ping' },
    { role: 'agent', text: 'pong' },
  ]);
});

test('cross-origin writes into a session are refused', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  const res = await call(w, env, 'POST', `/api/${key}/prompts`, {
    headers: { origin: 'https://evil.example.com' },
    body: { prompts: [{ uid: 'x', prompt: 'x', tag: 'message', text: 'x' }] },
  });
  assert.equal(res.status, 403);
  const sameOrigin = await call(w, env, 'POST', `/api/${key}/prompts`, {
    headers: { origin: BASE },
    body: { prompts: [{ uid: 'x', prompt: 'x', tag: 'message', text: 'x' }] },
  });
  assert.equal(sameOrigin.status, 200);
});

test('attachments round-trip and are delivered as URLs in the poll', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const up = await call(w, env, 'POST', `/api/${key}/attachments`, {
    headers: { 'content-type': 'image/png' }, raw: bytes,
  });
  assert.equal(up.status, 200);
  const id = up.body.attachment.id;

  const down = await w.fetch(new Request(`${BASE}/api/${key}/attachments/${id}`), env);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), bytes);

  await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u1', prompt: 'see the screenshot', tag: 'div', text: 'block', attachments: [{ id, name: 'shot.png' }] }] },
  });
  const poll = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  const att = poll.body.prompts[0].attachments[0];
  assert.equal(att.id, id);
  assert.equal(att.mime, 'image/png');
  assert.equal(att.url, `${BASE}/api/${key}/attachments/${id}`);

  const wrongType = await call(w, env, 'POST', `/api/${key}/attachments`, {
    headers: { 'content-type': 'application/x-msdownload' }, raw: bytes,
  });
  assert.equal(wrongType.status, 415);
});

test('republish bumps the version, keeps the key and reopens an agent-ended session', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env, '<html><body>v1</body></html>');
  await call(w, env, 'POST', '/api/end', { headers: auth, body: { key } });
  const second = await publish(w, env, '<html><body>v2</body></html>', { key });
  assert.equal(second.key, key);
  assert.equal(second.version, 2);
  const art = await call(w, env, 'GET', `/artifact/${key}/index.html`);
  assert.ok(art.text.includes('v2'));
  const send = await call(w, env, 'POST', `/api/${key}/prompts`, {
    body: { prompts: [{ uid: 'u1', prompt: 'q', tag: 'message', text: 'q' }] },
  });
  assert.equal(send.status, 200, 'republish reopened the agent-ended session');
});

test('the review-chrome side endpoints answer their contract shapes', async () => {
  const w = worker(); const env = makeEnv();
  const { key } = await publish(w, env);
  const health = await call(w, env, 'GET', '/health');
  assert.deepEqual(health.body, { ok: true, app: 'lavish-axi', version: 'stub' });

  const chromeLoad = await call(w, env, 'POST', `/api/${key}/chrome-loads/begin`, { body: {} });
  assert.equal(chromeLoad.status, 200);
  assert.ok(chromeLoad.body.chrome_load_token);
  assert.equal(chromeLoad.body.artifact_revision, 1);

  const artifactLoad = await call(w, env, 'POST', `/api/${key}/artifact-loads/begin`, {
    body: { request_id: 'r1', request_sequence: 1, chrome_load_token: chromeLoad.body.chrome_load_token },
  });
  assert.equal(artifactLoad.status, 200);
  assert.ok(artifactLoad.body.artifact_load_token);

  assert.equal((await call(w, env, 'GET', `/api/${key}/layout-warnings`)).body.warnings.length, 0);
  assert.equal((await call(w, env, 'POST', `/api/${key}/layout-diagnostics`, { body: {} })).body.status, 'recorded');
  assert.equal((await call(w, env, 'GET', `/api/${key}/mermaid-sources`)).body.sources.length, 0);
  assert.equal((await call(w, env, 'POST', `/api/${key}/share`, { body: {} })).status, 501);

  const failures = await call(w, env, 'POST', `/api/${key}/artifact-failures`, {
    body: { failures: [{ kind: 'artifact-unavailable', detail: 'boom' }] },
  });
  assert.equal(failures.body.status, 'recorded');
  const poll = await call(w, env, 'GET', `/api/poll?key=${key}`, { headers: auth });
  assert.equal(poll.body.status, 'feedback');
  assert.equal(poll.body.artifact_failures[0].kind, 'artifact-unavailable');

  const exported = await call(w, env, 'GET', `/api/${key}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
});
