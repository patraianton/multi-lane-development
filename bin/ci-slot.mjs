// CI-slot — the CI/PR stage: assign a free slot, open/ensure the PR, pin CI
// to the slot's runner label, poll, merge or fail, release the slot.
//
// A pool of slots comes from config (`slots: [{name, label}]`). Holders live
// in state/ci-slots.json (atomic writes). A slot is busy when another card
// holds it.
//
// NO QUEUE. If no slot is free this process does not wait: it prints
// "no free CI slot — add capacity", records the alarm in the occupancy file
// (the board reads that file), and exits 3. Adding capacity is the fix.
//
// Default is --dry-run: print the slot pick and the gh PR/merge plan, then
// exit 0 (or 3 when every slot is busy). --run is the only way gh runs or
// occupancy/board POSTs happen.
//
// No packages. The board imports the occupancy helpers below; this file's
// CLI only runs when invoked as the entry script.
//
// Run:  node bin/ci-slot.mjs --once <card-id> [--dry-run|--run] [--config <file>]
// Config: state/ci-slot.json     (or --config)
// Holders: state/ci-slots.json   (or --state-dir)

import { spawn } from 'node:child_process';
import { readFile, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_REL = 'state/ci-slot.json';
const OCCUPANCY_REL = 'state/ci-slots.json';
const DEFAULT_CONFIG = path.join(ROOT, CONFIG_REL);
const DEFAULT_STATE_DIR = path.join(ROOT, 'state');
const HTTP_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const GH = process.env.CISLOT_GH || process.env.WATCHTOWER_GH || 'gh';

export const NO_FREE_SLOT_MESSAGE = 'no free CI slot — add capacity';
export const NO_FREE_SLOT_EXIT = 3;

const HELP = `CI-slot: assign a free CI slot, open/ensure the PR, poll, merge or fail.

Usage:
  node bin/ci-slot.mjs --once <card-id> [--dry-run] [--config <file>]
  node bin/ci-slot.mjs --once <card-id> --run [--config <file>]
  node bin/ci-slot.mjs --help

Flags:
  --once <id>        one card by id (required unless --card is used)
  --card <id>        card id (same as --once <id> or the positional argument)
  --dry-run          print the slot pick and the gh PR/merge plan; do not gh;
                     do not POST; do not write occupancy. This is the default.
  --run              actually claim a slot, talk to gh, POST, release
  --config <file>    config JSON (default ${CONFIG_REL})
  --state-dir <dir>  occupancy file directory (default state/, or
                     WATCHTOWER_STATE_DIR). File: ci-slots.json
  --help             this help

Config (see docs/EXECUTION.md):
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "repo": "owner/name",
    "baseBranch": "main",
    "slots": [
      { "name": "ci-1", "label": "self-hosted-ci-1" },
      { "name": "ci-2", "label": "self-hosted-ci-2" },
      { "name": "ci-3", "label": "self-hosted-ci-3" }
    ]
  }

NO QUEUE: if every slot is held by another card this process does not wait.
It prints "${NO_FREE_SLOT_MESSAGE}", records the alarm for the board, assigns
nothing, and exits ${NO_FREE_SLOT_EXIT}. The fix is adding a slot, not waiting.

Exit codes: 0 ok, 1 failure, 2 bad usage, ${NO_FREE_SLOT_EXIT} no free CI slot
(clean — not a crash; occupancy and the card are untouched).
`;

const CONFIG_HINT = `Expected JSON object:
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "repo": "owner/name",
    "baseBranch": "main",
    "slots": [{ "name": "ci-1", "label": "self-hosted-ci-1" }]
  }
See docs/EXECUTION.md.`;

const ALLOWED_FLAGS = '--once <id>, --card <id>, --dry-run, --run, --config <file>, --state-dir <dir>, --help';

// ---------------------------------------------------------------- occupancy (board reads this)

let SLOTS_FILE = path.join(DEFAULT_STATE_DIR, 'ci-slots.json');
let occupancyChain = Promise.resolve();

export function configureSlots(stateDir) {
  const dir = path.resolve(String(stateDir || DEFAULT_STATE_DIR));
  SLOTS_FILE = path.join(dir, 'ci-slots.json');
}

export function occupancyPath() {
  return SLOTS_FILE;
}

function blank(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s === '-') return '';
  return s;
}

function isoOr(v, fallback) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function asSlotName(v) {
  return String(v ?? '').trim().slice(0, 100);
}

function normHolder(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = asSlotName(src.name);
  if (!name) return null;
  const card = blank(src.card);
  return {
    name,
    label: blank(src.label),
    card: card || null,
    since: card ? isoOr(src.since, null) : null,
  };
}

function holdersFromObjectMap(map) {
  const out = [];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [name, spec] of Object.entries(map)) {
    const id = asSlotName(name);
    if (!id) continue;
    if (spec == null || spec === '') {
      out.push({ name: id, label: '', card: null, since: null });
      continue;
    }
    if (typeof spec === 'string') {
      const card = blank(spec);
      out.push({
        name: id, label: '', card: card || null,
        since: card ? new Date().toISOString() : null,
      });
      continue;
    }
    const row = normHolder({ name: id, ...spec });
    if (row) out.push(row);
  }
  return out;
}

