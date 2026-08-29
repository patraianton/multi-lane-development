// Watchtower — a live kanban of your coding-agent fleet.
//
// One card = one herdr window working on the selected project. Everything on a
// card is read from live sources; nothing is typed in by hand.
//
// Sources:
//   herdr api snapshot / workspace list / agent list  — windows, panes, state
//   herdr agent explain <pane>                        — which rule set that state
//   herdr pane read <pane> --source visible           — footer line: account, model, effort
//   ssh <host> hzlane status + pgrep (local check)  — build lanes on Linux hosts
//   ssh <host> (git + pgrep + lsof)                   — build lanes on a Mac kitchen
//   gh pr list / gh issue view                        — open PRs, CI colour, umbrella issues
//   stream-watch file                                 — window -> lanes and branch prefixes
//   PROGRAM-STATE.md                                  — umbrella issue number
//   Claude session logs (*.jsonl)                     — the window's last words
//
// Run: node bin\watchtower.mjs [--open]   (or bin\watchtower.cmd)

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, mkdir, stat, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';
import { normStreamWatch } from './stream-watch.mjs';
import {
  BadRequest, send, sendText, readBody,
  clipText, toonTable, agentParams,
} from './serve.mjs';
import {
  configurePipeline, handlePipeline, setPipelineBoard, setShadowFacts, pipelineStaleProblems,
  sweepArtifactAnswers, setCardSprints, listPipelineCards, syncSprintUnits,
} from './pipeline.mjs';
import { sprintFactsFor, parseUnitBranch, parseUnitDeps } from './sprint-facts.mjs';
import { makeArtifactProbe } from './artifact-answers.mjs';
import { parseLavish } from './lavish-config.mjs';
import { configureSlots, slotsForBoard, slotsAlarmMessage } from './ci-slot.mjs';
import {
  configureTelegram,
  notifyArtifactReady,
  notifyAssignSubscription,
  notifyStuck,
  notifyDone,
} from './telegram-bot.mjs';
import { configureHooks, enqueueHook, listHooks, ackHooks, hooksNotice } from './hooks.mjs';
import {
  configureAuth, parseAuth, authEnabled, authWarnings, resolveViewer, handleAuth,
  accessDecision, signInPage, withJsonBody,
} from './auth.mjs';

// WATCHTOWER_PORT is the current name; AUTOPASE_BOARD_PORT is still read as a
// fallback so older installs keep starting on their usual port.
const PORT = Number(process.env.WATCHTOWER_PORT || process.env.AUTOPASE_BOARD_PORT || 4878);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// WATCHTOWER_STATE_DIR lets a test (or a second board) keep its own files
// without writing over the live state/. Unset — the repo's state/ as before.
const STATE_DIR = path.resolve(process.env.WATCHTOWER_STATE_DIR || path.join(ROOT, 'state'));
// On-disk state file names are deliberately left as they were: live installs
// already carry these files, and renaming them would drop their history.
const SEEN_FILE = path.join(STATE_DIR, 'autopase-seen.json');
// Hand edits of the board: hidden windows and cards added by the owner.
const CARDS_FILE = path.join(STATE_DIR, 'autopase-cards.json');
// Settings file: overrides DEFAULTS below and stores the chosen project.
const CONFIG_FILE = path.join(STATE_DIR, 'autopase-board.json');
const PAGE_FILE = path.join(ROOT, 'bin', 'watchtower.html');
const HOME = process.env.USERPROFILE ?? '';
const SEEN_KEEP_MS = 7 * 24 * 3600 * 1000;

// Built-in defaults. Everything here can be overridden by the settings file
// state/autopase-board.json, which is not in git — so each install keeps its
// own hosts, repository and paths out of the repository.
const DEFAULTS = {
  // Chosen project: the herdr worktree root (~/.herdr/worktrees/<project>/…) or
  // the repository name of a plain project folder. Empty means "not chosen yet"
  // and the board shows the onboarding screen instead.
  project: '',
  // true — show every herdr window, no project filter at all.
  allWindows: false,
  // Legacy filter kept for older settings files: a window is shown when its
  // working directory contains this substring. When set, it wins over project.
  match: '',
  // Windows never shown on the board (by folder name or window label).
  hide: [],
  // owner/name for `gh pr list` and `gh issue list`. Empty — GitHub is skipped.
  repo: '',
  // Optional JSON file that says which window owns which build lanes.
  streamWatch: '',
  // Optional folder with <PROGRAM>/PROGRAM-STATE.md files (umbrella issue numbers).
  specsDir: '',
  // Protocol markers, NOT interface text: these are the exact words your windows
  // and umbrella issues use to flag a question for a human. They are matched
  // against comment and screen text, so keep them in whatever language your team
  // actually writes — set your own in state/autopase-board.json.
  askWords: ['ВОПРОС CTO', 'ОТВЕТ ВЛАДЕЛЬЦУ', 'ВОПРОС ВЛАДЕЛЬЦУ'],
  // Markers that close such a question. Until one of them appears after the
  // question, the question counts as still open.
  answerWords: ['ОТВЕТ CTO', 'РЕШЕНИЕ CTO', 'CTO ОТВЕЧАЕТ', 'ОТВЕЧАЮ ПО ПУНКТАМ', 'СЛОВО ВЛАДЕЛЬЦА'],
  // Hosts where code is built. target — what to pass to ssh, key — a key in ~/.ssh.
  // Example:
  //   "hosts": {
  //     "builder": { "target": "root@203.0.113.10", "key": "id_ed25519", "kind": "hzlane" },
  //     "mac":     { "target": "mac", "kind": "mac", "kitchen": "~/kitchens/myproject" }
  //   }
  hosts: {},
  // Shared secret the probe sends as Authorization: Bearer. Empty — every
  // /probe/* path answers 403 until one is set.
  probeToken: '',
  // Shared secret agents send as Authorization: Bearer on /pipeline/* and
  // /hooks/enqueue when founder sign-in is on. Empty — those paths then need
  // a session or localhost instead. Unused while `auth.founders` is empty.
  apiToken: '',
  // Where window data comes from: "local" talks to herdr on this machine
  // (the original board); "probe" uses the last snapshot the probe posted.
  source: 'local',
  // A probe snapshot older than this many seconds is stale: the header says
  // so and /api/board lists it under problems. 60 is three times the probe's
  // usual 15-second interval, with a little slack.
  probeStaleSec: 60,
};

const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];
const SSH = process.env.WATCHTOWER_SSH || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const GH = process.env.WATCHTOWER_GH || 'gh';

const KNOWN_STATUSES = new Set(['blocked', 'done', 'working', 'idle', 'unknown']);

// Columns. The first one is what is standing still without a human.
const COLUMNS = [
  { key: 'ask', title: 'Needs you' },
  { key: 'running', title: 'Working' },
  { key: 'waiting', title: 'Lane is building' },
  { key: 'idle', title: 'Idle' },
  { key: 'off', title: 'No agent' },
];

// ---------------------------------------------------------------- small helpers

function normPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replaceAll('/', '\\').toLowerCase();
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

// Same trimming as normPath, but the original case is kept: project names are
// shown to the owner and stored in the settings file, so they must not be
// lower-cased by accident of path handling.
function trimPath(p) {
  let s = String(p ?? '');
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replaceAll('/', '\\');
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

// State files are read and written by bin/state-file.mjs: one atomic write queue
// shared with the pipeline, so two parts of the board never race over a file.

// Running an external command. Never throws — returns text or null.
function runText(bin, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout },
      (err, stdout) => {
        const out = String(stdout ?? '');
        if (err && !out.trim()) return resolve(null);
        resolve(out);
      });
  });
}

// herdr calls that answer with one line of JSON.
function herdr(args) {
  return new Promise((resolve, reject) => {
    const tryOne = (i) => {
      execFile(HERDR_CANDIDATES[i], args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            if (err.code === 'ENOENT' && i + 1 < HERDR_CANDIDATES.length) return tryOne(i + 1);
            return reject(new Error(`herdr ${args.join(' ')}: ${String(stderr || '').trim() || err.message}`));
          }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error(`herdr ${args.join(' ')}: answer is not JSON`)); }
        });
    };
    tryOne(0);
  });
}

// herdr calls that answer with plain text (explain, pane read).
async function herdrText(args) {
  for (const bin of HERDR_CANDIDATES) {
    const out = await runText(bin, args, 30000);
    if (out !== null) return out;
  }
  return null;
}

// Every source refreshes at its own pace in the background: the page polls
// /data every 3 seconds and never waits for ssh or for GitHub.
function makeSource(name, everyMs, fn) {
  const src = { name, at: 0, ok: false, busy: false, error: null, value: null, tookMs: null };
  src.tick = () => {
    if (src.busy || Date.now() - src.at < everyMs) return src.pending ?? null;
    src.busy = true;
    const started = Date.now();
    src.pending = (async () => {
      try {
        src.value = await fn();
        src.ok = true;
        src.error = null;
      } catch (e) {
        src.ok = false;
        src.error = String(e?.message || e);
      } finally {
        src.at = Date.now();
        src.tookMs = Date.now() - started;
        src.busy = false;
        src.pending = null;
      }
    })();
    return src.pending;
  };
  return src;
}

// --------------------------------------------------- settings and bindings

let config = { ...DEFAULTS };

function applyConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  config = { ...DEFAULTS, ...src, hosts: { ...DEFAULTS.hosts, ...(src.hosts ?? {}) } };
  config.source = config.source === 'probe' ? 'probe' : 'local';
  const stale = Number(config.probeStaleSec);
  config.probeStaleSec = Number.isFinite(stale) && stale >= 1 ? Math.floor(stale) : DEFAULTS.probeStaleSec;
  config.probeToken = String(config.probeToken ?? '').trim();
  config.apiToken = String(src.apiToken ?? config.apiToken ?? '').trim();
  // Missing, broken or empty founders list → null, and the board stays open.
  config.auth = parseAuth(src);
  reportAuthWarnings(config.auth);
  config.subscriptions = parseSubscriptions(src.subscriptions);
  const telegramOn = wireTelegram(src.telegram);
  setPipelineBoard({
    subscriptions: config.subscriptions,
    notifyEnabled: telegramOn,
    senders: telegramOn ? {
      artifactReady: notifyArtifactReady,
      assignSubscription: notifyAssignSubscription,
      stuck: notifyStuck,
      done: notifyDone,
    } : null,
  });
  return config;
}

function parseSubscriptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const name = (typeof item === 'string' || typeof item === 'number')
      ? String(item).trim()
      : String(item?.name ?? item?.id ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Present + (botToken or dryRun:true) → senders are live. Anything else is
// a skip, said once so a missing token is visible in the service log.
let telegramNotice = '';
function noteTelegram(msg) {
  if (msg === telegramNotice) return;
  telegramNotice = msg;
  console.log(msg);
}

function wireTelegram(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    configureTelegram(null);
    noteTelegram('telegram notifications skipped: no telegram config');
    return false;
  }
  const token = String(raw.botToken ?? raw.token ?? '').trim();
  const dryRun = raw.dryRun === true;
  if (!token && !dryRun) {
    configureTelegram(null);
    noteTelegram('telegram notifications skipped: no botToken');
    return false;
  }
  try {
    configureTelegram({ ...raw, botToken: token, dryRun });
  } catch (e) {
    configureTelegram(null);
    noteTelegram(`telegram notifications skipped: ${e.message}`);
    return false;
  }
  noteTelegram(dryRun ? 'telegram notifications: dry-run' : 'telegram notifications: on');
  return true;
}

// Risky sign-in settings are said out loud once, and again whenever they change,
// so the operator sees them in `journalctl -u watchtower`.
let lastAuthWarning = '';
function reportAuthWarnings(auth) {
  const lines = authWarnings(auth);
  const key = lines.join('\n');
  if (key === lastAuthWarning) return;
  lastAuthWarning = key;
  for (const line of lines) console.warn(`auth warning: ${line}`);
}

const cfgSource = makeSource('config', 30000, async () => applyConfig(await readJsonSoft(CONFIG_FILE, {})));

