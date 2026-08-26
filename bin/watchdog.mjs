// Watchdog — every intervalMin minutes, look at each active pipeline card,
// gather evidence, ask a cheap LLM for a one-line Status and a verdict, and
// write that back onto the card.
//
// A Status is "what is happening right now". It is not the Stage (the column
// the card sits in). Verdicts are moving / stalled / looping.
//
// No packages. Board traffic is global fetch. Lane logs are ssh. CI is the
// gh CLI when it is installed. The LLM is a shell command from config; the
// prompt is written to its stdin.
//
// Run:  node bin/watchdog.mjs [--once] [--dry-run] [--config <file>]
// File: state/watchdog.json   (or --config)

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_REL = 'state/watchdog.json';
const DEFAULT_CONFIG = path.join(ROOT, CONFIG_REL);
const DEFAULT_INTERVAL_MIN = 15;
const HTTP_TIMEOUT_MS = 20_000;
const SSH_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 25_000;
const LLM_TIMEOUT_MS = 90_000;
const LOG_CHARS = 3_000;
const STATUS_CHARS = 400;
const ACTIVE_STAGES = ['development', 'local_check', 'ci_pr'];
const VERDICTS = ['moving', 'stalled', 'looping'];
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const SSH = process.env.WATCHDOG_SSH
  || process.env.WATCHTOWER_SSH
  || (process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh');
const GH = process.env.WATCHDOG_GH || process.env.WATCHTOWER_GH || 'gh';

const HELP = `Watchdog: write a Status line and a moving/stalled/looping verdict on each active pipeline card.

Usage:
  node bin/watchdog.mjs [--once] [--dry-run] [--config <file>]
  node bin/watchdog.mjs --help

Flags:
  --once             one sweep, then exit
  --dry-run          gather evidence and print the prompt that WOULD go to the
                     LLM; do not call the LLM; do not POST Status
  --config <file>    config JSON (default ${CONFIG_REL})
  --help             this help

Config (see docs/WATCHDOG.md):
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "intervalMin": 15,
    "llmCommand": "claude -p --model haiku",
    "lanes": {
      "lane-1": { "ssh": "root@host", "command": "tail -n 80 /var/log/lane-1.log" }
    }
  }
`;

const CONFIG_HINT = `Expected JSON object:
  {
    "boardUrl": "https://board.example.com",
    "apiToken": "<secret>",
    "intervalMin": 15,
    "llmCommand": "claude -p --model haiku",
    "lanes": {
      "lane-1": { "ssh": "root@host", "command": "tail -n 80 /path/to.log" }
    }
  }
See docs/WATCHDOG.md.`;

// ---------------------------------------------------------------- flags

function parseFlags(argv) {
  const out = { once: false, dryRun: false, help: false, configPath: DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        throw Object.assign(new Error('--config needs a file path'), { code: 2 });
      }
      out.configPath = path.resolve(next);
    } else if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length).trim();
      if (!v) throw Object.assign(new Error('--config needs a file path'), { code: 2 });
      out.configPath = path.resolve(v);
    } else if (a.startsWith('-')) {
      throw Object.assign(
        new Error(`unknown flag ${a}\nAllowed: --once, --dry-run, --config <file>, --help`),
        { code: 2 },
      );
    } else {
      throw Object.assign(
        new Error(`unexpected argument ${a}\nAllowed: --once, --dry-run, --config <file>, --help`),
        { code: 2 },
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- logging

function ts() {
  return new Date().toISOString();
}

function log(line) {
  process.stderr.write(`[${ts()}] ${line}\n`);
}

function die(message, code = 1) {
  process.stderr.write(`${String(message).endsWith('\n') ? message : message + '\n'}`);
  process.exit(code);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n… (${s.length} chars total, clipped to ${n})`;
}

function oneLine(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------- config

function asIntervalMin(v) {
  if (v == null || v === '') return DEFAULT_INTERVAL_MIN;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('intervalMin must be a number of minutes >= 1');
  }
  return n;
}

function asUrl(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) throw new Error('boardUrl is missing');
  if (!/^https?:\/\//i.test(s)) {
    throw new Error(`boardUrl must start with http:// or https:// (got ${s})`);
  }
  return trimSlash(s);
}

function asToken(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) throw new Error('apiToken is missing');
  return s;
}

