// autopase-board — «Autopase в одном месте».
//
// Форк sheepdog, переделанный под один проект: на доске только окна herdr,
// которые работают над autopase.lv. Одна карточка = одно окно. Всё, что на
// карточке, берётся из живых источников; руками не вводится ничего.
//
// Источники:
//   herdr api snapshot / workspace list / agent list  — окна, панели, состояние
//   herdr agent explain <панель>                      — по какому правилу выставлено состояние
//   herdr pane read <панель> --source visible         — нижняя строка экрана: учётка, модель, усилие
//   ssh <полоса> hzlane status                        — полосы Hetzner и lanes-01
//   ssh mac (git + pgrep + lsof)                      — полосы Mac (lane-a, lane-b, …)
//   gh pr list / gh issue view                        — открытые PR, цвет CI, зонтичные issue
//   STREAM-WATCH.json                                 — привязка окно → полосы и префиксы веток
//   PROGRAM-STATE.md                                  — номер зонтичного issue
//   журналы сессий Claude (*.jsonl)                   — последние слова окна
//
// Запуск: node bin\autopase-board.mjs [--open]   (или bin\autopase-board.cmd)

import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename, rm, mkdir, stat, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AUTOPASE_BOARD_PORT || 4878);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = path.join(ROOT, 'state');
const SEEN_FILE = path.join(STATE_DIR, 'autopase-seen.json');
// Правки доски руками: спрятанные окна и карточки, добавленные владельцем.
const CARDS_FILE = path.join(STATE_DIR, 'autopase-cards.json');
const CONFIG_FILE = path.join(STATE_DIR, 'autopase-board.json');
const PAGE_FILE = path.join(ROOT, 'bin', 'autopase-board.html');
const HOME = process.env.USERPROFILE ?? '';
const SEEN_KEEP_MS = 7 * 24 * 3600 * 1000;

// Настройки по умолчанию. Их можно переопределить файлом state/autopase-board.json —
// он не в git, поэтому у каждого своя правка.
const DEFAULTS = {
  // Окно попадает на доску, если его рабочая папка содержит это слово.
  match: 'autopase',
  // Окна, которые на доску не берём (маркетинг — не разработка).
  hide: ['seo'],
  repo: 'Baltic-OrangesLV/vincheck-latvia',
  streamWatch: 'C:\\Users\\panto\\projects\\autopase-ops\\reports\\active-session-monitor\\STREAM-WATCH.json',
  specsDir: 'C:\\Users\\panto\\projects\\_conveyor\\autopase.lv\\specs',
  // Слова, по которым окно считается ждущим слова CTO или владельца.
  askWords: ['ВОПРОС CTO', 'ОТВЕТ ВЛАДЕЛЬЦУ', 'ВОПРОС ВЛАДЕЛЬЦУ'],
  // Слова, которыми вопрос в зонтике закрывают. Пока их нет — вопрос висит.
  answerWords: ['ОТВЕТ CTO', 'РЕШЕНИЕ CTO', 'CTO ОТВЕЧАЕТ', 'ОТВЕЧАЮ ПО ПУНКТАМ', 'СЛОВО ВЛАДЕЛЬЦА'],
  // Полосы, где пишется код. host — что подставить в ssh, key — ключ в ~/.ssh.
  hosts: {
    'lanes-01': { target: 'root@2.29.10.164', key: 'id_ed25519', kind: 'hzlane' },
    'hetzner': { target: 'root@89.167.116.229', key: 'id_ed25519', kind: 'hzlane' },
    'mac': { target: 'mac', kind: 'mac', kitchen: '~/kitchens/autopase.lv' },
  },
};

const HERDR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Herdr', 'bin', 'herdr.exe'),
  'herdr',
];
const SSH = process.env.AUTOPASE_SSH || 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const GH = process.env.AUTOPASE_GH || 'gh';

const KNOWN_STATUSES = new Set(['blocked', 'done', 'working', 'idle', 'unknown']);

// Колонки. Первая — по слову владельца: то, что стоит без него.
const COLUMNS = [
  { key: 'ask', title: 'Нужен CTO / владелец' },
  { key: 'running', title: 'В работе' },
  { key: 'waiting', title: 'Молчит, полоса пишет' },
  { key: 'idle', title: 'Простаивает' },
  { key: 'off', title: 'Без агента' },
];

