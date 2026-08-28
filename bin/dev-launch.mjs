// Development-launch — start a Development run for one pipeline card.
//
// Input: a card id. The process reads the card from the board, derives a
// branch name, and (on --run) ssh-es to the card's assigned lane to fetch the
// product repo, create the branch, write TASK-<id>.md, and start the
// orchestrator from the lane's launchCommand template, detached, with a log
// file. It then POSTs the branch onto the card via /pipeline/card/update.
//
// Default is --dry-run: print every ssh/git command that WOULD run, then
// exit 0. Incomplete config is allowed in dry-run. --run actually executes
// and refuses to guess a lane.
//
// No packages. Board traffic is global fetch. The lane is ssh. The script
// is sent on ssh stdin (`sh -s`) so a long spec cannot blow the Windows
// command-line limit.
//
// Run:  node bin/dev-launch.mjs <card-id> [--dry-run|--run] [--config <file>]
// File: state/dev-launch.json   (or --config)

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_REL = 'state/dev-launch.json';
const DEFAULT_CONFIG = path.join(ROOT, CONFIG_REL);
const HTTP_TIMEOUT_MS = 20_000;
const SSH_TIMEOUT_MS = 180_000;
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SSH = process.env.DEVLAUNCH_SSH
  || process.env.WATCHTOWER_SSH
  || (process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh');

const HELP = `Development-launch: start a Development run for one pipeline card.

Usage:
  node bin/dev-launch.mjs <card-id> [--dry-run] [--config <file>]
  node bin/dev-launch.mjs <card-id> --run [--config <file>]
  node bin/dev-launch.mjs --help

Flags:
  --dry-run          print every ssh/git command that WOULD run; do not ssh;
                     do not POST. This is the default.
  --run              actually ssh to the assigned lane and POST the branch
  --config <file>    config JSON (default ${CONFIG_REL})
  --card <id>        card id (same as the positional argument)
  --help             this help

Config (see docs/DEVLAUNCH.md):
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "product": { "gitUrl": "git@github.com:org/repo.git", "defaultBranch": "main" },
    "lanes": {
      "lane-1": {
        "ssh": "root@host",
        "workdir": "~/kitchens/repo/lane-1",
        "launchCommand": "codex exec \\"Read {taskFile} and implement on {branch}\\""
      }
    },
    "subscriptions": {
      "cx1": { "CODEX_HOME": "~/.codex-homes/cx1" }
    }
  }

Safety: --run refuses if the card has no lane assigned. This process never
picks a lane, never assigns a subscription and never moves the card's stage.

Exit codes: 0 ok, 1 failure, 2 bad usage.
`;

const CONFIG_HINT = `Expected JSON object:
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "product": { "gitUrl": "git@github.com:org/repo.git", "defaultBranch": "main" },
    "lanes": {
      "<lane>": { "ssh": "root@host", "workdir": "/path", "launchCommand": "…" }
    },
    "subscriptions": {
      "<name>": { "CODEX_HOME": "/path" }
    }
  }
See docs/DEVLAUNCH.md.`;

const ALLOWED_FLAGS = '--dry-run, --run, --config <file>, --card <id>, --help';

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
    else if (a === '--config') {
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
  // Dry-run is the default. --run is the only way anything actually starts.
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

// ---------------------------------------------------------------- slug / branch

function safeToken(s, fallback) {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return t || fallback;
}

function slugTitle(title) {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.slice(0, 48);
}

function branchName(cardId, title) {
  const id = safeToken(cardId, 'card');
  const slug = slugTitle(title);
  const name = slug ? `feat/card-${id}-${slug}` : `feat/card-${id}`;
  return name.slice(0, 80).replace(/-+$/g, '');
}

function taskFileName(cardId) {
  return `TASK-${safeToken(cardId, 'card')}.md`;
}

function logFileName(cardId) {
  return `dev-launch-${safeToken(cardId, 'card')}.log`;
}

function runnerFileName(cardId) {
  return `dev-launch-${safeToken(cardId, 'card')}.sh`;
}

// A POSIX path the remote shell can expand. Leading ~/ becomes $HOME/.
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

function asProduct(src) {
  let gitUrl = '';
  let defaultBranch = 'main';
  if (src.product && typeof src.product === 'object' && !Array.isArray(src.product)) {
    gitUrl = blank(src.product.gitUrl ?? src.product.url);
    defaultBranch = blank(src.product.defaultBranch ?? src.product.branch) || 'main';
  } else if (src.repo && typeof src.repo === 'object' && !Array.isArray(src.repo)) {
    gitUrl = blank(src.repo.gitUrl ?? src.repo.url);
    defaultBranch = blank(src.repo.defaultBranch ?? src.repo.branch) || 'main';
  } else if (typeof src.repo === 'string') {
    gitUrl = blank(src.repo);
    defaultBranch = blank(src.defaultBranch) || 'main';
  } else {
    gitUrl = blank(src.gitUrl);
    defaultBranch = blank(src.defaultBranch) || 'main';
  }
  return { gitUrl, defaultBranch };
}

function normLane(name, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    name,
    ssh: blank(raw.ssh ?? raw.target),
    key: blank(raw.key),
    workdir: blank(raw.workdir ?? raw.workDir ?? raw.cwd),
    launchCommand: blank(raw.launchCommand ?? raw.command),
  };
}

function asLanes(raw) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lanes must be an object of { "<lane>": { ssh, workdir, launchCommand } }');
  }
  const out = {};
  for (const [name, spec] of Object.entries(raw)) {
    const id = String(name ?? '').trim();
    if (!id) continue;
    const lane = normLane(id, spec);
    if (!lane) {
      throw new Error(
        `lanes.${id} must be an object { "ssh": "root@host", "workdir": "/path", "launchCommand": "…" }`);
    }
    out[id] = lane;
  }
  return out;
}

