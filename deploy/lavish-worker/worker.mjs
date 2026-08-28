// The public artifact instance: the serving side of Lavish on Cloudflare
// Workers (docs/GRILL.md §3, docs/ARTIFACT.md).
//
// A grill artifact published here gets a stable HTTPS URL that does not depend
// on the owner's machine. The page keeps the full Lavish review surface —
// element/text annotation, queued prompts, image attachments — because it is
// served with the real Lavish chrome and SDK, built from the owner's lavish-axi
// fork at deploy time (build-assets.mjs) and handed to createWorker() as plain
// strings. This module itself has no imports and no Cloudflare-only APIs, so
// the whole thing runs under node --test with an in-memory KV.
//
// Storage layout (one KV namespace, binding LAVISH_KV):
//   art:<key>            the artifact HTML, as published
//   meta:<key>           { title, file, createdAt, updatedAt, version }
//   end:<key>            { ended_by, at } — present once the session ended
//   fb:<key>:<ts>-<r>    one queued-prompts batch { prompts, dom_snapshot, at }
//   af:<key>:<ts>-<r>    one artifact-failures batch { failures, at }
//   chat:<key>:<ts>-<r>  one chat line { role, text, at }
//   att:<key>:<id>       attachment bytes; { mime, bytes, name } in KV metadata
//
// Feedback and chat are append-only: every write creates its own KV key, so two
// founders annotating at the same time can never overwrite each other. The poll
// drains by list → read → return → delete; KV's eventual consistency can at
// worst deliver a batch twice, never lose one.
//
// Deliberately different from the local server (documented in docs/ARTIFACT.md):
// no single-reviewer tab handoff (both founders may review at once), no layout
// gate, no live reload, no whiteboards, no publish-to-ht-ml.app. The chrome
// degrades gracefully on all of these paths.

const KEY_RE = /^[0-9a-f]{16}$/;
const REVISION = 1;
const CHROME_LOAD_TOKEN = 'public-chrome';
const ARTIFACT_LOAD_TOKEN = 'public';
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 4;
const ACCEPTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_PROMPTS_PER_BATCH = 200;
const MAX_TEXT = 20000;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function notFound(message = 'not found') {
  return json(404, { error: message });
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Keys under one prefix must sort in write order even within one millisecond,
// hence the in-isolate sequence between the timestamp and the random tail.
let stampSeq = 0;
function stampKey(prefix) {
  stampSeq = (stampSeq + 1) % 1_000_000;
  return `${prefix}${String(Date.now()).padStart(14, '0')}-${String(stampSeq).padStart(6, '0')}-${randomHex(4)}`;
}

function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isAuthorized(request, env) {
  const token = String(env.LAVISH_API_TOKEN ?? '');
  if (!token) return false;
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return Boolean(match) && constantTimeEqual(match[1].trim(), token);
}

// CSRF guard for the endpoints the review page calls: a browser always sends
// Origin on cross-origin POSTs, so a mismatched Origin is a foreign page trying
// to write into a session. Requests without Origin (curl, the CLI) pass — the
// session key in the URL is the capability.
function crossOrigin(request, url) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin !== url.origin;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

async function listAll(kv, prefix) {
  const names = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) names.push(k);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return names;
}

async function readChat(kv, key) {
  const entries = [];
  for (const k of await listAll(kv, `chat:${key}:`)) {
    const item = await kv.get(k.name, 'json');
    if (item && typeof item.text === 'string') entries.push(item);
  }
  return entries;
}