export function normOccupancy(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let slots = [];
  if (Array.isArray(src.slots)) {
    for (const row of src.slots) {
      const s = normHolder(row);
      if (s) slots.push(s);
    }
  } else if (src.slots && typeof src.slots === 'object') {
    slots = holdersFromObjectMap(src.slots);
  } else if (src.holders && typeof src.holders === 'object') {
    slots = holdersFromObjectMap(src.holders);
  }
  const seen = new Set();
  slots = slots.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
  let alarm = null;
  if (typeof src.alarm === 'string' && src.alarm.trim()) {
    alarm = { error: src.alarm.trim(), at: null };
  } else if (src.alarm && typeof src.alarm === 'object' && !Array.isArray(src.alarm)) {
    const error = blank(src.alarm.error ?? src.alarm.message ?? src.alarm.reason);
    alarm = error ? { error, at: isoOr(src.alarm.at, null) } : null;
  }
  return { slots, alarm };
}

function serializeOccupancy(st) {
  return {
    slots: st.slots.map((s) => ({
      name: s.name,
      label: s.label || '',
      card: s.card || null,
      since: s.since || null,
    })),
    alarm: st.alarm
      ? { error: st.alarm.error, at: st.alarm.at || new Date().toISOString() }
      : null,
  };
}

function allBusy(slots) {
  return slots.length > 0 && slots.every((s) => Boolean(s.card));
}

export async function slotsForBoard() {
  const raw = await readJsonSoft(SLOTS_FILE, null);
  const st = normOccupancy(raw);
  return {
    slots: st.slots.map((s) => ({
      name: s.name,
      card: s.card || null,
      since: s.since || null,
    })),
    alarm: allBusy(st.slots) ? NO_FREE_SLOT_MESSAGE : null,
  };
}

export async function slotsAlarmMessage() {
  const view = await slotsForBoard();
  return view.alarm || '';
}

async function loadOccupancy() {
  return normOccupancy(await readJsonSoft(SLOTS_FILE, null));
}

// Cross-process claim safety. occupancyChain / writeJsonAtomic only serialize
// read-modify-write WITHIN one Node process; two separate `ci-slot.mjs --run`
// processes would each read {slot free}, both pick it, both write — the same
// slot handed to two cards. An OS-level lock file closes that gap: exclusive
// create (open flag 'wx') is atomic across processes on Windows and POSIX, so
// only the lock holder reads and rewrites ci-slots.json. The second process
// then reads the updated state, finds no free slot, and reports the no-queue
// alarm instead of double-booking.
const LOCK_STALE_MS = 30_000;   // steal a lock older than this (holder crashed)
const LOCK_WAIT_MS = 15_000;    // give up waiting for the lock after this
const LOCK_RETRY_MS = 50;

function lockPath() {
  return `${SLOTS_FILE}.lock`;
}

