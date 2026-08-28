// Watchtower Telegram bot — one group, the two founders, every message a card.
//
// Two halves:
//   1. Sender API (exported). The board calls these when a card moves. Each
//      function takes a card and builds one English message with @tags and a
//      link back to that card.
//   2. Update loop (this file run as a process). Long-polls getUpdates; when a
//      founder presses a subscription button, POSTs the choice to the board
//      and edits the Telegram message so the group can see who picked what.
//
// No packages. Telegram is https://api.telegram.org via global fetch. The
// offset of getUpdates is a state file, written the same way watchtower writes
// its own (unique temporary name, then rename, writes of one file queued).
//
// The bot never talks to Telegram unless botToken is set. There is no token in
// the checkout — live sends are a configured install, tests are --dry-run /
// --selftest.

import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(STATE_DIR, 'telegram.json');
const OFFSET_FILE = path.join(STATE_DIR, 'telegram-offset.json');

const TG_API = 'https://api.telegram.org';
const CALLBACK_PREFIX = 'as|';
const CALLBACK_MAX_BYTES = 64;
const POLL_TIMEOUT_SEC = 25;
const POLL_ABORT_MS = 35_000;
const POLL_RETRY_MS = 3_000;
const TEXT_MAX = 4096;

// ------------------------------------------------------------------- flags

const ARGV = process.argv.slice(2);
const FLAGS = new Set(['--dry-run', '--selftest']);
const COMMANDS = new Set(['run']);

function ranAsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function unknownFlags() {
  return ARGV.filter(a => a.startsWith('-') && !FLAGS.has(a));
}

// --dry-run / --selftest apply only when this file is the process entry.
// The board will import the sender API from watchtower.mjs; a flag meant
// for the board must not silently swallow live notifications. The board
// opts into dry-run by passing dryRun:true to configureTelegram instead.
const SELFTEST = ranAsMain() && ARGV.includes('--selftest');
const DRY_RUN = ranAsMain() && (ARGV.includes('--dry-run') || ARGV.includes('--selftest'));
let importedDryRun = false;

function useDryRun() {
  return DRY_RUN || importedDryRun;
}

// ------------------------------------------------------------------- helpers

function die(message) {
  console.error(message);
  process.exit(1);
}

