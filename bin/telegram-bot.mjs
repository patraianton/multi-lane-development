// Watchtower Telegram sender — outbound board notifications only.
//
// The board injects the `telegram` block from state/autopase-board.json and
// calls the exported notify* functions. This module never polls Telegram and
// never calls back into the board.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TG_API = 'https://api.telegram.org';
const TEXT_MAX = 4096;

// ------------------------------------------------------------------- flags

const ARGV = process.argv.slice(2);
const FLAGS = new Set(['--dry-run', '--selftest']);

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

// Process flags apply only when this file is the entry point. The board opts
// into dry-run explicitly through configureTelegram({ dryRun: true }).
const SELFTEST = ranAsMain() && ARGV.includes('--selftest');
const DRY_RUN = ranAsMain() && (ARGV.includes('--dry-run') || SELFTEST);
let importedDryRun = false;

function useDryRun() {
  return DRY_RUN || importedDryRun;
}

// ------------------------------------------------------------------- helpers

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function normFounder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim();
  const tag = String(raw.tag ?? '').trim();
  const tgUserId = Number(raw.tgUserId);
  if (!name || !tag || !Number.isFinite(tgUserId) || tgUserId === 0) return null;
  return { name, tag, tgUserId, owner: raw.owner === true };
}

function tagOf(founder) {
  const tag = String(founder?.tag ?? '').trim();
  if (!tag) return String(founder?.name ?? '').trim();
  return tag.startsWith('@') ? tag : `@${tag}`;
}

function tagAll(founders) {
  return founders.map(tagOf).join(' ');
}

function ownerOf(cfg) {
  return cfg.founders.find(founder => founder.owner) ?? cfg.founders[0];
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function message(parts) {
  return parts.map(oneLine).filter(Boolean).join(' ');
}

function cardIdOf(card) {
  return String(card?.id ?? '').trim();
}

function cardTitleOf(card) {
  const title = String(card?.title ?? card?.name ?? '').trim();
  return title || 'untitled card';
}

function artifactUrlOf(card) {
  return String(card?.links?.artifact ?? card?.artifact ?? '').trim();
}

function needCard(card) {
  if (!cardIdOf(card)) throw new Error('a card id is required');
}

function clipText(text) {
  const value = String(text ?? '');
  if (value.length <= TEXT_MAX) return value;
  return value.slice(0, TEXT_MAX - 20) + ' … (clipped)';
}

function digestText(digest) {
  if (digest == null) return '(no digest)';
  if (typeof digest === 'string') return oneLine(digest) || '(no digest)';
  try { return JSON.stringify(digest); }
  catch { return oneLine(digest); }
}

// ------------------------------------------------------------------- config

let config = null;

function validateConfig(raw, { requireToken }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Telegram config is not a JSON object. See docs/TELEGRAM.md.');
  }

  const missing = [];
  const botToken = String(raw.botToken ?? raw.token ?? '').trim();
  const chatId = raw.chatId === 0 || raw.chatId ? String(raw.chatId).trim() : '';
  const ownerChatId = raw.ownerChatId === 0 || raw.ownerChatId
    ? String(raw.ownerChatId).trim()
    : '';
  if (requireToken && !botToken) missing.push('botToken');
  if (!chatId) missing.push('chatId');
  if (!Array.isArray(raw.founders) || raw.founders.length === 0) missing.push('founders');
  if (missing.length) {
    throw new Error(
      `Telegram config is incomplete: missing ${missing.join(', ')}. See docs/TELEGRAM.md.`);
  }

  const founders = [];
  for (const row of raw.founders) {
    const founder = normFounder(row);
    if (!founder) {
      throw new Error(
        'Telegram config founders must each have name, tag, and a numeric tgUserId. See docs/TELEGRAM.md.');
    }
    founders.push(founder);
  }
  if (!founders.some(founder => founder.owner)) {
    throw new Error('Telegram config needs at least one founder with owner: true.');
  }
  return { botToken, chatId, ownerChatId, founders };
}

async function loadConfig({ requireToken = true } = {}) {
  if (!config) throw new Error('Telegram sender is not configured');
  if (requireToken && !config.botToken) {
    throw new Error('Telegram config has no botToken — refusing to send.');
  }
  return config;
}

// The board injects its `telegram` block here. null clears the sender.
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

// --------------------------------------------------------------- message text

function artifactReadyText(cfg, card) {
  const artifact = artifactUrlOf(card);
  return message([
    tagAll(cfg.founders),
    `The grill artifact is ready for "${cardTitleOf(card)}".`,
    artifact ? `Artifact: ${artifact}` : 'Artifact: (the card has no artifact link yet)',
  ]);
}

function stuckText(cfg, card, digest) {
  return message([
    tagOf(ownerOf(cfg)),
    `Card "${cardTitleOf(card)}" is Stuck after 3 consecutive failures.`,
    `Digest: ${digestText(digest)}`,
  ]);
}

