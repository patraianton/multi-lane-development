// wt — Watchtower on the command line.
//
// A thin wrapper over GET /api/board and GET /api/pipeline of the running
// Watchtower server: it has no logic of its own, the whole answer is composed
// by the server (bin/watchtower.mjs). It lets an agent read the board and the
// pipeline with one command, without a browser or screenshots.
//
// Run: node bin\wt.mjs [pipeline | --pipeline | card <id>] [--json] [--full]
//                       [--spec] [--card <name>]   (or bin\wt.cmd)
// The port comes from WATCHTOWER_PORT (AUTOPASE_BOARD_PORT is still read as a
// fallback), 4878 by default — the same one the server listens on.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0';
const PORT = Number(process.env.WATCHTOWER_PORT || process.env.AUTOPASE_BOARD_PORT || 4878);
const BASE = `http://127.0.0.1:${PORT}`;
const SELF = fileURLToPath(import.meta.url);
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DESCRIPTION = 'Watchtower: herdr windows, build lanes, PRs and who is waiting for you';

// Our own path with the home folder folded into "~": the agent only needs to see
// which file it ran, the full home path is noise.
function selfPath() {
  const p = path.join(path.dirname(SELF), 'wt.cmd');
  if (HOME && p.toLowerCase().startsWith(HOME.toLowerCase())) return '~' + p.slice(HOME.length);
  return p;
}

const CMD = 'bin\\wt.cmd';
const TAKES = `${CMD} takes only pipeline, card <id>, --pipeline, --json, --full, --spec, --card <name>, --help, --version`;

const HELP = `bin: ${selfPath()}
description: ${DESCRIPTION}

With no flags it prints the live board as short text (TOON-flavoured).
pipeline or --pipeline prints the delivery pipeline. card <id> prints one
pipeline card.

Flags:
  --json          the same shape as plain JSON
  --full          long texts in full (no clipping)
  --spec          with card <id> only: the spec text in the answer
  --pipeline      the delivery pipeline (same as the pipeline subcommand)
  --card <name>   one window in full: its last words, why it waits, the question
                  from its umbrella issue. The name is the name cell of cards
  --help          this help
  --version       version number

Subcommands:
  pipeline        the delivery pipeline as short text (TOON-flavoured)
  card <id>       one pipeline card: summary, comments, history, clocks and the
                  spec line count. The spec text itself — --spec, or open
                  /pipeline/card/<id>/spec in a browser

What is in the board answer:
  summary     counters: windows, waiting for you, lanes building, open PRs, manual, hidden
  cards       one card per line, fields:
                column  board column: ask — needs you, running — working,
                        waiting — the window is silent but its lane is building,
                        idle — idle, off — window with no agent
                name    window name (or the title of a card typed by hand)
                state   agent state: working, idle, blocked, done, unknown, manual
                ask     does this card wait for a human: yes / no
                pr      newest open PR of the window and its CI colour, "+N" — how many more
                lanes   busy lanes of the window, "host/lane-N"
  asks        why a card waits; the question cell references an umbrella issue
  questions   questions from umbrella issues, once per umbrella (asks points here)
  words       the start of each window's last words and where they came from; in full —
              ${CMD} --card <name> or --full
  problems    board sources that did not answer (ssh, gh). Empty means everything is alive

What is in the pipeline answer:
  summary     counters: cards, stuck, done, failures
  cards       one card per line, fields:
                id      pipeline card id (taken by ${CMD} card <id>)
                title   the card's title
                stage   spec, grilled, ticketed, development, local_check, ci_pr,
                        done, or stuck
                clock   delivery time; a done card shows "(stopped)"
                fails   local / ci / review counts, or "-"
                verdict moving, stalled, looping, or "-"
  stuck       cards waiting for a human after three failures in a row
  specs       under --full only, the spec text of every card that has one

Examples:
  ${CMD}
  ${CMD} --full
  ${CMD} --json
  ${CMD} --card my-window
  ${CMD} pipeline
  ${CMD} --pipeline
  ${CMD} pipeline --full
  ${CMD} pipeline --json
  ${CMD} card <id>
  ${CMD} card <id> --json
  ${CMD} card <id> --spec
`;

const KNOWN = new Set(['--json', '--full', '--spec', '--card', '--pipeline', '--help', '-h', '--version', '-v', '-V']);

const args = process.argv.slice(2);
// Whether --json was asked for must be known before the first error: an agent
// that asked for JSON must get JSON in trouble too, otherwise it trips over the
// parsing instead of reading what happened.
const wantJson = args.includes('--json');

function die(text, code) {
  const out = wantJson ? asJson(text) : text;
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  process.exit(code);
}

// Our messages have one shape: an "error: …" line and a "help: …" line. In JSON
// they become two fields — as easy for a machine to read as the lines are for a
// human.
function asJson(text) {
  const lines = String(text).split('\n');
  const err = lines.find(l => l.startsWith('error:')) ?? lines[0] ?? '';
  const help = lines.find(l => l.startsWith('help:')) ?? '';
  return JSON.stringify({
    error: err.replace(/^error:\s*/, ''),
    help: help.replace(/^help:\s*/, '') || undefined,
  }, null, 2);
}

let wantWindowCard = null;
let wantPipelineFlag = false;
const positionals = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--card') {
    wantWindowCard = args[i + 1] ?? '';
    i += 1;
    if (!wantWindowCard || wantWindowCard.startsWith('--')) {
      die('error: --card was given without a card name\n'
        + `help: ${CMD} --card <name from the name cell of the cards section>`, 2);
    }
    continue;
  }
  if (a === '--pipeline') {
    wantPipelineFlag = true;
    continue;
  }
  if (KNOWN.has(a)) continue;
  if (a.startsWith('-')) {
    die(`error: unknown flag ${a}\n`
      + `help: ${TAKES}`, 2);
  }
  positionals.push(a);
}
if (args.includes('--help') || args.includes('-h')) die(HELP, 0);
if (args.includes('--version') || args.includes('-v') || args.includes('-V')) die(VERSION, 0);

