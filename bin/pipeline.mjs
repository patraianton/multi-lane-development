// The delivery pipeline: persistent cards that move from a spec to done.
//
// A Card is not a Window. A window is a live herdr session and disappears with
// the machine; a card lives in state/pipeline-cards.json, carries its spec, its
// comments, its per-stage clocks and its failure counters, and only ever leaves
// a stage through a validated transition.
//
// This module owns the whole pipeline: the store, the stage rules, the page
// endpoints and the agent view. watchtower.mjs only routes to it.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';
import { lanesLine } from './sprint-facts.mjs';
import {
  BadRequest, send, sendText, readBody,
  clipText, toonTable, agentParams,
} from './serve.mjs';

// ------------------------------------------------------------------- stages

// The stage a card sits in. Seven working stages, one terminal stage and Stuck,
// which is not a step of the road but where a card lands after its third
// consecutive failure and waits for a human. QA (decision 11, 2026-08-29) sits
// before done: the findings a sprint's reviews left behind land there as QA
// tickets, and nothing is done while one of them is open.
export const STAGES = [
  { key: 'spec', title: 'Spec' },
  { key: 'grilled', title: 'Grilled' },
  { key: 'ticketed', title: 'Ticketed' },
  { key: 'development', title: 'Development' },
  { key: 'local_check', title: 'Local check' },
  { key: 'ci_pr', title: 'CI/PR' },
  { key: 'review', title: 'Review' },
  { key: 'merged', title: 'Merged' },
  { key: 'done', title: 'Done' },
  { key: 'stuck', title: 'Stuck' },
];
const STAGE_KEYS = new Set(STAGES.map(s => s.key));

// Stage names from before decision 10 (2026-08-29): a card stored as
// "accepted", or waiting in "acceptance", is a done card. Read on load only.
const RENAMED_STAGES = { accepted: 'done', acceptance: 'done' };
// The QA column is gone (decision 19: QA is one run per sprint before done, not
// a step every card takes). A card stored in `qa` is read by what it was: a
// merged unit or a sprint waiting there is on main → merged; a finding parked
// there is a ticket nobody has picked up → ticketed.
const qaBecomes = src => (String(src?.unit ?? '') === 'QA' || /^QA\b/.test(String(src?.title ?? ''))) ? 'ticketed' : 'merged';
const stageKey = (s, src) => s === 'qa' ? qaBecomes(src) : (RENAMED_STAGES[s] ?? s);

// Every move a card may make on its own road. Everything else is a 400: a card
// never skips the grill, never walks backwards by hand and never leaves the
// terminal stage.
//
// The two ways off this map are deliberate and have their own endpoints, because
// neither is a step forward: a failure (back to Development, or to Stuck on the
// third one in a row) and a human pulling a card out of Stuck.
const MOVES = {
  spec: ['grilled'],
  grilled: ['ticketed'],
  ticketed: ['development'],
  development: ['local_check'],
  local_check: ['ci_pr'],
  ci_pr: ['review'],
  review: ['merged'],
  merged: ['done'],
  done: [],
  stuck: [],
};

// Stages whose time counts towards the card's delivery clock. Done is terminal:
// nothing is being spent there any more.
const OFF_THE_CLOCK = new Set(['done']);

// A failure is one of three kinds; each has its own counter on the card, because
// "the local check failed three times" and "the review said NO-GO three times"
// are different diseases. (The review kind was called "acceptance" while an
// acceptance stage existed — decision 10; old counters are read as review.)
const FAIL_KINDS = {
  local: 'localFails',
  ci: 'ciFails',
  review: 'reviewFails',
};

// The third consecutive failure sends the card to Stuck: something is looping
// and a human has to look, not the agent to try a fourth time.
const STUCK_AFTER = 3;

// Where a failure can happen at all: the stages where work is actually being
// checked. A card in Spec, Grilled or Ticketed has not been built yet, so "it
// failed" there is not a late report, it is a wrong request — and answering it
// would walk the card forward into Development around the grill and the
// tickets, which no move is allowed to do.
const CAN_FAIL = new Set(['development', 'local_check', 'ci_pr', 'review']);

// What the watchdog may write into a card's status line (Wave G writes it; the
// value is validated here so a wrong word never reaches the board).
const VERDICTS = ['moving', 'stalled', 'looping'];

// Stages the Watchdog scores. A missing or old Status on one of these is a
// signal: the checker is meant to refresh every intervalMin minutes.
const ACTIVE_STATUS_STAGES = new Set(['development', 'local_check', 'ci_pr', 'review']);
const DEFAULT_WATCHDOG_INTERVAL_MIN = 15;
const STALE_MULTIPLIER = 2;

// ------------------------------------------------------------------- limits

const LIMIT = {
  title: 200,
  spec: 20000,
  summary: 200,      // the short retelling a card shows instead of its spec
  // Reading from disk stays at the limit the summary was born with (1200): a
  // card stored before the cap dropped to 200 must come back as written, not
  // silently lose its tail to the next unrelated write. Only the API rejects.
  summaryOnDisk: 1200,
  author: 100,
  comment: 4000,
  link: 400,
  slotish: 100,      // lane, subscription, slot
  status: 400,
};

const LINK_KEYS = ['ticket', 'branch', 'pr', 'artifact'];

const NOTIFY_KINDS = ['artifact', 'stuck', 'done', 'assignSubscription'];

// -------------------------------------------------------------------- store

let FILE = '';
let state = null;         // { cards: [...] }
let loading = null;

// Board-wide extras the pipeline does not own (subscription names, Telegram
// senders). watchtower.mjs sets this on every config reload.
let BOARD = {
  subscriptions: [],
  notifyEnabled: false,
  senders: null,
};

// What is being built off the board (decision 14): watchtower.mjs runs the
// watch every sprint sweep and hands the findings here for the page and the
// agent views. `skipped` names the stale source when the watch did not run.
let OFF_BOARD = { at: null, findings: [], skipped: null };
// Idle lanes (decision 15): a free assigned lane while a startable unit waits.
// watchtower.mjs runs the watch every sprint sweep; findings carry `since`.
let IDLE_LANES = { at: null, findings: [] };
export function setOffBoard(next) {
  OFF_BOARD = {
    at: next?.at ?? null,
    findings: Array.isArray(next?.findings) ? next.findings : [],
    skipped: next?.skipped ?? null,
  };
}

export function setIdleLanes(next) {
  IDLE_LANES = {
    at: next?.at ?? null,
    findings: Array.isArray(next?.findings) ? next.findings : [],
  };
}

// Auto-dispatch (decision 16): what the board is about to send to a free
// lane — or would send, while WATCHTOWER_AUTO_DISPATCH is off — and what the
// journal says happened lately. rows: [{ card, unit, lane, base, state }].
let AUTO_DISPATCH = { at: null, on: false, rows: [] };
export function setAutoDispatch(next) {
  AUTO_DISPATCH = {
    at: next?.at ?? null,
    on: Boolean(next?.on),
    rows: Array.isArray(next?.rows) ? next.rows : [],
  };
}

export function configurePipeline(stateDir) {
  FILE = path.join(stateDir, 'pipeline-cards.json');
  state = null;
  loading = null;
}

export function setPipelineBoard(next = {}) {
  BOARD = {
    subscriptions: Array.isArray(next.subscriptions)
      ? next.subscriptions.map(s => String(s ?? '').trim()).filter(Boolean)
      : [],
    notifyEnabled: Boolean(next.notifyEnabled),
    senders: next.senders && typeof next.senders === 'object' ? next.senders : null,
  };
}

function str(v, limit) {
  return String(v ?? '').slice(0, limit);
}

// A summary arriving over the API. Unlike the fields above it is never clipped:
// the author would keep seeing a different text than they wrote. Over the limit
// is a 400 naming both numbers, so they know how much to cut without counting.
function checkedSummary(v) {
  const summary = String(v ?? '').trim();
  if (summary.length > LIMIT.summary) {
    throw new BadRequest(`the summary is ${summary.length} characters long`
      + ` — the limit is ${LIMIT.summary}`);
  }
  return summary;
}