function asLlmCommand(v, { required }) {
  if (Array.isArray(v)) {
    const parts = v.map(x => String(x ?? '').trim()).filter(Boolean);
    if (!parts.length) {
      if (!required) return '';
      throw new Error('llmCommand is missing');
    }
    return parts;
  }
  const s = v == null ? '' : String(v).trim();
  if (!s) {
    if (!required) return '';
    throw new Error('llmCommand is missing');
  }
  return s;
}

function fmtLlmCommand(cmd) {
  if (!cmd) return '(none)';
  return Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
}

function normLane(name, raw) {
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? { name, ssh: '', key: '', command: s, via: 'command-string' } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ssh = String(raw.ssh ?? raw.target ?? '').trim();
  const key = String(raw.key ?? '').trim();
  const logPath = String(raw.log ?? '').trim();
  const command = String(raw.command ?? '').trim()
    || (logPath ? `tail -n 80 ${logPath}` : '');
  if (!command) return null;
  // A string-only command (no ssh target) is run locally. Useful in tests;
  // a live lane should set ssh.
  return { name, ssh, key, command, via: ssh ? 'ssh' : 'local' };
}

function asLanes(raw) {
  if (raw == null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('lanes must be an object of { "<lane>": { ssh, command } }');
  }
  const out = {};
  for (const [name, spec] of Object.entries(raw)) {
    const id = String(name ?? '').trim();
    if (!id) continue;
    const lane = normLane(id, spec);
    if (!lane) {
      throw new Error(
        `lanes.${id} needs a command (or log) — e.g. { "ssh": "root@host", "command": "tail -n 80 /path.log" }`);
    }
    out[id] = lane;
  }
  return out;
}

function parseConfig(raw, { requireLlm }) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!src) throw new Error('expected a JSON object { boardUrl, apiToken, intervalMin, llmCommand, lanes }');
  return {
    boardUrl: asUrl(src.boardUrl),
    apiToken: asToken(src.apiToken),
    intervalMin: asIntervalMin(src.intervalMin),
    llmCommand: asLlmCommand(src.llmCommand, { required: requireLlm }),
    lanes: asLanes(src.lanes),
  };
}

async function loadConfigFile(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const shown = path.isAbsolute(file) && file !== DEFAULT_CONFIG ? file : CONFIG_REL;
      throw new Error(`missing config file ${shown}\n${CONFIG_HINT}`);
    }
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

async function loadConfig(file, { requireLlm }) {
  const raw = await loadConfigFile(file);
  try {
    return parseConfig(raw, { requireLlm });
  } catch (e) {
    throw new Error(`${file}: ${e.message}\n${CONFIG_HINT}`);
  }
}

function laneFor(cfg, laneId) {
  const id = String(laneId ?? '').trim();
  if (!id) return null;
  if (cfg.lanes[id]) return cfg.lanes[id];
  // "host/lane-1" on the card, "lane-1" in config (or the other way around).
  const slash = id.lastIndexOf('/');
  if (slash > 0) {
    const tail = id.slice(slash + 1);
    if (cfg.lanes[tail]) return cfg.lanes[tail];
  }
  return null;
}

// ---------------------------------------------------------------- subprocess

function runCaptured(bin, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '').trim();
      if (err) {
        if (err.code === 'ENOENT') {
          return resolve({ ok: false, error: `${bin} is not installed or not on PATH`, stdout: out });
        }
        if (err.killed || err.signal === 'SIGTERM') {
          return resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, stdout: out });
        }
        if (out.trim()) return resolve({ ok: true, stdout: out, warning: errText || err.message });
        return resolve({ ok: false, error: errText || err.message, stdout: out });
      }
      resolve({ ok: true, stdout: out });
    });
  });
}

