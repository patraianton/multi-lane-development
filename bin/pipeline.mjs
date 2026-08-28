// The delivery pipeline: persistent cards that move from a spec to acceptance.
//
// A Card is not a Window. A window is a live herdr session and disappears with
// the machine; a card lives in state/pipeline-cards.json, carries its spec, its
// comments, its per-stage clocks and its failure counters, and only ever leaves
// a stage through a validated transition.
//
// This module owns the whole pipeline: the store, the stage rules, the page
// endpoints and the agent view. watchtower.mjs only routes to it.

import path from 'node:path';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';
import {
  BadRequest, send, sendText, readBody,
  clipText, toonTable, agentParams,
} from './serve.mjs';

// ------------------------------------------------------------------- stages

// The stage a card sits in. Six working stages, one terminal stage and Stuck,
// which is not a step of the road but where a card lands after its third
// consecutive failure and waits for a human.
export const STAGES = [
  { key: 'spec', title: 'Spec' },
  { key: 'grilled', title: 'Grilled' },
  { key: 'development', title: 'Development' },
  { key: 'local_check', title: 'Local check' },
  { key: 'ci_pr', title: 'CI/PR' },
  { key: 'acceptance', title: 'Acceptance' },
  { key: 'accepted', title: 'Accepted' },
  { key: 'stuck', title: 'Stuck' },
];
const STAGE_KEYS = new Set(STAGES.map(s => s.key));

// Every move a card may make on its own road. Everything else is a 400: a card
// never skips the grill, never walks backwards by hand and never leaves the
// terminal stage.
//
// The two ways off this map are deliberate and have their own endpoints, because
// neither is a step forward: a failure (back to Development, or to Stuck on the
// third one in a row) and a human pulling a card out of Stuck.
const MOVES = {
  spec: ['grilled'],
  grilled: ['development'],
  development: ['local_check'],
  local_check: ['ci_pr'],
  ci_pr: ['acceptance'],
  acceptance: ['accepted'],
  accepted: [],
  stuck: [],
};

// Stages whose time counts towards the card's delivery clock. Acceptance is the
// owner's decision, not the pipeline's work — the card waits there with its
// clock stopped (the wait is still written into stageHistory, so it can be read
// separately). Accepted is terminal: nothing is being spent there any more.
const OFF_THE_CLOCK = new Set(['acceptance', 'accepted']);

// A failure is one of three kinds; each has its own counter on the card, because
// "the local check failed three times" and "acceptance was refused three times"
// are different diseases.
const FAIL_KINDS = {
  local: 'localFails',
  ci: 'ciFails',
  acceptance: 'acceptanceFails',
};

// The third consecutive failure sends the card to Stuck: something is looping
// and a human has to look, not the agent to try a fourth time.
const STUCK_AFTER = 3;

// Where a failure can happen at all: the stages where work is actually being
// checked. A card in Spec or Grilled has not been built yet, so "it failed" there
// is not a late report, it is a wrong request — and answering it would walk the
// card forward into Development around the grill, which no move is allowed to do.
const CAN_FAIL = new Set(['development', 'local_check', 'ci_pr', 'acceptance']);

// What the watchdog may write into a card's status line (Wave G writes it; the
// value is validated here so a wrong word never reaches the board).
const VERDICTS = ['moving', 'stalled', 'looping'];

// Stages the Watchdog scores. A missing or old Status on one of these is a
// signal: the checker is meant to refresh every intervalMin minutes.
const ACTIVE_STATUS_STAGES = new Set(['development', 'local_check', 'ci_pr']);
const DEFAULT_WATCHDOG_INTERVAL_MIN = 15;
const STALE_MULTIPLIER = 2;

// ------------------------------------------------------------------- limits

const LIMIT = {
  title: 200,
  spec: 20000,
  summary: 1200,     // the short retelling a card shows instead of its spec
  author: 100,
  comment: 4000,
  link: 400,
  slotish: 100,      // lane, subscription, slot
  status: 400,
};

const LINK_KEYS = ['ticket', 'branch', 'pr', 'artifact'];

const NOTIFY_KINDS = ['artifact', 'stuck', 'acceptance', 'assignSubscription'];

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

// Reading a card from disk. Every field is rebuilt from scratch: a file edited
// by hand, truncated by a crash or written by an older build must still produce
// a card the board can draw, never an exception on the way to the page.
function normCard(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id ?? '').trim();
  if (!id) return null;
  const title = str(src.title, LIMIT.title).trim();
  if (!title) return null;

  const stage = STAGE_KEYS.has(src.stage) ? src.stage : 'spec';
  const createdAt = isoOr(src.createdAt, new Date().toISOString());

  const stageHistory = [];
  for (const h of Array.isArray(src.stageHistory) ? src.stageHistory : []) {
    if (!h || !STAGE_KEYS.has(h.stage)) continue;
    stageHistory.push({
      stage: h.stage,
      enteredAt: isoOr(h.enteredAt, createdAt),
      leftAt: isoOr(h.leftAt, null),
    });
  }
  // A card with no readable history still has to have a clock: it entered its
  // current stage at least when it was created.
  if (!stageHistory.length) stageHistory.push({ stage, enteredAt: createdAt, leftAt: null });

  const counters = {};
  for (const key of Object.values(FAIL_KINDS)) counters[key] = int(src.counters?.[key]);

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
  const card = {
    id,
    title,
    spec: str(src.spec, LIMIT.spec),
    // Cards written before the summary existed simply have an empty one.
    summary: str(src.summary, LIMIT.summary).trim(),
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
//   total   — the delivery time, acceptance and accepted left out;
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
// stuck / acceptance may notify again (fresh timestamp). Artifact and
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
  if (card.stage === 'acceptance' && before.stage !== 'acceptance') stamp('acceptance');
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
  if (c.acceptanceFails) bits.push(`acceptance ${c.acceptanceFails}`);
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
      else if (kind === 'acceptance' && s.acceptance) await s.acceptance(card);
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
    summary: str(body.summary, LIMIT.summary).trim(),
    stage: 'spec',
    createdAt: now,
    stageHistory: [{ stage: 'spec', enteredAt: now, leftAt: null }],
    counters: { localFails: 0, ciFails: 0, acceptanceFails: 0 },
    consecutiveFails: 0,
    links: { ticket: '', branch: '', pr: '', artifact: '' },
    lane: '',
    subscription: '',
    slot: '',
    window: '',
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
    return st.cards.splice(i, 1)[0];
  });
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
    enterStage(card, to, new Date().toISOString());
    // A stage passed is the run that did not fail: the streak starts over.
    card.consecutiveFails = 0;
  });
}