// The founders' answers on a review artifact are read where they live — the
// desktop Lavish state file, or the Cloudflare instance from the `lavish`
// block — and marked on the card. Nothing is drained: the CTO's poll still
// receives every answer. Runs on its own timer, not on page polls, so a board
// nobody is looking at still notices.
const artifactSweepMs = Math.max(200, Number(process.env.WATCHTOWER_ARTIFACT_SWEEP_MS) || 30000);
let artifactSweepError = '';
const artifactSource = makeSource('artifact-answers', artifactSweepMs, async () => {
  let lavish = { publicBaseUrl: '', apiToken: '' };
  try { lavish = parseLavish(config.lavish); } catch { /* a malformed block: local state only */ }
  try {
    const result = await sweepArtifactAnswers(makeArtifactProbe({ lavish }));
    artifactSweepError = '';
    return result;
  } catch (e) {
    const message = String(e?.message || e);
    if (message !== artifactSweepError) console.log(`artifact-answers: ${message}`);
    artifactSweepError = message;
    throw e;
  }
});
setInterval(() => { artifactSource.tick(); }, artifactSweepMs).unref();

// Sprint cards: units bound to lanes and PRs by the live sources, then the
// unit cards spawned and walked by those facts. Runs on its own timer (and
// after every board sweep), so it does not depend on the page being open or a
// project being chosen. WATCHTOWER_SPRINT_FACTS_FILE (tests) replaces the live
// sources with a JSON file of the same shape.
const FRESH_MS = 10 * 60 * 1000;
// Only the sources the sprint facts are built from count: lanes, open and
// merged PRs, unit tickets. A slow umbrella or stream-watch read must not
// freeze every unit card.
function staleSourceNames() {
  return [lanesSource, prSource, mergedPrSource, unitIssuesSource]
    .filter(s => !s.ok || !s.at || (Date.now() - s.at) > FRESH_MS)
    .map(s => s.name);
}
// Lanes of a host whose probe just failed are unknown, not empty. The last
// good answer stands in for up to ten minutes (a unit keeps its lane through
// one dropped sweep); after that the host counts as a stale source and the
// unit cards hold still.
const lastGoodLanes = new Map(); // host -> { lanes, at }
function lanesWithMemory(hostResults, staleSources) {
  const lanes = [];
  for (const h of hostResults ?? []) {
    if (h.ok) {
      lastGoodLanes.set(h.host, { lanes: (h.lanes ?? []).map(l => ({ ...l, hostOk: true })), at: Date.now() });
      lanes.push(...lastGoodLanes.get(h.host).lanes);
      continue;
    }
    const kept = lastGoodLanes.get(h.host);
    if (kept && Date.now() - kept.at <= FRESH_MS) lanes.push(...kept.lanes.map(l => ({ ...l, hostOk: false, remembered: true })));
    else staleSources.push(`lanes:${h.host}`);
  }
  return lanes;
}

const sprintSweepMs = Math.max(200, Number(process.env.WATCHTOWER_SPRINT_SWEEP_MS) || 30000);
const sprintSource = makeSource('sprint-units', sprintSweepMs, async () => {
  let facts;
  if (process.env.WATCHTOWER_SPRINT_FACTS_FILE) {
    const f = await readJsonSoft(process.env.WATCHTOWER_SPRINT_FACTS_FILE, {});
    facts = {
      lanes: f.lanes ?? [], prs: f.prs ?? [], mergedPrs: f.mergedPrs ?? [],
      unitIssues: new Map(Object.entries(f.unitIssues ?? {}).map(([k, v]) => [Number(k), v])),
      ciJobs: new Map(Object.entries(f.ciJobs ?? {}).map(([k, v]) => [Number(k), v])),
      ciRunners: f.ciRunners ?? [],
      staleSources: f.staleSources ?? [],
    };
  } else {
    // The pipeline page never runs the windows sweep, so the slow sources are
    // refreshed here too (each on its own interval) — a board showing only
    // the pipeline still sees lanes, PRs and tickets move.
    await Promise.all([streamsSource, lanesSource, prSource, mergedPrSource, unitIssuesSource, umbrellaSource, ciRunnersSource]
      .map(src => src.tick()).filter(Boolean));
    // CI jobs read the PR list this sweep just refreshed; a failure here is
    // information missing, never a reason to hold a card.
    await ciJobsSource.tick();
    const staleSources = staleSourceNames();
    facts = {
      lanes: lanesWithMemory(lanesSource.value, staleSources),
      prs: prSource.value ?? [],
      mergedPrs: mergedPrSource.value ?? [],
      unitIssues: unitIssuesSource.value ?? new Map(),
      ciJobs: ciJobsSource.value ?? new Map(),
      ciRunners: ciRunnersSource.value ?? [],
      staleSources,
    };
  }
  const sprints = sprintFactsFor(await listPipelineCards(), { ...facts, at: new Date().toISOString() });
  setCardSprints(sprints);
  const sync = await syncSprintUnits(sprints);
  if (sync.spawned || sync.moved) console.log(`unit cards: ${sync.spawned} spawned, ${sync.moved} moved by facts`);
  return { sprints: sprints.size, ...sync };
});
setInterval(() => { sprintSource.tick(); }, sprintSweepMs).unref();

// Which project the board is showing, and how the filter is expressed.
//   none    — nothing chosen yet, the page shows onboarding
//   all     — every herdr window, no filter
//   match   — legacy settings file: substring of the working directory
//   project — herdr worktree root / repository name
function selection() {
  if (config.allWindows === true) return { mode: 'all', label: 'All windows' };
  const match = String(config.match ?? '').trim();
  const project = String(config.project ?? '').trim();
  if (match) return { mode: 'match', match: match.toLowerCase(), label: project || match };
  if (project) return { mode: 'project', project, label: project };
  return { mode: 'none', label: null };
}

// The project a window belongs to: the herdr worktree root when the window sits
// in ~/.herdr/worktrees/<project>/…, otherwise the git repository name, and as a
// last resort the folder name itself.
const WORKTREE_RX = /[\\/]\.herdr[\\/]worktrees[\\/]([^\\/]+)/i;

function projectOf(cwd, ws) {
  const raw = trimPath(cwd);
  if (!raw) return '';
  const m = raw.match(WORKTREE_RX);
  if (m) return m[1];
  const repo = ws?.worktree?.repo_name;
  if (repo) return String(repo);
  return path.basename(raw);
}

// The onboarding list: every project herdr currently has windows in, with how
// many windows and how many of them carry an agent.
function projectList(panes, wsById) {
  const byName = new Map();
  for (const p of panes) {
    const name = projectOf(p.cwd, wsById.get(p.workspace_id));
    if (!name) continue;
    const key = name.toLowerCase();
    let row = byName.get(key);
    if (!row) { row = { project: name, windows: new Set(), agents: new Set() }; byName.set(key, row); }
    row.windows.add(p.workspace_id);
    // Counted by window, not by pane: one window with two agent panes is still
    // one window with an agent, so `agents` can never exceed `windows`.
    if (p.agent) row.agents.add(p.workspace_id);
  }
  return [...byName.values()]
    .map(r => ({ project: r.project, windows: r.windows.size, agents: r.agents.size }))
    .sort((a, b) => b.windows - a.windows || a.project.localeCompare(b.project));
}

// The stream-watch file is the only place that records "this window drives these
// lanes and writes branches with these prefixes". The file is maintained
// elsewhere, the board only reads it — through normStreamWatch, which rebuilds
// every record so a hand-edited file can lose a record (reported under
// problems) but can never take the whole board collection down.
const streamsSource = makeSource('stream-watch', 30000, async () => {
  if (!config.streamWatch) {
    return { raw: null, byPane: new Map(), byId: new Map(), ctoPane: null, repo: config.repo, problems: [] };
  }
  const raw = await readJsonSoft(config.streamWatch, null);
  if (!raw) throw new Error(`cannot read ${config.streamWatch}`);
  const norm = normStreamWatch(raw);
  return {
    raw,
    byPane: norm.byPane,
    byId: norm.byId,
    ctoPane: norm.ctoPane,
    repo: norm.repo ?? config.repo,
    problems: norm.problems,
  };
});

// PROGRAM-STATE.md of each program: that is where the umbrella issue number is.
const programsSource = makeSource('programs', 30000, async () => {
  const out = new Map(); // program folder name (lower case) -> {umbrella, file, updated}
  if (!config.specsDir) return out;
  let dirs = [];
  try { dirs = await readdir(config.specsDir, { withFileTypes: true }); }
  catch (e) { throw new Error(`cannot read ${config.specsDir}: ${e.message}`); }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(config.specsDir, d.name, 'PROGRAM-STATE.md');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    const m = text.match(/umbrella:\s*#(\d+)/i);
    const head = text.match(/updated\s+([0-9T:\-\s.Z]+)/i);
    out.set(d.name.toLowerCase(), {
      program: d.name,
      file,
      umbrella: m ? Number(m[1]) : null,
      updated: head ? head[1].trim() : null,
    });
  }
  return out;
});

// ------------------------------------------------------------- build lanes

// A lane running the project's local check (scripts/ci-local.mjs, usually
// through ci-local-and-stamp.sh) is a fact of its own — it is what the
// local_check stage means. The process's working directory names the lane.
// The bracketed first letters keep pgrep from matching this very command.
// CWD is replaced per platform: /proc on Linux, lsof on the Mac.
const CHECK_PROBE = [
  'for p in $(pgrep -f "[s]cripts/ci-local.mjs|[c]i-local-and-stamp" 2>/dev/null); do',
  'echo "CHECK $p|$(ps -o etime= -p $p | tr -d " ")|CWD|$(ps -o args= -p $p | tr "\\n" " " | cut -c1-200)";',
  'done;',
].join(' ');
const HZ_PROBE = 'hzlane status 2>&1; '
  + CHECK_PROBE.replace('CWD', '$(readlink /proc/$p/cwd 2>/dev/null)');

// "CHECK <pid>|<etime>|<cwd>|<cmd>" → the lane whose folder the check runs in.
function attachChecks(lanes, out) {
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^CHECK\s+(\d+)\|([^|]*)\|([^|]*)\|(.*)$/);
    if (!m) continue;
    const cwd = m[3].trim().replace(/[\\/]+$/, '');
    const lane = lanes.find(l => cwd.endsWith('/' + l.lane) || cwd.includes('/' + l.lane + '/'));
    if (!lane || lane.check) continue;
    lane.check = { pid: m[1], since: m[2] ? `${m[2]} ago` : null, cmd: m[4].trim() };
  }
}

// hzlane status: "lane-3: BUSY since Wed 2026-08-26 09:25:20 UTC  branch=feat/…"
function parseHzlane(out, hostName) {
  const lanes = [];
  const extras = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^\s*(lane-[\w.-]+):\s*(\S+)(.*)$/i);
    if (m) {
      const rest = m[3] ?? '';
      const br = rest.match(/branch=(\S+)/);
      const since = rest.match(/since\s+(.+?)(?:\s{2,}|$)/);
      lanes.push({
        host: hostName,
        lane: m[1],
        busy: /busy/i.test(m[2]),
        state: m[2],
        branch: br ? br[1] : null,
        since: since ? since[1].trim() : null,
      });
      continue;
    }
    if (/^\s*(ci|host):/i.test(line)) extras.push(line.trim());
  }
  attachChecks(lanes, out);
  return { lanes, extras };
}

// A Mac kitchen has no hzlane: a lane is a folder <kitchen>/lane-*, the branch
// comes from git, and "busy" is decided by the working directory of a live
// `codex exec` process.
const MAC_PROBE = [
  'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH;',
  'for d in KITCHEN/lane-*; do [ -d "$d" ] || continue;',
  'echo "LANE $(basename "$d") branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"; done;',
  'for p in $(pgrep -f "codex exec" 2>/dev/null); do',
  'echo "PROC $p|$(ps -o etime= -p $p | tr -d " ")|$(lsof -a -d cwd -p $p -Fn 2>/dev/null | grep "^n" | head -1 | cut -c2-)|$(ps -o command= -p $p | tr "\\n" " " | cut -c1-400)";',
  'done;',
  CHECK_PROBE.replace('CWD', '$(lsof -a -d cwd -p $p -Fn 2>/dev/null | grep "^n" | head -1 | cut -c2-)'),
  'echo "UP $(uptime | tr -s " ")"',
].join(' ');