async function acquireOccupancyLock() {
  const file = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fh;
    try {
      fh = await open(file, 'wx');
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ageMs = Infinity;
      try { ageMs = Date.now() - (await stat(file)).mtimeMs; }
      catch { ageMs = Infinity; } // vanished between EEXIST and stat — retry to claim
      if (ageMs > LOCK_STALE_MS) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `could not acquire the CI-slot lock ${file} within ${LOCK_WAIT_MS}ms `
          + '(another ci-slot process is holding it)');
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try { await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`); }
    catch { /* the lock is the file's existence, not its contents */ }
    finally { await fh.close(); }
    return file;
  }
}

async function releaseOccupancyLock(file) {
  if (!file) return;
  await unlink(file).catch(() => {});
}

async function withOccupancy(mutate) {
  const run = occupancyChain.then(async () => {
    const lock = await acquireOccupancyLock();
    try {
      const st = await loadOccupancy();
      const result = mutate(st);
      await writeJsonAtomic(SLOTS_FILE, serializeOccupancy(st));
      return result;
    } finally {
      await releaseOccupancyLock(lock);
    }
  });
  occupancyChain = run.catch(() => {});
  return run;
}

function overlayPool(pool, occupancy) {
  const byName = new Map(occupancy.slots.map((s) => [s.name, s]));
  if (!pool.length) {
    return occupancy.slots.map((s) => ({ ...s }));
  }
  return pool.map((p) => {
    const h = byName.get(p.name);
    return {
      name: p.name,
      label: p.label || h?.label || '',
      card: h?.card || null,
      since: h?.card ? (h.since || null) : null,
    };
  });
}

function pickFree(slots, cardId) {
  const mine = slots.find((s) => s.card === cardId);
  if (mine) return { slot: mine, already: true };
  const free = slots.find((s) => !s.card);
  if (free) return { slot: free, already: false };
  return { slot: null, already: false };
}

// ---------------------------------------------------------------- flags / config

function usage(message) {
  const err = new Error(message);
  err.code = 2;
  return err;
}

function parseFlags(argv) {
  const out = {
    run: false,
    dryRun: false,
    help: false,
    once: false,
    configPath: DEFAULT_CONFIG,
    stateDir: process.env.WATCHTOWER_STATE_DIR
      ? path.resolve(process.env.WATCHTOWER_STATE_DIR)
      : DEFAULT_STATE_DIR,
    cardId: '',
  };
  let sawDry = false;
  let sawRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') { sawDry = true; out.dryRun = true; }
    else if (a === '--run') { sawRun = true; out.run = true; }
    else if (a === '--once') {
      out.once = true;
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        i += 1;
        if (out.cardId && out.cardId !== next) {
          throw usage(`card id given twice (${out.cardId} and ${next})`);
        }
        out.cardId = next;
      }
    } else if (a.startsWith('--once=')) {
      out.once = true;
      const v = a.slice('--once='.length).trim();
      if (!v) throw usage('--once needs a card id');
      if (out.cardId && out.cardId !== v) {
        throw usage(`card id given twice (${out.cardId} and ${v})`);
      }
      out.cardId = v;
    } else if (a === '--config') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) throw usage('--config needs a file path');
      out.configPath = path.resolve(next);
    } else if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length).trim();
      if (!v) throw usage('--config needs a file path');
      out.configPath = path.resolve(v);
    } else if (a === '--state-dir') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) throw usage('--state-dir needs a directory');
      out.stateDir = path.resolve(next);
    } else if (a.startsWith('--state-dir=')) {
      const v = a.slice('--state-dir='.length).trim();
      if (!v) throw usage('--state-dir needs a directory');
      out.stateDir = path.resolve(v);
    } else if (a === '--card') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) throw usage('--card needs a card id');
      if (out.cardId && out.cardId !== next) {
        throw usage(`card id given twice (${out.cardId} and ${next})`);
      }
      out.cardId = next;
    } else if (a.startsWith('--card=')) {
      const v = a.slice('--card='.length).trim();
      if (!v) throw usage('--card needs a card id');
      if (out.cardId && out.cardId !== v) {
        throw usage(`card id given twice (${out.cardId} and ${v})`);
      }
      out.cardId = v;
    } else if (a.startsWith('-')) {
      throw usage(`unknown flag ${a}\nAllowed: ${ALLOWED_FLAGS}`);
    } else {
      if (out.cardId && out.cardId !== a) {
        throw usage(`unexpected argument ${a}\nAllowed: a card id and ${ALLOWED_FLAGS}`);
      }
      out.cardId = a;
    }
  }
  if (sawDry && sawRun) {
    throw usage('use either --dry-run or --run, not both');
  }
  out.dryRun = !out.run;
  return out;
}

function die(message, code = 1) {
  process.stderr.write(`${String(message).endsWith('\n') ? message : message + '\n'}`);
  process.exit(code);
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function shownPath(file) {
  return path.isAbsolute(file) && file !== DEFAULT_CONFIG ? file : CONFIG_REL;
}

function asUrl(v) {
  const s = blank(v);
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`boardUrl must start with http:// or https:// (got ${s})`);
  }
  return trimSlash(s);
}

function asMs(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function asSlots(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('slots must be an array of { name, label }');
  }
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('each slot must be an object { "name", "label" }');
    }
    const name = asSlotName(row.name);
    if (!name) throw new Error('each slot needs a name');
    if (seen.has(name)) throw new Error(`duplicate slot name "${name}"`);
    seen.add(name);
    out.push({ name, label: blank(row.label) || name });
  }
  return out;
}

function parseConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw new Error('expected a JSON object { boardUrl, apiToken, repo, slots }');
  return {
    boardUrl: asUrl(src.boardUrl),
    apiToken: blank(src.apiToken ?? src.token),
    repo: blank(src.repo),
    baseBranch: blank(src.baseBranch ?? src.base) || 'main',
    slots: asSlots(src.slots),
    pollMs: asMs(src.pollMs, DEFAULT_POLL_MS),
    timeoutMs: asMs(src.timeoutMs, DEFAULT_TIMEOUT_MS),
    occupancyFile: blank(src.occupancyFile),
    raw: true,
  };
}

function emptyConfig() {
  return {
    boardUrl: '',
    apiToken: '',
    repo: '',
    baseBranch: 'main',
    slots: [],
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    occupancyFile: '',
    raw: false,
    missingFile: false,
  };
}