// ---------------------------------------------------------------- мелочи

function normPath(p) {
  if (!p) return '';
  let s = String(p);
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  s = s.replaceAll('/', '\\').toLowerCase();
  while (s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

async function readJsonSoft(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

// Запись файла состояния: сначала во временный файл, потом переименование.
// Две тонкости, за которые уже платили:
//   1. имя временного файла уникальное — иначе две одновременные записи
//      пишут в один и тот же <файл>.tmp и вторая переименовывает обрывок;
//   2. записи одного файла выстроены в очередь — переименования не обгоняют
//      друг друга и не спотыкаются об уже переименованный временный файл.
const writeQueues = new Map();

async function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
  // В очереди держим версию, которая никогда не падает: чужая неудача не
  // должна отменить следующую запись.
  const tail = run.catch(() => {});
  writeQueues.set(file, tail);
  tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return run;
}

// Запуск внешней команды. Никогда не бросает — возвращает текст или null.
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

// herdr, отвечающий строкой JSON.
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
          catch { reject(new Error(`herdr ${args.join(' ')}: ответ не JSON`)); }
        });
    };
    tryOne(0);
  });
}

// herdr, отвечающий обычным текстом (explain, pane read).
async function herdrText(args) {
  for (const bin of HERDR_CANDIDATES) {
    const out = await runText(bin, args, 30000);
    if (out !== null) return out;
  }
  return null;
}

// Каждый источник данных обновляется в своём темпе и в фоне: страница
// опрашивает /data раз в 3 секунды и никогда не ждёт ни ssh, ни GitHub.
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

// --------------------------------------------------- настройки и привязки

let config = { ...DEFAULTS };
const cfgSource = makeSource('config', 30000, async () => {
  const raw = await readJsonSoft(CONFIG_FILE, {});
  config = { ...DEFAULTS, ...raw, hosts: { ...DEFAULTS.hosts, ...(raw.hosts ?? {}) } };
  return config;
});

// STREAM-WATCH.json — единственное место, где записано «это окно ведёт вот эти
// полосы и пишет ветки с такими префиксами». Файл ведёт окно CTO, не доска.
const streamsSource = makeSource('stream-watch', 30000, async () => {
  const raw = await readJsonSoft(config.streamWatch, null);
  if (!raw) throw new Error(`не читается ${config.streamWatch}`);
  const byPane = new Map();
  const byId = new Map();
  for (const s of raw.streams ?? []) {
    if (s.disabled) continue;
    if (s.pane) byPane.set(s.pane, s);
    if (s.id) byId.set(String(s.id).toLowerCase(), s);
  }
  return { raw, byPane, byId, ctoPane: raw.cto_pane ?? null, repo: raw.repo ?? config.repo };
});

// PROGRAM-STATE.md каждой программы: оттуда берём номер зонтичного issue.
const programsSource = makeSource('programs', 30000, async () => {
  const out = new Map(); // имя папки программы (в нижнем регистре) -> {umbrella, file, updated}
  let dirs = [];
  try { dirs = await readdir(config.specsDir, { withFileTypes: true }); }
  catch (e) { throw new Error(`не читается ${config.specsDir}: ${e.message}`); }
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

// ------------------------------------------------------------- полосы

// hzlane status: «lane-3: BUSY since Wed 2026-08-26 09:25:20 UTC  branch=feat/…»
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
  return { lanes, extras };
}

// На Mac hzlane нет: полоса — папка ~/kitchens/autopase.lv/lane-*, ветка берётся
// из git, занятость — по рабочей папке живого процесса codex exec.
const MAC_PROBE = [
  'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH;',
  'for d in KITCHEN/lane-*; do [ -d "$d" ] || continue;',
  'echo "LANE $(basename "$d") branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)"; done;',
  'for p in $(pgrep -f "codex exec" 2>/dev/null); do',
  'echo "PROC $p|$(ps -o etime= -p $p | tr -d " ")|$(lsof -a -d cwd -p $p -Fn 2>/dev/null | grep "^n" | head -1 | cut -c2-)|$(ps -o command= -p $p | tr "\\n" " " | cut -c1-160)";',
  'done;',
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
    l.since = hit.etime ? `${hit.etime} назад` : null;
    const task = /TASK-[A-Za-z0-9._-]+/.exec(hit.cmd);
    l.task = task ? task[0] : null;
  }
  // Работа codex вне полос autopase (например, песочницы no-mistakes) на доску
  // не идёт, но её счёт полезен: она ест те же ядра.
  const outside = procs.filter(p => !lanes.some(l => p.cwd && p.cwd.endsWith('/' + l.lane))).length;
  if (outside) extras.push(`ещё ${outside} процесс(ов) codex вне полос autopase`);
  return { lanes, extras, kitchen: kitchenAbs };
}