function asSubscriptions(raw) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('subscriptions must be an object of { "<name>": { CODEX_HOME or CLAUDE_CONFIG_DIR or env } }');
  }
  const out = {};
  for (const [name, spec] of Object.entries(raw)) {
    const id = String(name ?? '').trim();
    if (!id) continue;
    const env = {};
    if (typeof spec === 'string') {
      const s = spec.trim();
      if (s) env.CODEX_HOME = s;
    } else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      if (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)) {
        for (const [k, v] of Object.entries(spec.env)) {
          const key = String(k ?? '').trim();
          const val = blank(v);
          if (key && val) env[key] = val;
        }
      }
      const codex = blank(spec.CODEX_HOME ?? spec.codexHome);
      const claude = blank(spec.CLAUDE_CONFIG_DIR ?? spec.claudeConfigDir);
      if (codex) env.CODEX_HOME = codex;
      if (claude) env.CLAUDE_CONFIG_DIR = claude;
    }
    out[id] = { name: id, env };
  }
  return out;
}

function parseConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw new Error('expected a JSON object { boardUrl, apiToken, product, lanes, subscriptions }');
  const product = asProduct(src);
  return {
    boardUrl: asUrl(src.boardUrl, { required: false }),
    apiToken: asToken(src.apiToken ?? src.token),
    product,
    lanes: asLanes(src.lanes),
    subscriptions: asSubscriptions(src.subscriptions),
    raw: true,
  };
}