async function loadConfigFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const err = new Error(`missing config file ${shownPath(file)}\n${CONFIG_HINT}`);
      err.code = 'ENOENT';
      throw err;
    }
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${shownPath(file)} is not valid JSON: ${e.message}`);
  }
}

async function loadConfig(file, { soft }) {
  let raw;
  try {
    raw = await loadConfigFile(file);
  } catch (e) {
    if (soft && e.code === 'ENOENT') {
      const cfg = emptyConfig();
      cfg.missingFile = true;
      cfg.missingFilePath = shownPath(file);
      return cfg;
    }
    throw e;
  }
  try {
    return parseConfig(raw);
  } catch (e) {
    throw new Error(`${shownPath(file)}: ${e.message}\n${CONFIG_HINT}`);
  }
}

// ---------------------------------------------------------------- card JSON

function parseLinks(raw) {
  if (!raw || raw === '-') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k ?? '').trim();
      if (!key) continue;
      out[key] = v == null ? '' : String(v).trim();
    }
    return out;
  }
  const s = String(raw).trim();
  if (!s || s === '-') return {};
  const out = {};
  for (const part of s.split(',')) {
    const t = part.trim();
    const sp = t.indexOf(' ');
    if (sp <= 0) continue;
    const key = t.slice(0, sp).trim();
    const val = t.slice(sp + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function normStage(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_');
}

function unwrapCard(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (data.card && typeof data.card === 'object' && !Array.isArray(data.card)) return data.card;
  return data;
}

function normCard(raw, fallbackId) {
  const src = unwrapCard(raw);
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const id = blank(src.id) || blank(fallbackId);
  if (!id) return null;
  return {
    id,
    title: blank(src.title),
    stage: normStage(src.stage),
    lane: blank(src.lane),
    subscription: blank(src.subscription),
    slot: blank(src.slot),
    spec: src.spec == null || src.spec === '-' ? '' : String(src.spec),
    links: parseLinks(src.links),
  };
}

// ---------------------------------------------------------------- HTTP / gh

async function boardFetch(url, { method, token, body }) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    const name = e?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`board unreachable: timed out after ${HTTP_TIMEOUT_MS / 1000}s (${url})`);
    }
    throw new Error(`board did not answer at ${url}: ${e.message || e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    try {
      const j = JSON.parse(text);
      if (j && j.error) snippet = String(j.error);
    } catch { /* keep snippet */ }
    throw new Error(`board HTTP ${res.status}${snippet ? `: ${snippet}` : ''} (${url})`);
  }
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`board answered with non-JSON (${url})`); }
}

function cardUrl(cfg, id) {
  return `${cfg.boardUrl}/api/pipeline/card/${encodeURIComponent(id)}?format=json`;
}

function pipelineUrl(cfg) {
  return `${cfg.boardUrl}/api/pipeline?format=json`;
}

function updateUrl(cfg) {
  return `${cfg.boardUrl}/pipeline/card/update`;
}

function moveUrl(cfg) {
  return `${cfg.boardUrl}/pipeline/card/move`;
}

function failUrl(cfg) {
  return `${cfg.boardUrl}/pipeline/card/fail`;
}

async function fetchCard(cfg, id) {
  const url = cardUrl(cfg, id);
  const data = await boardFetch(url, { method: 'GET', token: cfg.apiToken });
  const card = normCard(data, id);
  if (!card) {
    throw new Error(
      `GET ${url}: expected a JSON object for one card `
      + '(id, title, stage, lane, slot, links)');
  }
  return { url, card };
}

async function pickCiPrCard(cfg) {
  const url = pipelineUrl(cfg);
  const data = await boardFetch(url, { method: 'GET', token: cfg.apiToken });
  const rows = Array.isArray(data?.cards) ? data.cards : [];
  const hit = rows.find((c) => normStage(c?.stage) === 'ci_pr');
  if (!hit || !blank(hit.id)) {
    throw new Error('no card in ci_pr — pass --once <id>');
  }
  return fetchCard(cfg, hit.id);
}

function formatArgv(bin, args) {
  const parts = [bin, ...args].map((a) => {
    const s = String(a);
    if (!s) return '""';
    if (/[\s\n'"\\]/.test(s)) return JSON.stringify(s);
    return s;
  });
  return parts.join(' ');
}

function runGh(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(GH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `gh failed to start: ${e.message}`, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({
        ok: false,
        error: `gh timed out after ${GH_TIMEOUT_MS / 1000}s`,
        stdout,
        stderr,
      });
    }, GH_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 256 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 64 * 1024) stderr += d; });
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        finish({ ok: false, error: `${GH} is not installed or not on PATH`, stdout, stderr });
      } else {
        finish({ ok: false, error: `gh failed: ${e.message}`, stdout, stderr });
      }
    });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, stdout, stderr });
      else {
        const errText = (stderr || stdout).replace(/\s+/g, ' ').trim().slice(0, 400);
        finish({
          ok: false,
          error: `gh exited ${code}${errText ? `: ${errText}` : ''}`,
          stdout,
          stderr,
          code,
        });
      }
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoArgs(repo) {
  return repo ? ['--repo', repo] : [];
}

function prNumberFromLink(pr) {
  const s = blank(pr);
  if (!s) return '';
  if (/^\d+$/.test(s)) return s;
  const m = /\/pull\/(\d+)/.exec(s);
  return m ? m[1] : '';
}

