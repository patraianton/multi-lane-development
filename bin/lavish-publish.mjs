#!/usr/bin/env node
// Publish a grill artifact to the Cloudflare-hosted Lavish instance and work
// with it afterwards (docs/GRILL.md §3–§4, docs/ARTIFACT.md).
//
//   node bin/lavish-publish.mjs publish <file.html> [--title "…"] [--key <16hex>]
//                                       [--card <cardId>] [--dry-run]
//   node bin/lavish-publish.mjs poll <key|url> [--watch] [--interval <sec>]
//   node bin/lavish-publish.mjs reply <key|url> --text "…"
//   node bin/lavish-publish.mjs end <key|url>
//
// Shared flags: --base <url> and --token <apiToken> override the `lavish`
// block of state/autopase-board.json; --board <url> and --board-token override
// where --card attaches the artifact link. Publishing with --card POSTs
// /pipeline/card/update — on a grilled card that first set is what rings the
// Telegram doorbell (docs/TELEGRAM.md).
//
// --dry-run prints every request it would make and sends nothing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { readBoardConfig, requireFields } from './lavish-config.mjs';

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--watch') args[a.slice(2)] = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

// Accept either a bare session key or a full /session/<key> URL.
function sessionKeyOf(value, base) {
  const raw = String(value ?? '').trim();
  const fromUrl = /\/session\/([0-9a-f]{16})/.exec(raw);
  if (fromUrl) return fromUrl[1];
  if (/^[0-9a-f]{16}$/.test(raw)) return raw;
  fail(`"${raw}" is neither a session key nor a ${base}/session/<key> URL`);
}

async function api(base, token, method, pathName, body, dryRun) {
  const url = base + pathName;
  if (dryRun) {
    console.log(`dry-run: ${method} ${url}${body ? ` body ${JSON.stringify(body).slice(0, 200)}` : ''}`);
    return null;
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 300) }; }
  if (!res.ok) fail(`${method} ${url} answered ${res.status}: ${parsed.error ?? text.slice(0, 300)}`);
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (!command || !['publish', 'poll', 'reply', 'end'].includes(command)) {
  fail('usage: lavish-publish.mjs publish|poll|reply|end … (see docs/ARTIFACT.md)');
}

const config = await readBoardConfig();
const base = String(args.base ?? config.lavish.publicBaseUrl).replace(/\/+$/, '');
const token = String(args.token ?? config.lavish.apiToken);
if (!base || !token) {
  if (!args.base && !args.token) requireFields(config, ['lavish.publicBaseUrl', 'lavish.apiToken']);
  fail('both --base and --token are needed when the board config has no lavish block');
}
const dryRun = args['dry-run'] === true;

if (command === 'publish') {
  const file = args._[1];
  if (!file) fail('publish needs the artifact HTML file');
  const html = await readFile(file, 'utf8').catch(e => fail(`cannot read ${file}: ${e.message}`));
  const title = args.title
    ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1].trim() || path.basename(file));
  const body = { html, title, file: path.basename(file) };
  if (args.key) body.key = args.key;
  const published = await api(base, token, 'POST', '/api/publish', body, dryRun);
  const url = published?.url ?? `${base}/session/<key>`;
  console.log(dryRun ? `dry-run: would publish ${file} as "${title}"` : `published: ${url}`);
  if (published) console.log(`key: ${published.key} (version ${published.version})`);

  if (args.card) {
    const boardBase = String(args.board ?? config.boardUrl).replace(/\/+$/, '');
    const boardToken = String(args['board-token'] ?? config.boardApiToken);
    const update = { id: args.card, links: { artifact: url } };
    if (dryRun) {
      console.log(`dry-run: POST ${boardBase}/pipeline/card/update body ${JSON.stringify(update)}`);
    } else {
      const res = await fetch(`${boardBase}/pipeline/card/update`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(boardToken ? { authorization: `Bearer ${boardToken}` } : {}),
        },
        body: JSON.stringify(update),
      });
      const answer = await res.json().catch(() => ({}));
      if (!res.ok) fail(`the board refused the card update (${res.status}): ${answer.error ?? ''}`);
      console.log(`card ${args.card}: links.artifact set${answer.card?.notified?.artifact ? ', founders notified' : ''}`);
    }
  }
}

if (command === 'poll') {
  const key = sessionKeyOf(args._[1], base);
  const intervalMs = Math.max(2, Number(args.interval) || 20) * 1000;
  for (;;) {
    const answer = await api(base, token, 'GET', `/api/poll?key=${key}`, undefined, dryRun);
    if (dryRun) break;
    // --watch keeps quiet through "waiting" and stops on the first real answer.
    const done = !args.watch || answer.status !== 'waiting';
    if (done) console.log(JSON.stringify(answer, null, 2));
    if (done) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

if (command === 'reply') {
  const key = sessionKeyOf(args._[1], base);
  const text = String(args.text ?? '').trim();
  if (!text) fail('reply needs --text');
  const answer = await api(base, token, 'POST', `/api/${key}/agent-reply`, { text }, dryRun);
  if (answer) console.log('reply sent');
}

if (command === 'end') {
  const key = sessionKeyOf(args._[1], base);
  const answer = await api(base, token, 'POST', '/api/end', { key }, dryRun);
  if (answer) console.log('session ended');
}