// Reading a card from disk. Every field is rebuilt from scratch: a file edited
// by hand, truncated by a crash or written by an older build must still produce
// a card the board can draw, never an exception on the way to the page.
function normCard(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id ?? '').trim();
  if (!id) return null;
  const title = str(src.title, LIMIT.title).trim();
  if (!title) return null;

  const stage = STAGE_KEYS.has(stageKey(src.stage, src)) ? stageKey(src.stage, src) : 'spec';
  const createdAt = isoOr(src.createdAt, new Date().toISOString());

  const stageHistory = [];
  for (const h of Array.isArray(src.stageHistory) ? src.stageHistory : []) {
    if (!h || !STAGE_KEYS.has(stageKey(h.stage, src))) continue;
    stageHistory.push({
      stage: stageKey(h.stage, src),
      enteredAt: isoOr(h.enteredAt, createdAt),
      leftAt: isoOr(h.leftAt, null),
    });
  }
  // A card with no readable history still has to have a clock: it entered its
  // current stage at least when it was created.
  if (!stageHistory.length) stageHistory.push({ stage, enteredAt: createdAt, leftAt: null });

  const counters = {};
  for (const key of Object.values(FAIL_KINDS)) counters[key] = int(src.counters?.[key]);
  // Stored before decision 10: the review counter was named after the stage.
  if (!counters.reviewFails && src.counters?.acceptanceFails) counters.reviewFails = int(src.counters.acceptanceFails);

  const links = {};
  for (const key of LINK_KEYS) links[key] = str(src.links?.[key], LIMIT.link).trim();

  const comments = [];
  for (const c of Array.isArray(src.comments) ? src.comments : []) {
    const author = str(c?.author, LIMIT.author).trim();
    const text = str(c?.text, LIMIT.comment).trim();
    if (!author || !text) continue;
    comments.push({ author, text, at: isoOr(c?.at, createdAt) });
  }

  const verdict = VERDICTS.includes(src.status?.verdict) ? src.status.verdict : '';
  const notified = {};
  const rawNotified = src.notified && typeof src.notified === 'object' && !Array.isArray(src.notified)
    ? src.notified : {};
  for (const kind of NOTIFY_KINDS) {
    const at = isoOr(rawNotified[kind], null);
    if (at) notified[kind] = at;
  }
  // The founders' answers on the review artifact: when they were first seen,
  // how many, and who saw them. Absent until an answer exists.
  const rawAnswered = src.artifactAnswered && typeof src.artifactAnswered === 'object'
    && !Array.isArray(src.artifactAnswered) ? src.artifactAnswered : null;
  const answeredAt = rawAnswered ? isoOr(rawAnswered.at, null) : null;
  const card = {
    id,
    title,
    spec: str(src.spec, LIMIT.spec),
    // Cards written before the summary existed simply have an empty one; ones
    // written before the 200 cap keep their longer text until rewritten.
    summary: str(src.summary, LIMIT.summaryOnDisk).trim(),
    stage,
    createdAt,
    stageHistory,
    counters,
    consecutiveFails: int(src.consecutiveFails),
    links,
    lane: str(src.lane, LIMIT.slotish).trim(),
    subscription: str(src.subscription, LIMIT.slotish).trim(),
    slot: str(src.slot, LIMIT.slotish).trim(),
    window: str(src.window, LIMIT.slotish).trim(),
    // A unit card: one ticket of a sprint card (parent), spawned by the board
    // from the sprint facts. Empty on every other card.
    parent: str(src.parent, LIMIT.slotish).trim(),
    ticket: int(src.ticket),
    unit: str(src.unit, LIMIT.slotish).trim(),
    status: {
      text: str(src.status?.text, LIMIT.status).trim(),
      verdict,
      at: isoOr(src.status?.at, null),
    },
    comments,
  };
  // Omit an empty notified map so cards that never sent look like they did
  // before this wave (byte-identical when Telegram is off).
  if (Object.keys(notified).length) card.notified = notified;
  if (answeredAt) {
    card.artifactAnswered = {
      at: answeredAt,
      answers: Math.max(1, int(rawAnswered.answers)),
      by: str(rawAnswered.by, LIMIT.author).trim(),
    };
  }
  return card;
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A timestamp is kept only if it really is one. A broken value falls back
// instead of turning every clock on the board into NaN.
function isoOr(v, fallback) {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}

function normState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cards = [];
  const seen = new Set();
  for (const c of Array.isArray(src.cards) ? src.cards : []) {
    const card = normCard(c);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return { cards };
}

// The file is read once per board lifetime, and that read stays single even
// under concurrent requests: otherwise each of them starts its own parse and the
// edits made in the others are lost.
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

// An edit: change memory first, then write to disk through the shared atomic
// queue. If the write failed, roll memory back — otherwise the board would show
// the change as saved and it would be gone after a restart.
//
// Two details the rollback depends on:
//   1. edits are serialised, one at a time. Concurrent POSTs are normal here, and
//      a rollback taken while another edit is in flight would undo that other
//      edit too — although its own write to disk had already succeeded;
//   2. the rollback refills the store in place instead of replacing the object.
//      Nothing then keeps a reference to an orphaned store that is written to and
//      silently lost.
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
    // A rejected edit must leave the store exactly as it was, even if the change
    // was refused halfway through.
    restore(st, backup);
    throw e;
  }
  try {
    await writeJsonAtomic(FILE, st);
  } catch (e) {
    restore(st, backup);
    throw new Error(`could not save the card to disk: ${String(e?.message || e)}`);
  }
  return result;
}