function parsePrList(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : (data.number ? [data] : []);
    return rows
      .map((r) => ({
        number: r.number != null ? String(r.number) : '',
        url: blank(r.url),
        title: blank(r.title),
      }))
      .filter((r) => r.number);
  } catch {
    return [];
  }
}

function parseChecks(stdout) {
  const text = String(stdout ?? '');
  // `gh pr checks` lines look like: name <tab> pass|fail|pending <tab> …
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\t+/);
    if (parts.length >= 2) {
      rows.push({ name: parts[0], state: parts[1].toLowerCase() });
    }
  }
  if (!rows.length) {
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : [];
      for (const r of list) {
        rows.push({
          name: blank(r.name),
          state: blank(r.state || r.conclusion).toLowerCase(),
        });
      }
    } catch { /* not JSON */ }
  }
  return rows;
}

function checksVerdict(rows) {
  if (!rows.length) return 'pending';
  const fail = new Set(['fail', 'failed', 'failure', 'cancelled', 'timed_out', 'action_required', 'error']);
  const pending = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested', 'started']);
  const pass = new Set(['pass', 'passed', 'success', 'skipping', 'skipped', 'neutral']);
  let sawPending = false;
  for (const r of rows) {
    const st = r.state;
    if (fail.has(st)) return 'red';
    if (pending.has(st) || !pass.has(st)) sawPending = true;
  }
  return sawPending ? 'pending' : 'green';
}

function ghPlan({ repo, baseBranch, branch, title, label, pr }) {
  const r = repoArgs(repo);
  const prRef = pr || '<pr-number>';
  const head = branch || '<branch>';
  const commands = [];
  commands.push({
    why: 'look for an existing PR on this branch',
    argv: ['pr', 'list', ...r, '--head', head, '--json', 'number,url,title,labels'],
  });
  commands.push({
    why: 'open a PR if none exists, labelled with the slot runner',
    argv: [
      'pr', 'create', ...r,
      '--head', head,
      '--base', baseBranch || 'main',
      '--title', title || head,
      '--body', `Pipeline card. CI pinned to runner label ${label}.`,
      '--label', label,
    ],
  });
  commands.push({
    why: `pin CI: add runner label "${label}" on the PR (the slot's GitHub Actions runner)`,
    argv: ['pr', 'edit', prRef, ...r, '--add-label', label],
  });
  commands.push({
    why: 'poll CI',
    argv: ['pr', 'checks', prRef, ...r],
  });
  commands.push({
    why: 'merge on green',
    argv: ['pr', 'merge', prRef, ...r, '--squash'],
  });
  return commands;
}

// ---------------------------------------------------------------- occupancy mutations

function claimInStore(st, pool, cardId) {
  const slots = overlayPool(pool, st);
  const picked = pickFree(slots, cardId);
  if (!picked.slot) return { ok: false, slots };
  const now = new Date().toISOString();
  const name = picked.slot.name;
  let row = st.slots.find((s) => s.name === name);
  if (!row) {
    row = { name, label: picked.slot.label, card: null, since: null };
    st.slots.push(row);
  }
  row.card = cardId;
  if (!picked.already) row.since = now;
  if (row.label == null || row.label === '') row.label = picked.slot.label;
  st.alarm = allBusy(overlayPool(pool, st))
    ? { error: NO_FREE_SLOT_MESSAGE, at: now }
    : null;
  return { ok: true, slot: { ...row }, already: picked.already, slots: overlayPool(pool, st) };
}

function releaseInStore(st, pool, slotName, cardId) {
  const row = st.slots.find((s) => s.name === slotName);
  if (row && (!cardId || !row.card || row.card === cardId)) {
    row.card = null;
    row.since = null;
  }
  const slots = overlayPool(pool, st);
  st.alarm = allBusy(slots)
    ? { error: NO_FREE_SLOT_MESSAGE, at: new Date().toISOString() }
    : null;
  return slots;
}

function writeAlarmInStore(st) {
  st.alarm = { error: NO_FREE_SLOT_MESSAGE, at: new Date().toISOString() };
}

// ---------------------------------------------------------------- plan / print

function missingPieces(cfg, card) {
  const missing = [];
  const notes = [];
  if (cfg.missingFile) missing.push(`config file ${cfg.missingFilePath || CONFIG_REL}`);
  if (!cfg.boardUrl) missing.push('boardUrl');
  if (!cfg.apiToken) notes.push('apiToken is empty — the request will have no Authorization header');
  if (!cfg.repo) missing.push('repo');
  if (!cfg.slots.length) missing.push('slots (need at least one { name, label })');
  if (!card.title) notes.push('card title is empty — PR title will use the branch');
  if (!card.stage) notes.push('card has no stage');
  else if (card.stage !== 'ci_pr') {
    notes.push(`card stage is "${card.stage}", not ci_pr`);
  }
  if (!card.links.branch) missing.push('card.links.branch (needed to open/find the PR)');
  if (card.slot) notes.push(`card already has slot "${card.slot}"`);
  return { missing, notes };
}