function log(message) {
  console.error(`${new Date().toISOString()} ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimSlash(url) {
  return String(url ?? '').replace(/\/+$/, '');
}

async function readJsonSoft(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

// Writing a state file: to a temporary file first, then a rename. Two details
// already paid for:
//   1. the temporary name is unique — otherwise two concurrent writes share one
//      <file>.tmp and the second one renames a half-written stub;
//   2. writes of one file are queued — renames never overtake each other and
//      never trip over an already renamed temporary file.
const writeQueues = new Map();

async function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
  // The queue holds a version that never rejects: one failed write must not
  // cancel the next one.
  const tail = run.catch(() => {});
  writeQueues.set(file, tail);
  tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return run;
}

// ------------------------------------------------------------------- config

// Loaded once per process. --selftest never reads the file: a leftover token
// in a working copy must not be able to send during a test.
let config = null;

function normFounder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim();
  const tag = String(raw.tag ?? '').trim();
  const tgUserId = Number(raw.tgUserId);
  if (!name || !tag || !Number.isFinite(tgUserId) || tgUserId === 0) return null;
  return { name, tag, tgUserId, owner: raw.owner === true };
}

function tagOf(founder) {
  const t = String(founder?.tag ?? '').trim();
  if (!t) return String(founder?.name ?? '').trim();
  return t.startsWith('@') ? t : `@${t}`;
}

function tagAll(founders) {
  return founders.map(tagOf).join(' ');
}

function validateConfig(raw, { requireToken }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Telegram config is not a JSON object. See docs/TELEGRAM.md.');
  }
  const missing = [];
  const botToken = String(raw.botToken ?? raw.token ?? '').trim();
  const chatId = raw.chatId === 0 || raw.chatId ? String(raw.chatId).trim() : '';
  const boardUrl = trimSlash(raw.boardUrl);
  const apiToken = String(raw.apiToken ?? '').trim();
  if (requireToken && !botToken) missing.push('botToken');
  if (!chatId) missing.push('chatId');
  if (!boardUrl) missing.push('boardUrl');
  if (!apiToken) missing.push('apiToken');
  if (!Array.isArray(raw.founders) || raw.founders.length === 0) missing.push('founders');
  if (missing.length) {
    throw new Error(
      `Telegram config is incomplete: missing ${missing.join(', ')}. See docs/TELEGRAM.md.`);
  }
  const founders = [];
  for (const row of raw.founders) {
    const f = normFounder(row);
    if (!f) {
      throw new Error(
        'Telegram config founders must each have name, tag, and a numeric tgUserId. See docs/TELEGRAM.md.');
    }
    founders.push(f);
  }
  if (!founders.some(f => f.owner)) {
    throw new Error('Telegram config needs at least one founder with owner: true.');
  }
  return { botToken, chatId, boardUrl, apiToken, founders };
}

async function loadConfigFile() {
  let text;
  try {
    text = await readFile(CONFIG_FILE, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(
        `Telegram config is missing: expected ${CONFIG_FILE}. See docs/TELEGRAM.md for the format.`);
    }
    throw new Error(`could not read ${CONFIG_FILE}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Telegram config is not valid JSON: ${CONFIG_FILE}`);
  }
}

async function loadConfig({ requireToken = true } = {}) {
  if (config) return config;
  if (!ranAsMain()) {
    throw new Error('Telegram sender is not configured');
  }
  config = validateConfig(await loadConfigFile(), { requireToken });
  return config;
}

// The board injects its `telegram` block here so notify* never reads
// state/telegram.json from the board process. null clears the sender.
export function configureTelegram(raw) {
  if (!raw) {
    config = null;
    importedDryRun = false;
    return null;
  }
  importedDryRun = raw.dryRun === true;
  config = validateConfig(raw, { requireToken: !importedDryRun });
  return config;
}

function ownerOf(cfg) {
  return cfg.founders.find(f => f.owner) ?? cfg.founders[0];
}

function founderByTgId(cfg, tgUserId) {
  const id = Number(tgUserId);
  return cfg.founders.find(f => f.tgUserId === id) ?? null;
}

// ------------------------------------------------------------------- cards

function cardIdOf(card) {
  return String(card?.id ?? '').trim();
}

function cardTitleOf(card) {
  const t = String(card?.title ?? card?.name ?? '').trim();
  return t || 'untitled card';
}

function artifactUrlOf(card) {
  return String(card?.links?.artifact ?? card?.artifact ?? '').trim();
}

function cardUrl(cfg, card) {
  const id = cardIdOf(card);
  return `${cfg.boardUrl}/#pipeline/${encodeURIComponent(id)}`;
}

function needCard(card) {
  const id = cardIdOf(card);
  if (!id) throw new Error('a card id is required');
  return id;
}

function clipText(text) {
  const s = String(text ?? '');
  if (s.length <= TEXT_MAX) return s;
  return s.slice(0, TEXT_MAX - 20) + '\n… (clipped)';
}

function digestText(digest) {
  if (digest == null) return '(no digest)';
  if (typeof digest === 'string') return digest.trim() || '(no digest)';
  try { return JSON.stringify(digest, null, 2); }
  catch { return String(digest); }
}

function subscriptionId(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  return String(item.id ?? item.key ?? item.name ?? '').trim();
}

function subscriptionLabel(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  return String(item.name ?? item.label ?? item.id ?? item.key ?? '').trim();
}

function encodeCallback(cardId, subscription) {
  return `${CALLBACK_PREFIX}${cardId}|${subscription}`;
}

function decodeCallback(data) {
  const raw = String(data ?? '');
  if (!raw.startsWith(CALLBACK_PREFIX)) return null;
  const rest = raw.slice(CALLBACK_PREFIX.length);
  const cut = rest.indexOf('|');
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { cardId: rest.slice(0, cut), subscription: rest.slice(cut + 1) };
}

function subscriptionKeyboard(cardId, subscriptions) {
  const rows = [];
  for (const item of subscriptions) {
    const id = subscriptionId(item);
    const label = subscriptionLabel(item) || id;
    if (!id) continue;
    const data = encodeCallback(cardId, id);
    if (Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) {
      throw new Error(
        `subscription callback_data is longer than ${CALLBACK_MAX_BYTES} bytes for "${id}" — shorten the card id or the subscription name`);
    }
    rows.push([{ text: label, callback_data: data }]);
  }
  if (!rows.length) throw new Error('notifyAssignSubscription needs at least one subscription');
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------- message text

function lines(parts) {
  // Empty strings are blank lines in the Telegram message. null/undefined
  // (an optional field that is not there) is the only thing dropped.
  return parts.filter(p => p != null).join('\n');
}

function artifactReadyText(cfg, card) {
  const artifact = artifactUrlOf(card);
  return lines([
    tagAll(cfg.founders),
    '',
    `The grill artifact is ready for "${cardTitleOf(card)}".`,
    '',
    artifact ? `Artifact: ${artifact}` : 'Artifact: (the card has no artifact link yet)',
    `Card: ${cardUrl(cfg, card)}`,
  ]);
}

function assignSubscriptionText(cfg, card) {
  return lines([
    tagOf(ownerOf(cfg)),
    '',
    `Assign a subscription for "${cardTitleOf(card)}" so the card can move on to Ticketed.`,
    '',
    `Card: ${cardUrl(cfg, card)}`,
  ]);
}

function stuckText(cfg, card, digest) {
  return lines([
    tagAll(cfg.founders),
    '',
    `Card "${cardTitleOf(card)}" is Stuck after 3 consecutive failures.`,
    '',
    'Digest:',
    digestText(digest),
    '',
    `Card: ${cardUrl(cfg, card)}`,
  ]);
}

function acceptanceText(cfg, card) {
  return lines([
    tagAll(cfg.founders),
    '',
    `Card "${cardTitleOf(card)}" reached Acceptance.`,
    '',
    `Card: ${cardUrl(cfg, card)}`,
  ]);
}

function assignedText(original, founder, subscription) {
  return lines([
    original,
    '',
    `${founder.name} (${tagOf(founder)}) assigned subscription ${subscription}.`,
  ]);
}

// ---------------------------------------------------------------- Telegram I/O

function printDryRun(name, text, keyboard) {
  console.log(`--- ${name} ---`);
  console.log('text:');
  console.log(text);
  console.log('keyboard:');
  console.log(keyboard ? JSON.stringify(keyboard, null, 2) : 'null');
  console.log('');
}

async function tg(cfg, method, payload, { abortMs = 20_000 } = {}) {
  if (!cfg.botToken) {
    throw new Error('Telegram config has no botToken — refusing to send.');
  }
  const url = `${TG_API}/bot${cfg.botToken}/${method}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), abortMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`telegram ${method} timed out after ${abortMs}ms`);
    }
    throw new Error(`telegram ${method} failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`telegram ${method}: answer is not JSON (HTTP ${res.status})`);
  }
  if (!data.ok) {
    throw new Error(`telegram ${method} failed: ${data.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

async function sendMessage(cfg, { name, text, keyboard }) {
  const clipped = clipText(text);
  if (useDryRun()) {
    printDryRun(name, clipped, keyboard ?? null);
    return { ok: true, dryRun: true, text: clipped, keyboard: keyboard ?? null };
  }
  if (!cfg.botToken) {
    throw new Error('Telegram config has no botToken — refusing to send.');
  }
  const payload = {
    chat_id: cfg.chatId,
    text: clipped,
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = keyboard;
  const result = await tg(cfg, 'sendMessage', payload);
  return { ok: true, messageId: result?.message_id ?? null, text: clipped, keyboard: keyboard ?? null };
}

// -------------------------------------------------------------- sender API

export async function notifyArtifactReady(card) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyArtifactReady',
    text: artifactReadyText(cfg, card),
  });
}

export async function notifyAssignSubscription(card, subscriptions) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  const id = needCard(card);
  if (!Array.isArray(subscriptions)) {
    throw new Error('notifyAssignSubscription needs an array of subscriptions');
  }
  const keyboard = subscriptionKeyboard(id, subscriptions);
  return sendMessage(cfg, {
    name: 'notifyAssignSubscription',
    text: assignSubscriptionText(cfg, card),
    keyboard,
  });
}

export async function notifyStuck(card, digest) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyStuck',
    text: stuckText(cfg, card, digest),
  });
}

export async function notifyAcceptance(card) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyAcceptance',
    text: acceptanceText(cfg, card),
  });
}

// ------------------------------------------ assign-subscription → the board

// Contract the later wave must implement. Documented in docs/TELEGRAM.md.
//
//   POST {boardUrl}/pipeline/assign-subscription
//   Authorization: Bearer {apiToken}
//   { cardId, subscription, by: { name, tgUserId, tag } }
//
export function assignSubscriptionRequest(cfg, { cardId, subscription, by }) {
  return {
    url: `${cfg.boardUrl}/pipeline/assign-subscription`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiToken}`,
    },
    body: {
      cardId,
      subscription,
      by: {
        name: by.name,
        tgUserId: by.tgUserId,
        tag: by.tag,
      },
    },
  };
}

