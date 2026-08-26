// Founder sign-in: magic links, sessions, and the gates around the board.
//
// Missing or empty `auth.founders` in the settings file — this module is idle
// and the board stays open, as it always was. When the list is non-empty, every
// mutating path needs a session, a localhost-as-owner request (off by default,
// see parseAuth), or (for agents) the apiToken Bearer. Delivery of the login
// link is a later wave: this one records the token and prints the URL to stdout.
//
// Trust rules in one place: headers from the client (X-Forwarded-For / -Proto,
// X-Real-IP, Host) decide nothing unless the operator set `auth.trustProxy`
// or `auth.publicUrl`. Secrets are compared with constant-time hashes.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';
import { BadRequest, send, sendText, readBody } from './serve.mjs';

export const COOKIE = 'wt_session';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

let FILE = '';

// Rate limit lives in memory: a restart clears it, which is the right failure
// (the owner can request a link again). Sessions and tokens live on disk.
// Keyed by the socket address (never by a client-supplied header) and, in a
// second map, by the requested address, so a spoofed X-Forwarded-For cannot
// buy extra login links.
const rate = new Map();
const rateEmail = new Map();

// Constant-time comparison of two secrets of any length. Both sides are hashed
// first so the comparison itself never sees a length difference.
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function configureAuth(stateDir) {
  FILE = path.join(stateDir, 'auth.json');
}

// ----------------------------------------------------------------- config

// Returns a normalised auth block, or null when sign-in is off. A missing
// field, a broken object or an empty founders list all mean "open board".
export function parseAuth(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.auth : null;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const founders = [];
  const seen = new Set();
  for (const f of Array.isArray(src.founders) ? src.founders : []) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const email = String(f.email ?? '').trim();
    const name = String(f.name ?? '').trim();
    if (!email || !name) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    founders.push({ email, name, owner: f.owner === true });
  }
  if (!founders.length) return null;
  const days = Number(src.sessionDays);
  return {
    founders,
    sessionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30,
    // Opt-in, not opt-out. Any process on this host that forwards TCP to the
    // port (nginx proxy_pass, ssh -L, socat, a tunnel client) makes an outside
    // visitor arrive from 127.0.0.1, and no header proves otherwise. Default
    // off means such a setup cannot hand out owner rights by accident.
    allowLocalhost: src.allowLocalhost === true,
    // Forwarding headers are believed only when the operator says a proxy is
    // in front. Otherwise X-Forwarded-For / -Proto are just client input.
    trustProxy: src.trustProxy === true,
    // Absolute base for login links. Without it the Host header is used only
    // when it is loopback; anything else falls back to 127.0.0.1:<port>.
    publicUrl: normalisePublicUrl(src.publicUrl),
    // The cookie carries a 30-day session; ship it over TLS only. Browsers
    // accept Secure cookies on http://localhost, so the desktop still works.
    cookieSecure: src.cookieSecure !== false,
  };
}

function normalisePublicUrl(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return `${u.protocol}//${u.host}`;
}

// Operator-facing warnings about a risky combination. Printed once by the
// caller when the settings file is loaded.
export function authWarnings(auth) {
  const out = [];
  if (!auth) return out;
  if (auth.allowLocalhost) {
    out.push('auth.allowLocalhost is on: every request that reaches this port from '
      + '127.0.0.1 gets owner rights. Anything that forwards TCP to the port '
      + '(nginx proxy_pass without X-Forwarded-For, ssh -L, socat, a tunnel) '
      + 'passes that right to whoever is on the other end. Turn it off when the '
      + 'port is reachable through a proxy or a tunnel.');
  }
  if (auth.trustProxy) {
    out.push('auth.trustProxy is on: X-Forwarded-For decides the rate-limit bucket. '
      + 'Only keep this on when a proxy you control is the sole way in and it '
      + 'overwrites that header.');
  }
  if (!auth.publicUrl) {
    out.push('auth.publicUrl is not set: login links fall back to the loopback '
      + 'address unless the Host header is loopback. Set it to the public HTTPS '
      + 'base so links are usable and cannot be aimed elsewhere.');
  }
  return out;
}

export function authEnabled(config) {
  return Boolean(config?.auth?.founders?.length);
}

function findFounder(auth, email) {
  const want = String(email ?? '').trim().toLowerCase();
  if (!want) return null;
  return auth.founders.find(f => f.email.toLowerCase() === want) ?? null;
}

function ownerFounder(auth) {
  return auth.founders.find(f => f.owner) ?? null;
}

// ----------------------------------------------------------------- request

function unmap(raw) {
  const v = String(raw ?? '').trim();
  return v.startsWith('::ffff:') ? v.slice(7) : v;
}