function sshArgs(host, remote) {
  const args = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (host.key) args.push('-i', path.join(HOME, '.ssh', host.key));
  args.push(host.target, remote);
  return args;
}

async function probeHost(name, host) {
  const remote = host.kind === 'mac'
    ? MAC_PROBE.replaceAll('KITCHEN', host.kitchen ?? '~/kitchens/autopase.lv')
    : 'hzlane status 2>&1';
  const started = Date.now();
  const out = await runText(SSH, sshArgs(host, remote), 45000);
  if (out === null) {
    return { host: name, target: host.target, ok: false, lanes: [], extras: [], error: 'ssh не ответил', tookMs: Date.now() - started };
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
  if (!items.length) return { color: 'none', text: 'нет проверок' };
  let fail = 0, run = 0, ok = 0;
  for (const it of items) {
    const v = String(it.conclusion || it.state || it.status || '').toUpperCase();
    if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(v)) fail++;
    else if (['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(v)) run++;
    else ok++;
  }
  if (fail) return { color: 'red', text: `CI красный (${fail})` };
  if (run) return { color: 'run', text: `CI идёт (${run})` };
  return { color: 'green', text: `CI зелёный (${ok})` };
}

const prSource = makeSource('pull-requests', 60000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  const out = await runText(GH, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '80',
    '--json', 'number,title,headRefName,isDraft,url,updatedAt,statusCheckRollup,author'], 90000);
  if (out === null) throw new Error('gh pr list не ответил');
  const list = JSON.parse(out);
  return list.map(p => ({
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    draft: p.isDraft,
    url: p.url,
    updatedAt: p.updatedAt,
    author: p.author?.login ?? null,
    ci: ciColor(p.statusCheckRollup),
  }));
});

