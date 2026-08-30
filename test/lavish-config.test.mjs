// Parsing the `lavish` and `cloudflare` blocks of state/autopase-board.json
// (docs/GRILL.md §5, docs/ARTIFACT.md). Pure unit tests over bin/lavish-config.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseLavish, parseCloudflare, readBoardConfig, requireFields,
} from '../bin/lavish-config.mjs';

test('parseLavish normalizes a full block', () => {
  const out = parseLavish({ publicBaseUrl: 'https://lavish.example.com/', apiToken: ' t0k ' });
  assert.deepEqual(out, { publicBaseUrl: 'https://lavish.example.com', apiToken: 't0k' });
});

test('parseLavish tolerates an absent block', () => {
  assert.deepEqual(parseLavish(undefined), { publicBaseUrl: '', apiToken: '' });
  assert.deepEqual(parseLavish(null), { publicBaseUrl: '', apiToken: '' });
});

test('parseLavish rejects a non-object block and a bad URL', () => {
  assert.throws(() => parseLavish('nope'), /must be an object/);
  assert.throws(() => parseLavish(['nope']), /must be an object/);
  assert.throws(() => parseLavish({ publicBaseUrl: 'ftp://x' }), /http:\/\/ or https:\/\//);
});

test('parseCloudflare normalizes and tolerates absence', () => {
  assert.deepEqual(parseCloudflare({ accountId: ' a1 ', apiToken: 'cf' }),
    { accountId: 'a1', apiToken: 'cf' });
  assert.deepEqual(parseCloudflare(undefined), { accountId: '', apiToken: '' });
  assert.throws(() => parseCloudflare(42), /must be an object/);
});

test('readBoardConfig reads the file and survives a missing one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lavish-config-test-'));
  try {
    const file = path.join(dir, 'autopase-board.json');
    await writeFile(file, JSON.stringify({
      apiToken: 'board-token',
      lavish: { publicBaseUrl: 'https://lavish.example.com/', apiToken: 'pub' },
      cloudflare: { accountId: 'acc', apiToken: 'cf' },
    }));
    const cfg = await readBoardConfig(file);
    assert.equal(cfg.lavish.publicBaseUrl, 'https://lavish.example.com');
    assert.equal(cfg.lavish.apiToken, 'pub');
    assert.equal(cfg.cloudflare.accountId, 'acc');
    assert.equal(cfg.boardApiToken, 'board-token');
    assert.equal(cfg.boardUrl, 'http://127.0.0.1:4878');

    const empty = await readBoardConfig(path.join(dir, 'missing.json'));
    assert.equal(empty.lavish.publicBaseUrl, '');
    assert.equal(empty.boardUrl, 'http://127.0.0.1:4878');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requireFields names every missing field and the file', async () => {
  const cfg = { file: '/some/state/autopase-board.json',
    lavish: { publicBaseUrl: 'https://x.example', apiToken: '' },
    cloudflare: { accountId: '', apiToken: '' } };
  assert.throws(
    () => requireFields(cfg, ['lavish.publicBaseUrl', 'lavish.apiToken', 'cloudflare.accountId']),
    (e) => e.message.includes('lavish.apiToken')
      && e.message.includes('cloudflare.accountId')
      && !e.message.includes('lavish.publicBaseUrl,')
      && e.message.includes('/some/state/autopase-board.json'),
  );
  requireFields(cfg, ['lavish.publicBaseUrl']); // present — must not throw
});