function parseMac(out, hostName, kitchenAbs) {
  const lanes = [];
  const procs = [];
  const extras = [];
  for (const line of String(out).split(/\r?\n/)) {
    let m = line.match(/^LANE\s+(\S+)\s+branch=(\S*)$/);
    if (m) { lanes.push({ host: hostName, lane: m[1], busy: false, state: 'FREE', branch: m[2] || null, since: null }); continue; }
    m = line.match(/^PROC\s+(\d+)\|([^|]*)\|([^|]*)\|(.*)$/);
    if (m) { procs.push({ pid: m[1], etime: m[2], cwd: m[3], cmd: m[4] }); continue; }
    if (line.startsWith('UP ')) extras.push(line.slice(3).trim());
  }
  for (const l of lanes) {
    const hit = procs.find(p => p.cwd && (p.cwd.endsWith('/' + l.lane) || p.cwd.endsWith('\\' + l.lane)));
    if (!hit) continue;
    l.busy = true;
    l.state = 'BUSY';
    l.since = hit.etime ? `${hit.etime} ago` : null;
    const task = /TASK-[A-Za-z0-9._-]+/.exec(hit.cmd);
    l.task = task ? task[0] : null;
  }
  // Codex work outside the project lanes does not belong on the board, but its
  // count is useful: it eats the same cores.
  const outside = procs.filter(p => !lanes.some(l => p.cwd && p.cwd.endsWith('/' + l.lane))).length;
  if (outside) extras.push(`${outside} more codex process(es) outside the project lanes`);
  attachChecks(lanes, out);
  return { lanes, extras, kitchen: kitchenAbs };
}

// How long ssh may wait for the TCP handshake. A host behind a mesh VPN
// (the Mac over Tailscale) can drop the first SYNs and answer on a retry
// twenty seconds later; ten seconds there reads as "did not answer" every
// other sweep. Per host: hosts.<name>.connectTimeoutSec (default 10).
function connectTimeoutSec(host) {
  const n = Number(host?.connectTimeoutSec);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10;
}

function sshArgs(host, remote) {
  const args = ['-o', `ConnectTimeout=${connectTimeoutSec(host)}`, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (host.key) args.push('-i', path.join(HOME, '.ssh', host.key));
  args.push(host.target, remote);
  return args;
}

async function probeHost(name, host) {
  const remote = host.kind === 'mac'
    ? MAC_PROBE.replaceAll('KITCHEN', host.kitchen ?? '~/kitchens')
    : HZ_PROBE;
  const started = Date.now();
  const budget = Math.max(45000, (connectTimeoutSec(host) + 35) * 1000);
  let out = await runText(SSH, sshArgs(host, remote), budget);
  // A second attempt right away usually lands where the first one was dropped
  // on the way (mesh VPN paths); one retry, not a loop.
  if (out === null) out = await runText(SSH, sshArgs(host, remote), budget);
  if (out === null) {
    return { host: name, target: host.target, ok: false, lanes: [], extras: [], error: 'ssh did not answer', tookMs: Date.now() - started };
  }
  const parsed = host.kind === 'mac'
    ? parseMac(out, name, host.kitchen)
    : parseHzlane(out, name);
  return { host: name, target: host.target, ok: true, tookMs: Date.now() - started, ...parsed };
}

const lanesSource = makeSource('lanes', 45000, async () => {
  const entries = Object.entries(config.hosts ?? {});
  const res = await Promise.all(entries.map(([n, h]) => probeHost(n, h).catch(e =>
    ({ host: n, target: h.target, ok: false, lanes: [], extras: [], error: String(e.message || e) }))));
  return res;
});

// ------------------------------------------------------------- GitHub

function ciColor(rollup) {
  const items = rollup ?? [];
  if (!items.length) return { color: 'none', text: 'no checks' };
  let fail = 0, run = 0, ok = 0;
  for (const it of items) {
    const v = String(it.conclusion || it.state || it.status || '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(v)) fail++;
    else if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(v)) run++;
    else ok++;
  }
  if (fail) return { color: 'red', text: `CI red (${fail})` };
  if (run) return { color: 'run', text: `CI running (${run})` };
  return { color: 'green', text: `CI green (${ok})` };
}

const prSource = makeSource('pull-requests', 60000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  if (!repo) return [];
  const out = await runText(GH, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '80',
    '--json', 'number,title,headRefName,headRefOid,isDraft,url,createdAt,updatedAt,statusCheckRollup,author'], 90000);
  if (out === null) throw new Error('gh pr list did not answer');
  const list = JSON.parse(out);
  return list.map(p => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    headSha: p.headRefOid ?? null,
    draft: p.isDraft,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    author: p.author?.login ?? null,
    ci: ciColor(p.statusCheckRollup),
  }));
});

// The CI slot pool: the repo's self-hosted runners — who is online, who is
// busy, which server each belongs to (its labels). One call a minute.
const ciRunnersSource = makeSource('ci-runners', 60000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  if (!repo) return [];
  const out = await runText(GH, ['api', `repos/${repo}/actions/runners?per_page=100`,
    '--jq', '[.runners[] | {name, status, busy, labels: [.labels[].name]}]'], 60000);
  if (out === null) throw new Error('gh api actions/runners did not answer');
  return JSON.parse(out);
});

// Where each open PR's checks run: for PRs whose CI is queued or in progress,
// the workflow runs on the head SHA and their jobs — job status, runner name,
// start time. At most eight PRs a sweep; the rest wait for the next one.
const ciJobsSource = makeSource('ci-jobs', 60000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  const byPr = new Map();
  if (!repo) return byPr;
  const live = (prSource.value ?? []).filter(p => p.headSha && p.ci?.color === 'run').slice(0, 8);
  for (const pr of live) {
    const runsOut = await runText(GH, ['api', `repos/${repo}/actions/runs?head_sha=${pr.headSha}&per_page=5`,
      '--jq', '[.workflow_runs[] | select(.status == "queued" or .status == "in_progress" or .status == "waiting") | {id, name, status}]'], 60000);
    if (runsOut === null) continue;
    let runs;
    try { runs = JSON.parse(runsOut); } catch { continue; }
    const jobs = [];
    for (const run of runs.slice(0, 3)) {
      const jobsOut = await runText(GH, ['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=30`,
        '--jq', '[.jobs[] | {name, status, runner_name, started_at}]'], 60000);
      if (jobsOut === null) continue;
      let list;
      try { list = JSON.parse(jobsOut); } catch { continue; }
      for (const j of list) {
        jobs.push({ workflow: run.name, job: j.name, status: j.status, runner: j.runner_name ?? '', startedAt: j.started_at ?? null });
      }
    }
    byPr.set(pr.number, jobs);
  }
  return byPr;
});

// Merged PRs: the only observable proof that a window actually delivered
// something. Read-only, same repo, refreshed on its own timer.
const mergedPrSource = makeSource('pull-requests-merged', 120000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  if (!repo) return [];
  const out = await runText(GH, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100',
    '--json', 'number,title,headRefName,url,createdAt,mergedAt'], 90000);
  if (out === null) throw new Error('gh pr list --state merged did not answer');
  return JSON.parse(out).map(p => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    url: p.url,
    createdAt: p.createdAt,
    mergedAt: p.mergedAt,
  }));
});

// Open unit tickets: the sprint scope of a stream is the set of open issues
// that reference its umbrella by number ("#1300") in the title or body. The
// umbrella body itself is NOT read as a scope — it freezes on the day it is
// written; a live ticket has an observable open/closed state instead. Issues
// labelled `umbrella` are umbrellas, not units; issues labelled `wave-next`
// are deliberately parked for a later wave and do not hold a card back.
const unitIssuesSource = makeSource('umbrella-units', 180000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  const byUmbrella = new Map(); // umbrella number -> [{number, title, url, createdAt}]
  if (!repo) return byUmbrella;
  // Closed units are read too: a sprint card shows a finished unit as done,
  // not as vanished. Consumers that want the open scope filter on `state`.
  const out = await runText(GH, ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '300',
    '--json', 'number,title,body,url,labels,createdAt,state,closedAt'], 90000);
  if (out === null) throw new Error('gh issue list (units) did not answer');
  for (const it of JSON.parse(out)) {
    const labels = (it.labels ?? []).map(l => String(l.name ?? '').toLowerCase());
    if (labels.includes('umbrella') || labels.includes('wave-next')) continue;
    const refs = new Set();
    for (const m of `${it.title}\n${it.body ?? ''}`.matchAll(/#(\d{3,5})\b/g)) refs.add(Number(m[1]));
    for (const n of refs) {
      if (n === it.number) continue;
      if (!byUmbrella.has(n)) byUmbrella.set(n, []);
      byUmbrella.get(n).push({
        number: it.number, title: it.title, url: it.url, createdAt: it.createdAt,
        state: String(it.state ?? 'OPEN').toUpperCase(), closedAt: it.closedAt ?? null,
        branch: parseUnitBranch(it.body),
        deps: parseUnitDeps(it.body),
      });
    }
  }
  return byUmbrella;
});

// Umbrella issues: the list plus recent comments, so a question for a human can
// be spotted there.
const umbrellaSource = makeSource('umbrella', 120000, async () => {
  const out = new Map();
  const repo = streamsSource.value?.repo ?? config.repo;
  if (!repo) return out;
  const listOut = await runText(GH, ['issue', 'list', '--repo', repo, '--label', 'umbrella',
    '--state', 'open', '--limit', '40', '--json', 'number,title,url,updatedAt'], 90000);
  if (listOut === null) throw new Error('gh issue list did not answer');
  const numbers = new Set(JSON.parse(listOut).map(i => i.number));
  // Plus umbrellas named in PROGRAM-STATE.md: they may carry no label.
  for (const p of (programsSource.value ?? new Map()).values()) if (p.umbrella) numbers.add(p.umbrella);
  for (const n of numbers) {
    const raw = await runText(GH, ['issue', 'view', String(n), '--repo', repo,
      '--json', 'number,title,url,updatedAt,state,comments'], 90000);
    if (raw === null) continue;
    let j;
    try { j = JSON.parse(raw); } catch { continue; }
    const comments = (j.comments ?? []).slice(-30);
    const words = config.askWords ?? DEFAULTS.askWords;
    const answers = config.answerWords ?? DEFAULTS.answerWords;
    let ask = null;
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = String(comments[i].body ?? '');
      const hit = words.find(w => body.toUpperCase().includes(w.toUpperCase()));
      if (!hit) continue;
      // A question counts as closed only when an answer comment landed AFTER it.
      // Progress reports from the stream itself ("started", "merged") are not an
      // answer — the same account writes both, so the author tells us nothing.
      const answered = comments.slice(i + 1).some(c =>
        answers.some(a => String(c.body ?? '').toUpperCase().includes(a.toUpperCase())));
      ask = {
        word: hit,
        at: comments[i].createdAt ?? null,
        author: comments[i].author?.login ?? null,
        text: body.replace(/\s+/g, ' ').slice(0, 300),
        after: comments.length - 1 - i, // how many comments landed after the question
        answered,
      };
      break;
    }
    const last = comments[comments.length - 1];
    out.set(n, {
      number: j.number, title: j.title, url: j.url, state: j.state,
      updatedAt: j.updatedAt, commentCount: (j.comments ?? []).length, ask,
      lastComment: last ? {
        at: last.createdAt ?? null,
        author: last.author?.login ?? null,
        text: String(last.body ?? '').replace(/\s+/g, ' ').slice(0, 200),
      } : null,
    });
  }
  return out;
});

// ------------------------------------------ window screen and last words

// The footer line of a Claude Code screen:
//   name@example.com | effort: xhigh | user > branch | Opus 5 (1M context) | [====] 47% | cache …
function parseFooter(text) {
  const lines = String(text).split(/\r?\n/);
  let footer = null, mode = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!footer && l.includes('|') && /\beffort:/i.test(l)) { footer = l; continue; }
    if (!mode && /(bypass permissions|accept edits|plan mode|shift\+tab)/i.test(l)) mode = l.trim();
  }
  if (!footer) {
    // Not Claude Code: other agents draw their status line inside a box
    // ("╰─ Grok 4.6 (xhigh) · always approve ─╯"). Take it whole as the model.
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s*[╰└]─*\s*(\S.*?)\s*─*[╯┘]\s*$/);
      if (m && m[1].length >= 4) return { account: null, model: m[1], effort: null, contextPct: null, cache: null, mode };
    }
    return { account: null, model: null, effort: null, contextPct: null, cache: null, mode };
  }
  const parts = footer.split('|').map(s => s.trim()).filter(Boolean);
  const find = (rx) => parts.find(p => rx.test(p)) ?? null;
  const effort = find(/^effort:/i);
  const ctx = find(/\[[=\s]*\]|\[[=\s]+\]|\]\s*\d+%/) ?? find(/\d+%\s*$/);
  const cache = find(/cache|кэш/i);
  const account = parts[0] && /@/.test(parts[0]) ? parts[0] : null;
  // The model is whatever is not the account, not the effort, not the "user >
  // branch" part, not the context bar and not the cache counter.
  const model = parts.find(p =>
    p !== account && !/^effort:/i.test(p) && !/\s>\s/.test(p) && p !== ctx && p !== cache
    && !/^\[/.test(p) && /[A-Za-zА-Яа-я]/.test(p)) ?? null;
  const pct = ctx ? (ctx.match(/(\d+)\s*%/) ?? [])[1] : null;
  return {
    account,
    model,
    effort: effort ? effort.replace(/^effort:\s*/i, '') : null,
    contextPct: pct ? Number(pct) : null,
    cache: cache ?? null,
    mode,
  };
}