// Зонтичные issue: список + свежие комментарии, чтобы поймать «ВОПРОС CTO».
const umbrellaSource = makeSource('umbrella', 120000, async () => {
  const repo = streamsSource.value?.repo ?? config.repo;
  const listOut = await runText(GH, ['issue', 'list', '--repo', repo, '--label', 'umbrella',
    '--state', 'open', '--limit', '40', '--json', 'number,title,url,updatedAt'], 90000);
  if (listOut === null) throw new Error('gh issue list не ответил');
  const numbers = new Set(JSON.parse(listOut).map(i => i.number));
  // Плюс зонтики, названные в PROGRAM-STATE.md: они могут быть без метки.
  for (const p of (programsSource.value ?? new Map()).values()) if (p.umbrella) numbers.add(p.umbrella);
  const out = new Map();
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
      // Вопрос считается закрытым, только если ПОСЛЕ него лёг комментарий с
      // ответом. Отчёты самого потока («запущено», «влито») ответом не считаются —
      // в зонтике пишет одна и та же учётная запись, по автору не различить.
      const answered = comments.slice(i + 1).some(c =>
        answers.some(a => String(c.body ?? '').toUpperCase().includes(a.toUpperCase())));
      ask = {
        word: hit,
        at: comments[i].createdAt ?? null,
        author: comments[i].author?.login ?? null,
        text: body.replace(/\s+/g, ' ').slice(0, 300),
        after: comments.length - 1 - i, // сколько комментариев легло уже после вопроса
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

// ------------------------------------------ экран окна и последние слова

// Нижняя строка экрана Claude Code:
//   museyib@timelines.ai | effort: xhigh | panto > garage-lv-directories | Opus 5 (1M context) | [====] 47% | кэш …
function parseFooter(text) {
  const lines = String(text).split(/\r?\n/);
  let footer = null, mode = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!footer && l.includes('|') && /\beffort:/i.test(l)) { footer = l; continue; }
    if (!mode && /(bypass permissions|accept edits|plan mode|shift\+tab)/i.test(l)) mode = l.trim();
  }
  if (!footer) {
    // Не Claude Code: у grok и других строка состояния нарисована в рамке
    // («╰─ Grok 4.6 (xhigh) · always approve ─╯»). Берём её целиком как модель.
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
  const cache = find(/кэш/i);
  const account = parts[0] && /@/.test(parts[0]) ? parts[0] : null;
  // Модель — то, что не учётка, не effort, не «panto > …», не полоса контекста и не кэш.
  const model = parts.find(p =>
    p !== account && !/^effort:/i.test(p) && !/^panto\s*>/i.test(p) && p !== ctx && p !== cache
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

// Обвязка терминала: подсказки, полоски режима, приглашение оболочки. Это не
// слова окна, и в «последние слова» такие строки попадать не должны.
const CHROME = [
  /shift\+tab/i, /ctrl\+[a-z]/i, /\besc\b\s*:/i, /^PS\s+[A-Z]:\\/i, /CategoryInfo/i,
  /\(optional\)/i, /auto mode on/i, /bypass permissions/i, /for agents\s*$/i,
  /^\s*[❯>$#]/, /Update installed/i, /token(s)?\s*$/i, /^\S+=\S+&\S+=/,
  /^\s*✻/, /^\s*⎿/, /How is Claude doing/i, /^\s*\d+\s*\/\s*\d+\s+agents?\b/i,
  /^[╰╭╮╯┌┐└┘├┤│─═]/, // строка внутри рамки — обвязка окна, а не его слова
];
// Инструменты, а не слова: «● Bash(…)», «● Created PR #…» — это отчёт о действии.
const TOOL_LINE = /^(Monitor|Bash|Read|Write|Edit|Search|Task|Update|Created PR|Ran \d|Fetch|Glob|Grep|WebFetch|Skill)\b/;

// Строка в кавычках с экранированием (перенос строки, коды знаков) — в обычный
// текст. Если после разбора остались одни пробелы, показывать нечего.
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

// Рамки, стрелки и разделители словами не являются. Если после их удаления в
// строке осталось меньше десятка настоящих знаков — это обвязка, а не речь
// (иначе в «последние слова» попадала рамка вида «╰─ (Grok 4.6) ─╯»).
function wordyLength(l) {
  return l.replace(/[\s─═│┌┐└┘├┤┬┴┼╌╭╮╰╯▼▲►◄◇◆○●⏺|+\-–—·•]/g, '').length;
}

// Экран без «подвала»: последняя строка, которую окно действительно сказало.
function lastScreenWords(text) {
  const clean = (l) => l.replace(/\s+/g, ' ').trim().slice(0, 300);
  const junk = (l) => CHROME.some(rx => rx.test(l)) || /\beffort:/i.test(l) || wordyLength(l) < 12;
  const lines = String(text).split(/\r?\n/);
  // Строки Claude Code начинаются с маркера ● / ⏺ — это ответ агента.
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

// Экраны и правила состояния читаем реже, чем идёт опрос страницы: 40 окон ×
// два вызова herdr — это заметно, а текст на экране так быстро не меняется.
const paneCache = new Map(); // pane -> { at, footer, words, prs, explain, raw }
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
      // rule приходит как «osc_title_working (region=osc_title priority=1100)»:
      // на карточке нужно короткое имя, подробности уходят в подсказку.
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
    // Панели, которых больше нет, из памяти убираем.
    const live = new Set(panes);
    for (const k of paneCache.keys()) if (!live.has(k)) paneCache.delete(k);
  } finally { paneRefreshing = false; }
}

// -------------------------------------- последние слова из журнала сессии

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
  } catch { /* нет папки учёток — работаем с одной */ }
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

// Журналы соседних сессий того же окна, от свежего к старому. Нужны, когда
// текущая сессия ещё ничего не сказала вслух (только ходила по инструментам)
// — тогда последние слова окна лежат в её предшественнице.
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
  } catch { /* папка исчезла */ }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 3).map(x => x.file);
}

// Хвост журнала. Окно может час подряд ходить по инструментам, и в последней
// четверти мегабайта не окажется ни одной сказанной вслух строки — поэтому
// хвост берём растущими кусками, пока слова не найдутся (или не кончится файл).
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
    } catch { /* обрезанная строка журнала */ }
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
  } catch { /* журнал не читается — покажем слова с экрана */ }
  journalCache.set(file, { mtime: s.mtimeMs, text });
  return text;
}

