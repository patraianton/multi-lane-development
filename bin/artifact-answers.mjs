// Where the founders' answers to a review artifact live, read WITHOUT draining
// them. The CTO's poll (`lavish-axi poll`, `bin/lavish-publish.mjs poll`) is
// what delivers and consumes the answers; this module only looks.
//
// Two homes for a session, both addressed by the 16-hex key in the link:
//   - the desktop lavish-axi (the owner's fork) keeps every session in one
//     state.json (`~/.lavish-axi/state.json`, or `LAVISH_AXI_STATE_DIR`) and
//     counts every prompt the founders queue in `answers_total` /
//     `last_answer_at` at queue time — a poll drains the prompts, never the
//     count. A tunnel URL still names a local session, so the key is the
//     identity, not the host;
//   - the Cloudflare instance answers `GET /api/state?key=…` with a running
//     count of everything the founders ever queued (docs/ARTIFACT.md).

import os from 'node:os';
import path from 'node:path';
import { readJsonSoft } from './state-file.mjs';

const SESSION_RE = /\/session\/([0-9a-f]{16})(?:[/?#]|$)/;

export function sessionKeyOf(url) {
  const m = SESSION_RE.exec(String(url ?? ''));
  return m ? m[1] : '';
}

export function localLavishStateFile() {
  const dir = process.env.LAVISH_AXI_STATE_DIR || path.join(os.homedir(), '.lavish-axi');
  return path.join(dir, 'state.json');
}

// { answers, lastAt, source, ended } for a local session, null when the state
// file has no such session.
export async function readLocalAnswers(key, file = localLavishStateFile()) {
  const raw = await readJsonSoft(file, null);
  const session = raw?.sessions?.[key];
  if (!session || typeof session !== 'object') return null;
  // The fork's running count (answers_total / last_answer_at, written when
  // prompts are queued and never reset by a poll) is the truth. Older state
  // files have only what a poll leaves behind: chat messages and prompts not
  // yet delivered — form answers a poll already drained are invisible there.
  const chat = Array.isArray(session.chat) ? session.chat : [];
  const users = chat.filter(c => c && c.role === 'user');
  const pending = Array.isArray(session.prompts) ? session.prompts.length : 0;
  const answers = Math.max(Number(session.answers_total) || 0, users.length + pending);
  let lastAt = typeof session.last_answer_at === 'string' ? session.last_answer_at : null;
  for (const c of users) {
    if (typeof c.at === 'string' && (!lastAt || c.at > lastAt)) lastAt = c.at;
  }
  if (!lastAt && answers && typeof session.updated_at === 'string') lastAt = session.updated_at;
  return { answers, lastAt, source: 'lavish-local', ended: session.status === 'ended' };
}

// The same shape from the Cloudflare instance. Null when the instance does not
// know the key; a non-2xx answer is an error (the source is down, not empty).
export async function readWorkerAnswers(key, { publicBaseUrl, apiToken }, fetchImpl = fetch) {
  if (!publicBaseUrl || !apiToken) return null;
  const res = await fetchImpl(`${publicBaseUrl}/api/state?key=${key}`, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${publicBaseUrl}/api/state answered ${res.status}`);
  const body = await res.json();
  if (body.status === 'missing') return null;
  return {
    answers: Number(body.answers) || 0,
    lastAt: typeof body.lastAnswerAt === 'string' ? body.lastAnswerAt : null,
    source: 'lavish-worker',
    ended: body.status === 'ended',
  };
}

// One probe for the board's sweep: the local state first (a session the
// desktop knows is answered on the desktop, whatever host the link used), then
// the instance when the link is under its base URL. Anything else: unknown.
export function makeArtifactProbe({ lavish = {}, stateFile, fetchImpl } = {}) {
  const base = String(lavish.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
  const apiToken = String(lavish.apiToken ?? '').trim();
  return async (url) => {
    const key = sessionKeyOf(url);
    if (!key) return null;
    const local = await readLocalAnswers(key, stateFile);
    if (local) return local;
    if (base && String(url).startsWith(base + '/')) {
      return readWorkerAnswers(key, { publicBaseUrl: base, apiToken }, fetchImpl);
    }
    return null;
  };
}
