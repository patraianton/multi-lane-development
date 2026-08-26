// Local-check — run the Local check stage for one pipeline card.
//
// Input: a card id. The process reads the card from the board and, on --run,
// ssh-es to the card's assigned lane to start the project's local test command
// (config template localCheckCommand, placeholders {branch} {workdir}) detached
// with a log. It then polls that log for LOCAL_CHECK_EXIT=N.
//
// Pass → POST /pipeline/card/move { to: "ci_pr" }.
// Fail → POST /pipeline/card/fail { kind: "local" } (the board increments the
// counter and, on the third consecutive fail, auto-Stucks — see pipeline.mjs).
//
// Default is --dry-run: print every ssh command and the move/fail POST that
// WOULD run, then exit 0. Incomplete config is allowed in dry-run. --run
// actually executes and refuses to guess a lane.
//
// No packages. Board traffic is global fetch. The lane is ssh. The script
// is sent on ssh stdin (`sh -s`).
//
// Run:  node bin/local-check.mjs --once <card-id> [--dry-run|--run] [--config <file>]
// File: state/local-check.json   (or --config)

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_REL = 'state/local-check.json';
const DEFAULT_CONFIG = path.join(ROOT, CONFIG_REL);
const HTTP_TIMEOUT_MS = 20_000;
const SSH_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SSH = process.env.LOCALCHECK_SSH
  || process.env.WATCHTOWER_SSH
  || (process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh');

const HELP = `Local-check: run the Local check stage for one pipeline card.

Usage:
  node bin/local-check.mjs --once <card-id> [--dry-run] [--config <file>]
  node bin/local-check.mjs --once <card-id> --run [--config <file>]
  node bin/local-check.mjs --help

Flags:
  --once <id>        one card by id (required unless --card is used)
  --card <id>        card id (same as --once <id> or the positional argument)
  --dry-run          print the ssh test command and the move/fail POSTs that
                     WOULD run; do not ssh; do not POST. This is the default.
  --run              actually ssh to the assigned lane, poll the log, POST
  --config <file>    config JSON (default ${CONFIG_REL})
  --help             this help

Config (see docs/EXECUTION.md):
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "localCheckCommand": "npm test",
    "lanes": {
      "lane-1": {
        "ssh": "root@host",
        "workdir": "~/kitchens/repo/lane-1",
        "localCheckCommand": "npm test"
      }
    }
  }

Placeholders in localCheckCommand: {branch} {workdir}.
A per-lane localCheckCommand overrides the top-level template.

Safety: --run refuses if the card has no lane assigned. This process never
picks a lane. Dry-run is the default; nothing remote starts without --run.

Exit codes: 0 ok, 1 failure, 2 bad usage.
`;

const CONFIG_HINT = `Expected JSON object:
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "localCheckCommand": "npm test",
    "lanes": {
      "<lane>": { "ssh": "root@host", "workdir": "/path", "localCheckCommand": "…" }
    }
  }
See docs/EXECUTION.md.`;

const ALLOWED_FLAGS = '--once <id>, --card <id>, --dry-run, --run, --config <file>, --help';

// ---------------------------------------------------------------- flags

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

// ---------------------------------------------------------------- logging

function die(message, code = 1) {
  process.stderr.write(`${String(message).endsWith('\n') ? message : message + '\n'}`);
  process.exit(code);
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function blank(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s || s === '-') return '';
  return s;
}

function oneLine(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function shownPath(file) {
  return path.isAbsolute(file) && file !== DEFAULT_CONFIG ? file : CONFIG_REL;
}

function safeToken(s, fallback) {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return t || fallback;
}

function logFileName(cardId) {
  return `local-check-${safeToken(cardId, 'card')}.log`;
}

function runnerFileName(cardId) {
  return `local-check-${safeToken(cardId, 'card')}.sh`;
}

function posixJoin(workdir, name) {
  const w = String(workdir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const n = String(name ?? '').replace(/^\/+/, '');
  if (!w) return n;
  if (w === '~') return `$HOME/${n}`;
  if (w.startsWith('~/')) return `$HOME/${w.slice(2)}/${n}`;
  return `${w}/${n}`;
}

function posixWorkdir(workdir) {
  const w = String(workdir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!w) return '';
  if (w === '~') return '$HOME';
  if (w.startsWith('~/')) return `$HOME/${w.slice(2)}`;
  return w;
}

function shSingle(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- config

function asUrl(v, { required }) {
  const s = blank(v);
  if (!s) {
    if (!required) return '';
    throw new Error('boardUrl is missing');
  }
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`boardUrl must start with http:// or https:// (got ${s})`);
  }
  return trimSlash(s);
}

function asToken(v) {
  return blank(v);
}

function asMs(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function normLane(name, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    name,
    ssh: blank(raw.ssh ?? raw.target),
    key: blank(raw.key),
    workdir: blank(raw.workdir ?? raw.workDir ?? raw.cwd),
    localCheckCommand: blank(raw.localCheckCommand ?? raw.command),
  };
}

function asLanes(raw) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lanes must be an object of { "<lane>": { ssh, workdir, localCheckCommand } }');
  }
  const out = {};
  for (const [name, spec] of Object.entries(raw)) {
    const id = String(name ?? '').trim();
    if (!id) continue;
    const lane = normLane(id, spec);
    if (!lane) {
      throw new Error(
        `lanes.${id} must be an object { "ssh": "root@host", "workdir": "/path", "localCheckCommand": "…" }`);
    }
    out[id] = lane;
  }
  return out;
}

function parseConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw new Error('expected a JSON object { boardUrl, apiToken, localCheckCommand, lanes }');
  return {
    boardUrl: asUrl(src.boardUrl, { required: false }),
    apiToken: asToken(src.apiToken ?? src.token),
    localCheckCommand: blank(src.localCheckCommand ?? src.command),
    lanes: asLanes(src.lanes),
    pollMs: asMs(src.pollMs, DEFAULT_POLL_MS),
    timeoutMs: asMs(src.timeoutMs, DEFAULT_TIMEOUT_MS),
    raw: true,
  };
}

function emptyConfig() {
  return {
    boardUrl: '',
    apiToken: '',
    localCheckCommand: '',
    lanes: {},
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
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

function laneFor(cfg, laneId) {
  const id = String(laneId ?? '').trim();
  if (!id) return null;
  if (cfg.lanes[id]) return cfg.lanes[id];
  const slash = id.lastIndexOf('/');
  if (slash > 0) {
    const tail = id.slice(slash + 1);
    if (cfg.lanes[tail]) return cfg.lanes[tail];
  }
  for (const [name, lane] of Object.entries(cfg.lanes)) {
    if (name.endsWith('/' + id)) return lane;
  }
  return null;
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
    spec: src.spec == null || src.spec === '-' ? '' : String(src.spec),
    links: parseLinks(src.links),
  };
}

function applyTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{(branch|workdir)\}/g, (_, k) => {
    return vars[k] == null ? '' : String(vars[k]);
  });
}

function commandFor(cfg, lane) {
  return blank(lane?.localCheckCommand) || cfg.localCheckCommand || '';
}

// ---------------------------------------------------------------- remote script

function uniqueEof(kind, cardId, body) {
  let tag = `LOCALCHECK_${kind}_${safeToken(cardId, 'card')}`;
  let n = 0;
  while (String(body).includes(tag)) {
    n += 1;
    tag = `LOCALCHECK_${kind}_${safeToken(cardId, 'card')}_${n}`;
  }
  return tag;
}

