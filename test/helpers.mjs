// Shared plumbing for the integration tests: a real board server on its own
// port with its own state directory, so a test can speak plain HTTP to it and
// the live board (4878) is never touched.

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

// Start `node bin/watchtower.mjs` on the given port with a fresh state
// directory. `config` becomes state/autopase-board.json — pass a function to
// receive the directory path (for settings that must point into it, like
// streamWatch). Extra `files` land in the same directory.
export async function startBoard({ port, config = {}, files = {}, env = {} }) {
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
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'watchtower.mjs')], {
    env: { ...process.env, ...extraEnv, WATCHTOWER_PORT: String(port), WATCHTOWER_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const base = `http://127.0.0.1:${port}`;
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
      throw new Error(`the board did not start listening on ${port} in 15s:\n${output}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    base,
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