function printBusy(ctx) {
  const { card, slots, occupancyFile, dryRun } = ctx;
  const lines = [];
  lines.push(dryRun ? 'CI-slot dry-run: no free CI slot' : 'CI-slot: no free CI slot');
  lines.push(NO_FREE_SLOT_MESSAGE);
  lines.push(`card: ${card.id}`);
  lines.push(`stage: ${card.stage || '(unknown)'}`);
  lines.push(`occupancy: ${occupancyFile}`);
  lines.push('slots:');
  for (const s of slots) {
    lines.push(s.card
      ? `  ${s.name}  held by ${s.card}${s.since ? ` since ${s.since}` : ''}`
      : `  ${s.name}  free`);
  }
  lines.push('');
  lines.push('this is an alarm, not a wait. there is no queue.');
  lines.push('add a CI slot (capacity) and run again.');
  lines.push('assigned nothing.');
  if (dryRun) {
    lines.push('done. no gh, no POSTs, occupancy unchanged.');
  } else {
    lines.push(`alarm recorded in ${OCCUPANCY_REL} for the board header and /api/board problems.`);
  }
  return lines.join('\n') + '\n';
}

function printPlan(ctx) {
  const {
    cfg, card, slot, slots, already, branch, commands, fetchUrl, missing, notes, dryRun,
    occupancyFile,
  } = ctx;
  const lines = [];
  lines.push(dryRun ? 'CI-slot dry-run plan' : 'CI-slot plan');
  lines.push(`card: ${card.id}`);
  lines.push(`title: ${card.title || '(none)'}`);
  lines.push(`stage: ${card.stage || '(unknown)'}`);
  lines.push(`branch: ${branch || '(none)'}`);
  lines.push(`pr: ${card.links.pr || '(none yet)'}`);
  lines.push(`picked slot: ${slot ? `${slot.name} (label ${slot.label})` : '(none)'}`);
  if (already) lines.push('slot already held by this card — reuse, do not re-pick');
  lines.push(`occupancy: ${occupancyFile}`);
  lines.push('');
  lines.push(`board: ${cfg.boardUrl || '(no boardUrl)'}`);
  lines.push(`config: ${shownPath(ctx.configPath)}`);
  lines.push(`repo: ${cfg.repo || '(missing)'}`);
  lines.push(`baseBranch: ${cfg.baseBranch || 'main'}`);
  if (fetchUrl) lines.push(`GET ${fetchUrl}`);
  else lines.push('GET (skipped — no boardUrl, card was not fetched)');
  lines.push('');
  lines.push('slot pool:');
  for (const s of slots) {
    lines.push(s.card
      ? `  ${s.name}  label ${s.label || '-'}  held by ${s.card}`
      : `  ${s.name}  label ${s.label || '-'}  free`);
  }
  lines.push('');
  const postUrl = cfg.boardUrl ? updateUrl(cfg) : '{boardUrl}/pipeline/card/update';
  lines.push('POST that WOULD assign the slot:');
  lines.push(`  POST ${postUrl}`);
  if (cfg.apiToken) lines.push('  Authorization: Bearer <apiToken>');
  else lines.push('  Authorization: (none)');
  lines.push(`  ${JSON.stringify({ id: card.id, slot: slot?.name || '<slot>' })}`);
  lines.push('');
  lines.push('gh commands that WOULD run:');
  for (const c of commands) {
    lines.push(`  # ${c.why}`);
    lines.push(`  ${formatArgv(GH, c.argv)}`);
  }
  lines.push('  # pin: the slot runner is the GitHub Actions runner with that label;');
  lines.push('  # this process labels the PR so the workflow can select it. It does');
  lines.push('  # not edit workflow files.');
  lines.push(`poll every ${cfg.pollMs}ms, give up after ${cfg.timeoutMs}ms`);
  lines.push('');
  const passUrl = cfg.boardUrl ? moveUrl(cfg) : '{boardUrl}/pipeline/card/move';
  const failPost = cfg.boardUrl ? failUrl(cfg) : '{boardUrl}/pipeline/card/fail';
  lines.push('POST on green (after merge):');
  lines.push(`  POST ${passUrl}`);
  lines.push(`  ${JSON.stringify({ id: card.id, to: 'done' })}`);
  lines.push('');
  lines.push('POST on red (no merge):');
  lines.push(`  POST ${failPost}`);
  lines.push(`  ${JSON.stringify({ id: card.id, kind: 'ci' })}`);
  lines.push('  (the board increments ciFails and consecutiveFails; the third');
  lines.push('   consecutive fail auto-Stucks — see bin/pipeline.mjs)');
  lines.push('');
  lines.push(`slot ${slot?.name || '<slot>'} WOULD be released after either result.`);
  lines.push('');
  if (missing.length) {
    lines.push('missing pieces:');
    for (const m of missing) lines.push(`  - ${m}`);
  }
  if (notes.length) {
    lines.push('notes:');
    for (const n of notes) lines.push(`  - ${n}`);
  }
  if (dryRun) {
    lines.push('');
    lines.push('done. no gh, no POSTs, occupancy unchanged.');
  }
  return lines.join('\n') + '\n';
}