// ------------------------------------------------------- время в состоянии

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

// ------------------------------------------- правки доски руками (крестик, «+»)
//
// Всё, что владелец сделал руками, лежит в одном файле state/autopase-cards.json:
//   { "hidden": [ { "tab": "w5:t3", "cwd": "…", "name": "…", "at": "…" } ],
//     "manual": [ { "id": "m…", "title": "…", "text": "…", "column": "idle", "at": "…" } ] }
// hidden — автокарточки, спрятанные крестиком; их всегда можно вернуть из списка
// «скрытые: N». manual — карточки, заведённые кнопкой «+»; они удаляются насовсем.

let cardsState = null;

// Карточка — это не вкладка: одна вкладка с двумя панелями в разных рабочих
// папках даёт две карточки. Поэтому прячем по той же паре, по которой карточка
// и собирается: вкладка + рабочая папка.
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
    // Старые записи (без рабочей папки) не выбрасываем: они прячут вкладку
    // целиком, как раньше, пока владелец не вернёт окно на доску.
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

// Читаем файл один раз на всю жизнь доски. Чтение обязано быть однократным и
// при одновременных запросах: иначе каждый из них заводит СВОЙ разбор файла, и
// правки, сделанные в чужом, пропадают (12 одновременных «+» давали в файле
// одну карточку).
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

// Правка руками: сначала меняем в памяти, потом пишем на диск. Если запись не
// удалась — откатываем память обратно, иначе доска показывала бы карточку как
// сохранённую, а после перезапуска её бы не было.
async function commitCards(mutate) {
  const hand = await loadCards();
  const backup = { hidden: hand.hidden.slice(), manual: hand.manual.slice() };
  const result = mutate(hand);
  if (result === false) return hand;   // менять нечего — и писать нечего
  try {
    await saveCards();
  } catch (e) {
    hand.hidden = backup.hidden;
    hand.manual = backup.manual;
    throw new Error(`правку не удалось сохранить на диск: ${String(e?.message || e)}`);
  }
  return hand;
}

function newManualId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------- ветка рабочей копии

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
      // Голова может быть отсоединена от ветки — тогда в HEAD лежит просто
      // номер коммита. Это важно видеть: с такой копии PR не откроешь.
      if (r) value = { branch: r[1], detached: null };
      else if (/^[0-9a-f]{7,40}$/i.test(head)) value = { branch: null, detached: head.slice(0, 7) };
    }
  } catch { /* не репозиторий — ветки нет */ }
  branchCache.set(dir, { at: Date.now(), value });
  return value;
}

// ------------------------------------------------------------ сбор доски

// Сравнение названий без учёта регистра и разделителей: «GLD-garage-lv-directories»
// и «Garage LV directories» — про одно и то же.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '');
}

function matchesStream(stream, branch) {
  if (!stream || !branch) return false;
  return (stream.branch_prefix ?? []).some(p => branch.startsWith(p));
}

// Полосы этого окна: сначала по префиксу ветки писателя, потом по прямому
// совпадению с веткой рабочей копии, потом по названию задания.
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

function ageMs(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : Date.now() - t;
}