let wantPipeline = wantPipelineFlag;
let wantPipelineCard = null;
if (positionals.length) {
  const cmd = positionals[0];
  if (cmd === 'pipeline') {
    if (positionals.length > 1) {
      die(`error: unknown argument ${positionals[1]}\n`
        + `help: ${TAKES}`, 2);
    }
    wantPipeline = true;
  } else if (cmd === 'card') {
    const id = positionals[1] ?? '';
    if (!id || id.startsWith('--')) {
      die('error: card was given without a card id\n'
        + `help: ${CMD} card <id from the id cell of the pipeline cards section>`, 2);
    }
    if (positionals.length > 2) {
      die(`error: unknown argument ${positionals[2]}\n`
        + `help: ${TAKES}`, 2);
    }
    wantPipelineCard = id;
  } else {
    die(`error: unknown argument ${cmd}\n`
      + `help: ${TAKES}`, 2);
  }
}

if (wantPipeline && wantWindowCard) {
  die('error: --pipeline cannot be combined with --card\n'
    + `help: ${CMD} --pipeline reads the pipeline; ${CMD} --card <name> reads one window`, 2);
}
if (wantPipeline && wantPipelineCard) {
  die('error: pipeline and card cannot be used together\n'
    + `help: ${CMD} pipeline reads the list; ${CMD} card <id> reads one pipeline card`, 2);
}
if (wantWindowCard && wantPipelineCard) {
  die('error: card <id> is a pipeline card; --card <name> is a window\n'
    + `help: ${CMD} card <id>  or  ${CMD} --card <name>`, 2);
}

const wantFull = args.includes('--full');
if (wantWindowCard && wantFull) {
  die('error: --full is not needed together with --card\n'
    + 'help: one card is printed in full anyway, without clipping', 2);
}
if (wantPipelineCard && wantFull) {
  die('error: --full does not apply to card\n'
    + 'help: the card answer is unclipped but carries the spec line count, not the text —'
    + ' add --spec for the spec itself', 2);
}
const wantSpec = args.includes('--spec');
if (wantSpec && !wantPipelineCard) {
  die('error: --spec only makes sense together with card <id>\n'
    + `help: ${CMD} card <id> --spec adds the spec text to that card's answer`, 2);
}

const format = `format=${wantJson ? 'json' : 'toon'}`;
const url = wantPipelineCard
  ? `${BASE}/api/pipeline/card/${encodeURIComponent(wantPipelineCard)}?${format}${wantSpec ? '&spec=1' : ''}`
  : wantPipeline
    ? `${BASE}/api/pipeline?${format}${wantFull ? '&full=1' : ''}`
    : wantWindowCard
      ? `${BASE}/api/board/card/${encodeURIComponent(wantWindowCard)}?${format}`
      : `${BASE}/api/board?${format}${wantFull ? '&full=1' : ''}`;

let res;
try {
  res = await fetch(url, { signal: AbortSignal.timeout(180000) });
} catch (e) {
  // Not running, still starting up, or collecting the board for over three
  // minutes — three different troubles, and they are cured differently.
  const kind = String(e?.name || '');
  if (kind === 'TimeoutError' || kind === 'AbortError') {
    die(`error: Watchtower on ${BASE} did not answer within 3 minutes\n`
      + 'help: look at the window running bin\\watchtower.cmd — a source may have hung', 1);
  }
  die(`error: Watchtower is not running (${BASE} does not answer)\n`
    + 'help: start bin\\watchtower.cmd and repeat the command', 1);
}

const body = await res.text();
if (!res.ok) {
  // A 404 on our endpoint means the port holds a board started before
  // /api/board or /api/pipeline existed (or another program entirely). Its body
  // must not be relayed: the agent would get someone else's JSON instead of the
  // action it has to take.
  if (res.status === 404 && !wantWindowCard && !wantPipelineCard) {
    const endpoint = wantPipeline ? '/api/pipeline' : '/api/board';
    die(`error: the board on ${BASE} is an older build — it has no ${endpoint} endpoint\n`
      + 'help: close its window and start bin\\watchtower.cmd again', 1);
  }
  const type = String(res.headers.get('content-type') || '');
  // Watchtower reports its own trouble as plain text starting with "error:" —
  // that is printed as is. Anything else (JSON, HTML, another program's page) is
  // not passed through: the agent needs an action, not a raw dependency body.
  if (type.startsWith('text/plain') && body.trim().startsWith('error:')) {
    die(body.trim(), 1);
  }
  // --json asked for JSON: a JSON error body from the pipeline is already in
  // the shape the agent can parse, so it is printed as is.
  if (wantJson && (wantPipeline || wantPipelineCard) && type.startsWith('application/json')) {
    process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    process.exit(1);
  }
  die(`error: the board on ${BASE} answered with status ${res.status} and a body that is not a board\n`
    + 'help: check that bin\\watchtower.cmd is what listens on that port, and restart it', 1);
}

// Who we are and what this is — before the live data: an agent seeing an answer
// without the question must understand what this output is. With --json there is
// no header: there the answer must parse as JSON as a whole, and two extra lines
// would break it.
if (!wantJson) process.stdout.write(`bin: ${selfPath()}\ndescription: ${DESCRIPTION}\n`);
process.stdout.write(body.endsWith('\n') ? body : body + '\n');