// Terminal furniture: hints, mode bars, the shell prompt. That is not what the
// window said, and such lines must never end up in "last words".
const CHROME = [
  /shift\+tab/i, /ctrl\+[a-z]/i, /\besc\b\s*:/i, /^PS\s+[A-Z]:\\/i, /CategoryInfo/i,
  /\(optional\)/i, /auto mode on/i, /bypass permissions/i, /for agents\s*$/i,
  /^\s*[❯>$#]/, /Update installed/i, /token(s)?\s*$/i, /^\S+=\S+&\S+=/,
  /^\s*✻/, /^\s*⎿/, /How is Claude doing/i, /^\s*\d+\s*\/\s*\d+\s+agents?\b/i,
  /^[╰╭╮╯┌┐└┘├┤│─═]/, // a line inside a box is furniture, not speech
];
// Tools, not words: "● Bash(…)", "● Created PR #…" — that is a report of an action.
const TOOL_LINE = /^(Monitor|Bash|Read|Write|Edit|Search|Task|Update|Created PR|Ran \d|Fetch|Glob|Grep|WebFetch|Skill)\b/;

// A quoted, escaped line (newlines, character codes) turned into plain text. If
// only whitespace survives the unescaping, there is nothing to show.
function unquote(raw) {
  let t = String(raw).trim();
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  t = t
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length >= 3 ? t.slice(0, 120) : '';
}

// Box borders, arrows and separators are not words. If fewer than a dozen real
// characters remain after removing them, the line is furniture rather than
// speech (otherwise a box like "╰─ (Grok 4.6) ─╯" became the "last words").
function wordyLength(l) {
  return l.replace(/[\s─═│┌┐└┘├┤┬┴┼╌╭╮╰╯▼▲►◄◇◆○●⏺|+\-–—·•]/g, '').length;
}

// The screen without its footer: the last line the window really said.
function lastScreenWords(text) {
  const clean = (l) => l.replace(/\s+/g, ' ').trim().slice(0, 300);
  const junk = (l) => CHROME.some(rx => rx.test(l)) || /\beffort:/i.test(l) || wordyLength(l) < 12;
  const lines = String(text).split(/\r?\n/);
  // Claude Code lines start with a ● / ⏺ marker — that is the agent speaking.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*[●⏺]\s+(.{8,})$/);
    if (m && !TOOL_LINE.test(m[1]) && !junk(m[1])) return clean(m[1]);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (junk(l)) continue;
    return clean(l);
  }
  return null;
}

// Screens and state rules are read less often than the page polls: 40 windows ×
// two herdr calls is noticeable, and screen text does not change that fast.
const paneCache = new Map(); // pane -> { at, footer, words, prs, explain }
const PANE_TTL_MS = 12000;
let paneRefreshing = false;

async function refreshPanes(panes) {
  if (paneRefreshing) return;
  paneRefreshing = true;
  try {
    for (const pane of panes) {
      const hit = paneCache.get(pane);
      if (hit && Date.now() - hit.at < PANE_TTL_MS) continue;
      const [screen, explainRaw] = await Promise.all([
        herdrText(['pane', 'read', pane, '--source', 'visible']),
        herdrText(['agent', 'explain', pane]),
      ]);
      const explain = {};
      for (const line of String(explainRaw ?? '').split(/\r?\n/)) {
        const m = line.match(/^(agent|state|rule|evidence|manifest):\s*(.*)$/);
        if (m) explain[m[1]] = m[2].trim();
      }
      // rule arrives as "osc_title_working (region=osc_title priority=1100)":
      // the card needs the short name, the details go into the tooltip.
      if (explain.rule) {
        const r = explain.rule.match(/^(\S+)\s*(?:\((.*)\))?/);
        explain.ruleName = r ? r[1] : explain.rule;
        explain.ruleWhere = r?.[2] ?? null;
      }
      if (explain.evidence) explain.evidence = unquote(explain.evidence);
      const text = screen ?? '';
      paneCache.set(pane, {
        at: Date.now(),
        footer: parseFooter(text),
        words: lastScreenWords(text),
        prs: [...new Set([...text.matchAll(/#(\d{3,5})/g)].map(m => Number(m[1])))],
        explain,
      });
    }
    // Panes that no longer exist are dropped from memory.
    const live = new Set(panes);
    for (const k of paneCache.keys()) if (!live.has(k)) paneCache.delete(k);
  } finally { paneRefreshing = false; }
}

// -------------------------------------- last words from the session log

const sessionPathCache = new Map();
const journalCache = new Map();

async function findSessionFile(sid, cwd) {
  const hit = sessionPathCache.get(sid);
  if (hit && (hit.file || Date.now() - hit.at < 300000)) return hit;
  const escaped = String(cwd).replace(/[:\\/.]/g, '-');
  const roots = [path.join(HOME, '.claude')];
  try {
    for (const acc of await readdir(path.join(HOME, '.claude-accounts'))) {
      roots.push(path.join(HOME, '.claude-accounts', acc));
    }
  } catch { /* no per-account folders — a single home then */ }
  let file = null, dir = null;
  for (const root of roots) {
    const folder = path.join(root, 'projects', escaped);
    const candidate = path.join(folder, sid + '.jsonl');
    if (await stat(candidate).then(() => true, () => false)) { file = candidate; dir = folder; break; }
  }
  const found = { file, dir, at: Date.now() };
  sessionPathCache.set(sid, found);
  return found;
}

// Logs of neighbouring sessions of the same window, newest first. Needed when
// the current session has not spoken out loud yet (only used tools) — then the
// window's last words live in its predecessor.
async function siblingJournals(dir, exclude) {
  if (!dir) return [];
  const out = [];
  try {
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      if (full === exclude) continue;
      const s = await stat(full).catch(() => null);
      if (s) out.push({ file: full, mtime: s.mtimeMs });
    }
  } catch { /* the folder vanished */ }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 3).map(x => x.file);
}

// The tail of a log. A window can spend an hour on tools, and the last quarter
// megabyte may hold no spoken line at all — so the tail is read in growing
// chunks until words are found (or the file ends).
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

async function readTail(file, size, len) {
  const take = Math.min(len, size);
  const fh = await open(file, 'r');
  const buf = Buffer.alloc(take);
  try { await fh.read(buf, 0, take, size - take); } finally { await fh.close(); }
  return buf.toString('utf8').split('\n');
}

function findLastSpoken(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (o.type !== 'assistant' || o.isSidechain) continue;
      const t = (o.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (t && t.length >= 8) return t.replace(/\s+/g, ' ').slice(0, 400);
    } catch { /* a truncated log line */ }
  }
  return null;
}

async function lastAssistantText(file) {
  const s = await stat(file).catch(() => null);
  if (!s) return null;
  const cached = journalCache.get(file);
  if (cached && cached.mtime === s.mtimeMs) return cached.text;
  let text = null;
  try {
    for (const len of TAIL_STEPS) {
      text = findLastSpoken(await readTail(file, s.size, len));
      if (text || len >= s.size) break;
    }
  } catch { /* unreadable log — the screen words will do */ }
  journalCache.set(file, { mtime: s.mtimeMs, text });
  return text;
}

// ------------------------------------------------------- time in a state

let seenCache = null;
async function loadSeen() {
  if (!seenCache) seenCache = await readJsonSoft(SEEN_FILE, {});
  return seenCache;
}

function updateSeen(seen, panes, nowIso) {
  const nowMs = Date.parse(nowIso);
  for (const p of panes) {
    const key = `${p.pane_id}|${p.agent_status}`;
    if (!seen[key]) seen[key] = { since: nowIso };
    seen[key].last = nowIso;
    for (const k of Object.keys(seen)) {
      if (k.startsWith(p.pane_id + '|') && k !== key) delete seen[k];
    }
  }
  for (const k of Object.keys(seen)) {
    if (nowMs - Date.parse(seen[k].last ?? nowIso) > SEEN_KEEP_MS) delete seen[k];
  }
}

// ------------------------------------------- hand edits (the × and the +)
//
// Everything the owner did by hand lives in one file, state/autopase-cards.json:
//   { "hidden": [ { "tab": "w5:t3", "cwd": "…", "name": "…", "at": "…" } ],
//     "manual": [ { "id": "m…", "title": "…", "text": "…", "column": "idle", "at": "…" } ] }
// hidden — automatic cards hidden with the ×; they can always be restored from
// the settings screen. manual — cards added with the +; those are deleted for good.

let cardsState = null;

// A card is not a tab: one tab with two panes in different working directories
// gives two cards. So a card is hidden by the same pair it is built from:
// tab + working directory.
function cardKey(tab, cwd) {
  return `${tab}|${normPath(cwd)}`;
}

function normCardsState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const hidden = [];
  const seenKeys = new Set();
  for (const h of Array.isArray(src.hidden) ? src.hidden : []) {
    const tab = typeof h === 'string' ? h : String(h?.tab ?? '');
    if (!tab) continue;
    // Older records (without a working directory) are kept: they hide the whole
    // tab, as they used to, until the owner restores the window.
    const cwd = typeof h === 'string' ? '' : String(h?.cwd ?? '');
    const key = cardKey(tab, cwd);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    hidden.push({ tab, cwd, name: String(h?.name ?? '').slice(0, 200) || tab, at: h?.at ?? null });
  }
  const manual = [];
  for (const m of Array.isArray(src.manual) ? src.manual : []) {
    const id = String(m?.id ?? '');
    if (!id) continue;
    manual.push({
      id,
      title: String(m?.title ?? '').slice(0, 200),
      text: String(m?.text ?? '').slice(0, 2000),
      column: COLUMNS.some(c => c.key === m?.column) ? m.column : 'idle',
      at: m?.at ?? null,
    });
  }
  return { hidden, manual };
}

// The file is read once per board lifetime. That read must stay single even
// under concurrent requests: otherwise each of them starts its OWN parse and
// edits made in the others are lost (12 simultaneous "+" once produced one card).
let cardsLoading = null;
async function loadCards() {
  if (cardsState) return cardsState;
  if (!cardsLoading) {
    cardsLoading = (async () => {
      const state = normCardsState(await readJsonSoft(CARDS_FILE, null));
      cardsState = state;
      cardsLoading = null;
      return state;
    })();
  }
  return cardsLoading;
}

async function saveCards() {
  await writeJsonAtomic(CARDS_FILE, cardsState);
}

// A hand edit: change memory first, then write to disk. If the write failed,
// roll memory back — otherwise the board would show the card as saved and it
// would be gone after a restart.
async function commitCards(mutate) {
  const hand = await loadCards();
  const backup = { hidden: hand.hidden.slice(), manual: hand.manual.slice() };
  const result = mutate(hand);
  if (result === false) return hand;   // nothing changed — nothing to write
  try {
    await saveCards();
  } catch (e) {
    hand.hidden = backup.hidden;
    hand.manual = backup.manual;
    throw new Error(`could not save the edit to disk: ${String(e?.message || e)}`);
  }
  return hand;
}

function newManualId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------- checkout branch

const branchCache = new Map();
async function checkoutBranch(dir) {
  const hit = branchCache.get(dir);
  if (hit && Date.now() - hit.at < 20000) return hit.value;
  let value = { branch: null, detached: null };
  try {
    const dotGit = path.join(dir, '.git');
    const st = await stat(dotGit);
    let gitDir = dotGit;
    if (st.isFile()) {
      const m = (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m);
      gitDir = m ? m[1] : null;
    }
    if (gitDir) {
      const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
      const r = head.match(/refs\/heads\/(.+?)\s*$/);
      // HEAD may be detached from any branch — then it holds a plain commit id.
      // Worth seeing: you cannot open a PR from such a checkout.
      if (r) value = { branch: r[1], detached: null };
      else if (/^[0-9a-f]{7,40}$/i.test(head)) value = { branch: null, detached: head.slice(0, 7) };
    }
  } catch { /* not a repository — no branch */ }
  branchCache.set(dir, { at: Date.now(), value });
  return value;
}

