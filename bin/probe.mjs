// Probe — push local herdr state to the remote board and deliver queued hooks.
//
// Lives on the owner's Windows machine, next to herdr (ADR-0002 / ADR-0003).
// The board never talks to herdr itself: this process posts a snapshot and
// pulls pending hooks down, then runs them with `herdr pane run`.
//
// Sources (same local herdr calls watchtower.mjs uses):
//   herdr api snapshot     — windows, tabs, panes, focus
//   herdr workspace list   — window labels and worktrees
//   herdr agent list       — agent kind and state per pane
//
// Run: node bin\probe.mjs [--once] [--dry-run]   (or bin\probe.cmd)
// Config: state\probe.json  { boardUrl, token, intervalSec }

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_REL = 'state/probe.json';
const CONFIG_FILE = path.join(ROOT, CONFIG_REL);
const DEFAULT_INTERVAL_SEC = 15;
const HTTP_TIMEOUT_MS = 15000;
const HERDR_TIMEOUT_MS = 30000;
const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];

const HELP = `Probe: push herdr snapshots to the board and deliver queued hooks.

Usage:
  node bin\\probe.mjs [--once] [--dry-run]
  bin\\probe.cmd [--once] [--dry-run]

Flags:
  --once       one cycle, then exit
  --dry-run    collect and print what WOULD be sent and delivered;
               no network calls, no herdr pane run
  --help       this help

Config file (required except with --dry-run): ${CONFIG_REL}
  {
    "boardUrl": "https://board.example.com",
    "token": "<secret>",
    "intervalSec": 15
  }
`;

// ---------------------------------------------------------------- flags

const args = process.argv.slice(2);
let once = false;
let dryRun = false;
for (const a of args) {
  if (a === '--once') once = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--help' || a === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  } else {
    process.stderr.write(`probe: unknown flag ${a}\nAllowed: --once, --dry-run, --help\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------- logging

function ts() {
  return new Date().toISOString();
}

function log(line) {
  process.stdout.write(`[${ts()}] ${line}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`[${ts()}] ${message.endsWith('\n') ? message : message + '\n'}`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- config

function asInterval(v) {
  if (v == null || v === '') return DEFAULT_INTERVAL_SEC;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('intervalSec must be a number of seconds >= 1');
  }
  return n;
}

function asUrl(v, required) {
  const s = v == null ? '' : String(v).trim();
  if (!s) {
    if (!required) return null;
    throw new Error('boardUrl is missing');
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`boardUrl must start with http:// or https:// (got ${s})`);
  }
  return s.replace(/\/+$/, '');
}

function asToken(v, required) {
  const s = v == null ? '' : String(v).trim();
  if (!s) {
    if (!required) return null;
    throw new Error('token is missing');
  }
  return s;
}

function parseConfig(raw, { required }) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw new Error('expected a JSON object { boardUrl, token, intervalSec }');
  return {
    boardUrl: asUrl(src.boardUrl, required),
    token: asToken(src.token, required),
    intervalSec: asInterval(src.intervalSec),
  };
}

const CONFIG_HINT = `Expected JSON object:\n  { "boardUrl": "https://board.example.com", "token": "<secret>", "intervalSec": 15 }`;

async function loadConfig({ required }) {
  let text;
  try {
    text = await readFile(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      if (!required) {
        return { boardUrl: null, token: null, intervalSec: DEFAULT_INTERVAL_SEC, missing: true };
      }
      die(`probe: missing config file ${CONFIG_REL}\n${CONFIG_HINT}`);
    }
    const msg = `probe: cannot read ${CONFIG_REL}: ${e.message}`;
    if (required) die(msg);
    throw new Error(msg);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = `probe: ${CONFIG_REL} is not valid JSON: ${e.message}`;
    if (required) die(msg);
    throw new Error(msg);
  }
  try {
    return { ...parseConfig(raw, { required }), missing: false };
  } catch (e) {
    const msg = `probe: ${CONFIG_REL}: ${e.message}\n${CONFIG_HINT}`;
    if (required) die(msg);
    throw new Error(msg);
  }
}

function boardPath(base, p) {
  return String(base).replace(/\/+$/, '') + p;
}

// ---------------------------------------------------------------- herdr