function buildStartScript({ workdir, branch, card, command }) {
  const id = card.id;
  const logName = logFileName(id);
  const runnerName = runnerFileName(id);
  const wd = posixWorkdir(workdir) || '$HOME/local-check-workdir';
  const runnerLines = [
    '#!/bin/sh',
    `cd "${wd}" || exit 1`,
    'echo "local-check start $(date -u +%Y-%m-%dT%H:%M:%SZ) branch '
      + String(branch || '').replace(/"/g, '') + '"',
    'set +e',
    command || 'echo "no localCheckCommand configured" >&2; exit 1',
    'code=$?',
    'echo "LOCAL_CHECK_EXIT=$code"',
    'exit $code',
  ];
  const runnerBody = runnerLines.join('\n') + '\n';
  const runEof = uniqueEof('RUN', id, runnerBody);
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `WORKDIR="${wd}"`,
    'LOGNAME=' + shSingle(logName),
    'RUNNERNAME=' + shSingle(runnerName),
    'mkdir -p "$WORKDIR"',
    `cat > "$WORKDIR/$RUNNERNAME" << '${runEof}'`,
    runnerBody.replace(/\n$/, ''),
    runEof,
    '',
    'chmod +x "$WORKDIR/$RUNNERNAME"',
    'nohup /bin/sh "$WORKDIR/$RUNNERNAME" > "$WORKDIR/$LOGNAME" 2>&1 < /dev/null &',
    'echo "started pid $! log $WORKDIR/$LOGNAME"',
  ];
  return lines.join('\n') + '\n';
}

function buildPollScript({ workdir, card }) {
  const wd = posixWorkdir(workdir) || '$HOME/local-check-workdir';
  const logName = logFileName(card.id);
  return [
    '#!/bin/sh',
    `LOG="${wd}/${logName}"`,
    'if [ ! -f "$LOG" ]; then',
    '  echo "running log-missing"',
    '  exit 0',
    'fi',
    'line=$(grep "^LOCAL_CHECK_EXIT=" "$LOG" 2>/dev/null | tail -n 1 || true)',
    'if [ -n "$line" ]; then',
    '  echo "done $line"',
    'else',
    '  echo "running"',
    'fi',
  ].join('\n') + '\n';
}

function sshArgv(lane, remoteCommand) {
  const args = [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (lane?.key) args.push('-i', path.join(HOME, '.ssh', lane.key));
  args.push(lane?.ssh || '<ssh-target>', remoteCommand);
  return args;
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

function runSsh(lane, script) {
  const args = sshArgv(lane, 'sh -s');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(SSH, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `ssh failed to start: ${e.message}`, stdout: '', stderr: '' });
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
        error: `ssh timed out after ${SSH_TIMEOUT_MS / 1000}s`,
        stdout,
        stderr,
      });
    }, SSH_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 64 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 32 * 1024) stderr += d; });
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        finish({ ok: false, error: `${SSH} is not installed or not on PATH`, stdout, stderr });
      } else {
        finish({ ok: false, error: `ssh failed: ${e.message}`, stdout, stderr });
      }
    });
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, stdout, stderr });
      else {
        const errText = (stderr || stdout).replace(/\s+/g, ' ').trim().slice(0, 300);
        finish({
          ok: false,
          error: `ssh exited ${code}${errText ? `: ${errText}` : ''}`,
          stdout,
          stderr,
        });
      }
    });
    child.stdin.on('error', () => {});
    try { child.stdin.end(script, 'utf8'); }
    catch { /* process already gone */ }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePoll(stdout) {
  const text = String(stdout ?? '');
  const m = /LOCAL_CHECK_EXIT\s*=\s*(-?\d+)/.exec(text);
  if (m) return { done: true, code: Number(m[1]) };
  return { done: false, code: null };
}

// ---------------------------------------------------------------- HTTP

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
      + '(id, title, stage, spec, lane, links)');
  }
  return { url, card };
}

async function pickLocalCheckCard(cfg) {
  const url = pipelineUrl(cfg);
  const data = await boardFetch(url, { method: 'GET', token: cfg.apiToken });
  const rows = Array.isArray(data?.cards) ? data.cards : [];
  const hit = rows.find((c) => normStage(c?.stage) === 'local_check');
  if (!hit || !blank(hit.id)) {
    throw new Error('no card in local_check — pass --once <id>');
  }
  return fetchCard(cfg, hit.id);
}