function runBlockers(card, cfg, missing, slot) {
  const errors = [];
  if (!cfg.boardUrl) errors.push('boardUrl is missing — cannot fetch the card or POST');
  if (!cfg.repo) errors.push('repo is missing — cannot talk to gh');
  if (!cfg.slots.length) errors.push('slots is empty — configure at least one { name, label }');
  if (!card.links.branch) errors.push('card has no links.branch — cannot open or find the PR');
  if (card.stage && card.stage !== 'ci_pr') {
    errors.push(
      `card is in stage "${card.stage}", not ci_pr. `
      + 'CI-slot only runs for a card already in ci_pr.');
  }
  if (!slot) errors.push('no slot was picked');
  for (const m of missing) {
    if (m.startsWith('config file')) errors.push(`missing ${m}`);
  }
  return errors;
}

async function postJson(cfg, url, body, what) {
  process.stderr.write(`POST ${url}\n`);
  try {
    const res = await boardFetch(url, { method: 'POST', token: cfg.apiToken, body });
    process.stdout.write(
      `${what}`
      + (res && res.ok === true ? ' (ok)' : '')
      + '\n');
    return res;
  } catch (e) {
    throw new Error(`${what} failed: ${e.message}\nPOST ${url} with ${JSON.stringify(body)}`);
  }
}

async function ensurePr(cfg, card, branch, label) {
  const r = repoArgs(cfg.repo);
  const listed = await runGh(['pr', 'list', ...r, '--head', branch, '--json', 'number,url,title,labels']);
  if (!listed.ok) throw new Error(`could not list PRs: ${listed.error}`);
  const existing = parsePrList(listed.stdout);
  if (existing.length) {
    const pr = existing[0];
    process.stdout.write(`PR #${pr.number} already open (${pr.url || 'no url'})\n`);
    const pin = await runGh(['pr', 'edit', pr.number, ...r, '--add-label', label]);
    if (!pin.ok) {
      process.stderr.write(`could not add label ${label}: ${pin.error}\n`);
    }
    return pr;
  }
  const created = await runGh([
    'pr', 'create', ...r,
    '--head', branch,
    '--base', cfg.baseBranch || 'main',
    '--title', card.title || branch,
    '--body', `Pipeline card ${card.id}. CI pinned to runner label ${label}.`,
    '--label', label,
  ]);
  if (!created.ok) throw new Error(`could not open the PR: ${created.error}`);
  const url = String(created.stdout || '').trim().split(/\s+/)[0];
  const number = prNumberFromLink(url);
  process.stdout.write(`opened PR ${url || created.stdout.trim()}\n`);
  return { number, url, title: card.title };
}

async function pollChecks(cfg, prNumber) {
  const r = repoArgs(cfg.repo);
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    process.stderr.write(`gh pr checks ${prNumber}\n`);
    const ran = await runGh(['pr', 'checks', prNumber, ...r]);
    const rows = parseChecks(ran.stdout);
    const verdict = checksVerdict(rows);
    if (verdict === 'green' || verdict === 'red') return { verdict, rows, stdout: ran.stdout };
    // `gh pr checks` exits 1 when checks are pending or failing; pending is not red yet.
    await sleep(cfg.pollMs);
  }
  throw new Error(`CI poll timed out after ${cfg.timeoutMs}ms on PR #${prNumber}`);
}

async function mergePr(cfg, prNumber) {
  const r = repoArgs(cfg.repo);
  const ran = await runGh(['pr', 'merge', prNumber, ...r, '--squash']);
  if (!ran.ok) throw new Error(`could not merge PR #${prNumber}: ${ran.error}`);
  process.stdout.write(`merged PR #${prNumber}\n`);
}

// ---------------------------------------------------------------- main

