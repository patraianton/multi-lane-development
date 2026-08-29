// Auto-dispatch on the board (decision 16): with the switch off the sweep
// says what it would send — the log, the auto-dispatch table in
// /api/pipeline, the page data — and sends nothing. The live sources are a
// facts file; the launchers a fleet-launch file. No ssh, no gh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { startBoard, postJson, getJson } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';

const FACTS = {
  lanes: [
    { host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' },
    { host: 'mac', lane: 'lane-7', busy: true, since: '00:40 ago', branch: 'fix/other-stream' },
    { host: 'lanes-01', lane: 'lane-3', busy: false, since: null, branch: 'main' },
  ],
  prs: [
    { number: 1540, url: 'https://github.com/acme/web/pull/1540', branch: 'feat/salon-u01-readiness', headSha: 'abcdef1234567890abcdef1234567890abcdef12', ci: { color: 'green', text: 'CI green (5)' } },
  ],
  mergedPrs: [],
  openIssues: [],
  unitIssues: {
    1515: [
      { number: 1516, title: 'SALON-U1: readiness contract', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
      // Queued behind U1's open PR: startable from that PR's head.
      { number: 1517, title: 'SALON-U2: paid-placements reader', url: 'https://github.com/acme/web/issues/1517', state: 'OPEN', branch: 'feat/salon-u02-paid-reader', deps: [1516] },
      // Queued with no pinned branch: held, never sent.
      { number: 1522, title: 'SALON-U4: composition', url: 'https://github.com/acme/web/issues/1522', state: 'OPEN', branch: '' },
    ],
  },
  ciJobs: {},
  ciRunners: [],
  umbrellaStates: { 1515: 'OPEN' },
  staleSources: [],
};

const FLEET = {
  prompt: 'Прочитай {taskFile} и выполни целиком',
  hosts: {
    mac: { kitchen: '~/kitchens/web', shell: 'export PATH=/opt/homebrew/bin:$PATH;', launch: 'maclane {n} "{prompt}"' },
    'lanes-01': { kitchen: '/root/kitchens/web', launch: 'hzlane {n} "{prompt}"' },
  },
  lanes: { 'lane-6': { host: 'mac', n: 6 }, 'lane-7': { host: 'mac', n: 7 }, 'lane-3': { host: 'lanes-01', n: 3, noBuilds: true } },
};

async function until(base, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const data = await getJson(base, '/api/pipeline?format=json');
    if (ready(data.body) || Date.now() > deadline) return data.body;
    await new Promise(r => setTimeout(r, 150));
  }
}

test('off by default: the board says what it would dispatch and sends nothing', async () => {
  const board = await startBoard({
    port: 14985,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': FACTS, 'fleet-launch.json': FLEET },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
      WATCHTOWER_AUTO_DISPATCH: '',
    }),
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'AUTO-SALON sprint', spec: 'the spec' });
    const id = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'development' });

    const api = await until(board.base, b => (b.autoDispatch ?? []).some(r => r.state === 'would dispatch'));
    const would = api.autoDispatch.filter(r => r.state === 'would dispatch');
    assert.deepEqual(would, [{
      card: 'AUTO-SALON sprint', unit: 'U2 #1517', lane: 'mac/lane-6',
      base: 'feat/salon-u01-readiness@abcdef12 (PR #1540 of U1)', state: 'would dispatch',
    }], 'U2 goes to the free Mac lane from the head of U1\'s open PR; the light lane-3 is not chosen');
    assert.ok(api.autoDispatch.some(r => r.unit === 'U4 #1522' && /^held: no pinned branch/.test(r.state)), 'U4 without a branch is held, and the table says why');
    assert.equal(api.summary.autoDispatchOn, false);
    assert.equal(api.summary.autoDispatch, api.autoDispatch.length);

    // The same in the plain-text table and on the page's data.
    const text = await (await fetch(board.base + '/api/pipeline')).text();
    assert.match(text, /^auto-dispatch\[\d+\]\{card,unit,lane,base,state\}:$/m);
    assert.match(text, /AUTO-SALON sprint,U2 #1517,mac\/lane-6,feat\/salon-u01-readiness@abcdef12 \(PR #1540 of U1\),would dispatch/);
    const data = await getJson(board.base, '/pipeline/data');
    assert.equal(data.body.autoDispatch.on, false);
    assert.equal(data.body.autoDispatch.rows[0].unit, 'U2 #1517');

    // The log says so once; the journal stays empty — nothing was sent.
    assert.match(board.output(), /auto-dispatch: off \(dry-run\)/);
    assert.match(board.output(), /auto-dispatch: would dispatch U2 #1517 -> mac\/lane-6 from feat\/salon-u01-readiness@abcdef12 \(PR #1540 of U1\) \(WATCHTOWER_AUTO_DISPATCH=1 to send\)/);
    assert.equal((board.output().match(/would dispatch U2 #1517/g) ?? []).length, 1, 'said once, not every sweep');
    await assert.rejects(readFile(path.join(board.dir, 'auto-dispatch.json')), 'the journal is only written on a send: no file');
  } finally {
    await board.stop();
  }
});