function moveBody(cardId) {
  return { id: cardId, to: 'ci_pr' };
}

function failBody(cardId) {
  return { id: cardId, kind: 'local' };
}

// ---------------------------------------------------------------- plan

function missingPieces(cfg, card, lane) {
  const missing = [];
  const notes = [];
  if (cfg.missingFile) missing.push(`config file ${cfg.missingFilePath || CONFIG_REL}`);
  if (!cfg.boardUrl) missing.push('boardUrl');
  if (!cfg.apiToken) notes.push('apiToken is empty — the request will have no Authorization header');
  if (!card.title) notes.push('card title is empty');
  if (!card.stage) notes.push('card has no stage');
  else if (card.stage !== 'local_check') {
    notes.push(`card stage is "${card.stage}", not local_check`);
  }
  if (!card.lane) missing.push('card.lane (no lane assigned on the card)');
  if (card.lane && !lane) {
    const known = Object.keys(cfg.lanes);
    missing.push(known.length
      ? `lanes["${card.lane}"] (known: ${known.join(', ')})`
      : `lanes["${card.lane}"] (lanes in config is empty)`);
  }
  if (lane && !lane.ssh) missing.push(`lanes["${lane.name}"].ssh`);
  if (lane && !lane.workdir) missing.push(`lanes["${lane.name}"].workdir`);
  if (!commandFor(cfg, lane)) missing.push('localCheckCommand (top-level or on the lane)');
  if (!card.links.branch) notes.push('card has no links.branch — {branch} will be empty');
  return { missing, notes };
}

function printPlan(ctx) {
  const {
    cfg, card, lane, branch, workdir, logFile, runnerFile,
    commandExpanded, startScript, pollScript, fetchUrl, missing, notes, dryRun,
  } = ctx;
  const lines = [];
  lines.push(dryRun ? 'Local-check dry-run plan' : 'Local-check plan');
  lines.push(`card: ${card.id}`);
  lines.push(`title: ${card.title || '(none)'}`);
  lines.push(`stage: ${card.stage || '(unknown)'}`);
  lines.push(`lane: ${card.lane || '(none assigned)'}`);
  lines.push(`branch: ${branch || '(none)'}`);
  lines.push(`workdir: ${workdir || '(unknown — no workdir)'}`);
  lines.push(`logFile: ${logFile || '(unknown — no workdir)'}`);
  lines.push(`runnerFile: ${runnerFile || '(unknown — no workdir)'}`);
  lines.push('');
  lines.push(`board: ${cfg.boardUrl || '(no boardUrl)'}`);
  lines.push(`config: ${shownPath(ctx.configPath)}`);
  if (fetchUrl) lines.push(`GET ${fetchUrl}`);
  else lines.push('GET (skipped — no boardUrl, card was not fetched)');
  lines.push('');
  if (lane) {
    lines.push(`lane config (${lane.name}):`);
    lines.push(`  ssh: ${lane.ssh || '(missing)'}`);
    if (lane.key) lines.push(`  key: ${lane.key}`);
    lines.push(`  workdir: ${lane.workdir || '(missing)'}`);
    lines.push(`  localCheckCommand: ${commandFor(cfg, lane) || '(missing)'}`);
  } else {
    lines.push('lane config: (none — card has no lane, or that name is not in config.lanes)');
  }
  lines.push('');
  lines.push('localCheckCommand after {branch} {workdir}:');
  lines.push(commandExpanded || '(empty)');
  lines.push('');
  const argv = sshArgv(lane || { ssh: '<ssh-target>' }, 'sh -s');
  lines.push('ssh command that WOULD run (start the test, detached, with a log):');
  lines.push(`  ${formatArgv(SSH, argv)}`);
  lines.push('----- remote start script -----');
  lines.push(startScript.replace(/\s+$/, ''));
  lines.push('----- end remote start script -----');
  lines.push('');
  lines.push('ssh command that WOULD poll the log/exit (look for LOCAL_CHECK_EXIT=N):');
  lines.push(`  ${formatArgv(SSH, argv)}`);
  lines.push('----- remote poll script -----');
  lines.push(pollScript.replace(/\s+$/, ''));
  lines.push('----- end remote poll script -----');
  lines.push(`poll every ${cfg.pollMs}ms, give up after ${cfg.timeoutMs}ms`);
  lines.push('');
  const passUrl = cfg.boardUrl ? moveUrl(cfg) : '{boardUrl}/pipeline/card/move';
  const failPost = cfg.boardUrl ? failUrl(cfg) : '{boardUrl}/pipeline/card/fail';
  lines.push('POST that WOULD run on pass:');
  lines.push(`  POST ${passUrl}`);
  if (cfg.apiToken) lines.push('  Authorization: Bearer <apiToken>');
  else lines.push('  Authorization: (none)');
  lines.push(`  ${JSON.stringify(moveBody(card.id))}`);
  lines.push('');
  lines.push('POST that WOULD run on fail:');
  lines.push(`  POST ${failPost}`);
  if (cfg.apiToken) lines.push('  Authorization: Bearer <apiToken>');
  else lines.push('  Authorization: (none)');
  lines.push(`  ${JSON.stringify(failBody(card.id))}`);
  lines.push('  (the board increments localFails and consecutiveFails; the third');
  lines.push('   consecutive fail auto-Stucks — see bin/pipeline.mjs)');
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
    lines.push('done. no ssh, no POSTs.');
  }
  return lines.join('\n') + '\n';
}