function restore(st, backup) {
  st.cards.length = 0;
  for (const card of normState(JSON.parse(backup)).cards) st.cards.push(card);
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// -------------------------------------------------------------------- clocks

// Moving a card: close the segment it is leaving, open the one it enters. The
// history is the only source of the clocks, so nothing else may be recorded.
function enterStage(card, stage, nowIso) {
  const open = card.stageHistory[card.stageHistory.length - 1];
  if (open && !open.leftAt) open.leftAt = nowIso;
  card.stageHistory.push({ stage, enteredAt: nowIso, leftAt: null });
  card.stage = stage;
}

function spanMs(seg, now) {
  const from = Date.parse(seg.enteredAt);
  const to = seg.leftAt ? Date.parse(seg.leftAt) : now;
  const ms = to - from;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// The clocks of one card, all of them out of stageHistory:
//   byStage — every stage the card has been in, summed over its visits;
//   total   — the delivery time, done left out;
//   running — is the total still growing right now (the page ticks it itself).
export function clocks(card, now = Date.now()) {
  const byStage = {};
  let total = 0;
  for (const seg of card.stageHistory) {
    const ms = spanMs(seg, now);
    byStage[seg.stage] = (byStage[seg.stage] ?? 0) + ms;
    if (!OFF_THE_CLOCK.has(seg.stage)) total += ms;
  }
  return { total, byStage, running: !OFF_THE_CLOCK.has(card.stage) };
}

// A duration in plain words. Anything under a minute is "<1m": a board that
// counts seconds invites staring at it.
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---------------------------------------------------------------- status / stale
//
// Status is "what is happening right now", written by the Watchdog. It is not
// the Stage. A Status is stale when an active card has none, or the one it
// has is older than twice the Watchdog's interval (default 15 min → 30 min).
// Without a watchdog.json the missing-Status case is silent: the surface
// shows nothing until a Status exists.

function hasStatus(card) {
  const s = card?.status;
  if (!s || typeof s !== 'object') return false;
  return Boolean(String(s.text ?? '').trim() || s.verdict || s.at);
}

function statusAgeMs(card, now = Date.now()) {
  const t = Date.parse(card?.status?.at);
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

async function loadWatchdogMeta() {
  const intervalMin = DEFAULT_WATCHDOG_INTERVAL_MIN;
  const empty = {
    configured: false,
    intervalMin,
    staleAfterMs: intervalMin * STALE_MULTIPLIER * 60 * 1000,
  };
  if (!FILE) return empty;
  const raw = await readJsonSoft(path.join(path.dirname(FILE), 'watchdog.json'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  let next = intervalMin;
  const n = Number(raw.intervalMin);
  if (Number.isFinite(n) && n >= 1) next = n;
  return {
    configured: Boolean(String(raw.boardUrl ?? '').trim()),
    intervalMin: next,
    staleAfterMs: next * STALE_MULTIPLIER * 60 * 1000,
  };
}

function isStaleStatus(card, meta, now = Date.now()) {
  if (!ACTIVE_STATUS_STAGES.has(card.stage)) return false;
  if (!hasStatus(card)) return Boolean(meta?.configured);
  const age = statusAgeMs(card, now);
  if (age == null) return true;
  return age > (meta?.staleAfterMs ?? emptyStaleAfterMs());
}

function emptyStaleAfterMs() {
  return DEFAULT_WATCHDOG_INTERVAL_MIN * STALE_MULTIPLIER * 60 * 1000;
}

function staleList(cards, meta, now) {
  return cards.filter(c => isStaleStatus(c, meta, now));
}

// Used by the windows agent view (/api/board problems) so a stale Status is
// visible next to ssh/gh failures, without that view owning pipeline rules.
export async function pipelineStaleProblems() {
  const st = await load();
  const meta = await loadWatchdogMeta();
  const now = Date.now();
  const cards = staleList(st.cards, meta, now);
  return {
    count: cards.length,
    intervalMin: meta.intervalMin,
    staleAfterMin: meta.intervalMin * STALE_MULTIPLIER,
    ids: cards.map(c => c.id),
  };
}

// ------------------------------------------------------------------- actions
//
// Every action below is written as "validate, then change": a request that fails
// validation must leave the store exactly as it was.

function need(cards, id) {
  const card = cards.find(c => c.id === String(id ?? ''));
  if (!card) throw new BadRequest(`there is no card "${String(id ?? '')}" in the pipeline`);
  return card;
}

function snapshotNotify(card) {
  return {
    stage: card.stage,
    artifact: card.links.artifact,
    lane: card.lane,
    subscription: card.subscription,
  };
}

// Decide which Telegram messages this edit earned, and stamp the card in the
// same write so a restart cannot send the same event again. A new entry into
// stuck / done may notify again (fresh timestamp). Artifact and
// assign-subscription fire once until that field is first set.
function takeNotifyEvents(before, card) {
  const events = [];
  if (!BOARD.notifyEnabled) return events;
  const now = new Date().toISOString();
  const stamp = (kind) => {
    if (!card.notified) card.notified = {};
    card.notified[kind] = now;
    events.push(kind);
  };
  if (card.stage === 'stuck' && before.stage !== 'stuck') stamp('stuck');
  // A sprint or a standalone card finishing is the founders' cue; a unit card
  // finishing is one of many and stays quiet.
  if (card.stage === 'done' && before.stage !== 'done' && !card.parent) stamp('done');
  if (card.stage === 'grilled'
      && card.links.artifact
      && card.links.artifact !== before.artifact
      && !card.notified?.artifact) {
    stamp('artifact');
  }
  if (card.stage === 'grilled'
      && !card.subscription
      && card.lane
      && !before.lane
      && BOARD.subscriptions.length
      && !card.notified?.assignSubscription) {
    stamp('assignSubscription');
  }
  return events;
}

async function editCard(id, fn) {
  return commit(st => {
    const card = need(st.cards, id);
    const before = snapshotNotify(card);
    fn(card);
    const events = takeNotifyEvents(before, card);
    return { card, events };
  });
}

function stuckDigest(card) {
  const c = card.counters ?? {};
  const bits = [];
  if (c.localFails) bits.push(`local ${c.localFails}`);
  if (c.ciFails) bits.push(`ci ${c.ciFails}`);
  if (c.reviewFails) bits.push(`review ${c.reviewFails}`);
  const counters = bits.length
    ? bits.join(', ') + (card.consecutiveFails ? ` (${card.consecutiveFails} in a row)` : '')
    : (card.consecutiveFails ? `${card.consecutiveFails} in a row` : 'no counters');
  const last = card.comments[card.comments.length - 1];
  const comment = last
    ? `${last.author}: ${last.text}`
    : '(none)';
  return `counters: ${counters}\nlast comment: ${comment}`;
}

async function emitNotifications(card, events) {
  if (!BOARD.notifyEnabled || !events?.length || !BOARD.senders) return;
  const s = BOARD.senders;
  for (const kind of events) {
    try {
      if (kind === 'artifact' && s.artifactReady) await s.artifactReady(card);
      else if (kind === 'stuck' && s.stuck) await s.stuck(card, stuckDigest(card));
      else if (kind === 'done' && s.done) await s.done(card);
      else if (kind === 'assignSubscription' && s.assignSubscription) {
        await s.assignSubscription(card, BOARD.subscriptions);
      }
    } catch (e) {
      console.error(`${new Date().toISOString()} telegram notify ${kind} failed: ${String(e?.message || e)}`);
    }
  }
}

function unwrapMutation(result) {
  if (result && typeof result === 'object' && Array.isArray(result.events) && result.card) {
    return result;
  }
  return { card: result, events: [] };
}

function formatBy(by) {
  if (by == null || by === '') return '';
  if (typeof by === 'string' || typeof by === 'number') return String(by).trim();
  if (typeof by !== 'object' || Array.isArray(by)) return '';
  const name = str(by.name, LIMIT.author).trim();
  const tag = str(by.tag, LIMIT.author).trim();
  if (name && tag) return `${name} (${tag})`;
  return name || tag;
}

function authorFromBy(by) {
  if (by == null || by === '') return '';
  if (typeof by === 'string' || typeof by === 'number') return str(by, LIMIT.author).trim();
  if (typeof by !== 'object' || Array.isArray(by)) return '';
  return str(by.name, LIMIT.author).trim() || str(by.tag, LIMIT.author).trim();
}

async function createCard(body) {
  const title = str(body.title, LIMIT.title).trim();
  if (!title) throw new BadRequest('a title is required');
  const spec = str(body.spec, LIMIT.spec);
  const now = new Date().toISOString();
  const card = {
    id: newId(),
    title,
    spec,
    summary: checkedSummary(body.summary),
    stage: 'spec',
    createdAt: now,
    stageHistory: [{ stage: 'spec', enteredAt: now, leftAt: null }],
    counters: { localFails: 0, ciFails: 0, reviewFails: 0 },
    consecutiveFails: 0,
    links: { ticket: '', branch: '', pr: '', artifact: '' },
    lane: '',
    subscription: '',
    slot: '',
    window: '',
    parent: '',
    ticket: 0,
    unit: '',
    status: { text: '', verdict: '', at: null },
    comments: [],
  };
  await commit(st => { st.cards.push(card); });
  return card;
}

// An unknown id on delete is a 404 with the live ids — the same answer as
// reading a card — not a 400: the request is well-formed, the card is gone.
class MissingCard extends Error {
  constructor(id, ids) {
    super(`there is no card "${id}" in the pipeline`);
    this.ids = ids;
  }
}

// Deleting a card is the owner's decision after the work has landed, not a
// stage: the card leaves the store for good, whatever stage it was in. The
// removal goes through the same commit queue as every other mutation, so it is
// written atomically and can never race a concurrent edit.
async function deleteCard(body) {
  const id = String(body.id ?? '').trim();
  return commit(st => {
    const i = st.cards.findIndex(c => c.id === id);
    if (i < 0) throw new MissingCard(id, st.cards.map(c => c.id));
    const removed = st.cards.splice(i, 1)[0];
    // A sprint's unit cards are its own: they leave with it.
    for (let k = st.cards.length - 1; k >= 0; k--) if (st.cards[k].parent === id) st.cards.splice(k, 1);
    return removed;
  });
}

// A linked review artifact is the card's open question: nothing enters
// ticketed while it is unanswered. The board marks the answers itself (the
// artifact-answers sweep reads the desktop Lavish state or the Cloudflare
// instance), or an agent posts artifact-answered when they came another way.
function requireArtifactAnswered(card, to) {
  if (to !== 'ticketed' || !card.links.artifact || card.artifactAnswered) return;
  throw new BadRequest('the review artifact has not been answered yet — a card enters "ticketed"'
    + ' only after the founders answer on the artifact (the board marks that itself; or POST'
    + ' /pipeline/card/artifact-answered when the answers came another way)');
}

async function moveCard(body) {
  const to = String(body.to ?? '');
  if (!STAGE_KEYS.has(to)) {
    throw new BadRequest(`unknown stage "${to}" — stages are ${[...STAGE_KEYS].join(', ')}`);
  }
  return editCard(body.id, card => {
    const allowed = MOVES[card.stage] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequest(allowed.length
        ? `a card in "${card.stage}" can only move to ${allowed.join(', ')}`
        : `a card in "${card.stage}" cannot be moved by hand`
          + (card.stage === 'stuck' ? ' — use /pipeline/card/unstuck' : ''));
    }
    // Development starts only from written tickets: the CTO's work in Ticketed
    // is the GitHub tickets, and links.ticket is the proof it happened.
    if (card.stage === 'ticketed' && to === 'development' && !card.links.ticket) {
      throw new BadRequest('a card leaves "ticketed" only with a ticket link'
        + ' — set links.ticket (POST /pipeline/card/update) to the GitHub ticket first');
    }
    requireArtifactAnswered(card, to);
    enterStage(card, to, new Date().toISOString());
    // A stage passed is the run that did not fail: the streak starts over.
    card.consecutiveFails = 0;
  });
}

async function failCard(body) {
  const kind = String(body.kind ?? '');
  if (!FAIL_KINDS[kind]) {
    throw new BadRequest(`unknown failure kind "${kind}" — use local, ci or review`);
  }
  return editCard(body.id, card => {
    if (card.stage === 'done') throw new BadRequest('a done card cannot fail');
    if (card.stage === 'stuck') throw new BadRequest('the card is already stuck — return it to development first');
    if (!CAN_FAIL.has(card.stage)) {
      throw new BadRequest(`a card in "${card.stage}" cannot fail — nothing has been run yet;`
        + ` a failure is only reported from ${[...CAN_FAIL].join(', ')}`);
    }
    card.counters[FAIL_KINDS[kind]] += 1;
    card.consecutiveFails += 1;
    // Back to Development to be fixed — unless this is the third failure in a
    // row, and then the loop itself is the problem and a human has to see it.
    const to = card.consecutiveFails >= STUCK_AFTER ? 'stuck' : 'development';
    enterStage(card, to, new Date().toISOString());
  });
}

async function unstuckCard(body) {
  return editCard(body.id, card => {
    if (card.stage !== 'stuck') throw new BadRequest('the card is not stuck');
    enterStage(card, 'development', new Date().toISOString());
    // A human decided what to do about the loop, so the card gets a fresh run of
    // three attempts. Otherwise the very next failure would bounce it straight
    // back into Stuck and the decision would have bought nothing.
    card.consecutiveFails = 0;
  });
}

// The card's short retelling: what the page shows instead of the whole spec.
// {id, summary} writes or replaces it; an empty string clears it. The spec
// itself is not touched.
async function summaryCard(body) {
  if (typeof body.summary !== 'string') {
    throw new BadRequest('a summary text is required (send summary: "" to clear it)');
  }
  const summary = checkedSummary(body.summary);
  return editCard(body.id, card => { card.summary = summary; });
}

async function commentCard(body) {
  const author = str(body.author, LIMIT.author).trim();
  const text = str(body.text, LIMIT.comment).trim();
  if (!author) throw new BadRequest('an author is required');
  if (!text) throw new BadRequest('a comment text is required');
  return editCard(body.id, card => {
    card.comments.push({ author, text, at: new Date().toISOString() });
  });
}

// The card's attachments: what it links to, where it is being built and who pays
// for the run. Only the keys actually sent are touched — an omitted field keeps
// its value, an empty string clears it.
async function updateCard(body) {
  if (body.links !== undefined
      && (!body.links || typeof body.links !== 'object' || Array.isArray(body.links))) {
    throw new BadRequest('links must be an object');
  }
  if (body.links) {
    for (const key of Object.keys(body.links)) {
      if (!LINK_KEYS.includes(key)) {
        throw new BadRequest(`unknown link "${key}" — links are ${LINK_KEYS.join(', ')}`);
      }
    }
  }
  if (body.status !== undefined
      && (!body.status || typeof body.status !== 'object' || Array.isArray(body.status))) {
    throw new BadRequest('status must be an object');
  }
  const verdict = body.status?.verdict;
  if (verdict !== undefined && verdict !== '' && !VERDICTS.includes(verdict)) {
    throw new BadRequest(`unknown verdict "${verdict}" — verdicts are ${VERDICTS.join(', ')}`);
  }
  const spec = body.spec;
  if (spec !== undefined && typeof spec !== 'string') throw new BadRequest('spec must be a text');

  return editCard(body.id, card => {
    if (body.links) {
      const previousArtifact = card.links.artifact;
      for (const key of LINK_KEYS) {
        if (body.links[key] !== undefined) card.links[key] = str(body.links[key], LIMIT.link).trim();
      }
      // A new review page is a new round of questions: the answered mark
      // belonged to the old one.
      if (card.links.artifact && card.links.artifact !== previousArtifact) delete card.artifactAnswered;
    }
    for (const key of ['lane', 'subscription', 'slot', 'window']) {
      if (body[key] !== undefined) card[key] = str(body[key], LIMIT.slotish).trim();
    }
    if (spec !== undefined) card.spec = str(spec, LIMIT.spec);
    if (body.status) {
      if (body.status.text !== undefined) card.status.text = str(body.status.text, LIMIT.status).trim();
      if (verdict !== undefined) card.status.verdict = verdict;
      card.status.at = new Date().toISOString();
    }
  });
}

// The Watchdog's contract: POST /pipeline/card/<id>/status { text, verdict }.
// Id is in the path, not the body. Verdict is required and must be one of the
// three words; text is clipped to LIMIT.status. This is a refresh, not a
// second event — posting the same Status twice only updates `at`.
async function writeStatus(id, body) {
  const verdict = String(body?.verdict ?? '').trim().toLowerCase();
  if (!VERDICTS.includes(verdict)) {
    throw new BadRequest(
      verdict
        ? `unknown verdict "${verdict}" — verdicts are ${VERDICTS.join(', ')}`
        : `a verdict is required — verdicts are ${VERDICTS.join(', ')}`);
  }
  const text = str(body?.text, LIMIT.status).trim();
  return editCard(id, card => {
    card.status.text = text;
    card.status.verdict = verdict;
    card.status.at = new Date().toISOString();
  });
}

// Owner (or the Telegram bot on their behalf) picks who pays for the run.
// Only from Grilled, only while none is set; the card then walks into
// Ticketed in the same write, where the CTO writes the GitHub tickets before
// development starts.
async function assignSubscription(body) {
  const subscription = str(body.subscription, LIMIT.slotish).trim();
  if (!subscription) throw new BadRequest('a subscription is required');
  const by = formatBy(body.by);
  if (!by) throw new BadRequest('who assigned it (by) is required');
  const known = BOARD.subscriptions;
  if (!known.includes(subscription)) {
    throw new BadRequest(`unknown subscription "${subscription}" — known: ${
      known.length ? known.join(', ') : '(none configured)'}`);
  }
  const id = String(body.cardId ?? body.id ?? '').trim();
  if (!id) throw new BadRequest('a card id is required');
  return editCard(id, card => {
    if (card.stage !== 'grilled') {
      throw new BadRequest(`a subscription can only be assigned while the card is in "grilled", this one is in "${card.stage}"`);
    }
    if (card.subscription) {
      throw new BadRequest(`a subscription is already assigned ("${card.subscription}")`);
    }
    requireArtifactAnswered(card, 'ticketed');
    const now = new Date().toISOString();
    card.subscription = subscription;
    enterStage(card, 'ticketed', now);
    card.consecutiveFails = 0;
    card.comments.push({
      author: authorFromBy(body.by) || 'board',
      text: `subscription ${subscription} assigned by ${by}`,
      at: now,
    });
  });
}

// The founders answered on the review artifact. Idempotent: the first mark
// keeps its time and writes one comment; a later mark only raises the count.
async function artifactAnsweredCard(body) {
  const answers = Math.max(1, int(body.answers));
  const at = isoOr(body.at, new Date().toISOString());
  const by = str(body.by, LIMIT.author).trim() || 'board';
  return editCard(body.id, card => {
    if (!card.links.artifact) {
      throw new BadRequest('the card has no artifact link — set links.artifact (POST /pipeline/card/update) first');
    }
    if (card.artifactAnswered) {
      if (answers > card.artifactAnswered.answers) card.artifactAnswered.answers = answers;
      return;
    }
    card.artifactAnswered = { at, answers, by };
    card.comments.push({
      author: by,
      text: `review artifact answered — ${answers} answer${answers === 1 ? '' : 's'} seen (${card.links.artifact})`,
      at: new Date().toISOString(),
    });
  });
}

// The stages where a linked artifact is still the card's open question.
const PAPER_STAGES = new Set(['spec', 'grilled', 'ticketed']);

// "6 of 7 busy (hetzner 4/4, hzci 2/3; offline 3)" — the CI slot pool.
function ciSlotsLine(ci) {
  if (!ci || !ci.total) return '-';
  const hosts = Object.entries(ci.byHost).map(([h, v]) => `${h} ${v.busy}/${v.online}`).join(', ');
  return `${ci.busy} of ${ci.online} busy (${hosts}${ci.offline ? `; offline ${ci.offline}` : ''})`;
}

// The sprint in numbers for the list views; the full table is on the card.
function sprintSummary(s) {
  return {
    umbrella: s.umbrella,
    umbrellaOpen: s.umbrellaOpen ?? null,
    ...s.counts,
    ciSlots: s.ciSlots ?? null,
    lanes: s.lanes.map(l => ({ host: l.host, lane: l.lane, unit: l.unit, ticket: l.ticket, busy: l.busy })),
    laneCount: s.laneCount,
    free: s.free,
    stale: s.stale,
  };
}

function artifactCell(card) {
  if (!card.links.artifact) return '-';
  if (!card.artifactAnswered) return PAPER_STAGES.has(card.stage) ? 'awaiting answers' : 'no answers recorded';
  const a = card.artifactAnswered;
  return `answered ${a.at} (${a.answers} answer${a.answers === 1 ? '' : 's'}, by ${a.by || 'board'})`;
}

// The artifact-answers sweep (watchtower.mjs runs it on a timer): for every
// card whose linked artifact is still unanswered on a paper stage, ask the
// probe how many founder answers exist and mark the card when there are any.
// The probe reads without draining anything — the CTO's poll still receives
// every answer. Returns what was checked and what was marked.
export async function sweepArtifactAnswers(probe) {
  const st = await load();
  const due = st.cards.filter(c => c.links.artifact && !c.artifactAnswered && PAPER_STAGES.has(c.stage));
  let marked = 0;
  for (const card of due) {
    let seen;
    try { seen = await probe(card.links.artifact); }
    catch (e) { throw new Error(`artifact of card ${card.id}: ${String(e?.message || e)}`); }
    if (!seen || !(seen.answers > 0)) continue;
    await artifactAnsweredCard({ id: card.id, answers: seen.answers, at: seen.lastAt, by: seen.source || 'board' });
    marked += 1;
  }
  return { checked: due.length, marked };
}

// --------------------------------------------------------------- page view

// What the page polls. The clocks are NOT computed here on purpose: the page
// gets stageHistory and ticks the numbers itself, so a card's clock moves every
// second without a request per second.
async function pageData() {
  const st = await load();
  const meta = await loadWatchdogMeta();
  return {
    stages: STAGES,
    stuckAfter: STUCK_AFTER,
    offTheClock: [...OFF_THE_CLOCK],
    // Whether this board uses the subscription/Telegram flow at all. A board
    // with no subscriptions configured keeps its plain grilled -> Ticketed
    // button and never shows "waiting for a subscription": the assign endpoint
    // has no names to offer there anyway.
    usesSubscriptions: BOARD.subscriptions.length > 0,
    watchdogIntervalMin: meta.intervalMin,
    watchdogConfigured: meta.configured,
    offBoard: OFF_BOARD,
    idleLanes: IDLE_LANES,
    autoDispatch: AUTO_DISPATCH,
    cards: st.cards.map(c => cardExtras(c, st.cards)),
  };
}

// ---------------------------------------------------------------- shadow
//
// Step 1 of "the board decides the stage itself": for every stream card (a card
// with a window) the board computes what stage it WOULD set from observable
// facts — open PRs, merged PRs, open unit tickets of the umbrella, lanes — and
// writes it NOWHERE. The verdict is shown on the card and in the JSON, so the
// rule can be checked against reality before any automatic transition exists.
// Facts arrive from watchtower.mjs after every sweep of the windows board.
//
// Two hard rules, decided by the design review:
//   - unknown is never read as empty: a dead or stale source voids every verdict;
//   - a stream whose sprint scope is not machine-readable (no units:"issues"
//     promise in stream-watch, no branch prefixes, no umbrella) can never reach
//     done — the card says what is missing instead.
const AUTO_ELIGIBLE = new Set(['development', 'local_check', 'ci_pr', 'review', 'merged', 'done']);
let shadowMap = new Map(); // card id -> { would, same, reasons, at }

// Sprint facts (bin/sprint-facts.mjs): for a card whose ticket link is an
// umbrella issue, its unit tickets bound to lanes and PRs by facts.
// watchtower.mjs recomputes them after every sweep of the live sources.
let sprintMap = new Map(); // card id -> sprint

export function setCardSprints(map) {
  sprintMap = map instanceof Map ? map : new Map();
}

// The cards as stored, for the board's sweeps (read-only by contract).
export async function listPipelineCards() {
  const st = await load();
  return st.cards;
}

function cardExtras(c, all = []) {
  const extra = {};
  if (shadowMap.has(c.id)) extra.shadow = shadowMap.get(c.id);
  if (sprintMap.has(c.id)) extra.sprint = sprintMap.get(c.id);
  if (c.parent) {
    const parent = all.find(p => p.id === c.parent);
    if (parent) extra.sprintTitle = parent.title;
    const sp = sprintMap.get(c.parent);
    const u = [...(sp?.units ?? []), ...(sp?.qaTickets ?? [])].find(x => x.ticket === c.ticket);
    if (u) extra.unitFacts = { lane: u.lane, pr: u.pr, merged: u.merged, state: u.state, open: u.open, deps: u.deps ?? [], qa: Boolean(u.qa) };
  }
  return Object.keys(extra).length ? { ...c, ...extra } : c;
}

// ----------------------------------------------------------- unit cards
//
// After ticketed a sprint is its unit cards: one card per unit ticket, spawned
// here from the sprint facts, its branch / PR / lane refreshed every sweep, and
// walked forward by facts alone — on a busy lane → development, the lane
// running the project's local check → local_check, PR open → ci_pr, PR
// merged → done (a unit's review IS the GO its merge required). Never
// backwards, never out of stuck, never while a source is stale: unknown is not
// empty. The sprint card itself is moved by people (and, later, ADR-0006).
const ROAD_ORDER = STAGES.filter(s => s.key !== 'stuck').map(s => s.key);

function unitTitle(u) {
  const bare = String(u.title ?? '').replace(/^\s*[A-Z][A-Z0-9-]*-U\d{1,3}\s*[:—-]\s*/i, '').trim();
  return str(`${u.unit ? u.unit + ' ' : ''}#${u.ticket}${bare ? ' — ' + bare : ''}`, LIMIT.title);
}

function unitTargetStage(u) {
  // Merged is delivered to main, not accepted: the unit is done once its
  // ticket is closed after the merge (decision 13) — the PR's auto-close does
  // not count. For a rollout unit that close follows the production probe.
  // A QA finding closed with no fix behind it is accepted the same way.
  if (u.accepted) return 'done';
  // On main, waiting: for the rest of the sprint, for the sprint's one QA run
  // (runbook §7 — not a column, decision 19), for the acceptance close.
  if (u.merged) return 'merged';
  // Review (decision 17): the PR is open and its CI is green — the code waits
  // for a reader, then for the merge. A red or running CI, or a NO-GO whose
  // fix is being written, is CI/PR.
  if (u.pr) return (u.pr.ci?.color === 'green' && u.pr.verdict?.go !== false) ? 'review' : 'ci_pr';
  if (u.lane?.check) return 'local_check';
  if (u.lane?.busy) return 'development';
  // A QA finding nobody has picked up is a ticket like any other: ticketed.
  return null;
}

// What the facts would change, without changing anything — so a sweep that
// finds nothing new writes nothing to disk.
function unitPlan(cards, sprints) {
  const plan = [];
  for (const [sprintId, s] of sprints) {
    const sprint = cards.find(c => c.id === sprintId);
    if (!sprint || sprint.parent || ['spec', 'grilled'].includes(sprint.stage)) continue;
    const units = s.units ?? [];
    const qa = s.qaTickets ?? [];
    const allMerged = units.every(u => u.merged || !u.open);
    for (const u of [...units, ...qa]) {
      const card = cards.find(c => c.parent === sprintId && c.ticket === u.ticket);
      const lane = u.lane ? `${u.lane.host}/${u.lane.lane}` : '';
      const pr = str(u.merged?.url || u.pr?.url || card?.links.pr || '', LIMIT.link);
      const branch = u.branch ? str(u.branch, LIMIT.link) : (card?.links.branch ?? '');
      // The CI slot: the runner the PR's check is on right now (ADR-0005's
      // slot, read from GitHub rather than assigned).
      const slot = str(u.pr?.runner?.name ?? '', LIMIT.slotish);
      // A ticket that gained the qa label after its card was spawned becomes a
      // QA card: the label is the fact, the card follows it.
      const unit = str(u.unit ?? '', LIMIT.slotish);
      const target = (!s.stale?.length && card?.stage !== 'stuck') ? unitTargetStage(u) : null;
      let move = card && target && ROAD_ORDER.indexOf(target) > ROAD_ORDER.indexOf(card.stage) ? target : null;
      // One step back that is a fact, not a failure (decision 18): a card that
      // reached done on its ticket's auto-close — seen before the merge behind
      // it was — goes back to Merged. Only while the sprint is not done: an
      // accepted sprint stays as it was.
      if (card && !move && card.stage === 'done' && target === 'merged' && u.merged && !u.accepted && sprint.stage !== 'done') move = target;
      // A NO-GO on a card in review is a review failure: back to development
      // for the fix round (the third in a row → stuck), counted on the card.
      // Only a verdict newer than the card's entry into review counts once.
      const noGo = card?.stage === 'review' && u.pr?.verdict?.go === false ? u.pr.verdict : null;
      const enteredReview = card ? [...(card.stageHistory ?? [])].reverse().find(h => h.stage === 'review')?.enteredAt : null;
      if (noGo && (!noGo.at || !enteredReview || Date.parse(noGo.at) > Date.parse(enteredReview))) {
        plan.push({ kind: 'review-fail', id: card.id, lane, pr, branch, slot, unit, verdict: noGo });
        continue;
      }
      if (!card) plan.push({ kind: 'spawn', sprintId, u, lane, pr, branch, slot, target: target && target !== 'ticketed' ? target : null });
      else if (move || card.lane !== lane || card.links.pr !== pr || card.links.branch !== branch || card.slot !== slot || (unit && card.unit !== unit)) {
        plan.push({ kind: 'refresh', id: card.id, lane, pr, branch, slot, unit, move });
      }
    }
    // The sprint's own stage follows its units: development once any unit has
    // started; QA once every unit is merged (or closed) — the scope is
    // delivered, what remains is the acceptance of each unit and the findings
    // the reviews left behind (decisions 11, 13); done once every unit is
    // accepted, the QA tickets are closed and the umbrella is closed — the
    // umbrella's close is the pass declared. Forward only, facts only.
    if (units.length && !s.stale?.length && sprint.stage !== 'stuck') {
      const allAccepted = units.every(u => u.accepted);
      const qaDone = qa.every(u => u.merged || !u.open);
      const finished = allMerged && allAccepted && qaDone && s.umbrellaOpen === false;
      const anyStarted = units.some(u => u.lane || u.pr || u.merged);
      let to = null;
      if (allMerged && ['ticketed', 'development', 'local_check', 'ci_pr', 'review'].includes(sprint.stage)) to = finished ? 'done' : 'merged';
      else if (finished && sprint.stage === 'merged') to = 'done';
      else if (anyStarted && sprint.stage === 'ticketed') to = 'development';
      if (to) plan.push({ kind: 'sprint-stage', id: sprintId, to });
    }
  }
  return plan;
}

export async function syncSprintUnits(sprints) {
  if (!(sprints instanceof Map) || !sprints.size) return { spawned: 0, moved: 0 };
  const st = await load();
  if (!unitPlan(st.cards, sprints).length) return { spawned: 0, moved: 0 };
  return commit(state => {
    const now = new Date().toISOString();
    let spawned = 0, moved = 0;
    for (const step of unitPlan(state.cards, sprints)) {
      if (step.kind === 'spawn') {
        const sprint = state.cards.find(c => c.id === step.sprintId);
        const card = {
          id: newId(),
          title: unitTitle(step.u),
          spec: '',
          summary: '',
          stage: 'ticketed',
          createdAt: now,
          stageHistory: [{ stage: 'ticketed', enteredAt: now, leftAt: null }],
          counters: { localFails: 0, ciFails: 0, reviewFails: 0 },
          consecutiveFails: 0,
          links: { ticket: str(step.u.url, LIMIT.link), branch: step.branch, pr: step.pr, artifact: '' },
          lane: step.lane,
          subscription: sprint?.subscription ?? '',
          slot: step.slot,
          window: '',
          parent: step.sprintId,
          ticket: int(step.u.ticket),
          unit: str(step.u.unit, LIMIT.slotish),
          status: { text: '', verdict: '', at: null },
          comments: [],
        };
        if (step.target) { enterStage(card, step.target, now); moved++; }
        state.cards.push(card);
        spawned++;
        continue;
      }
      const card = state.cards.find(c => c.id === step.id);
      if (!card) continue;
      if (step.kind === 'sprint-stage') {
        if (ROAD_ORDER.indexOf(step.to) > ROAD_ORDER.indexOf(card.stage)) {
          enterStage(card, step.to, now); card.consecutiveFails = 0; moved++;
        }
        continue;
      }
      if (step.kind === 'review-fail') {
        card.counters.reviewFails += 1;
        card.consecutiveFails += 1;
        enterStage(card, card.consecutiveFails >= STUCK_AFTER ? 'stuck' : 'development', now);
        card.lane = step.lane; card.links.pr = step.pr; card.links.branch = step.branch; card.slot = step.slot;
        moved++;
        continue;
      }
      card.lane = step.lane;
      card.links.pr = step.pr;
      card.links.branch = step.branch;
      card.slot = step.slot;
      if (step.unit && card.unit !== step.unit) {
        card.unit = step.unit;
        if (step.unit === 'QA' && !/^QA /.test(card.title)) card.title = str(`QA ${card.title}`, LIMIT.title);
      }
      if (step.move) { enterStage(card, step.move, now); card.consecutiveFails = 0; moved++; }
    }
    return { spawned, moved };
  });
}

export function setShadowFacts({ facts, staleSources, at }) {
  const cards = state?.cards ?? [];
  const next = new Map();
  for (const card of cards) {
    if (!card.window || !AUTO_ELIGIBLE.has(card.stage)) continue;
    next.set(card.id, shadowVerdict(card, facts.get(card.window), staleSources ?? [], at));
  }
  shadowMap = next;
}

function shadowVerdict(card, f, staleSources, at) {
  const v = { would: null, same: false, reasons: [], at: at ?? null };
  if (staleSources.length) {
    v.reasons.push(`facts incomplete: ${staleSources.join(', ')}`);
    return v;
  }
  if (!f) {
    v.reasons.push('window is not on the windows board');
    return v;
  }
  if (f.openPrs.length) {
    v.would = 'ci_pr';
    v.reasons.push(`open PRs: ${f.openPrs.map(p => '#' + p.number).join(' ')}`);
    const red = f.openPrs.filter(p => p.ci === 'red').map(p => '#' + p.number);
    if (red.length) v.reasons.push(`CI red on ${red.join(' ')}`);
  } else if (f.laneBusy) {
    v.would = 'development';
    v.reasons.push('a lane of this window is busy');
  } else if (f.working) {
    v.would = 'development';
    v.reasons.push('the agent is working and no PR is open');
  } else if (!f.unitsPromised) {
    v.reasons.push('sprint scope not visible: stream-watch has no units:"issues" promise');
  } else if (!f.hasPrefixes) {
    v.reasons.push('sprint scope not visible: stream-watch has no branch prefixes');
  } else if (!f.umbrella) {
    v.reasons.push('sprint scope not visible: no umbrella issue');
  } else if (f.openUnitIssues.length) {
    v.reasons.push(`scope not empty: open unit tickets ${f.openUnitIssues.map(i => '#' + i.number).join(' ')}`);
  } else if (!f.merged.length) {
    v.reasons.push('no merged PRs bound to this window — nothing to finish');
  } else {
    v.would = 'done';
    v.reasons.push(`scope empty, ${f.merged.length} merged PR(s), lanes free`);
  }
  v.same = v.would === card.stage;
  return v;
}

// --------------------------------------------------------------- agent view

// One card in six fields — the sweep an agent does over the whole pipeline.
// Everything long (the spec, the comments, the history) is behind ?full=1 or
// /api/pipeline/card/<id>, exactly as on /api/board.
function failCell(card) {
  const c = card.counters;
  const bits = [];
  if (c.localFails) bits.push(`local ${c.localFails}`);
  if (c.ciFails) bits.push(`ci ${c.ciFails}`);
  if (c.reviewFails) bits.push(`review ${c.reviewFails}`);
  if (!bits.length) return '-';
  const all = bits.join(' ');
  return card.consecutiveFails ? `${all} (${card.consecutiveFails} in a row)` : all;
}

function agentRow(card, now, meta) {
  const cl = clocks(card, now);
  const present = hasStatus(card);
  return {
    id: card.id,
    title: card.title,
    stage: card.stage,
    clock: fmtDur(cl.total) + (cl.running ? '' : ' (stopped)'),
    fails: failCell(card),
    verdict: card.status.verdict || '-',
    lane: card.lane || '',
    links: {
      ticket: card.links.ticket || '',
      branch: card.links.branch || '',
      pr: card.links.pr || '',
      artifact: card.links.artifact || '',
    },
    status: present
      ? { text: card.status.text || '', verdict: card.status.verdict || '', at: card.status.at }
      : null,
    artifactAnswered: card.artifactAnswered ?? null,
    sprint: sprintMap.has(card.id) ? sprintSummary(sprintMap.get(card.id)) : null,
    parent: card.parent || '',
    unit: card.unit || '',
    ticket: card.ticket || 0,
    slot: card.slot || '',
    subscription: card.subscription || '',
    window: card.window || '',
    consecutiveFails: card.consecutiveFails,
    statusStale: isStaleStatus(card, meta, now),
    shadow: shadowMap.get(card.id) ?? null,
  };
}

async function buildAgentPipeline(cards, full, port) {
  const now = Date.now();
  const meta = await loadWatchdogMeta();
  const rows = cards.map(c => agentRow(c, now, meta));
  const stuck = cards.filter(c => c.stage === 'stuck');
  const stale = staleList(cards, meta, now);
  const view = {
    pipeline: `http://127.0.0.1:${port}`,
    generated: new Date(now).toISOString(),
    full: Boolean(full),
    summary: {
      cards: cards.length,
      stuck: stuck.length,
      done: cards.filter(c => c.stage === 'done').length,
      failures: cards.reduce((n, c) =>
        n + c.counters.localFails + c.counters.ciFails + c.counters.reviewFails, 0),
      staleStatus: stale.length,
      units: cards.filter(c => c.parent).length,
      offBoard: OFF_BOARD.findings.length,
      idleLanes: IDLE_LANES.findings.length,
      autoDispatch: AUTO_DISPATCH.rows.length,
      autoDispatchOn: AUTO_DISPATCH.on,
    },
    cards: rows,
    stuck: stuck.map(c => ({
      id: c.id,
      title: clipText(c.title, full),
      fails: failCell(c),
      waiting: fmtDur(clocks(c, now).byStage.stuck ?? 0),
    })),
    stale: stale.map(c => ({
      id: c.id,
      title: clipText(c.title, full),
      age: (() => {
        const age = statusAgeMs(c, now);
        return age == null ? 'no time' : fmtDur(age);
      })(),
    })),
    offBoard: OFF_BOARD.findings.map(f => ({
      kind: f.kind, ref: f.ref, title: clipText(f.title || '-', full), reason: f.reason, fix: f.fix,
    })),
    offBoardSkipped: OFF_BOARD.skipped,
    idleLanes: IDLE_LANES.findings.map(f => ({
      card: clipText(f.card?.title || f.card?.id || '-', full),
      free: (f.free ?? []).join(', '),
      queued: (f.startable ?? []).map(u => `${u.unit ? u.unit + ' ' : ''}#${u.ticket}`).join(', '),
      since: fmtDur(f.ageMs ?? 0),
    })),
    autoDispatch: AUTO_DISPATCH.rows.map(r => ({
      card: clipText(r.card || '-', full), unit: r.unit || '-', lane: r.lane || '-', base: r.base || '-', state: clipText(r.state || '-', full),
    })),
  };
  if (full) {
    view.specs = cards.filter(c => c.spec.trim())
      .map(c => ({ id: c.id, spec: clipText(c.spec, true) }));
  }
  return view;
}

function renderToonPipeline(v) {
  const s = v.summary;
  const out = [
    `pipeline: ${v.pipeline}`,
    `generated: ${v.generated}`,
    `summary: cards ${s.cards}, stuck ${s.stuck}, done ${s.done},`
      + ` failures ${s.failures}, stale status ${s.staleStatus}`,
    toonTable('cards', v.cards, ['id', 'title', 'stage', 'clock', 'fails', 'verdict'],
      'no cards in the pipeline'),
    toonTable('stuck', v.stuck, ['id', 'title', 'fails', 'waiting'],
      'no card is stuck'),
    toonTable('stale', v.stale, ['id', 'title', 'age'],
      'no active card has a stale Status'),
    toonTable('off-board', v.offBoard, ['kind', 'ref', 'title', 'reason', 'fix'],
      v.offBoardSkipped ? `watch skipped — ${v.offBoardSkipped}` : 'nothing is built off the board'),
    toonTable('idle-lanes', v.idleLanes, ['card', 'free', 'queued', 'since'],
      'no assigned lane sits free while a unit waits'),
    toonTable('auto-dispatch', v.autoDispatch, ['card', 'unit', 'lane', 'base', 'state'],
      `nothing to dispatch (auto-dispatch ${s.autoDispatchOn ? 'on' : 'off — dry-run'})`),
  ];
  if (v.specs) out.push(toonTable('specs', v.specs, ['id', 'spec'], 'no card has a spec'));
  const help = [];
  if (!v.full) {
    help.push('one card in full (summary, comments, history) — /api/pipeline/card/<id>;'
      + ' its spec text — ?spec=1 there, or /pipeline/card/<id>/spec as plain text;'
      + ' the whole pipeline in full — ?full=1');
  }
  help.push('stages: spec, grilled, ticketed, development, local_check, ci_pr, review, merged, done;'
    + ' review — the PR is open and CI is green: the code waits for its reader (verdict R<n> — GO / NO-GO as the first line of a PR comment) and then for the merge; a NO-GO sends the card back to development for the fix round;'
    + ' merged — on main, the ticket not yet closed by a person after the merge (the PR\'s own auto-close does not count); a unit is done once it is,'
    + ' a sprint once every unit is, its qa-labelled tickets are closed and the umbrella is closed; QA itself is one run per sprint before done, not a stage — its findings are qa-labelled tickets that travel the road like units;'
    + ' stuck — three failures in a row, waiting for a human');
  help.push('clock is the delivery time; done is terminal and does not count'
    + ' — a finished card shows "(stopped)"');
  help.push('stale status: an active card (development, local_check, ci_pr, review) whose Status is'
    + ' missing or older than twice the Watchdog interval');
  help.push('off-board: what is being built without a card — open PRs no card carries, tickets'
    + ' in work that name no umbrella, busy lanes on unknown branches; the ledger of such cases'
    + ' is /pipeline/edge-cases (plain text)');
  help.push('idle-lanes: a lane assigned to a sprint is free while a unit of that sprint is'
    + ' queued with nothing in its way — lanes are for code and nothing else holds them;'
    + ' after a short grace the board alarms the owner and the CTO window');
  help.push('auto-dispatch: the board itself sends a startable unit to a free assigned lane'
    + ' (task file = ticket + common brief + base, spec bundle shipped, launcher from the fleet)'
    + ' — state "would dispatch" while WATCHTOWER_AUTO_DISPATCH is off, else dispatched/failed/held'
    + ' from the journal state/auto-dispatch.json');
  help.push('?format=json — the same shape as plain JSON');
  out.push([`help[${help.length}]:`, ...help.map(t => '  ' + t)].join('\n'));
  return out.join('\n') + '\n';
}

// How many lines a spec is. The number stands next to the link to the full
// text, so the reader decides whether to open it before paying for it.
export function specLineCount(spec) {
  const t = String(spec ?? '').trim();
  return t ? t.split(/\r?\n/).length : 0;
}

// One card in full — except the spec. This is what the agent reads before it
// touches a card: the summary, every comment, and where the time went. The spec
// itself is hundreds of lines on a real card, so by default the answer carries
// only its line count and where to read it (?spec=1 here, or
// /pipeline/card/<id>/spec as plain text); withSpec adds the text itself.
async function buildAgentCard(card, withSpec = false) {
  const now = Date.now();
  const cl = clocks(card, now);
  const meta = await loadWatchdogMeta();
  const age = statusAgeMs(card, now);
  const ageWord = age == null ? 'no time' : `${fmtDur(age)} ago`;
  const stale = isStaleStatus(card, meta, now);
  const view = {
    id: card.id,
    title: card.title,
    stage: card.stage,
    created: card.createdAt,
    clockTotal: fmtDur(cl.total) + (cl.running ? '' : ' (stopped)'),
    clockByStage: STAGES.filter(s => cl.byStage[s.key])
      .map(s => `${s.key} ${fmtDur(cl.byStage[s.key])}`).join(', ') || '-',
    fails: failCell(card),
    consecutiveFails: card.consecutiveFails,
    lane: card.lane || '-',
    subscription: card.subscription || '-',
    slot: card.slot || '-',
    window: card.window || '-',
    links: LINK_KEYS.filter(k => card.links[k]).map(k => `${k} ${card.links[k]}`).join(', ') || '-',
    artifact: artifactCell(card),
    lanes: lanesLine(sprintMap.get(card.id) ?? null),
    ciSlots: ciSlotsLine(sprintMap.get(card.id)?.ciSlots ?? null),
    sprintOf: card.parent
      ? `${card.parent}${(() => { const p = (state?.cards ?? []).find(c => c.id === card.parent); return p ? ' — ' + p.title : ''; })()}`
      : '-',
    unit: card.unit || '-',
    ticket: card.ticket || 0,
    sprint: sprintMap.has(card.id) ? sprintSummary(sprintMap.get(card.id)) : null,
    units: (sprintMap.get(card.id)?.units ?? []).map(u => ({
      unit: u.unit || '-',
      ticket: `#${u.ticket}`,
      branch: u.branch || '-',
      lane: u.lane ? `${u.lane.host}/${u.lane.lane}${u.lane.busy ? '' : ' (idle)'}` : '-',
      pr: u.merged ? `#${u.merged.number} merged`
        : u.pr ? `#${u.pr.number} ${u.pr.ci?.text ?? ''}${u.pr.runner?.name ? ' · ' + u.pr.runner.name + (u.pr.runner.host ? ' (' + u.pr.runner.host + ')' : '') : ''}`.trim()
        : '-',
      state: u.state,
      deps: (u.deps ?? []).map(d => `#${d.ticket}${d.unit ? ' ' + d.unit : ''} ${d.state}`).join(', ') || 'none',
    })),
    qa: (sprintMap.get(card.id)?.qaTickets ?? []).map(u => ({
      ticket: `#${u.ticket}`,
      title: u.title || '-',
      pr: u.merged ? `#${u.merged.number} merged` : u.pr ? `#${u.pr.number} ${u.pr.ci?.text ?? ''}`.trim() : '-',
      state: u.state,
    })),
    status: hasStatus(card)
      ? `${card.status.text || '(empty)'} (${card.status.verdict || 'no verdict'}, ${ageWord}`
        + `${stale ? ', stale' : ''})`
      : (stale ? 'stale — watchdog has not written one yet' : '-'),
    summary: card.summary || '-',
    specLines: specLineCount(card.spec),
    // Agents read specs through this endpoint, so the way to the text must be
    // in the answer itself, not only in the docs.
    specHint: `the spec as written — /pipeline/card/${card.id}/spec (plain text);`
      + ' in this answer — ?spec=1',
    comments: card.comments.map(c => ({ author: c.author, at: c.at, text: c.text.replace(/\s+/g, ' ').trim() })),
    history: card.stageHistory.map(h => ({
      stage: h.stage,
      entered: h.enteredAt,
      left: h.leftAt ?? '-',
      took: fmtDur(spanMs(h, now)),
    })),
  };
  if (withSpec) view.spec = card.spec;
  return view;
}

function renderToonCard(c) {
  const out = [
    `card: ${c.id}`,
    `title: ${c.title}`,
    `stage: ${c.stage}`,
    `created: ${c.created}`,
    `clock: ${c.clockTotal}`,
    `clock-by-stage: ${c.clockByStage}`,
    `fails: ${c.fails}`,
    `consecutive-fails: ${c.consecutiveFails}`,
    `lane: ${c.lane}`,
    `subscription: ${c.subscription}`,
    `slot: ${c.slot}`,
    `window: ${c.window}`,
    `links: ${c.links}`,
    `artifact: ${c.artifact}`,
    `lanes: ${c.lanes}`,
    `ci-slots: ${c.ciSlots}`,
    `sprint-of: ${c.sprintOf}`,
    `status: ${c.status}`,
    // Folded like the spec below: TOON is line-based, and the API accepts a
    // summary with newlines in it.
    `summary: ${c.summary.replace(/\s+/g, ' ').trim() || '-'}`,
    `spec-lines: ${c.specLines}`,
  ];
  // The whole spec on one line, whitespace folded: TOON is line-based. The text
  // as written is behind /pipeline/card/<id>/spec.
  if (c.spec !== undefined) out.push(`spec: ${c.spec.replace(/\s+/g, ' ').trim() || '-'}`);
  out.push(
    toonTable('units', c.units, ['unit', 'ticket', 'branch', 'lane', 'pr', 'state', 'deps'],
      c.sprint ? 'no unit tickets reference the umbrella yet' : 'not a sprint card — links.ticket is not an umbrella issue'),
    toonTable('qa', c.qa, ['ticket', 'title', 'pr', 'state'],
      c.sprint ? 'no QA tickets — an issue labelled qa that references the umbrella' : 'not a sprint card'),
    toonTable('comments', c.comments, ['author', 'at', 'text'], 'nobody has commented'),
    toonTable('history', c.history, ['stage', 'entered', 'left', 'took'], 'no history'),
    `help: ${c.specHint}`,
  );
  return out.join('\n') + '\n';
}

// --------------------------------------------------------------- routing

const ACTIONS = {
  create: createCard,
  move: moveCard,
  fail: failCard,
  unstuck: unstuckCard,
  comment: commentCard,
  summary: summaryCard,
  update: updateCard,
  'artifact-answered': artifactAnsweredCard,
};

// Returns true when the request belonged to the pipeline and has been answered.
// Anything not matched here falls through to the rest of the board untouched.
export async function handlePipeline(req, res, url, port) {
  // What the page polls while the Pipeline view is on.
  if (req.method === 'GET' && url.pathname === '/pipeline/data') {
    send(res, 200, JSON.stringify(await pageData()));
    return true;
  }

  // The edge-case ledger: every case of work off the board, as written.
  if (req.method === 'GET' && url.pathname === '/pipeline/edge-cases') {
    let text = '';
    try { text = await readFile(path.join(path.dirname(FILE), 'edge-cases.md'), 'utf8'); }
    catch { text = 'no edge cases recorded yet — nothing has been built off the board since the watch started\n'; }
    sendText(res, 200, text);
    return true;
  }

  // The pipeline for an agent: no page, no pictures, short text.
  if (req.method === 'GET' && url.pathname === '/api/pipeline') {
    const p = agentParams(url, true);
    if (p.error) { sendText(res, 400, p.error); return true; }
    const st = await load();
    const view = await buildAgentPipeline(st.cards, p.full, port);
    if (p.format === 'json') send(res, 200, JSON.stringify(view, null, 2));
    else sendText(res, 200, renderToonPipeline(view));
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/pipeline/card/')) {
    const p = agentParams(url, false, true);
    if (p.error) { sendText(res, 400, p.error); return true; }
    let wanted;
    try { wanted = decodeURIComponent(url.pathname.slice('/api/pipeline/card/'.length)); }
    catch { wanted = ''; }
    if (!wanted.trim()) {
      sendText(res, 400, 'error: the card id in the path is empty\n'
        + 'help: /api/pipeline/card/<id from the id cell of the cards section>');
      return true;
    }
    const st = await load();
    const card = st.cards.find(c => c.id === wanted.trim());
    if (!card) {
      const list = st.cards.length ? st.cards.map(c => c.id).join(', ') : '(the pipeline is empty)';
      if (p.format === 'json') {
        send(res, 404, JSON.stringify(
          { error: `there is no card "${wanted}" in the pipeline`, cards: st.cards.map(c => c.id) }, null, 2));
      } else {
        sendText(res, 404, `error: there is no card "${wanted}" in the pipeline\n`
          + `help: in the pipeline right now: ${list}`);
      }
      return true;
    }
    const view = await buildAgentCard(card, p.spec);
    if (p.format === 'json') send(res, 200, JSON.stringify(view, null, 2));
    else sendText(res, 200, renderToonCard(view));
    return true;
  }

  // The spec as written: a plain-text page anyone with access to the board can
  // open in a browser. This is where the "spec (N lines)" link on a card leads,
  // and where an agent reads the text the API answer only counts.
  if (req.method === 'GET' && url.pathname.startsWith('/pipeline/card/')
      && url.pathname.endsWith('/spec')) {
    const raw = url.pathname.slice('/pipeline/card/'.length, -'/spec'.length);
    let id;
    try { id = decodeURIComponent(raw).trim(); }
    catch { id = String(raw || '').trim(); }
    if (!id || id.includes('/')) {
      sendText(res, 400, 'error: a card id is required\nhelp: /pipeline/card/<id>/spec');
      return true;
    }
    const st = await load();
    const card = st.cards.find(c => c.id === id);
    if (!card) {
      sendText(res, 404, `error: there is no card "${id}" in the pipeline`);
      return true;
    }
    sendText(res, 200, card.spec.trim() ? card.spec : '(the card has no spec)');
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/pipeline/assign-subscription') {
    const body = await readBody(req);
    if (!String(body.cardId ?? body.id ?? '').trim()) {
      send(res, 400, JSON.stringify({ error: 'a card id is required' }));
      return true;
    }
    const { card, events } = unwrapMutation(await assignSubscription(body));
    // The card is already persisted; answer the founder/agent first so a slow or
    // hanging Telegram round-trip can never delay their action, then notify.
    send(res, 200, JSON.stringify({ ok: true, card }));
    await emitNotifications(card, events);
    return true;
  }

  // Watchdog Status write: POST /pipeline/card/<id>/status { text, verdict }.
  // Checked before the action table so an id that happens to match an action
  // name cannot steal this path.
  if (req.method === 'POST' && url.pathname.startsWith('/pipeline/card/')
      && url.pathname.endsWith('/status')) {
    const raw = url.pathname.slice('/pipeline/card/'.length, -'/status'.length);
    let id;
    try { id = decodeURIComponent(raw).trim(); }
    catch { id = String(raw || '').trim(); }
    if (!id || id.includes('/')) {
      send(res, 400, JSON.stringify({ error: 'a card id is required' }));
      return true;
    }
    const body = await readBody(req);
    const { card, events } = unwrapMutation(await writeStatus(id, body));
    send(res, 200, JSON.stringify({ ok: true, card }));
    await emitNotifications(card, events);
    return true;
  }

  // Deleting a card. It lives next to the action table but answers its own
  // way: the deleted card comes back whole in `removed`, and an unknown id is
  // a 404 with the live ids — the table's wrapper can only say 200 or 400.
  if (req.method === 'POST' && url.pathname === '/pipeline/card/delete') {
    const body = await readBody(req);
    if (!String(body.id ?? '').trim()) {
      send(res, 400, JSON.stringify({ error: 'a card id is required' }));
      return true;
    }
    try {
      const removed = await deleteCard(body);
      send(res, 200, JSON.stringify({ ok: true, removed }));
    } catch (e) {
      if (!(e instanceof MissingCard)) throw e;
      send(res, 404, JSON.stringify({ error: e.message, cards: e.ids }));
    }
    return true;
  }

  // Every other mutation: /pipeline/card/<action>, a JSON body, an English 400
  // when the body does not say what it must.
  if (req.method === 'POST' && url.pathname.startsWith('/pipeline/card/')) {
    const action = url.pathname.slice('/pipeline/card/'.length);
    const fn = ACTIONS[action];
    if (!fn) {
      send(res, 404, JSON.stringify({
        error: `no such pipeline action "${action}"`,
        actions: [...Object.keys(ACTIONS), 'delete'],
      }));
      return true;
    }
    const body = await readBody(req);
    if (action !== 'create' && !String(body.id ?? '').trim()) {
      send(res, 400, JSON.stringify({ error: 'a card id is required' }));
      return true;
    }
    const { card, events } = unwrapMutation(await fn(body));
    // The mutation is already persisted; answer first so a slow or hanging
    // Telegram round-trip can never delay the founder/agent, then notify.
    send(res, 200, JSON.stringify({ ok: true, card }));
    await emitNotifications(card, events);
    return true;
  }

  return false;
}
