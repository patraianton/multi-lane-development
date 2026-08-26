// Persistent queue of hooks waiting for the probe to type into a herdr pane.
//
// The board never talks to herdr. Later waves call enqueueHook(); the probe
// pulls the queue with GET /probe/hooks and acks what it actually delivered.
// Writes go through the shared atomic queue in state-file.mjs so a hook and a
// pipeline edit never race over the same rename.

import path from 'node:path';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';
import { BadRequest } from './serve.mjs';

const LIMIT = {
  window: 200,
  text: 8000,
};

const STALE_NOTICE_MIN = 10;

// A herdr target id — the same shape the board checks everywhere else (TAB_RX
// in bin/watchtower.mjs), widened by one letter because a hook is delivered
// with `herdr pane run`, so a pane id counts too: w<workspace>:t<tab> or
// w<workspace>:p<pane>. Anything else — an object, a pane title, a path — is a
// hook the probe could never deliver: it would sit in the queue for ever
// (`[object Object]`) waiting for an ack that never comes.
const WINDOW_RX = /^w[0-9A-Za-z]*:[tp][0-9A-Za-z]+$/;

let FILE = '';
let state = null;         // { hooks: [...] }
let loading = null;

export function configureHooks(stateDir) {
  FILE = path.join(stateDir, 'hooks.json');
  state = null;
  loading = null;
}

function str(v, limit) {
  return String(v ?? '').slice(0, limit);
}

function isoOr(v, fallback) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function normHook(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id ?? '').trim();
  const window = str(src.window, LIMIT.window).trim();
  // Drops a hook an older build may have written with a broken window id, so a
  // poisoned queue file clears itself on the next read instead of jamming.
  if (!id || !window || !WINDOW_RX.test(window)) return null;
  return {
    id,
    window,
    text: str(src.text, LIMIT.text),
    queuedAt: isoOr(src.queuedAt, new Date().toISOString()),
  };
}

function normState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const hooks = [];
  const seen = new Set();
  for (const h of Array.isArray(src.hooks) ? src.hooks : []) {
    const hook = normHook(h);
    if (!hook || seen.has(hook.id)) continue;
    seen.add(hook.id);
    hooks.push(hook);
  }
  hooks.sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt)
    || a.id.localeCompare(b.id));
  return { hooks };
}

async function load() {
  if (state) return state;
  if (!loading) {
    loading = (async () => {
      state = normState(await readJsonSoft(FILE, null));
      loading = null;
      return state;
    })();
  }
  return loading;
}

// Same serial-edit pattern as the pipeline: one mutate at a time, memory first,
// disk second, rollback in place if the write failed.
let chain = Promise.resolve();

async function commit(mutate) {
  const run = chain.then(() => applyEdit(mutate), () => applyEdit(mutate));
  chain = run.catch(() => {});
  return run;
}

async function applyEdit(mutate) {
  const st = await load();
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
    throw new Error(`could not save the hook queue to disk: ${String(e?.message || e)}`);
  }
  return result;
}

function restore(st, backup) {
  st.hooks.length = 0;
  for (const h of normState(JSON.parse(backup)).hooks) st.hooks.push(h);
}

function newId() {
  return 'hk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function enqueueHook(window, text) {
  const w = typeof window === 'string' ? window.slice(0, LIMIT.window).trim() : '';
  // Nothing at all is "required"; something of the wrong shape gets the shape
  // back, so the caller is not told to send what it already sent.
  if (window == null || (typeof window === 'string' && w === '')) {
    throw new BadRequest('a window is required');
  }
  if (!WINDOW_RX.test(w)) {
    throw new BadRequest('a window must be a herdr id like w4Z:p1 or w4Z:t1');
  }
  if (text == null || String(text).trim() === '') throw new BadRequest('a text is required');
  const hook = {
    id: newId(),
    window: w,
    text: str(text, LIMIT.text),
    queuedAt: new Date().toISOString(),
  };
  await commit(st => { st.hooks.push(hook); });
  return hook;
}

export async function listHooks() {
  const st = await load();
  return st.hooks.slice();
}

export async function ackHooks(ids) {
  if (!Array.isArray(ids)) throw new BadRequest('ids must be an array');
  const wanted = new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean));
  if (!wanted.size) return { removed: 0 };
  return commit(st => {
    const before = st.hooks.length;
    st.hooks = st.hooks.filter(h => !wanted.has(h.id));
    return { removed: before - st.hooks.length };
  });
}

// Shown on the board when something has been sitting undelivered. Under ten
// minutes is just the probe's lag; after that the owner should see it.
export async function hooksNotice(now = Date.now()) {
  const st = await load();
  if (!st.hooks.length) return null;
  const oldest = st.hooks[0];
  const min = Math.floor((now - Date.parse(oldest.queuedAt)) / 60000);
  if (!Number.isFinite(min) || min < STALE_NOTICE_MIN) return null;
  return `hooks queued, oldest ${min}m`;
}