async function collect() {
  // Фоновые источники: просто «толкнуть», ответа не ждём.
  cfgSource.tick();
  const first = [];
  for (const s of [streamsSource, programsSource, lanesSource, prSource, umbrellaSource]) {
    const p = s.tick();
    if (s.at === 0 && p) first.push(p);
  }
  // Первый заход ждёт медленные источники один раз, иначе доска открылась бы пустой.
  if (first.length) await Promise.allSettled(first);

  const [snapRes, wsListRes, agentListRes, seen, hand] = await Promise.all([
    herdr(['api', 'snapshot']),
    herdr(['workspace', 'list']).catch(() => null),
    herdr(['agent', 'list']).catch(() => null),
    loadSeen(),
    loadCards(),
  ]);

  const snap = snapRes?.result?.snapshot ?? {};
  const wsById = new Map((snap.workspaces ?? []).map(w => [w.workspace_id, w]));
  const tabById = new Map((snap.tabs ?? []).map(t => [t.tab_id, t]));
  const allPanes = snap.panes ?? [];
  const agents = agentListRes?.result?.agents ?? [];
  const agentByPane = new Map(agents.map(a => [a.pane_id, a]));

  const wsList = wsListRes?.result?.workspaces ?? [];
  const wsMeta = new Map(wsList.map(w => [w.workspace_id, w]));

  const match = String(config.match ?? 'autopase').toLowerCase();
  const hide = (config.hide ?? []).map(s => String(s).toLowerCase());

  // Одна вкладка — одна карточка: у панели с агентом приоритет, дальше меньший id.
  const rank = (p) => `${p.agent ? 0 : 1}|${p.pane_id}`;
  const best = new Map();
  for (const p of allPanes) {
    const cwd = normPath(p.cwd);
    if (!cwd || !cwd.includes(match)) continue;
    const key = `${p.tab_id}|${cwd}`;
    const cur = best.get(key);
    if (!cur || rank(p) < rank(cur)) best.set(key, p);
  }
  let panes = [...best.values()];
  // Прячем то, что владелец просил не показывать (маркетинговое окно seo).
  const hidden = [];
  panes = panes.filter(p => {
    const folder = path.basename(normPath(p.cwd));
    const wsLabel = String(wsById.get(p.workspace_id)?.label ?? '').toLowerCase();
    if (hide.includes(folder) || hide.includes(wsLabel)) { hidden.push(folder || wsLabel); return false; }
    return true;
  });
  // Окна, спрятанные крестиком. Прячем ровно ту карточку, на которой нажали
  // крестик: пара «вкладка + рабочая папка», как в ключе сборки выше. Вернуть
  // их можно из списка «скрытые: N».
  const nameOf = (p) => {
    const ws = wsById.get(p.workspace_id);
    const meta = wsMeta.get(p.workspace_id);
    const tab = tabById.get(p.tab_id);
    const tabCount = ws?.tab_count ?? 1;
    const tabLabel = tab?.label && !/^\d+$/.test(tab.label) ? tab.label : null;
    return (tabCount > 1 && tabLabel) || meta?.label || ws?.label || path.basename(normPath(p.cwd));
  };
  const hiddenKeys = new Set(hand.hidden.filter(h => h.cwd).map(h => cardKey(h.tab, h.cwd)));
  // Записи старого образца (без рабочей папки) прячут вкладку целиком.
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
  // Скрытое не живёт вечно: если вкладки в снимке herdr больше нет, запись
  // выбрасываем — иначе новая вкладка с тем же id молча не появилась бы на
  // доске. У живых записей заодно освежаем имя, чтобы в списке «скрытые» не
  // висело чужое старое название.
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
      if (tabById.has(h.tab)) return true;   // вкладка жива, панель ещё не поднялась
      changed = true;
      return false;
    });
    if (changed) saveCards().catch(() => {});
  }
  panes.sort((a, b) => a.pane_id.localeCompare(b.pane_id));

  const now = new Date().toISOString();
  updateSeen(seen, panes, now);
  writeJsonAtomic(SEEN_FILE, seen).catch(() => {});
  refreshPanes(panes.map(p => p.pane_id));

  const streams = streamsSource.value;
  const programs = programsSource.value ?? new Map();
  const prs = prSource.value ?? [];
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
    // Полосы, которые в STREAM-WATCH числятся за окном, но сейчас свободны.
    const laneSlots = [...new Set((stream?.lanes ?? []).map(l => `${l.host}: ${l.task_match}`))];

    // Последние слова окна: журнал сессии точнее экрана, экран — запасной путь.
    let recap = null;
    let recapFrom = null;
    const sid = agent?.agent_session?.value;
    if (sid && cwd) {
      const { file, dir } = await findSessionFile(sid, cwd);
      if (file) {
        recap = await lastAssistantText(file);
        if (recap) recapFrom = 'журнал сессии';
      }
      if (!recap) {
        for (const other of await siblingJournals(dir, file)) {
          recap = await lastAssistantText(other);
          if (recap) { recapFrom = 'журнал прошлой сессии окна'; break; }
        }
      }
    }
    if (!recap && screen?.words) { recap = screen.words; recapFrom = 'экран окна'; }

    // Открытые PR этого окна. Номера, названные окном (на экране или в последних
    // словах), — самая честная привязка там, где ветка PR не совпала с веткой окна.
    const mentioned = new Set(screen?.prs ?? []);
    for (const m of String(recap ?? '').matchAll(/#(\d{3,5})/g)) mentioned.add(Number(m[1]));
    const cardPrs = [];
    for (const pr of prs) {
      let via = null;
      if (branch && pr.branch === branch) via = 'ветка окна';
      else if (matchesStream(stream, pr.branch)) via = 'префикс ветки';
      else if (lanes.some(l => l.branch === pr.branch)) via = 'ветка полосы';
      if (via) cardPrs.push({ ...pr, via });
    }
    cardPrs.sort((a, b) => b.number - a.number);

    // Зонтичный issue: из PROGRAM-STATE.md программы с таким же именем, иначе
    // из state_file потока, иначе по номеру, названному самим окном.
    let program = null;
    for (const [key, val] of programs) {
      if (key === folder || key.endsWith(folder) || folder.endsWith(key)) { program = val; break; }
    }
    if (!program && stream?.state_file) {
      const dirName = path.basename(path.dirname(stream.state_file)).toLowerCase();
      program = programs.get(dirName) ?? null;
    }
    let umbrellaNo = program?.umbrella ?? null;
    // Зонтик часто называет поток прямо в заголовке («…(POPULAR-001 + SALON-001) —
    // категории…»), и это надёжнее случайного номера, мелькнувшего на экране.
    if (!umbrellaNo) {
      // Сначала целиком, потом по хвосту имени: один зонтик может вести две
      // ветви сразу («…(POPULAR-001 + SALON-001)…»), и целиком имя в него не влезает.
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

    // Нужен ли CTO или владелец.
    const words = config.askWords ?? DEFAULTS.askWords;
    const askReasons = [];
    if (status === 'blocked') askReasons.push('окно blocked — ждёт ответа');
    const hay = `${recap ?? ''} ${screen?.words ?? ''}`.toUpperCase();
    for (const w of words) if (hay.includes(w.toUpperCase())) askReasons.push(`в последних словах «${w}»`);
    if (umbrella?.ask && !umbrella.ask.answered) {
      askReasons.push(`в зонтике #${umbrella.number} «${umbrella.ask.word}» без ответа`);
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
      // В окне с несколькими вкладками имя даёт вкладка («grok»,
      // «sheepdog-autopase»); безымянные вкладки («1», «2») именем не считаются.
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
    });
  }

  // Второй проход по PR: у кого ветка совпала — тот и хозяин, и на чужих
  // карточках такой PR не всплывает. Остальные открытые PR отдаём тем окнам,
  // которые сами их назвали (на экране или в последних словах) — иначе окно
  // CTO, где перечислены все номера, забирало бы себе всю доску.
  const ownedByBranch = new Set(cards.flatMap(c => c.prs.map(pr => pr.number)));
  for (const c of cards) {
    for (const pr of prs) {
      if (ownedByBranch.has(pr.number) || !c.mentioned.includes(pr.number)) continue;
      c.prs.push({ ...pr, via: 'названо окном' });
    }
    c.prs.sort((a, b) => b.number - a.number);
    delete c.mentioned;
  }

  // Карточки, заведённые руками. Они не привязаны ни к окну, ни к полосе, ни к
  // PR — только заголовок, текст и колонка, — поэтому добавляются последними,
  // уже после разбора PR по окнам.
  for (const m of hand.manual) {
    cards.push({
      manual: true,
      id: m.id,
      pane: null,
      tab: null,
      ws: null,
      place: 'вручную',
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
      recapFrom: m.text ? 'вписано руками' : null,
      askReasons: [],
      column: m.column,
      tabCount: 1,
    });
  }

  // Хозяева занятых полос. Считаем по ВСЕМ окнам, включая спрятанные
  // крестиком: скрытие — дело доски, а полоса от него ничьей не становится.
  const laneOwners = {};
  for (const c of cards) for (const l of c.lanes) laneOwners[`${l.host}|${l.lane}`] = c.name;
  for (const p of hiddenPanes) {
    const cwd = String(p.cwd ?? '');
    const folder = path.basename(normPath(cwd));
    const { branch } = await checkoutBranch(cwd);
    const stream = streams?.byPane.get(p.pane_id) ?? streams?.byId.get(folder) ?? null;
    for (const l of lanesFor(allLanes, stream, branch)) {
      const key = `${l.host}|${l.lane}`;
      if (!laneOwners[key]) laneOwners[key] = `${nameOf(p)} (скрыто с доски)`;
    }
  }

  // Полосы, которые заняты, но ни к какому окну не привязались.
  for (const l of allLanes) {
    if (l.busy && !laneOwners[`${l.host}|${l.lane}`]) l.orphan = true;
  }

  const sources = [cfgSource, streamsSource, programsSource, lanesSource, prSource, umbrellaSource]
    .map(s => ({ name: s.name, ok: s.ok, error: s.error, ageMs: s.at ? Date.now() - s.at : null, tookMs: s.tookMs }));

  return {
    generatedAt: now,
    columns: COLUMNS,
    cards,
    hosts: laneHosts,
    // Хозяева полос отдельно от карточек: спрятанное окно карточки не даёт,
    // но полосу свою не бросает.
    laneOwners,
    hidden: [...new Set(hidden)],
    // Спрятанное крестиком — отдельно от config.hide: это можно вернуть с доски.
    handHidden: hand.hidden,
    windowsTotal: (snap.workspaces ?? []).length,
    focusedTab: snap.focused_tab_id ?? null,
    ctoPane: streams?.ctoPane ?? null,
    repo: streams?.repo ?? config.repo,
    prsOpen: prs.length,
    umbrellas: [...umbrellas.values()],
    sources,
  };
}