async function failCard(body) {
  const kind = String(body.kind ?? '');
  if (!FAIL_KINDS[kind]) {
    throw new BadRequest(`unknown failure kind "${kind}" — use local, ci or acceptance`);
  }
  return editCard(body.id, card => {
    if (card.stage === 'accepted') throw new BadRequest('an accepted card cannot fail');
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

async function acceptCard(body) {
  return editCard(body.id, card => {
    if (card.stage !== 'acceptance') {
      throw new BadRequest(`only a card in "acceptance" can be accepted, this one is in "${card.stage}"`);
    }
    enterStage(card, 'accepted', new Date().toISOString());
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
  const summary = str(body.summary, LIMIT.summary).trim();
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
      for (const key of LINK_KEYS) {
        if (body.links[key] !== undefined) card.links[key] = str(body.links[key], LIMIT.link).trim();
      }
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
// Development in the same write.
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
    const now = new Date().toISOString();
    card.subscription = subscription;
    enterStage(card, 'development', now);
    card.consecutiveFails = 0;
    card.comments.push({
      author: authorFromBy(body.by) || 'board',
      text: `subscription ${subscription} assigned by ${by}`,
      at: now,
    });
  });
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
    // with no subscriptions configured keeps its plain grilled -> Development
    // button and never shows "waiting for a subscription": the assign endpoint
    // has no names to offer there anyway.
    usesSubscriptions: BOARD.subscriptions.length > 0,
    watchdogIntervalMin: meta.intervalMin,
    watchdogConfigured: meta.configured,
    cards: st.cards.map(c => (shadowMap.has(c.id) ? { ...c, shadow: shadowMap.get(c.id) } : c)),
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
//     acceptance — the card says what is missing instead.
const AUTO_ELIGIBLE = new Set(['development', 'local_check', 'ci_pr', 'acceptance']);
let shadowMap = new Map(); // card id -> { would, same, reasons, at }

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
    v.reasons.push('no merged PRs bound to this window — nothing to accept');
  } else {
    v.would = 'acceptance';
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
  if (c.acceptanceFails) bits.push(`acceptance ${c.acceptanceFails}`);
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
      waitingForAcceptance: cards.filter(c => c.stage === 'acceptance').length,
      accepted: cards.filter(c => c.stage === 'accepted').length,
      failures: cards.reduce((n, c) =>
        n + c.counters.localFails + c.counters.ciFails + c.counters.acceptanceFails, 0),
      staleStatus: stale.length,
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
    `summary: cards ${s.cards}, stuck ${s.stuck}, waiting for acceptance ${s.waitingForAcceptance},`
      + ` accepted ${s.accepted}, failures ${s.failures}, stale status ${s.staleStatus}`,
    toonTable('cards', v.cards, ['id', 'title', 'stage', 'clock', 'fails', 'verdict'],
      'no cards in the pipeline'),
    toonTable('stuck', v.stuck, ['id', 'title', 'fails', 'waiting'],
      'no card is stuck'),
    toonTable('stale', v.stale, ['id', 'title', 'age'],
      'no active card has a stale Status'),
  ];
  if (v.specs) out.push(toonTable('specs', v.specs, ['id', 'spec'], 'no card has a spec'));
  const help = [];
  if (!v.full) {
    help.push('one card in full (summary, comments, history) — /api/pipeline/card/<id>;'
      + ' its spec text — ?spec=1 there, or /pipeline/card/<id>/spec as plain text;'
      + ' the whole pipeline in full — ?full=1');
  }
  help.push('stages: spec, grilled, development, local_check, ci_pr, acceptance, accepted;'
    + ' stuck — three failures in a row, waiting for a human');
  help.push('clock is the delivery time; acceptance is the owner\'s decision and does not count'
    + ' — a card waiting there shows "(stopped)"');
  help.push('stale status: an active card (development, local_check, ci_pr) whose Status is'
    + ' missing or older than twice the Watchdog interval');
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
  accept: acceptCard,
  comment: commentCard,
  summary: summaryCard,
  update: updateCard,
};

// Returns true when the request belonged to the pipeline and has been answered.
// Anything not matched here falls through to the rest of the board untouched.
export async function handlePipeline(req, res, url, port) {
  // What the page polls while the Pipeline view is on.
  if (req.method === 'GET' && url.pathname === '/pipeline/data') {
    send(res, 200, JSON.stringify(await pageData()));
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