// One queued prompt, normalized. Everything the chrome sends is kept (the
// poll consumer needs selector/target to place an answer), strings are clipped,
// attachment refs are resolved to public URLs against the stored metadata.
async function normalizePrompt(raw, kv, key, origin) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = {
    uid: clip(raw.uid, 200),
    prompt: clip(raw.prompt, MAX_TEXT),
    selector: clip(raw.selector, 2000),
    tag: clip(raw.tag, 100),
    text: clip(raw.text, MAX_TEXT),
  };
  if (raw.target && typeof raw.target === 'object') prompt.target = raw.target;
  if (Array.isArray(raw.attachments) && raw.attachments.length) {
    const resolved = [];
    for (const ref of raw.attachments.slice(0, MAX_ATTACHMENT_COUNT)) {
      const id = clip(ref?.id, 64);
      if (!/^[0-9a-f]{8,64}$/.test(id)) continue;
      const stored = await kv.getWithMetadata(`att:${key}:${id}`, 'stream');
      if (!stored || stored.value === null) continue;
      const meta = stored.metadata || {};
      resolved.push({
        id,
        name: clip(ref?.name ?? meta.name, 300),
        mime: String(meta.mime || 'application/octet-stream'),
        bytes: Number(meta.bytes) || 0,
        url: `${origin}/api/${key}/attachments/${id}`,
      });
    }
    if (resolved.length) prompt.attachments = resolved;
  }
  return prompt;
}

function renderSessionPage(assets, { key, meta, chat, ended }) {
  const blockRe = /(<script id="lavish-session" type="application\/json">)([\s\S]*?)(<\/script>)/;
  const match = blockRe.exec(assets.chromeTemplate);
  if (!match) throw new Error('the chrome template has no lavish-session block');
  const session = JSON.parse(match[2]);
  session.key = key;
  session.file = meta.file || 'artifact.html';
  session.initialEnded = Boolean(ended);
  session.initialEndedBy = ended ? ended.ended_by : null;
  session.initialChat = chat.map(c => ({ role: c.role, text: c.text }));
  session.initialLayoutWarnings = [];
  session.initialArtifactRevision = REVISION;
  session.initialArtifactLoadToken = ARTIFACT_LOAD_TOKEN;
  session.initialArtifactLoadSequence = 0;
  session.chromeLoadToken = CHROME_LOAD_TOKEN;
  session.layoutGateEnabled = false;
  session.attachmentMaxBytes = MAX_ATTACHMENT_BYTES;
  session.attachmentMaxCount = MAX_ATTACHMENT_COUNT;
  session.attachmentAcceptedMime = ACCEPTED_IMAGE_MIME;
  const sessionJson = JSON.stringify(session)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return assets.chromeTemplate
    .replace(blockRe, (_, open, __, close) => `${open}${sessionJson}${close}`)
    .replaceAll('__LAVISH_KEY__', key)
    .replaceAll('__LAVISH_FILE__', escapeHtml(session.file))
    .replaceAll('__LAVISH_TITLE__', escapeHtml(meta.title || session.file));
}

function renderSdkJs(assets, key) {
  return assets.sdkJs
    .replace(/const key=("[^"\n]*");/, `const key=${JSON.stringify(key)};`)
    .replace(/const artifactRevision=\d+;/, `const artifactRevision=${REVISION};`)
    .replace(/const artifactLoadToken=("[^"\n]*");/,
      `const artifactLoadToken=${JSON.stringify(ARTIFACT_LOAD_TOKEN)};`)
    .replaceAll('__LAVISH_KEY__', key);
}

function injectSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}&artifact_revision=${REVISION}&artifact_load_token=${encodeURIComponent(ARTIFACT_LOAD_TOKEN)}"></script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${script}</body>`);
  return `${html}\n${script}`;
}