// -------------------------------------------------------------- сервер

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Плохой запрос от страницы — это не поломка доски: отвечаем 400 и своим
// текстом, а не английской руганью разборщика JSON, которую страница показала
// бы владельцу прямо у кнопки.
class BadRequest extends Error {}

// Тело POST-запроса. Больше сотни килобайт доска не принимает: там всё равно
// только заголовок карточки и пара строк текста.
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100000) throw new BadRequest('слишком длинный запрос');
  }
  if (!body) return {};
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new BadRequest('плохой запрос: тело не разобрать'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('плохой запрос: ожидался объект');
  }
  return parsed;
}

const TAB_RX = /^w[0-9A-Za-z]*:t[0-9A-Za-z]+$/;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/board')) {
      return send(res, 200, await readFile(PAGE_FILE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/data') {
      const payload = await collect();
      payload.pageVersion = (await stat(PAGE_FILE).catch(() => null))?.mtimeMs ?? null;
      return send(res, 200, JSON.stringify(payload));
    }
    // Единственное действие доски: перевести herdr на выбранную вкладку.
    // Ничего в чужие окна не пишется и не запускается.
    if (req.method === 'POST' && url.pathname === '/focus') {
      const { tab } = await readBody(req);
      if (!TAB_RX.test(String(tab))) return send(res, 400, '{"error":"плохой id вкладки"}');
      await herdr(['tab', 'focus', String(tab)]);
      return send(res, 200, '{"ok":true}');
    }

    // Крестик на автокарточке: окно уходит с доски до тех пор, пока его не
    // вернут из списка «скрытые». Ничего в самом окне не меняется.
    if (req.method === 'POST' && url.pathname === '/card/hide') {
      const { tab, cwd, name } = await readBody(req);
      const id = String(tab ?? '');
      if (!TAB_RX.test(id)) return send(res, 400, '{"error":"плохой id вкладки"}');
      // Прячем карточку, а не вкладку целиком: у вкладки может быть вторая
      // панель в другой рабочей папке — это отдельная карточка.
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

    // Вернуть спрятанное окно на доску.
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

    // Карточка, вписанная руками: заголовок обязателен, текст и колонка — нет.
    if (req.method === 'POST' && url.pathname === '/card/add') {
      const { title, text, column } = await readBody(req);
      const t = String(title ?? '').trim().slice(0, 200);
      if (!t) return send(res, 400, '{"error":"нужен заголовок"}');
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

    // Крестик на ручной карточке: удаляем насовсем, возвращать нечего.
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
    send(res, 404, '{"error":"нет такого пути"}');
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, JSON.stringify({ error: e.message }));
    send(res, 500, JSON.stringify({ error: String(e?.message || e) }));
  }
});

await mkdir(STATE_DIR, { recursive: true });
await cfgSource.tick();
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`Доска уже запущена: http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`autopase board: ${url}`);
  if (process.argv.includes('--open')) {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});