function runHerdr(bin, argv, { json = true, extraEnv = null } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, {
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      timeout: HERDR_TIMEOUT_MS,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '').trim();
      if (err) {
        return reject(new Error(`herdr ${argv.join(' ')}: ${errText || err.message}`));
      }
      if (!json) return resolve(out);
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`herdr ${argv.join(' ')}: answer is not JSON`)); }
    });
  });
}

function resolveHerdr() {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      if (i >= HERDR_CANDIDATES.length) {
        return reject(new Error(
          `herdr is not installed or not on PATH. Looked for: ${HERDR_CANDIDATES.join(', ')}`,
        ));
      }
      const bin = HERDR_CANDIDATES[i];
      execFile(bin, ['agent', 'list'], {
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        timeout: HERDR_TIMEOUT_MS,
      }, (err) => {
        if (err && err.code === 'ENOENT') return tryOne(i + 1);
        // Binary exists. A later collect() call reports if the server is down.
        resolve(bin);
      });
    };
    tryOne(0);
  });
}

function stripScroll(pane) {
  if (!pane || typeof pane !== 'object') return pane;
  const { scroll, ...rest } = pane;
  return rest;
}

async function collect(bin) {
  const [snapRes, wsListRes, agentListRes] = await Promise.all([
    runHerdr(bin, ['api', 'snapshot']),
    runHerdr(bin, ['workspace', 'list']).catch(() => null),
    runHerdr(bin, ['agent', 'list']).catch(() => null),
  ]);

  const snap = snapRes?.result?.snapshot ?? {};
  const windows = wsListRes?.result?.workspaces ?? snap.workspaces ?? [];
  const agents = agentListRes?.result?.agents ?? snap.agents ?? [];
  const panes = (snap.panes ?? []).map(stripScroll);
  const tabs = snap.tabs ?? [];

  return {
    generatedAt: new Date().toISOString(),
    host: os.hostname(),
    herdr: {
      version: snap.version ?? null,
      protocol: snap.protocol ?? null,
    },
    focused: {
      workspaceId: snap.focused_workspace_id ?? null,
      tabId: snap.focused_tab_id ?? null,
      paneId: snap.focused_pane_id ?? null,
    },
    windows,
    tabs,
    panes,
    agents,
  };
}

function countBy(items, key) {
  const out = {};
  for (const it of items ?? []) {
    const k = String(it?.[key] ?? 'unknown') || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function fmtCounts(map) {
  const keys = Object.keys(map).sort();
  if (!keys.length) return '(none)';
  return keys.map((k) => `${k}=${map[k]}`).join(' ');
}

function summarize(payload) {
  const lines = [];
  const nWin = (payload.windows ?? []).length;
  const nPane = (payload.panes ?? []).length;
  const nAgent = (payload.agents ?? []).length;
  const nTab = (payload.tabs ?? []).length;
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  lines.push(`generatedAt ${payload.generatedAt}`);
  lines.push(`host        ${payload.host}`);
  lines.push(`payload     ${bytes} bytes, windows ${nWin}, tabs ${nTab}, panes ${nPane}, agents ${nAgent}`);
  lines.push(`window states  ${fmtCounts(countBy(payload.windows, 'agent_status'))}`);
  lines.push(`agent states   ${fmtCounts(countBy(payload.agents, 'agent_status'))}`);
  const f = payload.focused ?? {};
  lines.push(`focused     workspace=${f.workspaceId ?? '-'} tab=${f.tabId ?? '-'} pane=${f.paneId ?? '-'}`);
  lines.push('windows:');
  for (const w of payload.windows ?? []) {
    const mark = w.focused ? '  focused' : '';
    const label = String(w.label ?? '').replace(/\s+/g, ' ');
    const id = String(w.workspace_id ?? '-').padEnd(4);
    const st = String(w.agent_status ?? 'unknown').padEnd(8);
    lines.push(`  ${id}  ${label.padEnd(32)}  ${st}  panes=${w.pane_count ?? 0}${mark}`);
  }
  return lines.join('\n');
}

async function paneRun(bin, window, text) {
  return runHerdr(bin, ['pane', 'run', window, '--', text], {
    json: false,
    extraEnv: { HERDR_ENV: '1' },
  });
}

// ---------------------------------------------------------------- board HTTP

async function boardFetch(url, { method, token, body }) {
  const headers = { Authorization: `Bearer ${token}` };
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
    throw new Error(`board unreachable: ${e.message || e} (${url})`);
  }
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`board unreachable: HTTP ${res.status}${snippet ? `: ${snippet}` : ''} (${url})`);
  }
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`board unreachable: non-JSON answer (${url})`); }
}