function sseResponse(events) {
  const lines = ['retry: 20000', ''];
  for (const { event, data } of events) {
    lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`, '');
  }
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function createWorker(assets) {
  async function handle(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const kv = env.LAVISH_KV;
    const method = request.method;

    if (pathname === '/health') {
      return json(200, { ok: true, app: 'lavish-axi', version: assets.version });
    }

    // ---------------------------------------------------------- CLI surface
    // Everything under here is Bearer-gated with lavish.apiToken.

    if (pathname === '/api/publish' && (method === 'POST' || method === 'PUT')) {
      if (!isAuthorized(request, env)) return json(401, { error: 'a Bearer token is required' });
      let body;
      try { body = await request.json(); } catch { return json(400, { error: 'the body must be JSON' }); }
      const html = String(body?.html ?? '');
      if (!html.trim()) return json(400, { error: 'html is required' });
      if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
        return json(413, { error: `the artifact is larger than ${MAX_HTML_BYTES} bytes` });
      }
      let key = String(body?.key ?? '').trim();
      if (key && !KEY_RE.test(key)) {
        return json(400, { error: 'key must be 16 lowercase hex characters' });
      }
      if (!key) key = randomHex(8);
      const existing = await kv.get(`meta:${key}`, 'json');
      const now = new Date().toISOString();
      const meta = {
        title: clip(body?.title, 300) || existing?.title || '',
        file: clip(body?.file, 300) || existing?.file || 'artifact.html',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        version: (existing?.version || 0) + 1,
      };
      await kv.put(`art:${key}`, html);
      await kv.put(`meta:${key}`, JSON.stringify(meta));
      // Republishing reopens an agent-ended session; a founder-ended one stays
      // ended until the founders are told a fresh round started.
      const ended = await kv.get(`end:${key}`, 'json');
      if (ended && ended.ended_by === 'agent') await kv.delete(`end:${key}`);
      return json(200, {
        key,
        url: `${url.origin}/session/${key}`,
        status: 'published',
        version: meta.version,
      });
    }

    if (pathname === '/api/poll' && method === 'GET') {
      if (!isAuthorized(request, env)) return json(401, { error: 'a Bearer token is required' });
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!KEY_RE.test(key)) return json(400, { error: 'key must be 16 lowercase hex characters' });
      if (!(await kv.get(`meta:${key}`, 'json'))) return json(200, { status: 'missing' });
      const batchKeys = await listAll(kv, `fb:${key}:`);
      const failureKeys = await listAll(kv, `af:${key}:`);
      const ended = await kv.get(`end:${key}`, 'json');
      if (!batchKeys.length && !failureKeys.length) {
        if (ended) return json(200, { status: 'ended', ended_by: ended.ended_by });
        return json(200, { status: 'waiting' });
      }
      const prompts = [];
      let domSnapshot = '';
      for (const k of batchKeys) {
        const batch = await kv.get(k.name, 'json');
        if (batch) {
          prompts.push(...(Array.isArray(batch.prompts) ? batch.prompts : []));
          if (batch.dom_snapshot) domSnapshot = batch.dom_snapshot;
        }
      }
      const failures = [];
      for (const k of failureKeys) {
        const batch = await kv.get(k.name, 'json');
        if (batch) failures.push(...(Array.isArray(batch.failures) ? batch.failures : []));
      }
      // Delivered — drop the drained keys. A concurrent write lands under its
      // own key and simply waits for the next poll.
      for (const k of [...batchKeys, ...failureKeys]) await kv.delete(k.name);
      const answer = { status: 'feedback', dom_snapshot: domSnapshot, prompts };
      if (failures.length) answer.artifact_failures = failures;
      if (ended) { answer.session_ended = true; answer.ended_by = ended.ended_by; }
      return json(200, answer);
    }

    // GET /api/state?key=… — how many founder answers the session has ever
    // received and whether it is still open, without draining anything.
    if (pathname === '/api/state' && method === 'GET') {
      if (!isAuthorized(request, env)) return json(401, { error: 'a Bearer token is required' });
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!KEY_RE.test(key)) return json(400, { error: 'key must be 16 lowercase hex characters' });
      if (!(await kv.get(`meta:${key}`, 'json'))) return json(200, { status: 'missing' });
      const [ans, ended, pending] = await Promise.all([
        kv.get(`ans:${key}`, 'json'),
        kv.get(`end:${key}`, 'json'),
        listAll(kv, `fb:${key}:`),
      ]);
      return json(200, {
        status: ended ? 'ended' : 'open',
        answers: Number(ans?.answers) || 0,
        lastAnswerAt: typeof ans?.lastAnswerAt === 'string' ? ans.lastAnswerAt : null,
        pending: pending.length,
      });
    }

    if (pathname === '/api/end' && method === 'POST') {
      if (!isAuthorized(request, env)) return json(401, { error: 'a Bearer token is required' });
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const key = String(body?.key ?? '').trim();
      if (!KEY_RE.test(key)) return json(400, { error: 'key must be 16 lowercase hex characters' });
      if (!(await kv.get(`meta:${key}`, 'json'))) return notFound('no such session');
      await kv.put(`end:${key}`, JSON.stringify({ ended_by: 'agent', at: new Date().toISOString() }));
      return json(200, { status: 'ended' });
    }

    // ------------------------------------------------- per-session routes
    const seg = pathname.split('/').filter(Boolean);

    // GET /session/<key> — the review page.
    if (seg[0] === 'session' && seg.length === 2 && method === 'GET') {
      const key = seg[1];
      if (!KEY_RE.test(key)) return notFound('no such session');
      const meta = await kv.get(`meta:${key}`, 'json');
      if (!meta) return notFound('no such session');
      const [chat, ended] = await Promise.all([readChat(kv, key), kv.get(`end:${key}`, 'json')]);
      return new Response(renderSessionPage(assets, { key, meta, chat, ended }), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'DENY',
          'content-security-policy': "frame-ancestors 'none'",
          'cache-control': 'no-store',
        },
      });
    }

    // Static chrome assets.
    if (method === 'GET' && pathname === '/chrome-client.js') {
      return new Response(assets.chromeClientJs, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (method === 'GET' && pathname === '/chrome.css') {
      return new Response(assets.chromeCss, {
        headers: { 'content-type': 'text/css; charset=utf-8' },
      });
    }
    if (method === 'GET' && seg[0] === 'design' && seg.length === 2) {
      const body = assets.design?.[seg[1]];
      if (body === undefined) return notFound('no such design asset');
      const type = seg[1].endsWith('.css') ? 'text/css' : 'text/javascript';
      return new Response(body, { headers: { 'content-type': `${type}; charset=utf-8` } });
    }
    if (method === 'GET' && pathname === '/sdk.js') {
      const key = String(url.searchParams.get('key') ?? '');
      if (!KEY_RE.test(key) || !(await kv.get(`meta:${key}`, 'json'))) return notFound('no such session');
      return new Response(renderSdkJs(assets, key), {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }

    // GET /artifact/<key>/index.html — the artifact iframe (any load token is
    // accepted: there is no single-reviewer arbitration on the public host).
    if (method === 'GET' && seg[0] === 'artifact') {
      const key = seg[1] ?? '';
      if (!KEY_RE.test(key)) return notFound('no such artifact');
      if (seg.length === 2) {
        return Response.redirect(`${url.origin}/artifact/${key}/index.html`, 302);
      }
      if (seg.length === 3 && seg[2] === 'index.html') {
        const html = await kv.get(`art:${key}`, 'text');
        if (html === null) return notFound('no such artifact');
        return new Response(injectSdk(html, key), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads',
            'cache-control': 'no-store',
          },
        });
      }
      // Published grill artifacts are single-file; sibling assets do not exist here.
      return notFound('published artifacts are single-file — inline your assets');
    }

    // /events/<key> — a short SSE snapshot; the browser reconnects every 20s,
    // which is this instance's refresh cadence for chat and presence.
    if (method === 'GET' && seg[0] === 'events' && seg.length === 2) {
      const key = seg[1];
      if (!KEY_RE.test(key) || !(await kv.get(`meta:${key}`, 'json'))) return notFound('no such session');
      const [chat, ended] = await Promise.all([readChat(kv, key), kv.get(`end:${key}`, 'json')]);
      const events = [
        { event: 'chat-sync', data: { chat: chat.map(c => ({ role: c.role, text: c.text })) } },
        { event: 'agent-presence', data: { state: 'listening' } },
      ];
      if (ended) events.push({ event: 'ended', data: { ended_by: ended.ended_by } });
      return sseResponse(events);
    }

    // /api/<key>/... — the session API the review page talks to.
    if (seg[0] === 'api' && KEY_RE.test(seg[1] ?? '') && seg.length >= 3) {
      const key = seg[1];
      const rest = seg.slice(2).join('/');
      const meta = await kv.get(`meta:${key}`, 'json');
      if (!meta) return notFound('no such session');
      if (method !== 'GET' && crossOrigin(request, url)) {
        return json(403, { error: 'cross-origin writes are not allowed' });
      }

      if (rest === 'prompts' && method === 'POST') {
        const ended = await kv.get(`end:${key}`, 'json');
        if (ended) return json(409, { status: 'ended', ended_by: ended.ended_by });
        let body;
        try { body = await request.json(); } catch { return json(400, { error: 'the body must be JSON' }); }
        const rawPrompts = Array.isArray(body?.prompts) ? body.prompts : [];
        if (rawPrompts.length > MAX_PROMPTS_PER_BATCH) {
          return json(400, { error: `at most ${MAX_PROMPTS_PER_BATCH} prompts per send` });
        }
        const prompts = [];
        for (const raw of rawPrompts) {
          const norm = await normalizePrompt(raw, kv, key, url.origin);
          if (norm) prompts.push(norm);
        }
        const endSession = body?.endSession === true || body?.end_session === true;
        if (!prompts.length && !endSession) return json(400, { error: 'there is nothing to queue' });
        const at = new Date().toISOString();
        if (prompts.length) {
          await kv.put(stampKey(`fb:${key}:`), JSON.stringify({
            prompts,
            dom_snapshot: clip(body?.domSnapshot ?? body?.dom_snapshot, 500000),
            at,
          }));
          for (const p of prompts) {
            if (p.tag === 'message' && p.text) {
              await kv.put(stampKey(`chat:${key}:`), JSON.stringify({ role: 'user', text: p.text, at }));
            }
          }
          // A running count that a poll never drains: the board reads it to
          // mark the card "artifact answered" without touching the queue.
          const prior = await kv.get(`ans:${key}`, 'json');
          await kv.put(`ans:${key}`, JSON.stringify({
            answers: (Number(prior?.answers) || 0) + prompts.length,
            lastAnswerAt: at,
          }));
        }
        if (endSession) {
          await kv.put(`end:${key}`, JSON.stringify({ ended_by: 'user', at }));
        }
        return json(200, { status: 'queued', pending_prompts: prompts.length });
      }

      if (rest === 'chrome-loads/begin' && method === 'POST') {
        return json(200, {
          chrome_load_token: CHROME_LOAD_TOKEN,
          artifact_revision: REVISION,
          artifact_load_token: ARTIFACT_LOAD_TOKEN,
          artifact_load_sequence: 0,
        });
      }

      if (rest === 'artifact-loads/begin' && method === 'POST') {
        return json(200, { artifact_revision: REVISION, artifact_load_token: ARTIFACT_LOAD_TOKEN });
      }

      if (rest === 'agent-reply' && method === 'POST') {
        if (!isAuthorized(request, env)) return json(401, { error: 'a Bearer token is required' });
        let body;
        try { body = await request.json(); } catch { body = {}; }
        const text = clip(body?.text, MAX_TEXT).trim();
        if (!text) return json(400, { error: 'text is required' });
        await kv.put(stampKey(`chat:${key}:`), JSON.stringify({
          role: 'agent', text, at: new Date().toISOString(),
        }));
        return json(200, { status: 'sent' });
      }

      if (rest === 'end' && method === 'POST') {
        await kv.put(`end:${key}`, JSON.stringify({ ended_by: 'user', at: new Date().toISOString() }));
        return json(200, { status: 'ended' });
      }

      if (rest === 'artifact-failures' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { body = {}; }
        const failures = (Array.isArray(body?.failures) ? body.failures : [])
          .slice(0, 20)
          .map(f => ({ kind: clip(f?.kind, 100), detail: clip(f?.detail, 300) }))
          .filter(f => f.kind);
        if (failures.length) {
          await kv.put(stampKey(`af:${key}:`), JSON.stringify({
            failures, at: new Date().toISOString(),
          }));
        }
        return json(200, { status: 'recorded' });
      }

      // The layout-audit machinery stays on the owner's desktop; the public
      // instance keeps an always-empty inbox so the chrome never shows the gate.
      if (rest === 'layout-diagnostics' && method === 'POST') {
        return json(200, { status: 'recorded', active_count: 0, warnings: [] });
      }
      if (rest === 'layout-warnings' && method === 'GET') {
        return json(200, { warnings: [], revision: 0 });
      }
      if (rest === 'layout-warnings/queue' && method === 'POST') {
        return json(200, { status: 'unchanged', queued_count: 0, prompt: '', warnings: [] });
      }
      if (rest === 'layout-warnings/dismiss' && method === 'POST') {
        return json(200, { status: 'unchanged', warnings: [] });
      }

      if (rest === 'export' && method === 'GET') {
        const html = await kv.get(`art:${key}`, 'text');
        if (html === null) return notFound('no such artifact');
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': `attachment; filename="${(meta.file || 'artifact.html').replace(/[^\w.-]/g, '_')}"`,
            'x-lavish-export-warning-count': '0',
            'x-lavish-export-notice-count': '0',
          },
        });
      }

      if (rest === 'share' && method === 'POST') {
        return json(501, { error: 'this page is already published — share this URL instead' });
      }

      if (rest === 'mermaid-sources' && method === 'GET') {
        return json(200, { sources: [] });
      }

      if (rest === 'attachments' && method === 'POST') {
        const mime = (request.headers.get('content-type') || '').split(';')[0].trim();
        if (!ACCEPTED_IMAGE_MIME.includes(mime)) {
          return json(415, { error: `the attachment type must be one of ${ACCEPTED_IMAGE_MIME.join(', ')}` });
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength === 0) return json(400, { error: 'the attachment is empty' });
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return json(413, { error: `attachments are capped at ${MAX_ATTACHMENT_BYTES} bytes` });
        }
        const id = randomHex(12);
        await kv.put(`att:${key}:${id}`, bytes, {
          metadata: { mime, bytes: bytes.byteLength },
        });
        return json(200, { status: 'stored', attachment: { id, mime, bytes: bytes.byteLength } });
      }

      if (seg[2] === 'attachments' && seg.length === 4 && method === 'GET') {
        const stored = await kv.getWithMetadata(`att:${key}:${seg[3]}`, 'arrayBuffer');
        if (!stored || stored.value === null) return notFound('no such attachment');
        return new Response(stored.value, {
          headers: {
            'content-type': String(stored.metadata?.mime || 'application/octet-stream'),
            'cache-control': 'private, max-age=300',
          },
        });
      }
      if (seg[2] === 'attachments' && seg.length === 4 && method === 'DELETE') {
        await kv.delete(`att:${key}:${seg[3]}`);
        return json(200, { status: 'removed' });
      }

      // Whiteboards are not served here; mermaid-sources is always empty, so
      // the chrome never offers them.
      if (rest.startsWith('whiteboard')) return notFound('whiteboards are not available on the public instance');

      return notFound(`no such endpoint /api/<key>/${rest}`);
    }

    return notFound();
  }

  return {
    async fetch(request, env) {
      try {
        return await handle(request, env);
      } catch (e) {
        return json(500, { error: `internal error: ${e?.message ?? e}` });
      }
    },
  };
}