// ------------------------------------------------------------ collecting

// Comparing names ignoring case and separators: "GLD-garage-lv-directories" and
// "Garage LV directories" are about the same thing.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '');
}

function matchesStream(stream, branch) {
  if (!stream || !branch) return false;
  return (stream.branch_prefix ?? []).some(p => branch.startsWith(p));
}

// The lanes of this window: first by the branch prefix of its writer, then by a
// direct match with the checkout branch, then by the task name.
function lanesFor(allLanes, stream, branch) {
  return allLanes.filter(l => {
    if (!l.busy) return false;
    if (matchesStream(stream, l.branch)) return true;
    if (branch && l.branch === branch) return true;
    if (l.task && stream) {
      return (stream.lanes ?? []).some(cfgLane => {
        try { return new RegExp(cfgLane.task_match, 'i').test(l.task); } catch { return false; }
      });
    }
    return false;
  });
}

// ------------------------------------------------- probe snapshot (source=probe)

const SNAPSHOT_FILE = path.join(STATE_DIR, 'probe-snapshot.json');
const SNAPSHOT_MAX = 2 * 1024 * 1024;

class PayloadTooLarge extends Error {}

// Last snapshot the probe posted: { receivedAt, snapshot }. Loaded from disk
// on the first read so a restart still has windows to draw.
let probeSnapshot = null;
let probeSnapshotLoaded = false;

async function loadProbeSnapshot() {
  if (probeSnapshotLoaded) return probeSnapshot;
  const raw = await readJsonSoft(SNAPSHOT_FILE, null);
  probeSnapshotLoaded = true;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.snapshot
      && typeof raw.snapshot === 'object' && !Array.isArray(raw.snapshot)) {
    probeSnapshot = {
      receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : null,
      // A file written by an older build (or edited by hand) can still hold
      // rubbish in its lists, so it is cleaned on the way in as well.
      snapshot: normalizeSnapshot(raw.snapshot),
    };
  } else {
    probeSnapshot = null;
  }
  return probeSnapshot;
}

async function saveProbeSnapshot(body) {
  const stored = { receivedAt: new Date().toISOString(), snapshot: normalizeSnapshot(body) };
  const prev = probeSnapshot;
  probeSnapshot = stored;
  probeSnapshotLoaded = true;
  try {
    await writeJsonAtomic(SNAPSHOT_FILE, stored);
  } catch (e) {
    probeSnapshot = prev;
    throw new Error(`could not save the probe snapshot to disk: ${String(e?.message || e)}`);
  }
  return stored;
}

function asList(v) {
  return Array.isArray(v) ? v : [];
}

// The probe payload arrives from another machine, so any of its lists can hold
// a null, a number or a string where the board expects an object. Everything
// downstream reads them as objects (`t.tab_id`, `w.workspace_id`), and one null
// used to be enough to make /data and /api/board answer 500 for good, because
// the snapshot was kept on disk and read back after a restart. The rubbish is
// dropped once, here, on the way in and on the way out.
function objectList(v) {
  return asList(v).filter(x => x && typeof x === 'object' && !Array.isArray(x));
}

function normalizeSnapshot(snap) {
  const src = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : {};
  return {
    ...src,
    windows: objectList(src.windows),
    tabs: objectList(src.tabs),
    panes: objectList(src.panes),
    agents: objectList(src.agents),
  };
}

// Titles and the agent kind live on the agent list in the probe payload, not
// always on the pane. Copy them across so collect() can keep reading panes
// the way it does for a local herdr snapshot.
function attachAgentFields(panes, agents) {
  const byPane = new Map();
  for (const a of agents) {
    if (a && typeof a === 'object' && a.pane_id) byPane.set(a.pane_id, a);
  }
  return panes.filter(p => p && typeof p === 'object').map((p) => {
    const a = byPane.get(p.pane_id);
    if (!a) return p;
    return {
      ...p,
      agent: p.agent ?? a.agent ?? null,
      agent_status: p.agent_status ?? a.agent_status,
      cwd: p.cwd || a.cwd,
      terminal_title: p.terminal_title ?? a.terminal_title,
      terminal_title_stripped: p.terminal_title_stripped ?? a.terminal_title_stripped,
    };
  });
}

function probeStaleMessage() {
  if (config.source !== 'probe') return null;
  const receivedAt = probeSnapshot?.receivedAt ?? null;
  const receivedMs = receivedAt ? Date.parse(receivedAt) : NaN;
  const limitMs = (config.probeStaleSec ?? DEFAULTS.probeStaleSec) * 1000;
  const stale = !Number.isFinite(receivedMs) || (Date.now() - receivedMs) > limitMs;
  if (!stale) return null;
  const since = Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : 'never';
  return `probe stale since ${since}`;
}

function probeSourceRow(stale) {
  if (!stale) return null;
  const receivedMs = probeSnapshot?.receivedAt ? Date.parse(probeSnapshot.receivedAt) : NaN;
  return {
    name: 'probe',
    ok: false,
    error: stale,
    ageMs: Number.isFinite(receivedMs) ? Date.now() - receivedMs : null,
    tookMs: null,
  };
}

async function herdrBoardState() {
  if (config.source === 'probe') {
    const stored = await loadProbeSnapshot();
    if (!stored?.snapshot) {
      return { snap: { workspaces: [], tabs: [], panes: [] }, wsList: [], agents: [] };
    }
    const snap = normalizeSnapshot(stored.snapshot);
    const windows = snap.windows;
    const agents = snap.agents;
    const focused = snap.focused && typeof snap.focused === 'object' ? snap.focused : {};
    return {
      snap: {
        workspaces: windows,
        tabs: snap.tabs,
        panes: attachAgentFields(snap.panes, agents),
        focused_tab_id: focused.tabId ?? null,
        focused_workspace_id: focused.workspaceId ?? null,
        focused_pane_id: focused.paneId ?? null,
      },
      wsList: windows,
      agents,
    };
  }
  const [snapRes, wsListRes, agentListRes] = await Promise.all([
    herdr(['api', 'snapshot']),
    herdr(['workspace', 'list']).catch(() => null),
    herdr(['agent', 'list']).catch(() => null),
  ]);
  return {
    snap: snapRes?.result?.snapshot ?? {},
    wsList: wsListRes?.result?.workspaces ?? [],
    agents: agentListRes?.result?.agents ?? [],
  };
}

