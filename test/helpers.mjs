// Shared plumbing for the integration tests: a real board server on its own
// port with its own state directory, so a test can speak plain HTTP to it and
// the live board (4878) is never touched.

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WAIT_TIMEOUT_MS = 30_000;

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!port) throw new Error('the OS did not assign a test port');
  return port;
}

// Test command fakes are JavaScript so they work on every board host. Windows
// needs a PATHEXT-visible wrapper; elsewhere the Node shebang is executable.
export async function executable(dir, name, text) {
  if (process.platform === 'win32') {
    const scriptName = `${name}.watchtower-fake.mjs`;
    const script = path.join(dir, scriptName);
    const wrapper = path.join(dir, `${name}.watchtower-fake.cmd`);
    // The board puts the argv JSON in a per-child environment variable. That
    // avoids cmd.exe reparsing bodies containing spaces, newlines or `&`.
    const source = String(text).replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
    await writeFile(script, [
      '#!/usr/bin/env node',
      "const encoded = process.env.WATCHTOWER_FAKE_ARGS_B64 || '';",
      "if (encoded) process.argv.push(...JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));",
      'delete process.env.WATCHTOWER_FAKE_ARGS_B64;',
      source,
    ].join('\n'));
    await writeFile(wrapper, `@"${process.execPath}" "%~dp0${scriptName}"\r\n`);
    return wrapper;
  }
  const file = path.join(dir, name);
  await writeFile(file, text);
  await chmod(file, 0o755);
  return file;
}

// Start `node bin/watchtower.mjs` on an OS-assigned port with a fresh state
// directory. `config` becomes state/autopase-board.json — pass a function to
// receive the directory path when needed. Extra `files` land in the same
// directory. A non-zero port remains available for focused helper debugging.
export async function startBoard({ port = 0, config = {}, files = {}, env = {} }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'watchtower-test-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  const rawCfg = typeof config === 'function' ? config(dir) : config;
  const cfg = { autoDispatch: false, ...(rawCfg ?? {}) };
  await writeFile(path.join(dir, 'autopase-board.json'), JSON.stringify(cfg, null, 2));
  // `env` adds process environment for the board (a function receives the
  // state directory, for variables that must point into it).
  const extraEnv = typeof env === 'function' ? env(dir) : env;
  const realPort = port || await availablePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'watchtower.mjs')], {
    env: { ...process.env, ...extraEnv, WATCHTOWER_PORT: String(realPort), WATCHTOWER_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${realPort}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the board exited before listening (code ${child.exitCode}):\n${output}`);
    }
    try {
      const res = await fetch(`${base}/pipeline/data`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the board did not start listening on ${realPort} in 15s:\n${output}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    base,
    port: realPort,
    dir,
    output: () => output,
    async stop() {
      child.kill();
      await new Promise(r => {
        child.once('exit', r);
        setTimeout(r, 2000);
      });
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Poll either a board endpoint or an async condition. Every suite uses the
// same generous failure deadline; successful conditions still return as soon
// as they are ready.
export async function until(baseOrCheck, ready, { pathName = '/api/pipeline?format=json' } = {}) {
  const check = typeof baseOrCheck === 'function'
    ? baseOrCheck
    : async () => {
        const body = (await getJson(baseOrCheck, pathName)).body;
        return ready(body) ? body : null;
      };
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = null;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error(`condition was not met in ${WAIT_TIMEOUT_MS}ms: ${JSON.stringify(last)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function journalUntil(file, ready) {
  return until(async () => {
    let value = null;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet */ }
    return value !== null && ready(value) ? value : null;
  });
}

export async function postJson(base, pathName, body) {
  const res = await fetch(base + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

export async function getJson(base, pathName) {
  const res = await fetch(base + pathName);
  return { status: res.status, body: await res.json() };
}
