import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getJson, postJson, startBoard } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('status is board data: no watchdog, no stale flag, no hand endpoint', async () => {
  const board = await startBoard({
    config: { source: 'probe' },
    files: { 'watchdog.json': { boardUrl: 'http://board.invalid', intervalMin: 1 } },
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Status without watchdog' });
    const id = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    await postJson(board.base, '/pipeline/card/update', {
      id,
      links: { ticket: 'https://github.com/acme/web/issues/22' },
    });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'development' });

    const before = await getJson(board.base, '/pipeline/data');
    assert.equal('watchdogIntervalMin' in before.body, false);
    assert.equal('watchdogConfigured' in before.body, false);

    const agentBefore = await getJson(board.base, '/api/pipeline?format=json');
    const rowBefore = agentBefore.body.cards.find(card => card.id === id);
    assert.equal('statusStale' in rowBefore, false);
    assert.equal('staleStatus' in agentBefore.body.summary, false);
    assert.equal('stale' in agentBefore.body, false);

    const windows = await getJson(board.base, '/api/board?format=json');
    assert.equal(windows.body.problems.some(problem => problem.source === 'watchdog'), false);

    const written = await postJson(board.base, `/pipeline/card/${encodeURIComponent(id)}/status`, { text: 'by hand' });
    assert.equal(written.status, 404);
    const ignored = await postJson(board.base, '/pipeline/card/update', { id, status: { text: 'by hand' } });
    assert.equal(ignored.status, 200);
    const card = (await getJson(board.base, '/pipeline/data')).body.cards.find(c => c.id === id);
    assert.deepEqual(Object.keys(card.status).sort(), ['at', 'text']);
    assert.equal(card.status.text, '');
  } finally {
    await board.stop();
  }
});

test('the browser has no founder session or logout client', async () => {
  const html = await readFile(path.join(ROOT, 'bin', 'watchtower.html'), 'utf8');
  for (const dead of ['/auth/me', '/auth/logout', 'loadSignedIn', 'signedIn', 'id="signed-in"']) {
    assert.equal(html.includes(dead), false, dead);
  }
});

test('deployment docs describe the local board and retained probe source mode', async () => {
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  assert.equal(readme.includes('pushed up by the probe'), false);
  assert.equal(readme.includes('probe pushes local herdr'), false);
  assert.match(readme, /board and herdr run on the same machine/i);
  assert.match(readme, /probe source mode remains/i);
});

test('the glossary no longer reserves Status for or defines the deleted watchdog', async () => {
  const context = await readFile(path.join(ROOT, 'CONTEXT.md'), 'utf8');
  assert.doesNotMatch(context, /\*\*Watchdog\*\*:/);
  assert.doesNotMatch(context, /reserved for the watchdog/i);
  assert.match(context, /\*\*Status\*\*:[\s\S]*written by the board/i);
});