async function collect() {
  cfgSource.tick();
  const sel = selection();

  const [board, seen, hand] = await Promise.all([
    herdrBoardState(),
    loadSeen(),
    loadCards(),
  ]);

  // Every list is filtered again here: collect() also runs on a local herdr
  // snapshot, and a single non-object in any of them must not be able to take
  // the whole board down with a 500.
  const snap = board.snap;
  const wsById = new Map(objectList(snap.workspaces).map(w => [w.workspace_id, w]));
  const tabById = new Map(objectList(snap.tabs).map(t => [t.tab_id, t]));
  const allPanes = objectList(snap.panes);
  const agents = objectList(board.agents);
  const agentByPane = new Map(agents.map(a => [a.pane_id, a]));

  const wsList = objectList(board.wsList);
  const wsMeta = new Map(wsList.map(w => [w.workspace_id, w]));

  const projects = projectList(allPanes, wsById);
  const now = new Date().toISOString();
  const stale = probeStaleMessage();

  // No project chosen yet: the page shows the onboarding screen instead of the
  // board, and nothing slow (ssh, gh) is asked for.
  if (sel.mode === 'none') {
    const sources = [{ name: 'project', ok: false, error: 'no project chosen yet', ageMs: 0, tookMs: null }];
    const probeRow = probeSourceRow(stale);
    if (probeRow) sources.push(probeRow);
    return {
      generatedAt: now,
      needsProject: true,
      project: null,
      projects,
      columns: COLUMNS,
      cards: [],
      hosts: [],
      laneOwners: {},
      hidden: [],
      handHidden: hand.hidden,
      windowsTotal: (snap.workspaces ?? []).length,
      focusedTab: snap.focused_tab_id ?? null,
      ctoPane: null,
      repo: config.repo || null,
      prsOpen: 0,
      umbrellas: [],
      sources,
      probeStale: stale,
      hooksNotice: await hooksNotice(),
      slotsAlarm: await slotsAlarmMessage(),
    };
  }

  // Background sources: just nudge them, do not wait for an answer.
  const first = [];
  for (const s of [streamsSource, programsSource, lanesSource, prSource, mergedPrSource, unitIssuesSource, umbrellaSource]) {
    const p = s.tick();
    if (s.at === 0 && p) first.push(p);
  }
  // The very first pass waits for the slow sources once, otherwise the board
  // would open empty.
  if (first.length) await Promise.allSettled(first);

  const hide = (config.hide ?? []).map(s => String(s).toLowerCase());

  const keep = (p) => {
    const cwd = normPath(p.cwd);
    if (!cwd) return false;
    if (sel.mode === 'all') return true;
    if (sel.mode === 'match') return cwd.includes(sel.match);
    return projectOf(p.cwd, wsById.get(p.workspace_id)).toLowerCase() === sel.project.toLowerCase();
  };

  // One tab — one card: a pane with an agent wins, then the lower pane id.
  const rank = (p) => `${p.agent ? 0 : 1}|${p.pane_id}`;
  const best = new Map();
  for (const p of allPanes) {
    if (!keep(p)) continue;
    const key = `${p.tab_id}|${normPath(p.cwd)}`;
    const cur = best.get(key);
    if (!cur || rank(p) < rank(cur)) best.set(key, p);
  }
  let panes = [...best.values()];
  // Windows the owner asked never to show (the `hide` setting).
  const hidden = [];
  panes = panes.filter(p => {
    const folder = path.basename(normPath(p.cwd));
    const wsLabel = String(wsById.get(p.workspace_id)?.label ?? '').toLowerCase();
    if (hide.includes(folder) || hide.includes(wsLabel)) { hidden.push(folder || wsLabel); return false; }
    return true;
  });
  // Windows hidden with the ×. Exactly the card the × was clicked on is hidden:
  // the pair "tab + working directory", the same key the card is built from.
  // They can be restored from the settings screen.
  const nameOf = (p) => {
    const ws = wsById.get(p.workspace_id);
    const meta = wsMeta.get(p.workspace_id);
    const tab = tabById.get(p.tab_id);
    const tabCount = ws?.tab_count ?? 1;
    const tabLabel = tab?.label && !/^\d+$/.test(tab.label) ? tab.label : null;
    return (tabCount > 1 && tabLabel) || meta?.label || ws?.label || path.basename(normPath(p.cwd));
  };
  const hiddenKeys = new Set(hand.hidden.filter(h => h.cwd).map(h => cardKey(h.tab, h.cwd)));
  // Records of the older shape (without a working directory) hide the whole tab.
  const hiddenTabs = new Set(hand.hidden.filter(h => !h.cwd).map(h => h.tab));
  const hiddenPanes = [];
  if (hiddenKeys.size || hiddenTabs.size) {
    panes = panes.filter(p => {
      if (hiddenKeys.has(cardKey(p.tab_id, p.cwd)) || hiddenTabs.has(p.tab_id)) {
        hiddenPanes.push(p);
        return false;
      }
      return true;
    });
  }
  // A hidden record does not live forever: when the tab is gone from the herdr
  // snapshot, the record is dropped — otherwise a new tab reusing the id would
  // silently fail to appear. Live records also get their name refreshed, so the
  // restore list never shows a stale title.
  {
    const alive = new Map(hiddenPanes.map(p => [cardKey(p.tab_id, p.cwd), p]));
    let changed = false;
    hand.hidden = hand.hidden.filter(h => {
      const pane = alive.get(cardKey(h.tab, h.cwd));
      if (pane) {
        const nm = nameOf(pane);
        if (nm && nm !== h.name) { h.name = nm; changed = true; }
        return true;
      }
      if (tabById.has(h.tab)) return true;   // tab alive, pane not up yet
      changed = true;
      return false;
    });
    if (changed) saveCards().catch(() => {});
  }
  panes.sort((a, b) => a.pane_id.localeCompare(b.pane_id));

  updateSeen(seen, panes, now);
  writeJsonAtomic(SEEN_FILE, seen).catch(() => {});
  // Screens and explain come from herdr on this machine. In probe mode the
  // board is not next to herdr, so those calls would hang; the snapshot is
  // the window data.
  if (config.source !== 'probe') refreshPanes(panes.map(p => p.pane_id));

  const streams = streamsSource.value;
  const programs = programsSource.value ?? new Map();
  const prs = prSource.value ?? [];
  const mergedPrs = mergedPrSource.value ?? [];
  const unitIssues = unitIssuesSource.value ?? new Map();
  const umbrellas = umbrellaSource.value ?? new Map();
  const laneHosts = lanesSource.value ?? [];
  const allLanes = laneHosts.flatMap(h => (h.lanes ?? []).map(l => ({ ...l, hostOk: h.ok })));

  const cards = [];
  for (const p of panes) {
    const ws = wsById.get(p.workspace_id);
    const meta = wsMeta.get(p.workspace_id);
    const cwd = String(p.cwd ?? '');
    const folder = path.basename(normPath(cwd));
    const agent = agentByPane.get(p.pane_id) ?? null;
    const status = KNOWN_STATUSES.has(p.agent_status) ? p.agent_status : 'unknown';
    const tabCount = ws?.tab_count ?? 1;
    const screen = paneCache.get(p.pane_id) ?? null;
    const { branch, detached } = await checkoutBranch(cwd);
    const stream = streams?.byPane.get(p.pane_id) ?? streams?.byId.get(folder) ?? null;

    const lanes = lanesFor(allLanes, stream, branch);
    // Lanes the stream file assigns to this window that are free right now.
    const laneSlots = [...new Set((stream?.lanes ?? []).map(l => `${l.host}: ${l.task_match}`))];

    // The window's last words: the session log is more precise than the screen,
    // the screen is the fallback.
    let recap = null;
    let recapFrom = null;
    const sid = agent?.agent_session?.value;
    if (sid && cwd) {
      const { file, dir } = await findSessionFile(sid, cwd);
      if (file) {
        recap = await lastAssistantText(file);
        if (recap) recapFrom = 'session log';
      }
      if (!recap) {
        for (const other of await siblingJournals(dir, file)) {
          recap = await lastAssistantText(other);
          if (recap) { recapFrom = 'previous session log'; break; }
        }
      }
    }
    if (!recap && screen?.words) { recap = screen.words; recapFrom = 'window screen'; }

    // Open PRs of this window. Numbers the window named itself (on screen or in
    // its last words) are the most honest binding where the PR branch does not
    // match the window branch.
    const mentioned = new Set(screen?.prs ?? []);
    for (const m of String(recap ?? '').matchAll(/#(\d{3,5})/g)) mentioned.add(Number(m[1]));
    const strongVia = (pr) => {
      if (branch && pr.branch === branch) return 'window branch';
      if (matchesStream(stream, pr.branch)) return 'branch prefix';
      if (lanes.some(l => l.branch === pr.branch)) return 'lane branch';
      return null;
    };
    const cardPrs = [];
    for (const pr of prs) {
      const via = strongVia(pr);
      if (via) cardPrs.push({ ...pr, via });
    }
    cardPrs.sort((a, b) => b.number - a.number);
    // Merged PRs of this window: the same strong bindings, plus the numbers the
    // window named itself (weak — good enough as evidence of delivered work,
    // never used alone to move a card forward).
    const cardMerged = [];
    for (const pr of mergedPrs) {
      const via = strongVia(pr);
      if (via) cardMerged.push({ number: pr.number, mergedAt: pr.mergedAt, via, strong: true });
      else if (mentioned.has(pr.number)) {
        cardMerged.push({ number: pr.number, mergedAt: pr.mergedAt, via: 'named by the window', strong: false });
      }
    }
    cardMerged.sort((a, b) => b.number - a.number);

    // Umbrella issue: from the PROGRAM-STATE.md of a program with the same name,
    // else from the stream's state file, else from a number the window named.
    let program = null;
    for (const [key, val] of programs) {
      if (key === folder || key.endsWith(folder) || folder.endsWith(key)) { program = val; break; }
    }
    if (!program && stream?.state_file) {
      const dirName = path.basename(path.dirname(stream.state_file)).toLowerCase();
      program = programs.get(dirName) ?? null;
    }
    let umbrellaNo = program?.umbrella ?? null;
    // An umbrella often names the stream right in its title, and that is more
    // reliable than a random number that flashed on a screen.
    if (!umbrellaNo) {
      // Whole name first, then the tail of it: one umbrella can drive two
      // branches at once and the whole name will not fit in its title.
      const parts = folder.split(/[-_.]/).filter(Boolean);
      const needles = [slug(folder), slug(parts.slice(-2).join(''))].filter(n => n.length >= 6);
      for (const needle of needles) {
        for (const u of umbrellas.values()) {
          if (slug(u.title ?? '').includes(needle)) { umbrellaNo = u.number; break; }
        }
        if (umbrellaNo) break;
      }
    }
    if (!umbrellaNo) {
      const found = [...mentioned].find(n => umbrellas.has(n) && !prs.some(pr => pr.number === n));
      if (found) umbrellaNo = found;
    }
    const umbrella = umbrellaNo ? (umbrellas.get(umbrellaNo) ?? { number: umbrellaNo }) : null;

    // Does this window need a human?
    const words = config.askWords ?? DEFAULTS.askWords;
    const askReasons = [];
    if (status === 'blocked') askReasons.push('window is blocked — waiting for an answer');
    const hay = `${recap ?? ''} ${screen?.words ?? ''}`.toUpperCase();
    for (const w of words) if (hay.includes(w.toUpperCase())) askReasons.push(`last words contain "${w}"`);
    if (umbrella?.ask && !umbrella.ask.answered) {
      askReasons.push(`umbrella #${umbrella.number}: "${umbrella.ask.word}" with no answer`);
    }

    const laneAlive = lanes.length > 0;
    let column;
    if (askReasons.length) column = 'ask';
    else if (!agent) column = 'off';
    else if (status === 'working') column = 'running';
    else if (laneAlive) column = 'waiting';
    else column = 'idle';

    cards.push({
      pane: p.pane_id,
      tab: p.tab_id,
      ws: p.workspace_id,
      number: ws?.number ?? null,
      place: `${p.workspace_id}:${p.pane_id.split(':')[1] ?? ''}`,
      // In a window with several tabs the tab gives the name; unnamed tabs
      // ("1", "2") do not count as a name.
      name: nameOf(p),
      window: meta?.label || ws?.label || null,
      folder,
      cwd,
      isWorktree: Boolean(meta?.worktree?.is_linked_worktree),
      repoName: meta?.worktree?.repo_name ?? null,
      branch,
      detached,
      status,
      focused: Boolean(p.focused),
      since: seen[`${p.pane_id}|${status}`]?.since ?? null,
      title: p.terminal_title_stripped || p.terminal_title || '',
      agent: p.agent ?? agent?.agent ?? null,
      explain: screen?.explain ?? null,
      footer: screen?.footer ?? null,
      screenAt: screen?.at ?? null,
      lanes,
      laneSlots,
      streamId: stream?.id ?? null,
      prs: cardPrs,
      umbrella,
      program: program ? { name: program.program, file: program.file, updated: program.updated } : null,
      recap,
      recapFrom,
      mentioned: [...mentioned],
      askReasons,
      column,
      tabCount,
      _shadow: {
        merged: cardMerged,
        openUnitIssues: umbrellaNo ? (unitIssues.get(umbrellaNo) ?? []).filter(i => i.state !== 'CLOSED') : [],
        unitsPromised: stream?.units === 'issues',
        hasPrefixes: (stream?.branch_prefix ?? []).length > 0,
      },
    });
  }

  // Second pass over PRs: whoever matched by branch owns the PR, and it does not
  // pop up on other cards. The remaining open PRs go to the windows that named
  // them themselves — otherwise one window listing every number would take the
  // whole board.
  const ownedByBranch = new Set(cards.flatMap(c => c.prs.map(pr => pr.number)));
  for (const c of cards) {
    for (const pr of prs) {
      if (ownedByBranch.has(pr.number) || !c.mentioned.includes(pr.number)) continue;
      c.prs.push({ ...pr, via: 'named by the window' });
    }
    c.prs.sort((a, b) => b.number - a.number);
    delete c.mentioned;
  }

  // Facts for the pipeline's shadow verdicts (step 1: the board only says what
  // it WOULD do — no transition is written anywhere). A source that is dead or
  // older than ten minutes makes every verdict "facts incomplete": unknown is
  // never read as empty.
  const FRESH_MS = 10 * 60 * 1000;
  const staleSources = [streamsSource, lanesSource, prSource, mergedPrSource, unitIssuesSource, umbrellaSource]
    .filter(s => !s.ok || !s.at || (Date.now() - s.at) > FRESH_MS)
    .map(s => s.name);
  const shadowFacts = new Map();
  for (const c of cards) {
    if (c.manual) continue;
    shadowFacts.set(c.name, {
      openPrs: c.prs.map(pr => ({
        number: pr.number,
        ci: pr.ci?.color ?? 'none',
        strong: pr.via !== 'named by the window',
        createdAt: pr.createdAt ?? null,
      })),
      merged: c._shadow.merged,
      openUnitIssues: c._shadow.openUnitIssues.map(i => ({ number: i.number, createdAt: i.createdAt })),
      unitsPromised: c._shadow.unitsPromised,
      hasPrefixes: c._shadow.hasPrefixes,
      umbrella: c.umbrella?.number ?? null,
      laneBusy: c.lanes.length > 0,
      working: c.status === 'working',
    });
    delete c._shadow;
  }
  setShadowFacts({ facts: shadowFacts, staleSources, at: now });

  // The sprint sweep sees the sources this sweep just refreshed.
  sprintSource.at = 0;
  sprintSource.tick();

  // Cards added by hand. They are bound to no window, no lane and no PR — only a
  // title, a text and a column — so they are appended last, after PRs have been
  // handed out to windows.
  for (const m of hand.manual) {
    cards.push({
      manual: true,
      id: m.id,
      pane: null,
      tab: null,
      ws: null,
      place: 'by hand',
      name: m.title,
      window: null,
      folder: null,
      cwd: '',
      branch: null,
      detached: null,
      status: 'unknown',
      focused: false,
      since: m.at,
      title: '',
      agent: null,
      explain: null,
      footer: null,
      lanes: [],
      laneSlots: [],
      prs: [],
      umbrella: null,
      program: null,
      recap: m.text || null,
      recapFrom: m.text ? 'typed by hand' : null,
      askReasons: [],
      column: m.column,
      tabCount: 1,
    });
  }

  // Owners of busy lanes. Counted over ALL windows, hidden ones included:
  // hiding is a board matter, a lane does not become unclaimed because of it.
  const laneOwners = {};
  for (const c of cards) for (const l of c.lanes) laneOwners[`${l.host}|${l.lane}`] = c.name;
  for (const p of hiddenPanes) {
    const cwd = String(p.cwd ?? '');
    const folder = path.basename(normPath(cwd));
    const { branch } = await checkoutBranch(cwd);
    const stream = streams?.byPane.get(p.pane_id) ?? streams?.byId.get(folder) ?? null;
    for (const l of lanesFor(allLanes, stream, branch)) {
      const key = `${l.host}|${l.lane}`;
      if (!laneOwners[key]) laneOwners[key] = `${nameOf(p)} (hidden from the board)`;
    }
  }

  // Lanes that are busy but did not bind to any window.
  for (const l of allLanes) {
    if (l.busy && !laneOwners[`${l.host}|${l.lane}`]) l.orphan = true;
  }

  const sources = [cfgSource, streamsSource, programsSource, lanesSource, prSource, mergedPrSource,
    unitIssuesSource, umbrellaSource]
    .map(s => ({ name: s.name, ok: s.ok, error: s.error, ageMs: s.at ? Date.now() - s.at : null, tookMs: s.tookMs }));
  const probeRow = probeSourceRow(stale);
  if (probeRow) sources.push(probeRow);

  return {
    generatedAt: now,
    needsProject: false,
    project: sel.label,
    projects,
    columns: COLUMNS,
    cards,
    hosts: laneHosts,
    // Lane owners separately from cards: a hidden window has no card but does
    // not abandon its lane.
    laneOwners,
    hidden: [...new Set(hidden)],
    // Hidden with the × — separate from the `hide` setting: this can be undone.
    handHidden: hand.hidden,
    windowsTotal: (snap.workspaces ?? []).length,
    focusedTab: snap.focused_tab_id ?? null,
    ctoPane: streams?.ctoPane ?? null,
    // `|| null` and not `??`: an unset repo is an empty string in the config, and
    // the agent answer must show one single "no value" (`-`), not a blank line.
    repo: (streams?.repo ?? config.repo) || null,
    prsOpen: prs.length,
    umbrellas: [...umbrellas.values()],
    // Records the stream-watch file lost on the way in (skipped or trimmed by
    // normStreamWatch). The source itself is ok — only these records are not.
    streamProblems: streams?.problems ?? [],
    sources,
    probeStale: stale,
    hooksNotice: await hooksNotice(),
    slotsAlarm: await slotsAlarmMessage(),
  };
}

// --------------------------------------------- the agent view (/api/board)
//
// An endpoint for a watchdog agent: the same board without a picture and without
// a browser. Its shape is pinned separately from /data: the page lives on /data
// and its fields change together with the layout, while the agent reads
// /api/board, so editing the page does not break it.
//
// What it returns: a summary line with counters, a table of cards in six fields,
// and separate sections for long texts (the window's last words, the question
// from an umbrella) — TOON-flavoured: the same data, noticeably shorter than JSON.

// How many characters of a long text are shown without ?full=1 lives in
// bin/serve.mjs (AGENT_TEXT_LIMIT) together with the clipping itself: the
// pipeline endpoints clip by the same rule.

// The window's last words are the longest part of the answer and the most
// reference-like: on a sweep the agent only needs a hint of what the window was
// talking about. So the list keeps a short line and the whole text is fetched on
// demand — /api/board/card/<name> for one window, ?full=1 for the whole board.
const AGENT_WORDS_LIMIT = 80;

const CI_WORD = { green: 'green', red: 'red', run: 'running', none: 'no-checks' };

// A card's PRs in one cell: the newest number with its CI colour, the rest as a count.
function prCell(prs) {
  if (!prs?.length) return '-';
  const head = `#${prs[0].number} ${CI_WORD[prs[0].ci?.color] ?? 'CI-unknown'}`;
  return prs.length > 1 ? `${head} +${prs.length - 1}` : head;
}

function laneCell(lanes) {
  if (!lanes?.length) return '-';
  return lanes.map(l => `${l.host}/${l.lane}`).join(' ');
}

// From the big /data snapshot to a small pinned view. Internal fields (explain,
// footer, mentioned, place, …) deliberately do not leak in here.
const nameOfCard = (c) => String(c.name || c.folder || '(unnamed)');

// Is this card waiting for a human? A window has parsed reasons; a card typed by
// hand never has any (askReasons is always empty there) — for it the column
// speaks: the owner put it into "ask" precisely because it waits for an answer.
// Without this branch a hand-typed card would be invisible to the agent.
function askWhy(c) {
  if (c.askReasons?.length) return c.askReasons.join('; ');
  if (c.manual && c.column === 'ask') return 'card was put by hand into the "needs you" column';
  return '';
}

function buildAgentBoard(payload, full) {
  const cards = payload.cards ?? [];
  const auto = cards.filter(c => !c.manual);
  const manual = cards.filter(c => c.manual);
  const lanesBusy = (payload.hosts ?? [])
    .reduce((n, h) => n + (h.lanes ?? []).filter(l => l.busy).length, 0);

  const rows = cards.map(c => ({
    column: c.column,
    name: nameOfCard(c),
    state: c.manual ? 'manual' : (c.status ?? 'unknown'),
    ask: askWhy(c) ? 'yes' : 'no',
    pr: prCell(c.prs),
    lanes: laneCell(c.lanes),
  }));

  // Why a window waits — separately from the table: there can be several reasons
  // and they are long, such things do not go into a cell.
  //
  // The question from an umbrella issue is the same for every window of one
  // program, and printing it once per window is paying twice for identical text.
  // So the row carries a reference like "#1299" and the text sits once in the
  // questions section.
  const asks = [];
  const questions = [];
  const questionSeen = new Map();
  for (const c of cards) {
    const why = askWhy(c);
    if (!why) continue;
    const ask = c.umbrella?.ask && !c.umbrella.ask.answered ? c.umbrella.ask : null;
    let ref = '-';
    if (ask?.text) {
      ref = `#${c.umbrella.number}`;
      if (!questionSeen.has(ref)) {
        questionSeen.set(ref, true);
        questions.push({ umbrella: ref, text: clipText(ask.text, full) });
      }
    }
    asks.push({ name: nameOfCard(c), why: clipText(why, full), question: ref });
  }

  const words = cards
    .filter(c => c.recap)
    .map(c => ({
      name: nameOfCard(c),
      from: c.recapFrom ?? '-',
      text: clipText(c.recap, full, AGENT_WORDS_LIMIT),
    }));

  // A source may have failed to answer (ssh, gh). Then an empty "no lanes" cell
  // means not knowing, not a fact; the agent must see the difference.
  const problems = [
    ...(payload.sources ?? []).filter(s => !s.ok)
      .map(s => ({ source: s.name, error: clipText(s.error, full) || 'no answer' })),
    ...(payload.hosts ?? []).filter(h => !h.ok)
      .map(h => ({ source: `lane host ${h.host}`, error: clipText(h.error, full) || 'no answer' })),
    // The stream-watch file was read, but these records were skipped or trimmed.
    ...(payload.streamProblems ?? [])
      .map(text => ({ source: 'stream-watch', error: clipText(text, full) })),
  ];
  if (payload.slotsAlarm) {
    problems.push({ source: 'ci-slots', error: payload.slotsAlarm });
  }

  return {
    board: `http://127.0.0.1:${PORT}`,
    generated: payload.generatedAt,
    repo: payload.repo || null,
    full: Boolean(full),
    summary: {
      windows: auto.length,
      waitingWord: asks.length,
      lanesBusy,
      prsOpen: payload.prsOpen ?? 0,
      manual: manual.length,
      hidden: (payload.handHidden ?? []).length,
    },
    cards: rows,
    asks,
    questions,
    words,
    problems,
  };
}

// One card in full: last words without clipping, the reason it waits and the
// question from its umbrella. It exists so that a board sweep need not carry
// long texts at all and only the interesting window is read out in full.
function buildAgentCard(payload, wanted) {
  const cards = payload.cards ?? [];
  const needle = String(wanted ?? '').trim().toLowerCase();
  const card = cards.find(c => nameOfCard(c).toLowerCase() === needle);
  if (!card) return { found: false, names: cards.map(nameOfCard) };
  const ask = card.umbrella?.ask && !card.umbrella.ask.answered ? card.umbrella.ask : null;
  return {
    found: true,
    card: {
      name: nameOfCard(card),
      column: card.column,
      state: card.manual ? 'manual' : (card.status ?? 'unknown'),
      ask: askWhy(card) ? 'yes' : 'no',
      why: askWhy(card) || '-',
      umbrella: card.umbrella?.number ? `#${card.umbrella.number}` : '-',
      question: ask?.text ? String(ask.text).replace(/\s+/g, ' ').trim() : '-',
      pr: prCell(card.prs),
      lanes: laneCell(card.lanes),
      wordsFrom: card.recapFrom ?? '-',
      words: card.recap ? String(card.recap).replace(/\s+/g, ' ').trim() : '-',
    },
  };
}

// ---- TOON-flavoured output (the cell and table writers live in bin/serve.mjs)

function renderToonBoard(v) {
  const s = v.summary;
  const out = [
    `board: ${v.board}`,
    `generated: ${v.generated}`,
    `repo: ${v.repo ?? '-'}`,
    `summary: windows ${s.windows}, waiting for you ${s.waitingWord}, lanes building ${s.lanesBusy},`
      + ` open PRs ${s.prsOpen}, manual ${s.manual}, hidden ${s.hidden}`,
    toonTable('cards', v.cards, ['column', 'name', 'state', 'ask', 'pr', 'lanes'],
      'no cards on the board'),
    toonTable('asks', v.asks, ['name', 'why', 'question'],
      'nobody is waiting for you'),
    toonTable('questions', v.questions, ['umbrella', 'text'],
      'no questions in umbrella issues'),
    toonTable('words', v.words, ['name', 'from', 'text'],
      'no window has said anything'),
    toonTable('problems', v.problems, ['source', 'error'],
      'every source answers'),
  ];
  const help = [];
  if (!v.full) {
    help.push('words holds only the start of the last words; one window in full —'
      + ' /api/board/card/<name>, the whole board in full — ?full=1');
  }
  help.push('in asks the question cell is a reference to an umbrella; the text is in the questions section');
  help.push('?format=json — the same shape as plain JSON');
  help.push('columns: ask — needs you, running — working, waiting — window is silent,'
    + ' its lane is building, idle — idle, off — no agent');
  // Help is a plain list, without fields: these are next steps, not data.
  out.push([`help[${help.length}]:`, ...help.map(t => '  ' + t)].join('\n'));
  return out.join('\n') + '\n';
}

function slotsQuery(url) {
  const allowed = ['format'];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) {
      return { error: `error: unknown parameter "${key}"\n`
        + 'help: allowed is format=json (default) or format=toon' };
    }
    if (url.searchParams.getAll(key).length > 1) {
      return { error: `error: parameter "${key}" given more than once\n`
        + 'help: leave one value — the board does not guess which of them you meant' };
    }
  }
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'toon' && format !== 'json') {
    return { error: `error: unknown format "${format}"\n`
      + 'help: format=json (default) or format=toon' };
  }
  return { format };
}