function emptyConfig() {
  return {
    boardUrl: '',
    apiToken: '',
    product: { gitUrl: '', defaultBranch: 'main' },
    lanes: {},
    subscriptions: {},
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

function subscriptionFor(cfg, name) {
  const id = String(name ?? '').trim();
  if (!id) return null;
  if (cfg.subscriptions[id]) return cfg.subscriptions[id];
  const lower = id.toLowerCase();
  for (const [k, v] of Object.entries(cfg.subscriptions)) {
    if (k.toLowerCase() === lower) return v;
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
  return String(tpl ?? '').replace(/\{(branch|taskFile|subscription)\}/g, (_, k) => {
    return vars[k] == null ? '' : String(vars[k]);
  });
}

function taskMarkdown(card, branch) {
  const spec = String(card.spec ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = [
    `# ${card.title || card.id}`,
    '',
    `- card: ${card.id}`,
    `- branch: ${branch}`,
  ];
  if (card.lane) lines.push(`- lane: ${card.lane}`);
  if (card.subscription) lines.push(`- subscription: ${card.subscription}`);
  lines.push('');
  lines.push(spec.trim() ? spec : '(no spec on the card)');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- remote script

function uniqueEof(kind, cardId, body) {
  let tag = `DEVLAUNCH_${kind}_${safeToken(cardId, 'card')}`;
  let n = 0;
  while (String(body).includes(tag)) {
    n += 1;
    tag = `DEVLAUNCH_${kind}_${safeToken(cardId, 'card')}_${n}`;
  }
  return tag;
}

function exportLines(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`export ${k}=${shSingle(v)}`);
  }
  return lines;
}

function buildRemoteScript({
  gitUrl, defaultBranch, workdir, branch, card, launchExpanded, env,
}) {
  const id = card.id;
  const taskName = taskFileName(id);
  const logName = logFileName(id);
  const runnerName = runnerFileName(id);
  const wd = posixWorkdir(workdir) || '$HOME/dev-launch-workdir';
  const taskBody = taskMarkdown(card, branch);
  const taskEof = uniqueEof('TASK', id, taskBody);
  const runnerLines = [
    '#!/bin/sh',
    `cd "${wd}" || exit 1`,
    ...exportLines(env),
    launchExpanded || 'echo "no launchCommand configured" >&2; exit 1',
  ];
  const runnerBody = runnerLines.join('\n') + '\n';
  const runEof = uniqueEof('RUN', id, runnerBody);
  const gitUrlQ = shSingle(gitUrl || '');
  const branchQ = shSingle(branch);
  const defQ = shSingle(defaultBranch || 'main');

  const lines = [
    '#!/bin/sh',
    'set -eu',
    'export GIT_TERMINAL_PROMPT=0',
    `WORKDIR="${wd}"`,
    `GITURL=${gitUrlQ}`,
    `DEFAULT_BRANCH=${defQ}`,
    `BRANCH=${branchQ}`,
    'TASKNAME=' + shSingle(taskName),
    'LOGNAME=' + shSingle(logName),
    'RUNNERNAME=' + shSingle(runnerName),
    '',
    'mkdir -p "$WORKDIR"',
    'if [ ! -d "$WORKDIR/.git" ]; then',
    '  if [ "$(ls -A "$WORKDIR" 2>/dev/null || true)" ]; then',
    '    echo "workdir is not empty and is not a git repository: $WORKDIR" >&2',
    '    exit 1',
    '  fi',
    '  if [ -z "$GITURL" ]; then',
    '    echo "product gitUrl is missing; cannot clone into $WORKDIR" >&2',
    '    exit 1',
    '  fi',
    '  git clone --branch "$DEFAULT_BRANCH" "$GITURL" "$WORKDIR" \\',
    '    || git clone "$GITURL" "$WORKDIR"',
    'fi',
    '',
    'if [ -n "$GITURL" ]; then',
    '  if git -C "$WORKDIR" remote get-url origin >/dev/null 2>&1; then',
    '    git -C "$WORKDIR" remote set-url origin "$GITURL"',
    '  else',
    '    git -C "$WORKDIR" remote add origin "$GITURL"',
    '  fi',
    'fi',
    'git -C "$WORKDIR" fetch --prune origin',
    '',
    'if git -C "$WORKDIR" rev-parse --verify "origin/$DEFAULT_BRANCH" >/dev/null 2>&1; then',
    '  BASE="origin/$DEFAULT_BRANCH"',
    'elif git -C "$WORKDIR" rev-parse --verify "$DEFAULT_BRANCH" >/dev/null 2>&1; then',
    '  BASE="$DEFAULT_BRANCH"',
    'else',
    '  BASE="$(git -C "$WORKDIR" rev-parse HEAD)"',
    'fi',
    '',
    'if git -C "$WORKDIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then',
    '  git -C "$WORKDIR" checkout "$BRANCH"',
    'else',
    '  git -C "$WORKDIR" checkout -b "$BRANCH" "$BASE"',
    'fi',
    '',
    `cat > "$WORKDIR/$TASKNAME" << '${taskEof}'`,
    taskBody.replace(/\n$/, ''),
    taskEof,
    '',
    `cat > "$WORKDIR/$RUNNERNAME" << '${runEof}'`,
    runnerBody.replace(/\n$/, ''),
    runEof,
    '',
    'chmod +x "$WORKDIR/$RUNNERNAME"',
    'nohup /bin/sh "$WORKDIR/$RUNNERNAME" > "$WORKDIR/$LOGNAME" 2>&1 < /dev/null &',
    'echo "started pid $! branch $BRANCH task $WORKDIR/$TASKNAME log $WORKDIR/$LOGNAME"',
  ];
  return lines.join('\n') + '\n';
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
  // spec=1: the card API answers without the spec text by default, and the
  // TASK file is built from exactly that text.
  return `${cfg.boardUrl}/api/pipeline/card/${encodeURIComponent(id)}?format=json&spec=1`;
}

function updateUrl(cfg) {
  return `${cfg.boardUrl}/pipeline/card/update`;
}

async function fetchCard(cfg, id) {
  const url = cardUrl(cfg, id);
  const data = await boardFetch(url, { method: 'GET', token: cfg.apiToken });
  const card = normCard(data, id);
  if (!card) {
    throw new Error(
      `GET ${url}: expected a JSON object for one card `
      + '(id, title, stage, spec, lane, subscription, links)');
  }
  return { url, card };
}

function updateBody(cardId, branch) {
  return { id: cardId, links: { branch } };
}

// ---------------------------------------------------------------- plan

function missingPieces(cfg, card, lane) {
  const missing = [];
  const notes = [];
  if (cfg.missingFile) missing.push(`config file ${cfg.missingFilePath || CONFIG_REL}`);
  if (!cfg.boardUrl) missing.push('boardUrl');
  if (!cfg.apiToken) notes.push('apiToken is empty — the request will have no Authorization header');
  if (!cfg.product.gitUrl) missing.push('product.gitUrl');
  if (!card.title) notes.push('card title is empty — branch slug will use the id only');
  if (!card.spec) notes.push('card spec is empty — TASK file will say so');
  if (!card.stage) notes.push('card has no stage');
  else if (card.stage !== 'development') {
    notes.push(`card stage is "${card.stage}", not development`);
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
  if (lane && !lane.launchCommand) missing.push(`lanes["${lane.name}"].launchCommand`);
  if (card.subscription) {
    const sub = subscriptionFor({ subscriptions: cfg.subscriptions }, card.subscription);
    if (!sub) {
      notes.push(`subscription "${card.subscription}" is not in config subscriptions — `
        + '{subscription} will still be the name, no extra env');
    }
  } else {
    notes.push('card has no subscription');
  }
  return { missing, notes };
}

function gitCommandPlan(workdir, gitUrl, defaultBranch, branch) {
  const wd = posixWorkdir(workdir) || '<workdir>';
  const url = gitUrl || '<gitUrl>';
  const def = defaultBranch || 'main';
  return [
    `mkdir -p ${wd}`,
    `git clone --branch ${def} ${url} ${wd}   # if ${wd} has no .git; falls back to git clone without --branch`,
    `git -C ${wd} remote set-url origin ${url}   # or remote add, when gitUrl is set`,
    `git -C ${wd} fetch --prune origin`,
    `git -C ${wd} checkout -b ${branch} origin/${def}   # if branch does not exist; else checkout ${branch}`,
  ];
}

function printPlan(ctx) {
  const {
    cfg, card, lane, branch, taskFile, logFile, runnerFile,
    launchExpanded, script, fetchUrl, env, missing, notes, dryRun,
  } = ctx;
  const lines = [];
  lines.push(dryRun ? 'Development-launch dry-run plan' : 'Development-launch plan');
  lines.push(`card: ${card.id}`);
  lines.push(`title: ${card.title || '(none)'}`);
  lines.push(`stage: ${card.stage || '(unknown)'}`);
  lines.push(`lane: ${card.lane || '(none assigned)'}`);
  lines.push(`subscription: ${card.subscription || '(none)'}`);
  lines.push(`branch: ${branch}`);
  lines.push(`taskFile: ${taskFile || '(unknown — no workdir)'}`);
  lines.push(`logFile: ${logFile || '(unknown — no workdir)'}`);
  lines.push(`runnerFile: ${runnerFile || '(unknown — no workdir)'}`);
  lines.push('');
  lines.push(`board: ${cfg.boardUrl || '(no boardUrl)'}`);
  lines.push(`config: ${shownPath(ctx.configPath)}`);
  if (fetchUrl) lines.push(`GET ${fetchUrl}`);
  else lines.push('GET (skipped — no boardUrl, card was not fetched)');
  lines.push('');
  lines.push('product:');
  lines.push(`  gitUrl: ${cfg.product.gitUrl || '(missing)'}`);
  lines.push(`  defaultBranch: ${cfg.product.defaultBranch || 'main'}`);
  lines.push('');
  if (lane) {
    lines.push(`lane config (${lane.name}):`);
    lines.push(`  ssh: ${lane.ssh || '(missing)'}`);
    if (lane.key) lines.push(`  key: ${lane.key}`);
    lines.push(`  workdir: ${lane.workdir || '(missing)'}`);
    lines.push(`  launchCommand: ${lane.launchCommand || '(missing)'}`);
  } else {
    lines.push('lane config: (none — card has no lane, or that name is not in config.lanes)');
  }
  if (Object.keys(env || {}).length) {
    lines.push('subscription env that WOULD be exported:');
    for (const [k, v] of Object.entries(env)) lines.push(`  ${k}=${v}`);
  }
  lines.push('');
  lines.push('launchCommand after {branch} {taskFile} {subscription}:');
  lines.push(launchExpanded || '(empty)');
  lines.push('');
  lines.push('git commands that WOULD run on the lane:');
  for (const c of gitCommandPlan(lane?.workdir, cfg.product.gitUrl, cfg.product.defaultBranch, branch)) {
    lines.push(`  ${c}`);
  }
  lines.push('');
  const argv = sshArgv(lane || { ssh: '<ssh-target>' }, 'sh -s');
  lines.push('ssh command that WOULD run (remote script on stdin):');
  lines.push(`  ${formatArgv(SSH, argv)}`);
  lines.push('----- remote script -----');
  lines.push(script.replace(/\s+$/, ''));
  lines.push('----- end remote script -----');
  lines.push('');
  const postUrl = cfg.boardUrl ? updateUrl(cfg) : '{boardUrl}/pipeline/card/update';
  lines.push('POST that WOULD run after ssh succeeds:');
  lines.push(`  POST ${postUrl}`);
  if (cfg.apiToken) lines.push('  Authorization: Bearer <apiToken>');
  else lines.push('  Authorization: (none)');
  lines.push(`  ${JSON.stringify(updateBody(card.id, branch))}`);
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
  if (!cfg.boardUrl) errors.push('boardUrl is missing — cannot fetch the card or POST the branch');
  if (!card.lane) {
    errors.push(
      'this card has no lane assigned. Assign a lane before --run. '
      + 'Development-launch will not pick one.');
  } else if (!lane) {
    const known = Object.keys(cfg.lanes);
    errors.push(known.length
      ? `card lane "${card.lane}" is not in config.lanes (known: ${known.join(', ')})`
      : `card lane "${card.lane}" is not in config.lanes (the map is empty)`);
  }
  if (lane && !lane.ssh) {
    errors.push(`lane "${lane.name}" has no ssh target`);
  }
  if (lane && !lane.workdir) {
    errors.push(`lane "${lane.name}" has no workdir`);
  }
  if (lane && !lane.launchCommand) {
    errors.push(`lane "${lane.name}" has no launchCommand`);
  }
  if (!cfg.product.gitUrl) errors.push('product.gitUrl is missing — the lane cannot fetch the repo');
  if (card.stage && card.stage !== 'development') {
    errors.push(
      `card is in stage "${card.stage}", not development. `
      + 'Development-launch only starts a run for a card already in development.');
  }
  // missing[] may repeat the same facts; prefer the English sentences above.
  for (const m of missing) {
    if (m.startsWith('config file')) errors.push(`missing ${m}`);
  }
  return errors;
}

// ---------------------------------------------------------------- main

function buildContext(cfg, card, { configPath, fetchUrl, dryRun }) {
  const lane = laneFor(cfg, card.lane);
  const branch = branchName(card.id, card.title);
  const sub = subscriptionFor(cfg, card.subscription);
  const env = sub ? { ...sub.env } : {};
  const workdir = lane?.workdir || '';
  const taskFile = workdir ? posixJoin(workdir, taskFileName(card.id)) : '';
  const logFile = workdir ? posixJoin(workdir, logFileName(card.id)) : '';
  const runnerFile = workdir ? posixJoin(workdir, runnerFileName(card.id)) : '';
  const launchExpanded = applyTemplate(lane?.launchCommand || '', {
    branch,
    taskFile: taskFile || `{taskFile}`,
    subscription: card.subscription || '',
  });
  const script = buildRemoteScript({
    gitUrl: cfg.product.gitUrl,
    defaultBranch: cfg.product.defaultBranch || 'main',
    workdir: workdir || '~/dev-launch-workdir',
    branch,
    card,
    launchExpanded,
    env,
  });
  const { missing, notes } = missingPieces(cfg, card, lane);
  return {
    cfg, card, lane, branch, taskFile, logFile, runnerFile,
    launchExpanded, script, fetchUrl, env, missing, notes,
    configPath, dryRun,
  };
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

  if (!flags.cardId) {
    die(`a card id is required\nUsage: node bin/dev-launch.mjs <card-id> [--dry-run|--run]\nAllowed: ${ALLOWED_FLAGS}`, 2);
  }

  const cfg = await loadConfig(flags.configPath, { soft: flags.dryRun });

  let fetchUrl = '';
  let card;
  if (cfg.boardUrl) {
    const got = await fetchCard(cfg, flags.cardId);
    fetchUrl = got.url;
    card = got.card;
  } else if (flags.dryRun) {
    card = {
      id: flags.cardId,
      title: '',
      stage: '',
      lane: '',
      subscription: '',
      spec: '',
      links: {},
    };
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

  process.stderr.write(`ssh ${ctx.lane.ssh} (script on stdin, timeout ${SSH_TIMEOUT_MS / 1000}s)\n`);
  const ran = await runSsh(ctx.lane, ctx.script);
  if (!ran.ok) {
    const extra = ran.stderr && !String(ran.error).includes(oneLine(ran.stderr, 80))
      ? `\n${ran.stderr.trim().slice(0, 800)}`
      : '';
    throw new Error(`${ran.error}${extra}`);
  }
  const started = (ran.stdout || '').trim();
  if (started) process.stdout.write(`${started}\n`);
  if (ran.stderr && ran.stderr.trim()) {
    process.stderr.write(ran.stderr.endsWith('\n') ? ran.stderr : ran.stderr + '\n');
  }

  const url = updateUrl(cfg);
  const body = updateBody(card.id, ctx.branch);
  process.stderr.write(`POST ${url}\n`);
  try {
    const res = await boardFetch(url, { method: 'POST', token: cfg.apiToken, body });
    process.stdout.write(
      `posted links.branch=${ctx.branch} on card ${card.id}`
      + (res && res.ok === true ? ' (ok)' : '')
      + '\n');
  } catch (e) {
    throw new Error(
      `the lane run has started (${ctx.branch}) but the board was not updated: ${e.message}\n`
      + `POST ${url} with ${JSON.stringify(body)}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => die(`dev-launch: ${e.message || e}`, e.code === 2 ? 2 : 1),
);
