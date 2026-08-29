// Unit cards: after ticketed a sprint card's unit tickets become cards of their
// own, bound to the sprint and walked forward by facts (lane, PR, merge). The
// live sources are replaced by a facts file for the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBoard, postJson, getJson } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';

const FACTS = {
  lanes: [
    { host: 'radar', lane: 'lane-1', busy: true, since: 'Fri 18:44', branch: 'feat/salon-u02-paid-reader' },
    { host: 'radar', lane: 'lane-2', busy: false, since: null, branch: 'main' },
    { host: 'mac', lane: 'lane-b', busy: true, since: '00:40 ago', branch: 'feat/salon-u05-migration-133', task: 'TASK-1519.md' },
    // The lane is running the project's local check: that is the local_check fact.
    { host: 'mac', lane: 'lane-a', busy: true, since: '03:10 ago', branch: 'feat/salon-u06-band', task: 'TASK-1523.md', check: { pid: '4242', since: '02:40 ago', cmd: 'node scripts/ci-local.mjs' } },
  ],
  prs: [{ number: 1540, url: 'https://github.com/acme/web/pull/1540', branch: 'feat/salon-u01-readiness', ci: { color: 'green', text: 'CI green (5)' } }],
  mergedPrs: [{ number: 1530, url: 'https://github.com/acme/web/pull/1530', branch: 'feat/salon-u03-reserve-reader', mergedAt: '2026-08-28T20:00:00Z' }],
  unitIssues: {
    1515: [
      { number: 1519, title: 'SALON-U5: migration 133 - daily rotation set', url: 'https://github.com/acme/web/issues/1519', state: 'OPEN', branch: 'feat/salon-u05-migration-133', deps: [1518, 1516] },
      { number: 1517, title: 'SALON-U2: paid-placements reader', url: 'https://github.com/acme/web/issues/1517', state: 'OPEN', branch: 'feat/salon-u02-paid-reader' },
      { number: 1516, title: 'SALON-U1: readiness contract', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
      { number: 1518, title: 'SALON-U3: reserve reader', url: 'https://github.com/acme/web/issues/1518', state: 'CLOSED', branch: 'feat/salon-u03-reserve-reader' },
      { number: 1522, title: 'SALON-U4: composition', url: 'https://github.com/acme/web/issues/1522', state: 'OPEN', branch: 'feat/salon-u04-composition' },
      { number: 1523, title: 'SALON-U6: sprint band', url: 'https://github.com/acme/web/issues/1523', state: 'OPEN', branch: 'feat/salon-u06-band' },
    ],
  },
  ciJobs: { 1540: [{ workflow: 'pr-ci', job: 'pr-ci', status: 'in_progress', runner: 'radar-runner-3', startedAt: '2026-08-28T20:50:00Z' }] },
  ciRunners: [{ name: 'radar-runner-3', status: 'online', busy: true, labels: ['self-hosted', 'hetzner'] }],
  staleSources: [],
};

// The sprint sweep runs on its own short timer in the test; wait for it.
async function until(base, ready, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const data = await getJson(base, '/pipeline/data');
    if (ready(data.body) || Date.now() > deadline) return data.body;
    await new Promise(r => setTimeout(r, 150));
  }
}
const untilUnits = (base, parent, count) => until(base, d => d.cards.filter(c => c.parent === parent).length >= count);
const settle = ms => new Promise(r => setTimeout(r, ms));