async function postAssignSubscription(cfg, payload) {
  const req = assignSubscriptionRequest(cfg, payload);
  if (!cfg.apiToken) {
    throw new Error('Telegram config has no apiToken — cannot tell the board.');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let res;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ac.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('board assign-subscription timed out after 20000ms');
    }
    throw new Error(`board assign-subscription failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`board assign-subscription ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function answerCallback(cfg, callbackId, text, extra = {}) {
  if (useDryRun()) return;
  await tg(cfg, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: String(text ?? '').slice(0, 200),
    ...extra,
  });
}

async function editMessage(cfg, { chatId, messageId, text }) {
  if (useDryRun()) return;
  await tg(cfg, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: clipText(text),
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
}

async function handleCallback(cfg, query) {
  const callbackId = query?.id;
  const fromId = query?.from?.id;
  const data = query?.data;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;
  const original = String(query?.message?.text ?? '');

  if (chatId != null && String(chatId) !== String(cfg.chatId)) {
    log(`ignoring callback from chat ${chatId} (configured chat is ${cfg.chatId})`);
    return;
  }

  const founder = founderByTgId(cfg, fromId);
  if (!founder) {
    if (callbackId) {
      await answerCallback(cfg, callbackId, 'Only a board founder can assign a subscription.');
    }
    return;
  }

  const parsed = decodeCallback(data);
  if (!parsed) {
    if (callbackId) await answerCallback(cfg, callbackId, 'Unknown button.');
    return;
  }

  try {
    await postAssignSubscription(cfg, {
      cardId: parsed.cardId,
      subscription: parsed.subscription,
      by: founder,
    });
  } catch (e) {
    log(`assign-subscription failed: ${e.message}`);
    if (callbackId) {
      await answerCallback(cfg, callbackId, `The board did not accept the assignment: ${e.message}`, { show_alert: true });
    }
    return;
  }

  if (chatId != null && messageId != null) {
    try {
      await editMessage(cfg, {
        chatId,
        messageId,
        text: assignedText(original, founder, parsed.subscription),
      });
    } catch (e) {
      log(`could not edit the Telegram message: ${e.message}`);
    }
  }

  if (callbackId) {
    await answerCallback(cfg, callbackId, `Assigned ${parsed.subscription}.`);
  }
}

// -------------------------------------------------------------- update loop

async function loadOffset() {
  const raw = await readJsonSoft(OFFSET_FILE, {});
  const n = Number(raw?.nextOffset);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function saveOffset(nextOffset) {
  await writeJsonAtomic(OFFSET_FILE, { nextOffset, at: new Date().toISOString() });
}

async function pollOnce(cfg, offset) {
  const payload = {
    offset,
    timeout: POLL_TIMEOUT_SEC,
    allowed_updates: ['callback_query'],
  };
  return tg(cfg, 'getUpdates', payload, { abortMs: POLL_ABORT_MS });
}

export async function startUpdateLoop() {
  const cfg = await loadConfig({ requireToken: true });
  if (!cfg.botToken) {
    throw new Error('Telegram config has no botToken — refusing to start.');
  }
  if (useDryRun()) {
    throw new Error('the update loop needs the network; --dry-run is only for notify / --selftest');
  }

  let offset = await loadOffset();
  log(`telegram bot is polling getUpdates (chat ${cfg.chatId}, offset ${offset})`);

  for (;;) {
    try {
      const updates = await pollOnce(cfg, offset);
      for (const update of updates ?? []) {
        const id = Number(update.update_id);
        if (Number.isFinite(id)) offset = id + 1;
        if (update.callback_query) {
          try {
            await handleCallback(cfg, update.callback_query);
          } catch (e) {
            log(`callback failed: ${e.message}`);
          }
        }
        await saveOffset(offset);
      }
    } catch (e) {
      log(`getUpdates failed: ${e.message}`);
      await sleep(POLL_RETRY_MS);
    }
  }
}

// ----------------------------------------------------------------- selftest

const SELFTEST_CONFIG = {
  botToken: '',
  chatId: '-1000000000001',
  boardUrl: 'https://watchtower.example',
  apiToken: 'selftest-token',
  founders: [
    { name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true },
    { name: 'Partner', tgUserId: 1002, tag: '@partner', owner: false },
  ],
};

const SELFTEST_CARD = {
  id: 'c-selftest',
  title: 'Ship the pipeline Telegram bot',
  stage: 'grilled',
  consecutiveFails: 3,
  links: {
    artifact: 'https://example.com/artifact/grill-1',
    ticket: 'https://github.com/example/repo/issues/1',
  },
};

const SELFTEST_SUBSCRIPTIONS = ['cx1', 'initech', 'hz1'];
const SELFTEST_DIGEST = 'local check failed: lane-2 exited 1 (test: pipeline cards)';

async function runSelftest() {
  config = validateConfig(SELFTEST_CONFIG, { requireToken: false });
  await notifyArtifactReady(SELFTEST_CARD);
  await notifyAssignSubscription(SELFTEST_CARD, SELFTEST_SUBSCRIPTIONS);
  await notifyStuck(SELFTEST_CARD, SELFTEST_DIGEST);
  await notifyAcceptance(SELFTEST_CARD);
}

async function main() {
  const unknown = unknownFlags();
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]} — allowed flags: --dry-run, --selftest`);
    process.exit(2);
  }
  const positional = ARGV.filter(a => !a.startsWith('-'));
  if (positional.length && positional.some(c => !COMMANDS.has(c))) {
    console.error(`unknown command ${positional[0]} — allowed: run`);
    process.exit(2);
  }
  if (SELFTEST) {
    await runSelftest();
    return;
  }
  try {
    await startUpdateLoop();
  } catch (e) {
    die(e.message);
  }
}

if (ranAsMain()) {
  main().catch(e => die(e.message));
}