function runBlockers(card, lane, cfg, missing) {
  const errors = [];
  if (!cfg.boardUrl) errors.push('boardUrl is missing — cannot fetch the card or POST the result');
  if (!card.lane) {
    errors.push(
      'this card has no lane assigned. Assign a lane before --run. '
      + 'Local-check will not pick one.');
  } else if (!lane) {
    const known = Object.keys(cfg.lanes);
    errors.push(known.length
      ? `card lane "${card.lane}" is not in config.lanes (known: ${known.join(', ')})`
      : `card lane "${card.lane}" is not in config.lanes (the map is empty)`);
  }
  if (lane && !lane.ssh) errors.push(`lane "${lane.name}" has no ssh target`);
  if (lane && !lane.workdir) errors.push(`lane "${lane.name}" has no workdir`);
  if (!commandFor(cfg, lane)) errors.push('localCheckCommand is missing');
  if (card.stage && card.stage !== 'local_check') {
    errors.push(
      `card is in stage "${card.stage}", not local_check. `
      + 'Local-check only runs for a card already in local_check.');
  }
  for (const m of missing) {
    if (m.startsWith('config file')) errors.push(`missing ${m}`);
  }
  return errors;
}

// ---------------------------------------------------------------- main

function buildContext(cfg, card, { configPath, fetchUrl, dryRun }) {
  const lane = laneFor(cfg, card.lane);
  const branch = blank(card.links.branch);
  const workdir = lane?.workdir || '';
  const logFile = workdir ? posixJoin(workdir, logFileName(card.id)) : '';
  const runnerFile = workdir ? posixJoin(workdir, runnerFileName(card.id)) : '';
  const commandExpanded = applyTemplate(commandFor(cfg, lane), {
    branch: branch || '{branch}',
    workdir: posixWorkdir(workdir) || '{workdir}',
  });
  const startScript = buildStartScript({
    workdir: workdir || '~/local-check-workdir',
    branch,
    card,
    command: commandExpanded,
  });
  const pollScript = buildPollScript({
    workdir: workdir || '~/local-check-workdir',
    card,
  });
  const { missing, notes } = missingPieces(cfg, card, lane);
  return {
    cfg, card, lane, branch, workdir, logFile, runnerFile,
    commandExpanded, startScript, pollScript, fetchUrl, missing, notes,
    configPath, dryRun,
  };
}