test('a sprint card spawns unit cards from its tickets and the facts move them', async () => {
  const board = await startBoard({
    port: 14990,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': FACTS },
    env: dir => ({ WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'), WATCHTOWER_SPRINT_SWEEP_MS: '300' }),
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'AUTO-SALON sprint', spec: 'the spec' });
    const id = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    // Still on a paper stage: an umbrella link alone spawns nothing.
    await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
    const early = await until(board.base, d => d.cards.find(c => c.id === id)?.sprint);
    assert.equal(early.cards.filter(c => c.parent === id).length, 0);
    assert.equal(early.cards.find(c => c.id === id).sprint.counts.units, 6, 'the roll-up exists already');

    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    const data = await untilUnits(board.base, id, 6);
    const units = data.cards.filter(c => c.parent === id);
    assert.equal(units.length, 6);
    const by = Object.fromEntries(units.map(u => [u.unit, u]));
    assert.deepEqual(Object.keys(by).sort(), ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']);

    // Titles, bindings, attachments.
    assert.equal(by.U5.title, 'U5 #1519 — migration 133 - daily rotation set');
    assert.equal(by.U5.ticket, 1519);
    assert.equal(by.U5.links.ticket, 'https://github.com/acme/web/issues/1519');
    assert.equal(by.U5.links.branch, 'feat/salon-u05-migration-133');
    assert.equal(by.U5.lane, 'mac/lane-b');
    assert.equal(by.U5.sprintTitle, 'AUTO-SALON sprint');
    assert.equal(by.U5.unitFacts.state, 'on lane');
    // The card carries its ticket's dependencies with the state of each unit named.
    assert.deepEqual(by.U5.unitFacts.deps, [
      { ticket: 1518, unit: 'U3', state: 'merged', met: true },
      { ticket: 1516, unit: 'U1', state: 'pr green', met: false },
    ]);
    assert.deepEqual(by.U2.unitFacts.deps, []);

    // Stages by facts: lane → development, the lane running the local check →
    // local_check, PR → ci_pr, merged → done, nothing → ticketed.
    assert.equal(by.U5.stage, 'development');
    assert.equal(by.U2.stage, 'development');
    assert.equal(by.U6.stage, 'local_check', 'the lane runs the local check');
    assert.equal(by.U6.unitFacts.state, 'local check');
    assert.equal(by.U6.lane, 'mac/lane-a');
    assert.equal(by.U1.stage, 'ci_pr');
    assert.equal(by.U1.links.pr, 'https://github.com/acme/web/pull/1540');
    assert.equal(by.U1.slot, 'radar-runner-3', 'the CI slot is the runner the check is on');
    assert.equal(by.U1.unitFacts.pr.runner.host, 'hetzner');
    assert.equal(by.U3.stage, 'done');
    assert.equal(by.U3.links.pr, 'https://github.com/acme/web/pull/1530');
    assert.equal(by.U4.stage, 'ticketed');
    assert.equal(by.U4.unitFacts.state, 'queued');
    // The clock of a spawned card starts at the stage the facts put it in.
    assert.deepEqual(by.U1.stageHistory.map(h => h.stage), ['ticketed', 'ci_pr']);
    // The sprint's own stage followed its units: work has started.
    assert.equal(data.cards.find(c => c.id === id).stage, 'development');

    // A second sweep changes nothing and spawns nothing twice.
    await settle(700);
    const again = await getJson(board.base, '/pipeline/data');
    assert.equal(again.body.cards.filter(c => c.parent === id).length, 6);

    // The agent views.
    const list = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(list.body.summary.units, 6);
    assert.equal(list.body.cards.find(c => c.id === id).sprint.onLane, 2);
    const one = await getJson(board.base, `/api/pipeline/card/${by.U1.id}?format=json`);
    assert.equal(one.body.sprintOf, `${id} — AUTO-SALON sprint`);
    assert.equal(one.body.unit, 'U1');
    const toon = await fetch(`${board.base}/api/pipeline/card/${id}`).then(r => r.text());
    assert.ok(toon.includes('lanes: radar/lane-1 U2 #1517, mac/lane-b U5 #1519, mac/lane-a U6 #1523'), toon);
    assert.ok(/units\[6\]/.test(toon), toon);
    assert.ok(toon.includes('ci-slots: 1 of 1 busy (hetzner 1/1)'), toon);
    assert.ok(toon.includes('radar-runner-3 (hetzner)'), toon);

    // Facts never walk a card backwards: a lane that went quiet leaves U5 in development.
    const quiet = { ...FACTS, lanes: FACTS.lanes.filter(l => l.lane !== 'lane-b') };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(quiet));
    const after = await until(board.base, d => d.cards.find(c => c.id === by.U5.id)?.lane === '');
    const u5 = after.cards.find(c => c.id === by.U5.id);
    assert.equal(u5.stage, 'development');
    assert.equal(u5.lane, '', 'the lane attachment follows the facts');

    // Stale sources hold every move; attachments still refresh.
    const stale = { ...FACTS, staleSources: ['lanes'], prs: [...FACTS.prs, { number: 1550, url: 'https://github.com/acme/web/pull/1550', branch: 'feat/salon-u04-composition', ci: { color: 'run', text: 'CI running (1)' } }] };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(stale));
    const held = await until(board.base, d => d.cards.find(c => c.id === by.U4.id)?.links.pr);
    const u4 = held.cards.find(c => c.id === by.U4.id);
    assert.equal(u4.stage, 'ticketed', 'stale sources: no move');
    assert.equal(u4.links.pr, 'https://github.com/acme/web/pull/1550');

    // Every unit merged (or closed): the sprint reaches done by itself — and
    // no further.
    const done = {
      ...FACTS, staleSources: [], prs: [],
      mergedPrs: FACTS.unitIssues[1515].map((u, i) => ({ number: 1600 + i, url: `https://github.com/acme/web/pull/${1600 + i}`, branch: u.branch, mergedAt: '2026-08-29T01:00:00Z' })),
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(done));
    const finished = await until(board.base, d => d.cards.find(c => c.id === id)?.stage === 'done');
    assert.equal(finished.cards.find(c => c.id === id).stage, 'done');
    assert.ok(finished.cards.filter(c => c.parent === id).every(u => u.stage === 'done'));

    // Deleting the sprint takes its unit cards with it.
    const del = await postJson(board.base, '/pipeline/card/delete', { id });
    assert.equal(del.status, 200);
    const gone = await getJson(board.base, '/pipeline/data');
    assert.equal(gone.body.cards.length, 0);
  } finally {
    await board.stop();
  }
});