function renderToonSlots(view) {
  const rows = (view.slots ?? []).map(s => ({
    name: s.name,
    card: s.card || '-',
    since: s.since || '-',
  }));
  const out = [
    toonTable('slots', rows, ['name', 'card', 'since'], 'no CI slots on the board'),
  ];
  if (view.alarm) out.push(`alarm: ${view.alarm}`);
  return out.join('\n') + '\n';
}

// One card as plain "field: value" lines: there is nothing to build a table
// from, the row is single.
function renderToonCard(c) {
  return [
    `card: ${c.name}`,
    `column: ${c.column}`,
    `state: ${c.state}`,
    `ask: ${c.ask}`,
    `why: ${c.why}`,
    `umbrella: ${c.umbrella}`,
    `question: ${c.question}`,
    `pr: ${c.pr}`,
    `lanes: ${c.lanes}`,
    `words-from: ${c.wordsFrom}`,
    `words: ${c.words}`,
  ].join('\n') + '\n';
}

// -------------------------------------------------------------- server
//
// send, sendText, readBody, BadRequest and agentParams live in bin/serve.mjs:
// the pipeline endpoints answer in the same shape and reject a bad parameter
// with the same words.

function probeAuthError(req) {
  const token = String(config.probeToken ?? '').trim();
  if (!token) return { code: 403, text: 'probe access is not configured' };
  const hdr = String(req.headers.authorization ?? '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (!m || m[1].trim() !== token) return { code: 401, text: 'unauthorized' };
  return null;
}

// Reading the body without killing the connection. A body with no
// Content-Length (chunked) is only known to be too large half way through it,
// and tearing the socket down there left the probe with a reset connection
// instead of an answer. So the rest is read and thrown away — up to a sane
// bound — and the request then fails as 413, which the client can actually
// read.
const SNAPSHOT_DRAIN_MAX = 16 * 1024 * 1024;

function readSnapshotBytes(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    let discarded = 0;
    const finish = (fn, arg) => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onErr);
      fn(arg);
    };
    const onData = (chunk) => {
      if (over) {
        discarded += chunk.length;
        // Past this point the sender is not going to stop on its own; there is
        // nothing to be gained by reading further.
        if (discarded > SNAPSHOT_DRAIN_MAX) finish(reject, new PayloadTooLarge('payload too large'));
        return;
      }
      size += chunk.length;
      if (size > SNAPSHOT_MAX) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (over) finish(reject, new PayloadTooLarge('payload too large'));
      else finish(resolve, Buffer.concat(chunks));
    };
    const onErr = (e) => finish(reject, e);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onErr);
  });
}

async function readSnapshotBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > SNAPSHOT_MAX) {
    throw new PayloadTooLarge('payload too large');
  }
  const body = await readSnapshotBytes(req);
  if (!body.length) throw new BadRequest('malformed snapshot: body is empty');
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch { throw new BadRequest('malformed snapshot: body cannot be parsed'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('malformed snapshot: an object was expected');
  }
  for (const key of ['windows', 'tabs', 'panes', 'agents']) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new BadRequest(`malformed snapshot: ${key} must be an array`);
    }
  }
  return parsed;
}

