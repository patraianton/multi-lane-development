#!/usr/bin/env node
// One-command deploy of the artifact worker to Cloudflare (docs/ARTIFACT.md).
//
//   node bin/lavish-deploy.mjs [--fork <path>] [--check]
//
// Reads cloudflare.accountId / cloudflare.apiToken and lavish.apiToken from
// state/autopase-board.json and then, in order:
//   1. builds the chrome assets from the lavish-axi fork (build-assets.mjs),
//   2. makes sure the KV namespace "watchtower-lavish-sessions" exists
//      (Cloudflare REST API; the id is cached back into the board config as
//      cloudflare.kvNamespaceId so later deploys skip the lookup),
//   3. writes deploy/lavish-worker/wrangler.gen.jsonc from the template,
//   4. runs `npx wrangler deploy`,
//   5. stores lavish.apiToken as the worker secret LAVISH_API_TOKEN.
//
// --check stops after validating config and assets — nothing touches
// Cloudflare. Without credentials in the config the command refuses with the
// exact fields to add; it never asks interactively.

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readBoardConfig, requireFields, configFile } from './lavish-config.mjs';
import { readJsonSoft, writeJsonAtomic } from './state-file.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKER_DIR = path.join(ROOT, 'deploy', 'lavish-worker');
const KV_TITLE = 'watchtower-lavish-sessions';

const args = process.argv.slice(2);
const check = args.includes('--check');
const forkIdx = args.indexOf('--fork');
const forkFlag = forkIdx >= 0 ? ['--fork', args[forkIdx + 1]] : [];

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: opts.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });
}

async function cf(config, method, pathName, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${config.cloudflare.apiToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok || answer.success === false) {
    const detail = (answer.errors ?? []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${method} ${pathName} failed: ${detail}`);
  }
  return answer.result;
}

const config = await readBoardConfig();
try {
  requireFields(config, ['cloudflare.accountId', 'cloudflare.apiToken', 'lavish.apiToken']);
} catch (e) {
  console.error(`error: ${e.message}`);
  console.error('The Cloudflare API token scopes this deploy needs are listed in docs/ARTIFACT.md.');
  process.exit(1);
}

console.log('building chrome assets from the lavish-axi fork…');
await run(process.execPath, [path.join(WORKER_DIR, 'build-assets.mjs'), ...forkFlag]);

if (check) {
  console.log('check passed: config complete, assets built. Run without --check to deploy.');
  process.exit(0);
}

// KV namespace: reuse the cached id, otherwise find or create it by title.
const rawConfig = await readJsonSoft(configFile(), {});
let kvId = String(rawConfig.cloudflare?.kvNamespaceId ?? '').trim();
if (!kvId) {
  const account = `/accounts/${config.cloudflare.accountId}`;
  const existing = (await cf(config, 'GET', `${account}/storage/kv/namespaces?per_page=100`))
    .find(ns => ns.title === KV_TITLE);
  kvId = existing?.id
    ?? (await cf(config, 'POST', `${account}/storage/kv/namespaces`, { title: KV_TITLE })).id;
  await writeJsonAtomic(configFile(), {
    ...rawConfig,
    cloudflare: { ...rawConfig.cloudflare, kvNamespaceId: kvId },
  });
  console.log(`KV namespace "${KV_TITLE}": ${kvId} (saved to the board config)`);
}

const template = await readFile(path.join(WORKER_DIR, 'wrangler.template.jsonc'), 'utf8');
const generated = template
  .replace('__ACCOUNT_ID__', config.cloudflare.accountId)
  .replace('__KV_NAMESPACE_ID__', kvId);
const generatedPath = path.join(WORKER_DIR, 'wrangler.gen.jsonc');
await writeFile(generatedPath, generated);

const wranglerEnv = {
  CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken,
  CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId,
};
console.log('deploying with wrangler…');
await run('npx', ['-y', 'wrangler@4', 'deploy', '--config', generatedPath], { env: wranglerEnv, cwd: WORKER_DIR });
console.log('storing the publish token as the worker secret…');
await run('npx', ['-y', 'wrangler@4', 'secret', 'put', 'LAVISH_API_TOKEN', '--config', generatedPath], {
  env: wranglerEnv, cwd: WORKER_DIR, input: config.lavish.apiToken,
});
console.log('done. Set lavish.publicBaseUrl in the board config to the URL wrangler printed,');
console.log('then publish with: node bin/lavish-publish.mjs publish <file.html>');