function sshArgs(lane) {
  const args = [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (lane.key) args.push('-i', path.join(HOME, '.ssh', lane.key));
  args.push(lane.ssh, lane.command);
  return args;
}

async function readLaneLog(lane) {
  if (!lane) return { ok: false, error: 'no lane on the card' };
  if (!lane.command) return { ok: false, error: `no command configured for lane "${lane.name}"` };
  if (lane.ssh) {
    const ran = await runCaptured(SSH, sshArgs(lane), SSH_TIMEOUT_MS);
    if (!ran.ok) return { ok: false, error: `ssh failed: ${ran.error}` };
    return { ok: true, text: ran.stdout };
  }
  // Local command: split like a shell would for a simple "tail -n 80 file".
  const parts = lane.command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) ?? [];
  if (!parts.length) return { ok: false, error: 'empty local command' };
  const ran = await runCaptured(parts[0], parts.slice(1), SSH_TIMEOUT_MS);
  if (!ran.ok) return { ok: false, error: `local command failed: ${ran.error}` };
  return { ok: true, text: ran.stdout };
}

function parsePr(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = s.match(/github\.com[:/]([^/]+)\/([^/#\s]+?)(?:\.git)?(?:\/pull\/|#)(\d+)/i);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: m[3], url: s };
  m = s.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: m[3], url: s };
  m = s.match(/^#?(\d+)$/);
  if (m) return { repo: '', number: m[1], url: s };
  return { repo: '', number: '', url: s };
}

function summariseChecks(rollup) {
  const items = Array.isArray(rollup) ? rollup : [];
  if (!items.length) return 'no checks';
  let fail = 0;
  let run = 0;
  let ok = 0;
  for (const it of items) {
    const v = String(it.conclusion || it.state || it.status || '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(v)) fail++;
    else if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(v)) run++;
    else ok++;
  }
  if (fail) return `CI red (${fail} failed, ${ok} ok, ${run} running)`;
  if (run) return `CI running (${run} in progress, ${ok} ok)`;
  return `CI green (${ok})`;
}

let ghAvailable = null;

async function ghIsAvailable() {
  if (ghAvailable != null) return ghAvailable;
  const ran = await runCaptured(GH, ['--version'], 8_000);
  ghAvailable = ran.ok;
  return ghAvailable;
}

async function readCi(prRaw) {
  const pr = parsePr(prRaw);
  if (!pr) return { ok: false, error: 'no PR link on the card' };
  if (!(await ghIsAvailable())) return { ok: false, error: 'gh CLI is not available' };
  const args = ['pr', 'view'];
  if (pr.number) args.push(pr.number);
  else args.push(pr.url);
  if (pr.repo) args.push('--repo', pr.repo);
  args.push('--json', 'number,title,state,url,updatedAt,statusCheckRollup');
  const ran = await runCaptured(GH, args, GH_TIMEOUT_MS);
  if (!ran.ok) return { ok: false, error: `gh failed: ${ran.error}` };
  let data;
  try { data = JSON.parse(ran.stdout); }
  catch { return { ok: false, error: 'gh answered but it was not JSON', raw: clip(ran.stdout, 400) }; }
  const lines = [
    `PR #${data.number ?? pr.number} ${data.state ?? ''}`.trim()
      + (data.title ? ` — ${data.title}` : ''),
    data.url || pr.url || '',
    summariseChecks(data.statusCheckRollup),
    data.updatedAt ? `updated ${data.updatedAt}` : '',
  ].filter(Boolean);
  return { ok: true, text: lines.join('\n') };
}

function runLlm(command, prompt) {
  // spawn has no timeout / maxBuffer the way execFile does — we cap the
  // collected text and kill the process ourselves.
  const isArr = Array.isArray(command);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = isArr
        ? spawn(command[0], command.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(String(command), { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(`llmCommand failed: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = fn => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(() => reject(new Error(`llmCommand timed out after ${LLM_TIMEOUT_MS}ms`)));
    }, LLM_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 64 * 1024) out += d; });
    child.stderr.on('data', d => { if (err.length < 8 * 1024) err += d; });
    child.on('error', e => {
      finish(() => {
        if (e && e.code === 'ENOENT') {
          reject(new Error(`llmCommand not found: ${fmtLlmCommand(command)}`));
        } else {
          reject(new Error(`llmCommand failed: ${e.message}`));
        }
      });
    });
    child.on('close', code => {
      finish(() => {
        const text = out.trim();
        if (code && !text) {
          reject(new Error(
            `llmCommand exited ${code}${err.trim() ? `: ${oneLine(err, 300)}` : ''}`));
        } else {
          resolve(out);
        }
      });
    });
    child.stdin.on('error', () => {});
    try { child.stdin.end(prompt, 'utf8'); }
    catch { /* process already gone */ }
  });
}

// ---------------------------------------------------------------- cards / HTTP

function normStage(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_');
}

function asLinks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    out[key] = v == null ? '' : String(v).trim();
  }
  return out;
}

function asStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = String(raw.text ?? '').trim();
  const verdict = String(raw.verdict ?? '').trim().toLowerCase();
  const at = raw.at ? String(raw.at) : '';
  if (!text && !verdict) return null;
  return { text, verdict, at };
}

function normCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  const card = {
    id,
    title: String(raw.title ?? '').trim(),
    stage: normStage(raw.stage),
    lane: String(raw.lane ?? '').trim(),
    links: asLinks(raw.links),
    status: asStatus(raw.status),
    consecutiveFails: Number.isFinite(Number(raw.consecutiveFails))
      ? Math.max(0, Math.floor(Number(raw.consecutiveFails)))
      : 0,
    slot: String(raw.slot ?? '').trim(),
    subscription: String(raw.subscription ?? '').trim(),
  };
  if (!card.status) {
    const v = String(raw.verdict ?? '').trim().toLowerCase();
    if (VERDICTS.includes(v)) card.status = { text: '', verdict: v, at: '' };
  }
  return card;
}

function asCards(data) {
  let list = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray(data.cards)) list = data.cards;
  else {
    throw new Error(
      'GET /api/pipeline?format=json: expected a JSON array of cards '
      + '(id, title, stage, links, lane), or an object { cards: [...] }');
  }
  return list.map(normCard).filter(Boolean);
}

function isActive(card) {
  return ACTIVE_STAGES.includes(card.stage);
}

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
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new Error(`board HTTP ${res.status}${snippet ? `: ${snippet}` : ''} (${url})`);
  }
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`board answered with non-JSON (${url})`); }
}

function statusUrl(cfg, id) {
  return `${cfg.boardUrl}/pipeline/card/${encodeURIComponent(id)}/status`;
}

function pipelineUrl(cfg) {
  return `${cfg.boardUrl}/api/pipeline?format=json`;
}

// ---------------------------------------------------------------- evidence + prompt

async function gatherEvidence(cfg, card) {
  const evidence = {
    laneId: card.lane || '',
    laneLog: '',
    laneError: '',
    ci: '',
    ciError: '',
  };

  if (card.lane) {
    const lane = laneFor(cfg, card.lane);
    if (!lane) {
      const known = Object.keys(cfg.lanes);
      evidence.laneError = known.length
        ? `no ssh command configured for lane "${card.lane}" (known: ${known.join(', ')})`
        : `no ssh command configured for lane "${card.lane}" (lanes in config is empty)`;
    } else {
      const got = await readLaneLog(lane);
      if (got.ok) evidence.laneLog = String(got.text ?? '');
      else evidence.laneError = got.error;
    }
  } else {
    evidence.laneError = 'no lane on the card';
  }

  const pr = card.links.pr || card.links.pull || '';
  if (pr) {
    const got = await readCi(pr);
    if (got.ok) evidence.ci = got.text;
    else evidence.ciError = got.error;
  } else {
    evidence.ciError = 'no PR link on the card';
  }

  return evidence;
}

function evidenceBlock(evidence) {
  const lines = [];
  if (evidence.laneLog.trim()) {
    lines.push('Lane log tail:');
    lines.push(clip(evidence.laneLog.trim(), LOG_CHARS));
  } else {
    lines.push(`Lane log: ${evidence.laneError || 'empty'}`);
  }
  lines.push('');
  if (evidence.ci.trim()) {
    lines.push('CI:');
    lines.push(clip(evidence.ci.trim(), 800));
  } else {
    lines.push(`CI: ${evidence.ciError || 'none'}`);
  }
  return lines.join('\n');
}

function buildPrompt(card, evidence) {
  const links = Object.entries(card.links)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || '(none)';
  const prev = card.status
    ? `${card.status.text || '(empty)'}${card.status.verdict ? ` [${card.status.verdict}]` : ''}${card.status.at ? ` at ${card.status.at}` : ''}`
    : '(none)';
  const extra = [
    card.slot ? `Slot: ${card.slot}` : '',
    card.subscription ? `Subscription: ${card.subscription}` : '',
    card.consecutiveFails ? `Consecutive fails: ${card.consecutiveFails}` : '',
  ].filter(Boolean).join('\n');

  return [
    'You are the Watchtower Watchdog. One pipeline card. Write what is happening right now.',
    '',
    'Output EXACTLY two lines and nothing else:',
    'STATUS: <one plain-English sentence, no quotes, under 200 characters>',
    'VERDICT: moving|stalled|looping',
    '',
    'Verdicts:',
    '- moving: work is progressing (new log lines, CI running or newly green, agent not stuck)',
    '- stalled: nothing useful has happened recently',
    '- looping: the same failure or the same step is repeating',
    '',
    `Card: ${card.id} — ${card.title || '(no title)'}`,
    `Stage: ${card.stage || '(unknown)'}`,
    `Lane: ${card.lane || '(none)'}`,
    extra || null,
    `Links: ${links}`,
    `Previous status: ${prev}`,
    '',
    evidenceBlock(evidence),
  ].filter(s => s != null).join('\n') + '\n';
}

function parseLlm(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('LLM returned an empty answer');

  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (stripped.startsWith('{')) {
    try {
      const obj = JSON.parse(stripped);
      const verdict = String(obj.verdict ?? '').trim().toLowerCase();
      const status = String(obj.text ?? obj.status ?? obj.STATUS ?? '').trim();
      if (VERDICTS.includes(verdict) && status) {
        return { text: oneLine(status, STATUS_CHARS), verdict };
      }
    } catch { /* fall through to line parser */ }
  }

  let status = '';
  let verdict = '';
  for (const line of stripped.split(/\r?\n/)) {
    const sm = line.match(/^\s*STATUS:\s*(.+)\s*$/i);
    if (sm) status = sm[1].trim();
    const vm = line.match(/^\s*VERDICT:\s*(moving|stalled|looping)\s*$/i);
    if (vm) verdict = vm[1].toLowerCase();
  }
  if (!verdict) {
    const vm = stripped.match(/\b(moving|stalled|looping)\b/i);
    if (vm) verdict = vm[1].toLowerCase();
  }
  if (!status) {
    const first = stripped.split(/\r?\n/).map(l => l.trim()).find(l => l && !/^verdict:/i.test(l));
    if (first) status = first.replace(/^STATUS:\s*/i, '');
  }
  if (!status) throw new Error('LLM answer had no STATUS line');
  if (!VERDICTS.includes(verdict)) {
    throw new Error(`LLM answer had no verdict (want moving|stalled|looping), got: ${oneLine(stripped, 180)}`);
  }
  return { text: oneLine(status, STATUS_CHARS), verdict };
}

// ---------------------------------------------------------------- one card / one sweep

function printPlanCard(card, evidence, prompt, cfg) {
  const lines = [];
  lines.push(`--- card ${card.id}  "${card.title || '(no title)'}"  stage=${card.stage || '(unknown)'} ---`);
  if (!isActive(card)) {
    lines.push(`skipped: stage "${card.stage || ''}" is not active`);
    lines.push(`active stages: ${ACTIVE_STAGES.join(', ')}`);
    return lines.join('\n');
  }
  lines.push(`lane: ${card.lane || '(none)'}`);
  lines.push('evidence:');
  lines.push(`  laneLog: ${evidence.laneError || (evidence.laneLog.trim()
    ? `${evidence.laneLog.trim().split(/\r?\n/).length} line(s), ${evidence.laneLog.length} chars`
    : 'empty')}`);
  lines.push(`  ci: ${evidence.ciError || oneLine(evidence.ci, 120) || 'empty'}`);
  lines.push('prompt that WOULD be sent to llmCommand on stdin:');
  lines.push('-----');
  lines.push(prompt.replace(/\s+$/, ''));
  lines.push('-----');
  lines.push(`would POST ${statusUrl(cfg, card.id)}`);
  lines.push('  { "text": "(llm would write this)", "verdict": "moving|stalled|looping" }');
  return lines.join('\n');
}

async function processCard(cfg, card, { dryRun }) {
  if (!isActive(card)) {
    return { id: card.id, skipped: true, reason: `stage ${card.stage || '(empty)'}` };
  }
  const evidence = await gatherEvidence(cfg, card);
  const prompt = buildPrompt(card, evidence);

  if (dryRun) {
    process.stdout.write(printPlanCard(card, evidence, prompt, cfg) + '\n\n');
    return { id: card.id, dryRun: true };
  }

  const raw = await runLlm(cfg.llmCommand, prompt);
  const parsed = parseLlm(raw);
  const url = statusUrl(cfg, card.id);
  await boardFetch(url, {
    method: 'POST',
    token: cfg.apiToken,
    body: { text: parsed.text, verdict: parsed.verdict },
  });
  log(`${card.id}: ${parsed.verdict} — ${parsed.text}`);
  return { id: card.id, verdict: parsed.verdict, text: parsed.text };
}

async function fetchCards(cfg) {
  const url = pipelineUrl(cfg);
  const data = await boardFetch(url, { method: 'GET', token: cfg.apiToken });
  return { url, cards: asCards(data) };
}

async function sweep(cfg, { dryRun }) {
  const { url, cards } = await fetchCards(cfg);
  const active = cards.filter(isActive);
  const skipped = cards.length - active.length;

  if (dryRun) {
    const known = Object.keys(cfg.lanes);
    process.stdout.write([
      'Watchdog dry-run plan',
      `board: ${cfg.boardUrl}`,
      `intervalMin: ${cfg.intervalMin}`,
      `llmCommand: ${fmtLlmCommand(cfg.llmCommand)}  (NOT called in dry-run)`,
      `lanes: ${known.length ? known.join(', ') : '(none)'}`,
      `GET ${url}`,
      `cards: ${cards.length}  (active ${active.length}, skipped ${skipped})`,
      `active stages: ${ACTIVE_STAGES.join(', ')}`,
      '',
    ].join('\n') + '\n');
  } else {
    log(`sweep: ${cards.length} cards, ${active.length} active, ${skipped} skipped`);
  }

  if (!cards.length && dryRun) {
    process.stdout.write('no cards on the pipeline — nothing to score.\n');
  }

  let failed = 0;
  for (const card of cards) {
    try {
      if (dryRun && !isActive(card)) {
        process.stdout.write(printPlanCard(card, null, '', cfg) + '\n\n');
        continue;
      }
      await processCard(cfg, card, { dryRun });
    } catch (e) {
      failed += 1;
      log(`card ${card.id || '?'}: skipped: ${e.message || e}`);
      if (dryRun) {
        process.stdout.write(
          `--- card ${card.id || '?'} ---\nskipped after error: ${e.message || e}\n\n`);
      }
    }
  }

  if (dryRun) {
    process.stdout.write(
      `done. no LLM call, no POSTs.${failed ? ` (${failed} card(s) failed and were skipped)` : ''}\n`);
  } else if (failed) {
    log(`sweep finished with ${failed} card(s) skipped after errors`);
  }
}

// ---------------------------------------------------------------- main

const flags = (() => {
  try {
    return parseFlags(process.argv.slice(2));
  } catch (e) {
    die(e.message, e.code === 2 ? 2 : 1);
  }
})();

if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

async function startConfig() {
  try {
    return await loadConfig(flags.configPath, { requireLlm: !flags.dryRun });
  } catch (e) {
    die(`watchdog: ${e.message}`);
  }
}

let cfg = await startConfig();

process.on('SIGINT', () => { log('stopping'); process.exit(0); });
process.on('SIGTERM', () => { log('stopping'); process.exit(0); });

async function runOnce() {
  try {
    await sweep(cfg, { dryRun: flags.dryRun });
  } catch (e) {
    const msg = String(e.message || e);
    if (flags.once) throw e;
    log(msg);
  }
}

if (flags.once) {
  try {
    await runOnce();
  } catch (e) {
    die(`watchdog: ${e.message || e}`);
  }
  process.exit(0);
}

log(`watchdog started, every ${cfg.intervalMin} min, board ${cfg.boardUrl}`
  + (flags.dryRun ? ' (dry-run: no LLM, no POSTs)' : ''));
for (;;) {
  await runOnce();
  try {
    cfg = await loadConfig(flags.configPath, { requireLlm: !flags.dryRun });
  } catch (e) {
    log(`keeping previous config: ${e.message}`);
  }
  await sleep(cfg.intervalMin * 60 * 1000);
}