function calledAsCli() {
  const self = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!entry) return false;
  return path.basename(self).toLowerCase() === path.basename(entry).toLowerCase();
}

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (e) {
    die(e.message, e.code === 2 ? 2 : 1);
  }

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (flags.once && !flags.cardId) {
    die(`--once needs a card id\nUsage: node bin/ci-slot.mjs --once <card-id> [--dry-run|--run]\nAllowed: ${ALLOWED_FLAGS}`, 2);
  }

  const cfg = await loadConfig(flags.configPath, { soft: flags.dryRun });
  if (cfg.occupancyFile) {
    SLOTS_FILE = path.resolve(cfg.occupancyFile);
  } else {
    configureSlots(flags.stateDir);
  }

  let fetchUrl = '';
  let card;
  if (cfg.boardUrl && flags.cardId) {
    const got = await fetchCard(cfg, flags.cardId);
    fetchUrl = got.url;
    card = got.card;
  } else if (cfg.boardUrl && !flags.cardId) {
    const got = await pickCiPrCard(cfg);
    fetchUrl = got.url;
    card = got.card;
  } else if (flags.dryRun && flags.cardId) {
    card = {
      id: flags.cardId,
      title: '',
      stage: '',
      lane: '',
      subscription: '',
      slot: '',
      spec: '',
      links: {},
    };
  } else if (flags.dryRun) {
    die(`a card id is required (--once <id>)\nUsage: node bin/ci-slot.mjs --once <card-id> [--dry-run|--run]\nAllowed: ${ALLOWED_FLAGS}`, 2);
  } else {
    throw new Error('boardUrl is missing — cannot fetch the card');
  }

  const occupancy = await loadOccupancy();
  const slots = overlayPool(cfg.slots, occupancy);
  const { missing, notes } = missingPieces(cfg, card);
  const picked = pickFree(slots, card.id);
  const occupancyFile = SLOTS_FILE;

  if (!picked.slot && cfg.slots.length) {
    const busyText = printBusy({
      card, slots, occupancyFile, dryRun: flags.dryRun,
    });
    process.stdout.write(busyText);
    if (!flags.dryRun) {
      await withOccupancy((st) => { writeAlarmInStore(st); });
    }
    process.exitCode = NO_FREE_SLOT_EXIT;
    return;
  }

  const slot = picked.slot;
  const branch = blank(card.links.branch);
  const commands = ghPlan({
    repo: cfg.repo,
    baseBranch: cfg.baseBranch,
    branch,
    title: card.title,
    label: slot?.label || '<label>',
    pr: prNumberFromLink(card.links.pr) || undefined,
  });

  process.stdout.write(printPlan({
    cfg, card, slot, slots, already: picked.already, branch, commands,
    fetchUrl, missing, notes, dryRun: flags.dryRun, occupancyFile,
    configPath: flags.configPath,
  }));

  if (flags.dryRun) return;

  const errors = runBlockers(card, cfg, missing, slot);
  if (errors.length) {
    throw new Error(`cannot --run:\n  - ${errors.join('\n  - ')}`);
  }

  let claimed = null;
  try {
    const claim = await withOccupancy((st) => claimInStore(st, cfg.slots, card.id));
    if (!claim.ok) {
      process.stdout.write(printBusy({
        card, slots: claim.slots, occupancyFile, dryRun: false,
      }));
      process.exitCode = NO_FREE_SLOT_EXIT;
      return;
    }
    claimed = claim.slot;
    process.stdout.write(
      `${claim.already ? 'reusing' : 'claimed'} slot ${claimed.name} for card ${card.id}\n`);

    await postJson(cfg, updateUrl(cfg), { id: card.id, slot: claimed.name },
      `posted slot=${claimed.name} on card ${card.id}`);

    const pr = await ensurePr(cfg, card, branch, claimed.label);
    if (pr.url || pr.number) {
      const prLink = pr.url || String(pr.number);
      try {
        await postJson(cfg, updateUrl(cfg), { id: card.id, links: { pr: prLink } },
          `posted links.pr=${prLink} on card ${card.id}`);
      } catch (e) {
        process.stderr.write(`${e.message}\n`);
      }
    }
    const prNumber = pr.number || prNumberFromLink(pr.url);
    if (!prNumber) throw new Error('could not determine the PR number');

    const result = await pollChecks(cfg, prNumber);
    if (result.verdict === 'green') {
      process.stdout.write('CI green\n');
      await mergePr(cfg, prNumber);
      await postJson(cfg, moveUrl(cfg), { id: card.id, to: 'done' },
        `moved card ${card.id} to done`);
    } else {
      process.stdout.write('CI red\n');
      await postJson(cfg, failUrl(cfg), { id: card.id, kind: 'ci' },
        `reported ci fail on card ${card.id} (board may Stuck on the third in a row)`);
    }
  } finally {
    if (claimed) {
      await withOccupancy((st) => releaseInStore(st, cfg.slots, claimed.name, card.id));
      process.stdout.write(`released slot ${claimed.name}\n`);
    }
  }
}

if (calledAsCli()) {
  // Set process.exitCode and let the event loop drain rather than calling
  // process.exit() synchronously. On Windows a spawn ENOENT (missing gh)
  // leaves the child's async handle mid-close; a synchronous process.exit()
  // in that window trips a libuv assertion
  // (!(handle->flags & UV_HANDLE_CLOSING), async.c) and aborts with code 127,
  // defeating the graceful "gh is not installed" handling. Draining lets the
  // handle finish closing first, then Node exits with the code we set.
  main().then(
    () => { /* success — exitCode stays whatever main set (0 by default) */ },
    (e) => {
      process.exitCode = e && e.code === 2 ? 2 : 1;
      process.stderr.write(`ci-slot: ${e && e.message ? e.message : e}\n`);
    },
  );
}