async function postResult(cfg, cardId, passed) {
  const url = passed ? moveUrl(cfg) : failUrl(cfg);
  const body = passed ? moveBody(cardId) : failBody(cardId);
  process.stderr.write(`POST ${url}\n`);
  const res = await boardFetch(url, { method: 'POST', token: cfg.apiToken, body });
  const what = passed ? 'moved to ci_pr' : 'reported local fail (board may Stuck on the third in a row)';
  process.stdout.write(
    `${what} on card ${cardId}`
    + (res && res.ok === true ? ' (ok)' : '')
    + '\n');
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
    die(`--once needs a card id\nUsage: node bin/local-check.mjs --once <card-id> [--dry-run|--run]\nAllowed: ${ALLOWED_FLAGS}`, 2);
  }

  const cfg = await loadConfig(flags.configPath, { soft: flags.dryRun });

  let fetchUrl = '';
  let card;
  if (cfg.boardUrl && flags.cardId) {
    const got = await fetchCard(cfg, flags.cardId);
    fetchUrl = got.url;
    card = got.card;
  } else if (cfg.boardUrl && !flags.cardId) {
    const got = await pickLocalCheckCard(cfg);
    fetchUrl = got.url;
    card = got.card;
  } else if (flags.dryRun && flags.cardId) {
    card = {
      id: flags.cardId,
      title: '',
      stage: '',
      lane: '',
      subscription: '',
      spec: '',
      links: {},
    };
  } else if (flags.dryRun) {
    die(`a card id is required (--once <id>)\nUsage: node bin/local-check.mjs --once <card-id> [--dry-run|--run]\nAllowed: ${ALLOWED_FLAGS}`, 2);
  } else {
    throw new Error('boardUrl is missing — cannot fetch the card');
  }

  const ctx = buildContext(cfg, card, {
    configPath: flags.configPath,
    fetchUrl,
    dryRun: flags.dryRun,
  });

  process.stdout.write(printPlan(ctx));

  if (flags.dryRun) return;

  const errors = runBlockers(card, ctx.lane, cfg, ctx.missing);
  if (errors.length) {
    throw new Error(`cannot --run:\n  - ${errors.join('\n  - ')}`);
  }

  process.stderr.write(`ssh ${ctx.lane.ssh} start (script on stdin, timeout ${SSH_TIMEOUT_MS / 1000}s)\n`);
  const started = await runSsh(ctx.lane, ctx.startScript);
  if (!started.ok) {
    const extra = started.stderr && !String(started.error).includes(oneLine(started.stderr, 80))
      ? `\n${started.stderr.trim().slice(0, 800)}`
      : '';
    throw new Error(`${started.error}${extra}`);
  }
  if (started.stdout && started.stdout.trim()) {
    process.stdout.write(`${started.stdout.trim()}\n`);
  }

  const deadline = Date.now() + cfg.timeoutMs;
  let poll;
  while (Date.now() < deadline) {
    await sleep(cfg.pollMs);
    process.stderr.write(`ssh ${ctx.lane.ssh} poll log\n`);
    poll = await runSsh(ctx.lane, ctx.pollScript);
    if (!poll.ok) {
      throw new Error(`poll failed: ${poll.error}`);
    }
    const parsed = parsePoll(poll.stdout);
    if (parsed.done) {
      const passed = parsed.code === 0;
      process.stdout.write(`local-check ${passed ? 'pass' : 'fail'} LOCAL_CHECK_EXIT=${parsed.code}\n`);
      try {
        await postResult(cfg, card.id, passed);
      } catch (e) {
        throw new Error(
          `the local check finished (${passed ? 'pass' : 'fail'}) but the board was not updated: ${e.message}`);
      }
      return;
    }
  }
  throw new Error(
    `local-check timed out after ${cfg.timeoutMs}ms waiting for LOCAL_CHECK_EXIT in ${ctx.logFile}`);
}

main().then(
  () => process.exit(0),
  (e) => die(`local-check: ${e.message || e}`, e.code === 2 ? 2 : 1),
);