function asHooks(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.hooks)) return data.hooks;
  throw new Error('GET /probe/hooks: expected a JSON array of {id, window, text}');
}

function normHook(raw, index) {
  if (!raw || typeof raw !== 'object') {
    log(`skipping malformed hook at ${index}: not an object`);
    return null;
  }
  const id = String(raw.id ?? '').trim();
  const window = String(raw.window ?? '').trim();
  const text = raw.text == null ? '' : String(raw.text);
  if (!id || !window) {
    log(`skipping malformed hook at ${index}: need id and window`);
    return null;
  }
  return { id, window, text };
}

// ---------------------------------------------------------------- one cycle

async function cycle(bin, cfg) {
  const payload = await collect(bin);

  if (dryRun) {
    const dest = cfg.boardUrl
      ? boardPath(cfg.boardUrl, '/probe/snapshot')
      : '{boardUrl}/probe/snapshot';
    log(`dry-run: would POST ${dest}`);
    process.stdout.write(summarize(payload) + '\n');
    log(`dry-run: would GET ${cfg.boardUrl ? boardPath(cfg.boardUrl, '/probe/hooks') : '{boardUrl}/probe/hooks'}`);
    log('dry-run: hook-delivery plan: 0 pending (no board contact in dry-run)');
    return;
  }

  const snapUrl = boardPath(cfg.boardUrl, '/probe/snapshot');
  await boardFetch(snapUrl, { method: 'POST', token: cfg.token, body: payload });
  log(`posted snapshot: windows ${(payload.windows ?? []).length}, panes ${(payload.panes ?? []).length}, agents ${(payload.agents ?? []).length}`);

  const hookUrl = boardPath(cfg.boardUrl, '/probe/hooks');
  const pending = asHooks(await boardFetch(hookUrl, { method: 'GET', token: cfg.token }))
    .map(normHook)
    .filter(Boolean);

  if (!pending.length) {
    log('hooks: 0 pending');
    return;
  }

  log(`hooks: ${pending.length} pending`);
  const acked = [];
  for (const h of pending) {
    try {
      await paneRun(bin, h.window, h.text);
      acked.push(h.id);
      log(`delivered hook ${h.id} -> ${h.window}`);
    } catch (e) {
      log(`hook ${h.id} not delivered: ${e.message || e}`);
    }
  }

  if (!acked.length) return;
  const ackUrl = boardPath(cfg.boardUrl, '/probe/hooks/ack');
  await boardFetch(ackUrl, { method: 'POST', token: cfg.token, body: { ids: acked } });
  log(`acked ${acked.length} hook(s)`);
}

// ---------------------------------------------------------------- main

const cfg = await loadConfig({ required: !dryRun });
let herdrBin;
try {
  herdrBin = await resolveHerdr();
} catch (e) {
  die(`probe: ${e.message}`);
}

async function runOnce() {
  try {
    const live = dryRun ? cfg : await loadConfig({ required: true }).catch((e) => {
      throw e;
    });
    await cycle(herdrBin, live);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.startsWith('herdr is not installed')) throw e;
    if (msg.startsWith('herdr ')) {
      // herdr CLI is present but a call failed (server down, bad JSON, …)
      if (once) throw e;
      log(msg);
      return;
    }
    if (msg.includes('board unreachable') || msg.includes('GET /probe/hooks')) {
      log(msg);
      return;
    }
    if (once && !dryRun) {
      // missing/invalid config on a one-shot live run is fatal (startup already
      // checked, but a re-read in the loop can still fail)
      throw e;
    }
    log(msg);
  }
}

process.on('SIGINT', () => { log('stopping'); process.exit(0); });
process.on('SIGTERM', () => { log('stopping'); process.exit(0); });

if (once) {
  try {
    await runOnce();
  } catch (e) {
    die(`probe: ${e.message || e}`);
  }
  process.exit(0);
}

log(`probe started, every ${cfg.intervalSec}s, board ${cfg.boardUrl ?? '(dry-run)'}${dryRun ? ' (dry-run)' : ''}`);
for (;;) {
  await runOnce();
  const live = dryRun ? cfg : await loadConfig({ required: false }).catch(() => cfg);
  const waitSec = live.intervalSec ?? cfg.intervalSec ?? DEFAULT_INTERVAL_SEC;
  await sleep(waitSec * 1000);
}