const TAB_RX = /^w[0-9A-Za-z]*:t[0-9A-Za-z]+$/;
// A project name comes from the herdr snapshot: a folder name, so no control
// characters, no path separators and nothing longer than a folder can be.
const PROJECT_RX = /^[^\\/\r\n\t\u0000-\u001f]{1,200}$/;

// Saving the chosen project into the settings file. Everything else in that file
// is kept as it is: it holds the owner's hosts, repository and paths.
async function saveSelection(patch) {
  const raw = await readJsonSoft(CONFIG_FILE, {});
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const next = { ...base, ...patch };
  await writeJsonAtomic(CONFIG_FILE, next);
  applyConfig(next);
  // The file has just been read into memory — do not let the periodic reload
  // race with this write.
  cfgSource.at = Date.now();
  cfgSource.ok = true;
  cfgSource.error = null;
  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (await handleAuth(req, res, url, { port: PORT, config })) return;

    // Sign-in is off (no auth.founders) — the rest of the board is reached
    // exactly as before. When it is on, a session, localhost-as-owner or
    // (on agent paths) apiToken is required before anything else runs.
    if (authEnabled(config)) {
      const viewer = await resolveViewer(req, config);
      const decision = accessDecision(req, url, viewer);
      if (decision === 'signin') {
        return send(res, 200, signInPage(), 'text/html; charset=utf-8');
      }
      if (decision === 'deny') {
        return send(res, 401, JSON.stringify({ error: 'unauthorized' }));
      }
      // A signed-in founder commenting without an author: fill it in here so
      // pipeline.mjs can keep requiring one. Agents (apiToken) still send their
      // own author.
      if (viewer.founder && req.method === 'POST' && url.pathname === '/pipeline/card/comment') {
        const body = await readBody(req);
        if (!String(body.author ?? '').trim()) body.author = viewer.founder.name;
        req = withJsonBody(req, body);
      }
    }

    // The pipeline owns everything under /pipeline/… and /api/pipeline. It is
    // asked first and answers only its own paths, so the windows view below is
    // reached exactly as before.
    if (await handlePipeline(req, res, url, PORT)) return;

    const probeOnly = url.pathname.startsWith('/probe/');
    if (probeOnly) {
      const denied = probeAuthError(req);
      if (denied) return sendText(res, denied.code, denied.text);
    }
    // Without founder sign-in, /hooks/enqueue keeps using probeToken. With
    // sign-in on, the gate above already accepted a session, localhost or
    // apiToken, so the probe secret is not required a second time.
    if (!authEnabled(config) && url.pathname === '/hooks/enqueue') {
      const denied = probeAuthError(req);
      if (denied) return sendText(res, denied.code, denied.text);
    }

    if (req.method === 'POST' && url.pathname === '/probe/snapshot') {
      const body = await readSnapshotBody(req);
      const stored = await saveProbeSnapshot(body);
      return send(res, 200, JSON.stringify({ ok: true, receivedAt: stored.receivedAt }));
    }
    if (req.method === 'GET' && url.pathname === '/probe/hooks') {
      return send(res, 200, JSON.stringify({ hooks: await listHooks() }));
    }
    if (req.method === 'POST' && url.pathname === '/probe/hooks/ack') {
      const body = await readBody(req);
      const result = await ackHooks(body.ids);
      return send(res, 200, JSON.stringify({ ok: true, removed: result.removed }));
    }
    if (req.method === 'POST' && url.pathname === '/hooks/enqueue') {
      const body = await readBody(req);
      const hook = await enqueueHook(body.window, body.text);
      return send(res, 200, JSON.stringify({ ok: true, hook }));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board')) {
      return send(res, 200, await readFile(PAGE_FILE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/data') {
      const payload = await collect();
      payload.pageVersion = (await stat(PAGE_FILE).catch(() => null))?.mtimeMs ?? null;
      return send(res, 200, JSON.stringify(payload));
    }
    // CI slot occupancy. Holders live in state/ci-slots.json (written by
    // bin/ci-slot.mjs). Auth is the same as the other /api/* reads.
    if (req.method === 'GET' && url.pathname === '/api/slots') {
      const p = slotsQuery(url);
      if (p.error) return sendText(res, 400, p.error);
      const view = await slotsForBoard();
      const body = {
        slots: view.slots.map(s => ({
          name: s.name,
          card: s.card || null,
          since: s.since || null,
        })),
      };
      if (view.alarm) body.alarm = view.alarm;
      if (p.format === 'json') return send(res, 200, JSON.stringify(body, null, 2));
      return sendText(res, 200, renderToonSlots(body));
    }
    // The board for a watchdog agent: no page, no pictures, short text. Built by
    // the same collect() as /data — the sources inside it go out on their own
    // timers, so this costs no extra ssh or gh call.
    if (req.method === 'GET' && url.pathname === '/api/board') {
      const p = agentParams(url, true);
      if (p.error) return sendText(res, 400, p.error);
      let payload;
      try {
        payload = await collect();
      } catch (e) {
        return sendText(res, 500,
          `error: could not collect the board: ${String(e?.message || e)}\n`
          + 'help: check that herdr answers — herdr api snapshot');
      }
      const view = buildAgentBoard(payload, p.full);
      try {
        const stale = await pipelineStaleProblems();
        if (stale.count) {
          const n = stale.count;
          const ids = stale.ids.join(', ');
          view.problems.push({
            source: 'watchdog',
            error: n === 1
              ? `1 active card has a stale Status (older than ${stale.staleAfterMin}m): ${ids}`
              : `${n} active cards have a stale Status (older than ${stale.staleAfterMin}m): ${ids}`,
          });
        }
      } catch (e) {
        view.problems.push({
          source: 'watchdog',
          error: `could not read pipeline Status: ${String(e?.message || e)}`,
        });
      }
      if (p.format === 'json') return send(res, 200, JSON.stringify(view, null, 2));
      return sendText(res, 200, renderToonBoard(view));
    }
    // One window in full: long texts without clipping. Windows have short texts
    // one by one and long texts in bulk, which is why the board view omits them.
    if (req.method === 'GET' && url.pathname.startsWith('/api/board/card/')) {
      const p = agentParams(url, false);
      if (p.error) return sendText(res, 400, p.error);
      let wanted;
      try { wanted = decodeURIComponent(url.pathname.slice('/api/board/card/'.length)); }
      catch { wanted = ''; }
      if (!wanted.trim()) {
        return sendText(res, 400,
          'error: the card name in the path is empty\n'
          + 'help: /api/board/card/<name from the name cell of the cards section>');
      }
      let payload;
      try {
        payload = await collect();
      } catch (e) {
        return sendText(res, 500,
          `error: could not collect the board: ${String(e?.message || e)}\n`
          + 'help: check that herdr answers — herdr api snapshot');
      }
      const found = buildAgentCard(payload, wanted);
      if (!found.found) {
        const list = found.names.length ? found.names.join(', ') : '(the board is empty)';
        if (p.format === 'json') {
          return send(res, 404, JSON.stringify(
            { error: `there is no card "${wanted}" on the board`, cards: found.names }, null, 2));
        }
        return sendText(res, 404,
          `error: there is no card "${wanted}" on the board\n`
          + `help: on the board right now: ${list}`);
      }
      if (p.format === 'json') return send(res, 200, JSON.stringify(found.card, null, 2));
      return sendText(res, 200, renderToonCard(found.card));
    }

    // Choosing the project the board shows: onboarding on first run, and the
    // same screen behind the gear afterwards.
    if (req.method === 'POST' && url.pathname === '/project/select') {
      const body = await readBody(req);
      const all = body.all;
      if (all !== undefined && typeof all !== 'boolean') {
        return send(res, 400, '{"error":"all must be true or false"}');
      }
      if (all === true) {
        // "All windows" wins over any project, and the legacy substring filter
        // has to be cleared, otherwise it would keep filtering.
        await saveSelection({ allWindows: true, project: '', match: '' });
        return send(res, 200, JSON.stringify({ ok: true, project: 'All windows' }));
      }
      const project = String(body.project ?? '').trim();
      if (!project || !PROJECT_RX.test(project)) {
        return send(res, 400, '{"error":"a project name is required"}');
      }
      await saveSelection({ allWindows: false, project, match: '' });
      return send(res, 200, JSON.stringify({ ok: true, project }));
    }

    // The board's only action on herdr: switch to the chosen tab. Nothing is
    // written into or started in other windows.
    if (req.method === 'POST' && url.pathname === '/focus') {
      const { tab } = await readBody(req);
      if (!TAB_RX.test(String(tab))) return send(res, 400, '{"error":"bad tab id"}');
      await herdr(['tab', 'focus', String(tab)]);
      return send(res, 200, '{"ok":true}');
    }

    // The × on an automatic card: the window leaves the board until it is
    // restored from the settings screen. Nothing changes in the window itself.
    if (req.method === 'POST' && url.pathname === '/card/hide') {
      const { tab, cwd, name } = await readBody(req);
      const id = String(tab ?? '');
      if (!TAB_RX.test(id)) return send(res, 400, '{"error":"bad tab id"}');
      // A card is hidden, not the whole tab: a tab may have a second pane in
      // another working directory — that is a separate card.
      const dir = String(cwd ?? '').slice(0, 400);
      const key = cardKey(id, dir);
      const hand = await commitCards(h => {
        if (h.hidden.some(x => cardKey(x.tab, x.cwd) === key)) return false;
        h.hidden = [...h.hidden, {
          tab: id, cwd: dir,
          name: String(name ?? '').slice(0, 200) || id,
          at: new Date().toISOString(),
        }];
      });
      return send(res, 200, JSON.stringify({ ok: true, hidden: hand.hidden }));
    }

    // Bring a hidden window back to the board.
    if (req.method === 'POST' && url.pathname === '/card/unhide') {
      const { tab, cwd } = await readBody(req);
      const id = String(tab ?? '');
      const key = cardKey(id, String(cwd ?? ''));
      const hand = await commitCards(h => {
        const rest = h.hidden.filter(x => cardKey(x.tab, x.cwd) !== key);
        if (rest.length === h.hidden.length) return false;
        h.hidden = rest;
      });
      return send(res, 200, JSON.stringify({ ok: true, hidden: hand.hidden }));
    }

    // A card typed by hand: the title is required, the text and the column are not.
    if (req.method === 'POST' && url.pathname === '/card/add') {
      const { title, text, column } = await readBody(req);
      const t = String(title ?? '').trim().slice(0, 200);
      if (!t) return send(res, 400, '{"error":"a title is required"}');
      const col = COLUMNS.some(c => c.key === column) ? column : 'idle';
      const item = {
        id: newManualId(),
        title: t,
        text: String(text ?? '').trim().slice(0, 2000),
        column: col,
        at: new Date().toISOString(),
      };
      await commitCards(h => { h.manual = [...h.manual, item]; });
      return send(res, 200, JSON.stringify({ ok: true, card: item }));
    }

    // The × on a hand-typed card: deleted for good, there is nothing to restore.
    if (req.method === 'POST' && url.pathname === '/card/remove') {
      const { id } = await readBody(req);
      const key = String(id ?? '');
      const hand = await commitCards(h => {
        const rest = h.manual.filter(m => m.id !== key);
        if (rest.length === h.manual.length) return false;
        h.manual = rest;
      });
      return send(res, 200, JSON.stringify({ ok: true, manual: hand.manual.length }));
    }
    send(res, 404, '{"error":"no such path"}');
  } catch (e) {
    if (e instanceof PayloadTooLarge) {
      // The answer goes out first; the connection is closed after it, so the
      // client reads 413 rather than a reset.
      if (!res.headersSent) res.setHeader('Connection', 'close');
      return sendText(res, 413, e.message);
    }
    if (e instanceof BadRequest) return send(res, 400, JSON.stringify({ error: e.message }));
    send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
  }
});

await mkdir(STATE_DIR, { recursive: true });
configurePipeline(STATE_DIR);
configureSlots(STATE_DIR);
configureHooks(STATE_DIR);
configureAuth(STATE_DIR);
await loadProbeSnapshot();
await cfgSource.tick();
artifactSource.tick();
sprintSource.tick();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Watchtower is already running: http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Watchtower: ${url}`);
  if (process.argv.includes('--open')) {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});
