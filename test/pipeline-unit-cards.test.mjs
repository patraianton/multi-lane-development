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
  ],
  prs: [{ number: 1540, url: 'https://github.com/acme/web/pull/1540', branch: 'feat/salon-u01-readiness', ci: { color: 'green', text: 'CI green (5)' } }],
  mergedPrs: [{ number: 1530, url: 'https://github.com/acme/web/pull/1530', branch: 'feat/salon-u03-reserve-reader', mergedAt: '2026-08-28T20:00:00Z' }],
  unitIssues: {
    1515: [
      { number: 1519, title: 'SALON-U5: migration 133 - daily rotation set', url: 'https://github.com/acme/web/issues/1519', state: 'OPEN', branch: 'feat/salon-u05-migration-133' },
      { number: 1517, title: 'SALON-U2: paid-placements reader', url: 'https://github.com/acme/web/issues/1517', state: 'OPEN', branch: 'feat/salon-u02-paid-reader' },
      { number: 1516, title: 'SALON-U1: readiness contract', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
      { number: 1518, title: 'SALON-U3: reserve reader', url: 'https://github.com/acme/web/issues/1518', state: 'CLOSED', branch: 'feat/salon-u03-reserve-reader' },
      { number: 1522, title: 'SALON-U4: composition', url: 'https://github.com/acme/web/issues/1522', state: 'OPEN', branch: 'feat/salon-u04-composition' },
    ],
  },
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
    assert.equal(early.cards.find(c => c.id === id).sprint.counts.units, 5, 'the roll-up exists already');

    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
    const data = await untilUnits(board.base, id, 5);
    const units = data.cards.filter(c => c.parent === id);
    assert.equal(units.length, 5);
    const by = Object.fromEntries(units.map(u => [u.unit, u]));
    assert.deepEqual(Object.keys(by).sort(), ['U1', 'U2', 'U3', 'U4', 'U5']);

    // Titles, bindings, attachments.
    assert.equal(by.U5.title, 'U5 #1519 — migration 133 - daily rotation set');
    assert.equal(by.U5.ticket, 1519);
    assert.equal(by.U5.links.ticket, 'https://github.com/acme/web/issues/1519');
    assert.equal(by.U5.links.branch, 'feat/salon-u05-migration-133');
    assert.equal(by.U5.lane, 'mac/lane-b');
    assert.equal(by.U5.sprintTitle, 'AUTO-SALON sprint');
    assert.equal(by.U5.unitFacts.state, 'on lane');

    // Stages by facts: lane → development, PR → ci_pr, merged → accepted, nothing → ticketed.
    assert.equal(by.U5.stage, 'development');
    assert.equal(by.U2.stage, 'development');
    assert.equal(by.U1.stage, 'ci_pr');
    assert.equal(by.U1.links.pr, 'https://github.com/acme/web/pull/1540');
    assert.equal(by.U3.stage, 'accepted');
    assert.equal(by.U3.links.pr, 'https://github.com/acme/web/pull/1530');
    assert.equal(by.U4.stage, 'ticketed');
    assert.equal(by.U4.unitFacts.state, 'queued');
    // The clock of a spawned card starts at the stage the facts put it in.
    assert.deepEqual(by.U1.stageHistory.map(h => h.stage), ['ticketed', 'ci_pr']);

    // A second sweep changes nothing and spawns nothing twice.
    await settle(700);
    const again = await getJson(board.base, '/pipeline/data');
    assert.equal(again.body.cards.filter(c => c.parent === id).length, 5);

    // The agent views.
    const list = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(list.body.summary.units, 5);
    assert.equal(list.body.cards.find(c => c.id === id).sprint.onLane, 2);
    const one = await getJson(board.base, `/api/pipeline/card/${by.U1.id}?format=json`);
    assert.equal(one.body.sprintOf, `${id} — AUTO-SALON sprint`);
    assert.equal(one.body.unit, 'U1');
    const toon = await fetch(`${board.base}/api/pipeline/card/${id}`).then(r => r.text());
    assert.ok(toon.includes('lanes: radar/lane-1 U2 #1517, mac/lane-b U5 #1519'), toon);
    assert.ok(/units\[5\]/.test(toon), toon);

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

    // Deleting the sprint takes its unit cards with it.
    const del = await postJson(board.base, '/pipeline/card/delete', { id });
    assert.equal(del.status, 200);
    const gone = await getJson(board.base, '/pipeline/data');
    assert.equal(gone.body.cards.length, 0);
  } finally {
    await board.stop();
  }
});
