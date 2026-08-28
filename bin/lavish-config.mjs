// The artifact pipeline's slice of state/autopase-board.json (docs/GRILL.md §5).
//
// Two blocks, both optional in the file but validated here when a caller needs
// them (docs/ARTIFACT.md documents the full shape):
//
//   "lavish":     { "publicBaseUrl": "https://…", "apiToken": "…" }
//   "cloudflare": { "accountId": "…", "apiToken": "…" }
//
// The file itself never lives in git (state/ is ignored). This module is the
// single reader for these blocks — the publish CLI and the deploy CLI both go
// through it, so the error a human sees when a field is missing is always the
// same sentence naming the file and the field.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonSoft } from './state-file.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function stateDir() {
  return process.env.WATCHTOWER_STATE_DIR || path.join(ROOT, 'state');
}

export function configFile() {
  return path.join(stateDir(), 'autopase-board.json');
}

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

// Normalize the `lavish` block. Returns { publicBaseUrl, apiToken } with
// missing fields as empty strings — callers decide which fields they require.
export function parseLavish(raw) {
  if (raw === undefined || raw === null) return { publicBaseUrl: '', apiToken: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the "lavish" block in the board config must be an object');
  }
  const publicBaseUrl = trimSlash(raw.publicBaseUrl);
  if (publicBaseUrl && !/^https?:\/\//.test(publicBaseUrl)) {
    throw new Error('lavish.publicBaseUrl must start with http:// or https://');
  }
  return { publicBaseUrl, apiToken: String(raw.apiToken ?? '').trim() };
}

// Normalize the `cloudflare` block the same way.
export function parseCloudflare(raw) {
  if (raw === undefined || raw === null) return { accountId: '', apiToken: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the "cloudflare" block in the board config must be an object');
  }
  return {
    accountId: String(raw.accountId ?? '').trim(),
    apiToken: String(raw.apiToken ?? '').trim(),
  };
}

// Read the whole config file and normalize the pipeline-relevant parts.
// `boardApiToken` and `boardUrl` ride along because the publish CLI also talks
// to the board (to attach the artifact link to a card).
export async function readBoardConfig(file = configFile()) {
  const raw = await readJsonSoft(file, {});
  return {
    file,
    lavish: parseLavish(raw.lavish),
    cloudflare: parseCloudflare(raw.cloudflare),
    boardApiToken: String(raw.apiToken ?? '').trim(),
    boardUrl: trimSlash(raw.telegram?.boardUrl) || 'http://127.0.0.1:4878',
  };
}

// Demand specific fields, failing with one message that lists everything
// missing at once and names the file to edit.
export function requireFields(config, fields) {
  const missing = [];
  for (const field of fields) {
    const [block, key] = field.split('.');
    if (!config[block]?.[key]) missing.push(field);
  }
  if (missing.length) {
    throw new Error(
      `the board config is missing ${missing.join(', ')} — add ${missing.length > 1 ? 'them' : 'it'} to ${config.file} (see docs/ARTIFACT.md)`,
    );
  }
}