// The address the socket really came from. Never a header.
export function socketIp(req) {
  return unmap(req.socket?.remoteAddress ?? '') || 'unknown';
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

// The address used for rate limiting and logs. X-Forwarded-For is client input
// unless the operator declared a proxy (auth.trustProxy) AND the connection
// itself arrives over loopback, i.e. from that proxy on this machine.
export function clientIp(req, auth = null) {
  const sock = socketIp(req);
  if (auth?.trustProxy && isLoopbackIp(sock)) {
    const xff = unmap(String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim())
      || unmap(String(req.headers['x-real-ip'] ?? '').trim());
    if (xff) return xff;
  }
  return sock;
}

// Loopback on both ends and no forwarding header. This is a hint, not a proof:
// a plain TCP forwarder adds no headers and keeps the socket on 127.0.0.1, so
// the real guard is auth.allowLocalhost being off by default (see parseAuth and
// authWarnings).
export function isLocalRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto']
      || req.headers['x-real-ip'] || req.headers['forwarded']) {
    return false;
  }
  const local = unmap(req.socket?.localAddress ?? '');
  if (local && !isLoopbackIp(local)) return false;
  return isLoopbackIp(socketIp(req));
}

function bearer(req) {
  const hdr = String(req.headers.authorization ?? '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  return m ? m[1].trim() : '';
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie ?? '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    // A cookie with broken percent-encoding is a bad cookie, not a server
    // fault: the visitor must still get the sign-in page, not a 500.
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

function isLoopbackHost(host) {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.');
}

// Where the login link points. The Host header is attacker-controlled, so it is
// used only when it names loopback; a real deployment sets auth.publicUrl and
// the header is ignored entirely.
function publicOrigin(req, port, auth) {
  if (auth?.publicUrl) return auth.publicUrl;
  const xfProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = auth?.trustProxy && (xfProto === 'https' || xfProto === 'http') ? xfProto : 'http';
  const host = String(req.headers.host ?? '').trim();
  if (host && isLoopbackHost(host)) return `${proto}://${host}`;
  return `${proto}://127.0.0.1:${port}`;
}

function newSecret() {
  return randomBytes(32).toString('hex');
}

function isoNow(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function isoOr(v) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ----------------------------------------------------------------- store

function normState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tokens = [];
  for (const t of Array.isArray(src.tokens) ? src.tokens : []) {
    const token = String(t?.token ?? '').trim();
    const email = String(t?.email ?? '').trim();
    const createdAt = isoOr(t?.createdAt);
    const expiresAt = isoOr(t?.expiresAt);
    if (!token || !email || !createdAt || !expiresAt) continue;
    tokens.push({ token, email, createdAt, expiresAt, used: t?.used === true });
  }
  const sessions = [];
  for (const s of Array.isArray(src.sessions) ? src.sessions : []) {
    const id = String(s?.id ?? '').trim();
    const email = String(s?.email ?? '').trim();
    const createdAt = isoOr(s?.createdAt);
    const expiresAt = isoOr(s?.expiresAt);
    if (!id || !email || !createdAt || !expiresAt) continue;
    sessions.push({ id, email, createdAt, expiresAt });
  }
  return { tokens, sessions };
}

function prune(st, now = Date.now()) {
  st.tokens = st.tokens.filter(t => Date.parse(t.expiresAt) > now);
  st.sessions = st.sessions.filter(s => Date.parse(s.expiresAt) > now);
}

let chain = Promise.resolve();

async function commit(mutate) {
  const run = chain.then(() => applyEdit(mutate), () => applyEdit(mutate));
  chain = run.catch(() => {});
  return run;
}

async function applyEdit(mutate) {
  const st = normState(await readJsonSoft(FILE, null));
  prune(st);
  const backup = JSON.stringify(st);
  let result;
  try {
    result = mutate(st);
  } catch (e) {
    restore(st, backup);
    throw e;
  }
  try {
    await writeJsonAtomic(FILE, st);
  } catch (e) {
    restore(st, backup);
    throw new Error(`could not save the login state to disk: ${String(e?.message || e)}`);
  }
  return result;
}

function restore(st, backup) {
  const prev = normState(JSON.parse(backup));
  st.tokens.length = 0;
  st.sessions.length = 0;
  for (const t of prev.tokens) st.tokens.push(t);
  for (const s of prev.sessions) st.sessions.push(s);
}

// Always re-read from disk so a hand-edit (the expired-token check) is seen
// without a restart. The file is tiny.
async function load() {
  const st = normState(await readJsonSoft(FILE, null));
  prune(st);
  return st;
}

// Constant-time over the session ids, and no early exit: every row is compared
// so the answer time does not depend on how far down the match sits.
async function findSession(id) {
  const want = String(id ?? '').trim();
  if (!want) return null;
  const st = await load();
  const now = Date.now();
  let hit = null;
  for (const s of st.sessions) {
    const ok = safeEqual(s.id, want) && Date.parse(s.expiresAt) > now;
    if (ok && !hit) hit = s;
  }
  return hit;
}

// ----------------------------------------------------------------- viewer

export async function resolveViewer(req, config) {
  const auth = config?.auth;
  if (!auth) return { founder: null, via: null, sessionId: null };

  const sid = readCookie(req, COOKIE);
  if (sid) {
    const session = await findSession(sid);
    if (session) {
      const founder = findFounder(auth, session.email);
      if (founder) return { founder, via: 'session', sessionId: session.id };
    }
  }

  if (auth.allowLocalhost && isLocalRequest(req)) {
    const founder = ownerFounder(auth);
    if (founder) return { founder, via: 'localhost', sessionId: null };
  }

  const tok = bearer(req);
  if (tok && config.apiToken && safeEqual(tok, config.apiToken)) {
    return { founder: null, via: 'api', sessionId: null };
  }

  return { founder: null, via: null, sessionId: null };
}

// What a path needs when sign-in is on.
//   allow  — go on to the existing handler
//   signin — GET / without a viewer: the English sign-in page
//   deny   — 401 JSON
export function accessDecision(req, url, viewer) {
  const p = url.pathname;
  if (p.startsWith('/auth/') || p.startsWith('/probe/')) return 'allow';

  const founder = Boolean(viewer?.founder);
  const agent = viewer?.via === 'api';
  const m = req.method;

  if (p === '/' || p === '/board') {
    if (founder) return 'allow';
    return (m === 'GET' || m === 'HEAD') ? 'signin' : 'deny';
  }
  if (p === '/data') return founder ? 'allow' : 'deny';
  if (p === '/pipeline/data' || p.startsWith('/api/')) {
    return (founder || agent) ? 'allow' : 'deny';
  }
  if (p.startsWith('/pipeline/') || p === '/hooks/enqueue') {
    return (founder || agent) ? 'allow' : 'deny';
  }
  if (p.startsWith('/card/') || p === '/project/select' || p === '/focus') {
    return founder ? 'allow' : 'deny';
  }
  return 'allow';
}

export function withJsonBody(req, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  return {
    method: req.method,
    headers: req.headers,
    url: req.url,
    socket: req.socket,
    async *[Symbol.asyncIterator]() { yield buf; },
  };
}

export function signInPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watchtower — sign in</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #080d13; color: #e5edf5;
    font-family: "Segoe UI", system-ui, sans-serif; }
  main { max-width: 360px; margin: 12vh auto; padding: 24px 22px;
    border: 1px solid #253445; border-radius: 8px; background: #111b26; }
  h1 { margin: 0 0 6px; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; }
  p { margin: 0 0 16px; color: #9cafc1; font-size: 13px; line-height: 1.45; }
  label { display: block; font-size: 12px; color: #9cafc1; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; font-size: 14px; padding: 7px 8px;
    background: #0a1119; color: #e5edf5; border: 1px solid #253445; border-radius: 4px; }
  input:focus { outline: none; border-color: #78ddff; }
  button { margin-top: 12px; font-size: 13px; padding: 6px 12px; cursor: pointer;
    border: 1px solid #40546a; border-radius: 9px; background: #0a1119; color: #e5edf5; }
  button:hover { border-color: #78ddff; color: #78ddff; }
  #msg { margin-top: 14px; color: #35d6a0; font-size: 13px; }
  #msg.err { color: #ff5c5f; }
</style>
</head>
<body>
<main>
  <h1>Watchtower</h1>
  <p>Sign in with the email on the founders list. A login link is issued for
    that address; this wave prints it on the server, it is not emailed yet.</p>
  <form id="f" autocomplete="on">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required maxlength="200">
    <button type="submit">Send link</button>
  </form>
  <p id="msg" hidden></p>
</main>
<script>
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const msg = document.getElementById('msg');
  msg.hidden = false;
  msg.className = '';
  msg.textContent = '';
  const email = document.getElementById('email').value.trim();
  const r = await fetch('/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (r.status === 429) {
    msg.className = 'err';
    msg.textContent = 'Too many requests. Try again in a few minutes.';
    return;
  }
  msg.textContent = 'Check your link.';
};
</script>
</body>
</html>
`;
}

function cookieFlags(auth) {
  return auth?.cookieSecure === false ? '' : '; Secure';
}

function sessionCookie(id, maxAgeSec, auth) {
  return `${COOKIE}=${id}; HttpOnly${cookieFlags(auth)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function clearCookieHeader(auth) {
  return `${COOKIE}=; HttpOnly${cookieFlags(auth)}; Path=/; SameSite=Lax; Max-Age=0`;
}

function hit(map, key) {
  const now = Date.now();
  // Keep the maps bounded: an attacker may invent addresses freely.
  if (map.size > 2000) {
    for (const [k, v] of map) {
      if (!v.some(t => now - t < RATE_WINDOW_MS)) map.delete(k);
    }
  }
  const list = (map.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) {
    map.set(key, list);
    return true;
  }
  list.push(now);
  map.set(key, list);
  return false;
}

// Two buckets, both spoof-proof: one per connecting socket address, one per
// requested email. A header cannot move a request out of either.
function tooMany(ip, email) {
  const byIp = hit(rate, ip);
  const byEmail = email ? hit(rateEmail, email) : false;
  return byIp || byEmail;
}

function founderPayload(founder) {
  if (!founder) return null;
  return { email: founder.email, name: founder.name, owner: Boolean(founder.owner) };
}

export async function handleAuth(req, res, url, { port, config }) {
  if (!url.pathname.startsWith('/auth/')) return false;

  if (req.method === 'GET' && url.pathname === '/auth/me') {
    if (!config.auth) {
      send(res, 200, JSON.stringify({ founder: null, via: null }));
      return true;
    }
    const viewer = await resolveViewer(req, config);
    const founder = founderPayload(viewer.founder);
    send(res, 200, JSON.stringify({ founder, via: founder ? viewer.via : null }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/request') {
    const auth = config.auth;
    const body = await readBody(req);
    const email = String(body.email ?? '').trim();
    if (tooMany(clientIp(req, auth), email.toLowerCase())) {
      send(res, 429, JSON.stringify({ error: 'too many requests' }));
      return true;
    }
    const answer = JSON.stringify({ ok: true, sent: 'if that address is on the list' });
    const founder = auth ? findFounder(auth, email) : null;
    // Both branches do the same work in the same order — random token, one
    // atomic write, then the answer — so the response time says nothing about
    // whether the address is on the list. Only the log line differs, and it is
    // written after the answer has gone out.
    const now = Date.now();
    const token = newSecret();
    await commit(st => {
      if (!founder) return;
      st.tokens.push({
        token,
        email: founder.email,
        createdAt: isoNow(now),
        expiresAt: isoNow(now + TOKEN_TTL_MS),
        used: false,
      });
    });
    send(res, 200, answer);
    if (founder) {
      const link = `${publicOrigin(req, port, auth)}/auth/link?token=${token}`;
      console.log(`login link for ${founder.email}: ${link}`);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/auth/link') {
    const token = String(url.searchParams.get('token') ?? '').trim();
    const auth = config.auth;
    try {
      if (!auth) throw new BadRequest('this login link is invalid or has expired');
      if (!token) throw new BadRequest('this login link is invalid or has expired');
      const session = await commit(st => {
        // Constant-time over every stored token, no early exit.
        let row = null;
        for (const t of st.tokens) {
          if (safeEqual(t.token, token) && !row) row = t;
        }
        if (!row) throw new BadRequest('this login link is invalid or has expired');
        if (row.used) throw new BadRequest('this login link is invalid or has expired');
        if (Date.parse(row.expiresAt) <= Date.now()) {
          throw new BadRequest('this login link is invalid or has expired');
        }
        const founder = findFounder(auth, row.email);
        if (!founder) throw new BadRequest('this login link is invalid or has expired');
        row.used = true;
        const now = Date.now();
        const sess = {
          id: newSecret(),
          email: founder.email,
          createdAt: isoNow(now),
          expiresAt: isoNow(now + auth.sessionDays * 24 * 3600 * 1000),
        };
        st.sessions.push(sess);
        return sess;
      });
      const maxAge = auth.sessionDays * 24 * 3600;
      res.writeHead(302, {
        Location: '/',
        'Cache-Control': 'no-store',
        'Set-Cookie': sessionCookie(session.id, maxAge, auth),
      });
      res.end();
    } catch (e) {
      if (e instanceof BadRequest) sendText(res, 400, e.message);
      else throw e;
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const sid = readCookie(req, COOKIE);
    if (sid) {
      await commit(st => {
        const rest = st.sessions.filter(s => !safeEqual(s.id, sid));
        if (rest.length === st.sessions.length) return false;
        st.sessions = rest;
      });
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': clearCookieHeader(config.auth),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  send(res, 404, JSON.stringify({ error: 'no such path' }));
  return true;
}
