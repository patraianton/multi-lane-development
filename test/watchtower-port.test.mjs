import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('watchtower reports the port assigned when it listens on port zero', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'watchtower-port-test-'));
  await writeFile(path.join(dir, 'autopase-board.json'), JSON.stringify({
    autoDispatch: false,
    source: 'probe',
  }));

  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'watchtower.mjs')], {
    env: { ...process.env, WATCHTOWER_PORT: '0', WATCHTOWER_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 2000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await rm(dir, { recursive: true, force: true });
  });

  let output = '';
  const startupPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`startup line not found:\n${output}`)), 15_000);
    const onData = chunk => {
      output += chunk;
      const match = output.match(/Watchtower: http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`watchtower exited with code ${code}:\n${output}`));
    });
  });

  assert.ok(startupPort > 0, `expected an assigned port, got ${startupPort}`);
  const response = await fetch(`http://127.0.0.1:${startupPort}/pipeline/data`);
  assert.equal(response.status, 200);
});