function idleLanesText(cfg, card, finding) {
  const startable = finding?.startable ?? [];
  const queued = startable
    .map(unit => `${unit.unit ? unit.unit + ' ' : ''}#${unit.ticket}`)
    .join(', ');
  const mins = Math.round((finding?.ageMs ?? 0) / 60000);
  return message([
    tagOf(ownerOf(cfg)),
    `⚠ Idle lanes on "${cardTitleOf(card)}": ${(finding?.free ?? []).join(', ')} free for ${mins}m while ${queued} ${startable.length === 1 ? 'waits' : 'wait'} with nothing in the way.`,
    'Lanes are for code; nothing else holds them.',
  ]);
}

function readyText(card) {
  const umbrella = String(card?.links?.ticket ?? card?.umbrella?.url ?? '').trim();
  return `Sprint ${cardTitleOf(card)} is ready for acceptance — ${umbrella}`;
}

function doneText(cfg, card) {
  return message([
    tagAll(cfg.founders),
    `Card "${cardTitleOf(card)}" is done.`,
  ]);
}

// ---------------------------------------------------------------- Telegram I/O

function printDryRun(name, chatId, text) {
  console.log(`--- ${name} ---`);
  console.log(`chatId: ${chatId}`);
  console.log(`text: ${text}`);
  console.log('');
}

async function tg(cfg, method, payload, { abortMs = 20_000 } = {}) {
  if (!cfg.botToken) {
    throw new Error('Telegram config has no botToken — refusing to send.');
  }
  const url = `${TG_API}/bot${cfg.botToken}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), abortMs);
  let response;
  let data;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    data = await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`telegram ${method} timed out after ${abortMs}ms`);
    }
    if (response) {
      throw new Error(`telegram ${method}: answer is not JSON (HTTP ${response.status})`);
    }
    throw new Error(`telegram ${method} failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!data.ok) {
    throw new Error(`telegram ${method} failed: ${data.description || `HTTP ${response.status}`}`);
  }
  return data.result;
}

function destination(cfg, audience) {
  const key = audience === 'owner' ? 'ownerChatId' : 'chatId';
  const chatId = String(cfg[key] ?? '').trim();
  if (!chatId) throw new Error(`Telegram config has no ${key} — refusing to send.`);
  return chatId;
}

async function sendMessage(cfg, { name, audience, text }) {
  const chatId = destination(cfg, audience);
  const clipped = clipText(text);
  if (useDryRun()) {
    printDryRun(name, chatId, clipped);
    return { ok: true, dryRun: true, chatId, text: clipped };
  }
  const result = await tg(cfg, 'sendMessage', {
    chat_id: chatId,
    text: clipped,
    disable_web_page_preview: true,
  });
  return { ok: true, messageId: result?.message_id ?? null, chatId, text: clipped };
}

// -------------------------------------------------------------- sender API

export async function notifyArtifactReady(card) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyArtifactReady',
    audience: 'group',
    text: artifactReadyText(cfg, card),
  });
}

export async function notifyStuck(card, digest) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyStuck',
    audience: 'owner',
    text: stuckText(cfg, card, digest),
  });
}

export async function notifyIdleLanes(card, finding) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyIdleLanes',
    audience: 'owner',
    text: idleLanesText(cfg, card, finding),
  });
}

// The first board-level alarm that belongs to no card: main turned red, a
// merge the board gave up on. Deliberately no needCard.
export async function notifyOwner(text) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  return sendMessage(cfg, { name: 'notifyOwner', audience: 'owner', text: String(text ?? '') });
}

export async function notifyReady(card) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyReady',
    audience: 'owner',
    text: readyText(card),
  });
}

export async function notifyDone(card) {
  const cfg = await loadConfig({ requireToken: !useDryRun() });
  needCard(card);
  return sendMessage(cfg, {
    name: 'notifyDone',
    audience: 'group',
    text: doneText(cfg, card),
  });
}

// ----------------------------------------------------------------- selftest

const SELFTEST_CONFIG = {
  botToken: '',
  chatId: '-1000000000001',
  ownerChatId: '1001',
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
    ticket: 'https://github.com/acme/web/issues/42',
  },
};

async function runSelftest() {
  config = validateConfig(SELFTEST_CONFIG, { requireToken: false });
  await notifyArtifactReady(SELFTEST_CARD);
  await notifyStuck(SELFTEST_CARD, 'local check failed: lane-2 exited 1 (test: pipeline cards)');
  await notifyIdleLanes(SELFTEST_CARD, {
    free: ['lane-2'],
    ageMs: 5 * 60_000,
    startable: [{ unit: 'T2', ticket: 42 }],
  });
  await notifyReady(SELFTEST_CARD);
  await notifyDone(SELFTEST_CARD);
}

async function main() {
  const unknown = unknownFlags();
  if (unknown.length) {
    die(`unknown flag ${unknown[0]} — allowed flags: --dry-run, --selftest`, 2);
  }
  const positional = ARGV.filter(arg => !arg.startsWith('-'));
  if (positional.length) {
    die(`unknown command ${positional[0]} — telegram-bot.mjs is send-only`, 2);
  }
  if (!SELFTEST) {
    die('telegram-bot.mjs is send-only; the board imports its sender functions');
  }
  await runSelftest();
}

if (ranAsMain()) {
  main().catch(error => die(error.message));
}
