// Unit cards: after ticketed a sprint card's unit tickets become cards of their
// own, bound to the sprint and walked forward by facts (lane, PR, merge). The
// live sources are replaced by a facts file for the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { startBoard, postJson, getJson } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';
const REVIEW_HEAD = 'abc12345abcdef0123456789abcdef0123456789';

const FACTS = {
  lanes: [
    { host: 'radar', lane: 'lane-1', busy: true, since: 'Fri 18:44', branch: 'feat/salon-u02-paid-reader' },
    { host: 'radar', lane: 'lane-2', busy: false, since: null, branch: 'main' },
    { host: 'mac', lane: 'lane-b', busy: true, since: '00:40 ago', branch: 'feat/salon-u05-migration-133', task: 'TASK-1519.md' },
    // The lane is running the project's local check: that is the local_check fact.
    { host: 'mac', lane: 'lane-a', busy: true, since: '03:10 ago', branch: 'feat/salon-u06-band', task: 'TASK-1523.md', check: { pid: '4242', since: '02:40 ago', cmd: 'node scripts/ci-local.mjs' } },
  ],
  prs: [
    { number: 1540, url: 'https://github.com/acme/web/pull/1540', branch: 'feat/salon-u01-readiness', headSha: REVIEW_HEAD, ci: { color: 'green', text: 'CI green (5)', headSha: REVIEW_HEAD } },
    // Nobody's PR: no card carries its branch — off the board.
    { number: 1599, title: 'stray fix', url: 'https://github.com/acme/web/pull/1599', branch: 'fix/stray', ci: { color: 'none', text: 'no checks' } },
  ],
  // Open issues as the watch sees them: a fix labelled qa that names no umbrella.
  openIssues: [
    { number: 1595, title: 'salon: heading fix', url: 'https://github.com/acme/web/issues/1595', qa: true, refs: [] },
    { number: 1596, title: 'a thought for later', url: 'https://github.com/acme/web/issues/1596', refs: [] },
  ],
  mergedPrs: [{ number: 1530, url: 'https://github.com/acme/web/pull/1530', branch: 'feat/salon-u03-reserve-reader', mergedAt: '2026-08-28T20:00:00Z' }],
  unitIssues: {
    1515: [
      { number: 1519, title: 'SALON-U5: migration 133 - daily rotation set', url: 'https://github.com/acme/web/issues/1519', state: 'OPEN', branch: 'feat/salon-u05-migration-133', deps: [1518, 1516] },
      { number: 1517, title: 'SALON-U2: paid-placements reader', url: 'https://github.com/acme/web/issues/1517', state: 'OPEN', branch: 'feat/salon-u02-paid-reader' },
      { number: 1516, title: 'SALON-U1: readiness contract', url: 'https://github.com/acme/web/issues/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
      // Closed an hour after its merge: accepted, so done.
      { number: 1518, title: 'SALON-U3: reserve reader', url: 'https://github.com/acme/web/issues/1518', state: 'CLOSED', closedAt: '2026-08-28T21:00:00Z', branch: 'feat/salon-u03-reserve-reader' },
      { number: 1522, title: 'SALON-U4: composition', url: 'https://github.com/acme/web/issues/1522', state: 'OPEN', branch: 'feat/salon-u04-composition' },
      { number: 1523, title: 'SALON-U6: sprint band', url: 'https://github.com/acme/web/issues/1523', state: 'OPEN', branch: 'feat/salon-u06-band' },
      // A QA ticket: the reviews' leftovers, labelled qa — not scope, a card in QA.
      { number: 1590, title: 'AUTO-SALON tails carried out of the sprint', url: 'https://github.com/acme/web/issues/1590', state: 'OPEN', branch: '', qa: true },
    ],
  },
  ciJobs: { 1540: [{ workflow: 'pr-ci', job: 'pr-ci', status: 'in_progress', runner: 'radar-runner-3', startedAt: '2026-08-28T20:50:00Z' }] },
  ciRunners: [{ name: 'radar-runner-3', status: 'online', busy: true, labels: ['self-hosted', 'hetzner'] }],
  umbrellaStates: { 1515: 'OPEN' },
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

function failureFacts({ ci = null, comments = [] } = {}) {
  const branch = 'feat/failure-u1';
  return {
    lanes: [],
    prs: ci ? [{
      number: 5154,
      url: 'https://github.com/acme/web/pull/5154',
      branch,
      headSha: 'abc1234567890000000000000000000000000000',
      ci,
    }] : [],
    mergedPrs: [],
    unitIssues: {
      5151: [{
        number: 5152,
        title: 'FAIL-U1: prove failures',
        url: 'https://github.com/acme/web/issues/5152',
        state: 'OPEN',
        branch,
        comments,
      }],
    },
    umbrellaStates: { 5151: 'OPEN' },
    staleSources: [],
  };
}

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
    const data = await untilUnits(board.base, id, 7);
    const units = data.cards.filter(c => c.parent === id);
    assert.equal(units.length, 7);
    const by = Object.fromEntries(units.map(u => [u.unit, u]));
    assert.deepEqual(Object.keys(by).sort(), ['QA', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6']);
    // The QA ticket is a card in QA from the start, apart from the units.
    assert.equal(by.QA.title, 'QA #1590 — AUTO-SALON tails carried out of the sprint');
    assert.equal(by.QA.stage, 'ticketed', 'a finding nobody has picked up is a ticket like any other (decision 19)');
    assert.equal(by.QA.unitFacts.state, 'open');
    assert.equal(data.cards.find(c => c.id === id).sprint.counts.units, 6, 'QA tickets are not scope');
    assert.equal(data.cards.find(c => c.id === id).sprint.counts.qaOpen, 1);

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
      { ticket: 1518, unit: 'U3', state: 'accepted', met: true },
      { ticket: 1516, unit: 'U1', state: 'pr green', met: false },
    ]);
    assert.deepEqual(by.U2.unitFacts.deps, []);

    // Stages by facts: lane → development, the lane running the local check →
    // local_check, PR with green CI → review (decision 17), merged → done, nothing → ticketed.
    assert.equal(by.U5.stage, 'development');
    assert.equal(by.U2.stage, 'development');
    assert.equal(by.U6.stage, 'local_check', 'the lane runs the local check');
    assert.equal(by.U6.unitFacts.state, 'local check');
    assert.equal(by.U6.lane, 'mac/lane-a');
    assert.equal(by.U1.stage, 'ci_pr', 'PR open: CI and the reader on the same head, then the merge (decision 20)');
    assert.equal(by.U1.links.pr, 'https://github.com/acme/web/pull/1540');
    assert.equal(by.U1.slot, 'radar-runner-3', 'the CI slot is the runner the check is on');
    assert.equal(by.U1.unitFacts.pr.runner.host, 'hetzner');
    assert.equal(by.U3.stage, 'done');
    assert.equal(by.U3.links.pr, 'https://github.com/acme/web/pull/1530');
    assert.equal(by.U4.stage, 'ticketed');
    assert.equal(by.U4.unitFacts.state, 'queued');
    // The clock of a spawned card starts at the stage the facts put it in.
    assert.deepEqual(by.U1.stageHistory.map(h => h.stage), ['ticketed', 'ci_pr']);

    // The live review badge (decision 20): the board says a reader is
    // on U1's head; the board shows it and clears it when a verdict newer than
    // the badge lands on the PR, filing the round.
    const lit = await postJson(board.base, '/pipeline/card/update', { id: by.U1.id, review: { running: true, round: 1, by: 'opus' } });
    assert.equal(lit.status, 200);
    assert.equal(lit.body.card.review.running, true);
    assert.equal(lit.body.card.review.round, 1);
    assert.ok(lit.body.card.review.since);
    const listed = await getJson(board.base, '/api/pipeline?format=json');
    assert.deepEqual(listed.body.cards.find(c => c.id === by.U1.id).review.round, 1);
    const judged = {
      ...FACTS,
      prs: FACTS.prs.map(p => p.number === 1540 ? { ...p, verdict: { round: 1, go: true, head: 'abc12345', at: '2030-01-01T00:00:00Z' } } : p),
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(judged));
    const dark = await until(board.base, d => d.cards.find(c => c.id === by.U1.id)?.review?.running === false);
    const u1Read = dark.cards.find(c => c.id === by.U1.id);
    assert.equal(u1Read.review.running, false, 'the verdict clears the badge');
    assert.equal(u1Read.reviews.length, 1);
    assert.equal(u1Read.reviews[0].round, 1);
    assert.equal(u1Read.reviews[0].until, '2030-01-01T00:00:00.000Z', 'the round ends when the verdict was written');
    assert.equal(u1Read.stage, 'ci_pr', 'a GO does not move the card: the merge does');
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(FACTS));
    // The sprint's own stage followed its units: work has started.
    assert.equal(data.cards.find(c => c.id === id).stage, 'development');

    // The watch: the stray PR and the umbrella-less fix are off the board, the
    // thought is not work; both are in the ledger with their fix.
    const watched = await until(board.base, d => d.offBoard && d.offBoard.findings.length === 2);
    assert.deepEqual(watched.offBoard.findings.map(f => [f.kind, f.ref]).sort(), [['pr', 'PR #1599'], ['ticket', '#1595']]);
    assert.equal(watched.offBoard.skipped, null);
    const ledger = await readFile(path.join(board.dir, 'edge-cases.md'), 'utf8');
    assert.match(ledger, /PR #1599 off the board \(pr\)/);
    assert.match(ledger, /#1595 off the board \(ticket\)/);
    const agentView = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(agentView.body.summary.offBoard, 2);
    const ledgerText = await fetch(`${board.base}/pipeline/edge-cases`).then(r => r.text());
    assert.match(ledgerText, /Edge cases/);

    // A second sweep changes nothing and spawns nothing twice.
    await settle(700);
    const again = await getJson(board.base, '/pipeline/data');
    assert.equal(again.body.cards.filter(c => c.parent === id).length, 7);

    // The agent views.
    const list = await getJson(board.base, '/api/pipeline?format=json');
    assert.equal(list.body.summary.units, 7);
    assert.equal(list.body.cards.find(c => c.id === id).sprint.onLane, 2);
    const one = await getJson(board.base, `/api/pipeline/card/${by.U1.id}?format=json`);
    assert.equal(one.body.sprintOf, `${id} — AUTO-SALON sprint`);
    assert.equal(one.body.unit, 'U1');
    const toon = await fetch(`${board.base}/api/pipeline/card/${id}`).then(r => r.text());
    assert.ok(toon.includes('lanes: radar/lane-1 U2 #1517, mac/lane-b U5 #1519, mac/lane-a U6 #1523'), toon);
    assert.ok(/units\[6\]/.test(toon), toon);
    assert.ok(/qa\[1\]/.test(toon), toon);
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

    // One unit merged while the rest are still in flight: it waits in Merged —
    // on main, nobody checking it — because the QA opens only with the sprint's
    // last unit (decision 18). A QA finding whose fix a lane has started leaves
    // QA for development: work starting, not a failure.
    const partial = {
      ...FACTS, staleSources: [],
      prs: FACTS.prs.filter(p => p.number !== 1540),
      mergedPrs: [...FACTS.mergedPrs, { number: 1540, url: 'https://github.com/acme/web/pull/1540', branch: 'feat/salon-u01-readiness', mergedAt: '2026-08-29T01:00:00Z' }],
      lanes: [...FACTS.lanes, { host: 'radar', lane: 'lane-3', busy: true, since: '00:05 ago', branch: 'fix/salon-tails' }],
      unitIssues: { 1515: FACTS.unitIssues[1515].map(u => u.number === 1590 ? { ...u, branch: 'fix/salon-tails' } : u) },
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(partial));
    const partly = await until(board.base, d => d.cards.find(c => c.id === by.U1.id)?.stage === 'merged');
    assert.equal(partly.cards.find(c => c.id === by.U1.id).stage, 'merged', 'merged, the sprint not yet: waits in Merged');
    assert.equal(partly.cards.find(c => c.id === id).stage, 'development', 'the sprint is still in flight');
    const finding = partly.cards.find(c => c.parent === id && c.unit === 'QA');
    assert.equal(finding.stage, 'development', 'the finding left QA for the lane fixing it');
    assert.equal(finding.lane, 'radar/lane-3');
    assert.deepEqual(finding.stageHistory.map(h => h.stage), ['ticketed', 'development']);

    // The auto-close race: the issue list says U1's ticket is closed before the
    // merged-PR list knows the merge. Closed with no merge behind it reads as
    // accepted — the card reaches done — and comes back to Merged the moment
    // the merge is known and the close turns out to be a second after it.
    const raced = {
      ...partial, mergedPrs: FACTS.mergedPrs,
      unitIssues: { 1515: partial.unitIssues[1515].map(u => u.number === 1516 ? { ...u, state: 'CLOSED', closedAt: '2026-08-29T01:00:01Z' } : u) },
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(raced));
    const wrongly = await until(board.base, d => d.cards.find(c => c.id === by.U1.id)?.stage === 'done');
    assert.equal(wrongly.cards.find(c => c.id === by.U1.id).stage, 'done', 'an old close with no merge known is a person\'s word');
    const caught = { ...raced, mergedPrs: partial.mergedPrs };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(caught));
    const back = await until(board.base, d => d.cards.find(c => c.id === by.U1.id)?.stage === 'merged');
    assert.equal(back.cards.find(c => c.id === by.U1.id).stage, 'merged', 'the auto-close is not an acceptance: back from done');
    assert.deepEqual(back.cards.find(c => c.id === by.U1.id).stageHistory.slice(-2).map(h => h.stage), ['done', 'merged']);

    // Every unit merged (or closed): the sprint reaches Merged by itself and
    // waits there — the scope is on main; the one QA run, the acceptance of
    // each unit and the findings are what remain (decision 19: no QA column).
    const merged = {
      ...FACTS, staleSources: [], prs: [],
      // U3's own merge (#1530, the day before its close) stays as it was: a merge
      // dated after the close would read as "closed before delivery", not accepted.
      mergedPrs: [...FACTS.mergedPrs, ...FACTS.unitIssues[1515].filter(u => u.branch && u.number !== 1518).map((u, i) => ({ number: 1600 + i, url: `https://github.com/acme/web/pull/${1600 + i}`, branch: u.branch, mergedAt: '2026-08-29T01:00:00Z' }))],
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(merged));
    const onMain = await until(board.base, d => d.cards.find(c => c.id === id)?.stage === 'merged');
    assert.equal(onMain.cards.find(c => c.id === id).stage, 'merged');
    // Merged is not accepted: every unit waits in merged until its ticket is
    // closed after the merge — U3's was, an hour later, so it is done.
    for (const u of onMain.cards.filter(c => c.parent === id && c.unit !== 'QA')) {
      assert.equal(u.stage, u.unit === 'U3' ? 'done' : 'merged', u.unit);
    }
    // The finding's lane went quiet and no PR carries it: it stays where it was.
    assert.equal(onMain.cards.find(c => c.parent === id && c.unit === 'QA').stage, 'development');

    // Every ticket closed an hour after the merge, the QA ticket too: the units
    // are done — and the sprint still waits, its umbrella is open.
    const accepted = {
      ...merged,
      unitIssues: { 1515: FACTS.unitIssues[1515].map(u => ({ ...u, state: 'CLOSED', closedAt: '2026-08-29T02:00:00Z' })) },
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(accepted));
    const acceptedState = await until(board.base, d => d.cards.filter(c => c.parent === id).every(u => u.stage === 'done'));
    assert.ok(acceptedState.cards.filter(c => c.parent === id).every(u => u.stage === 'done'));
    assert.equal(acceptedState.cards.find(c => c.id === id).stage, 'merged', 'the umbrella is open: the pass is not declared');
    assert.equal(acceptedState.cards.find(c => c.id === id).sprint.umbrellaOpen, true);

    // The umbrella closed: the sprint reaches done — and no further.
    const done = { ...accepted, umbrellaStates: { 1515: 'CLOSED' } };
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

test('a red check on the current head counts once and records its reason', async () => {
  const green = failureFacts({ ci: { color: 'green', text: 'CI green (2)' } });
  const board = await startBoard({
    port: 15012,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': green },
    env: dir => ({ WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'), WATCHTOWER_SPRINT_SWEEP_MS: '200' }),
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Failure sprint', spec: 'one unit' });
    const parent = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id: parent, links: { ticket: 'https://github.com/acme/web/issues/5151' } });
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'ticketed' });
    const spawned = await until(board.base, data => data.cards.some(card => card.parent === parent && card.stage === 'ci_pr'));
    const id = spawned.cards.find(card => card.parent === parent).id;

    // Static green facts cannot erase a newer lane/review no-proof failure.
    const noProof = await postJson(board.base, '/pipeline/card/fail', {
      id, kind: 'review', reason: 'review lane freed without proof',
    });
    assert.equal(noProof.body.card.consecutiveFails, 1);
    const preserved = await until(board.base, data => {
      const card = data.cards.find(item => item.id === id);
      return card?.stage === 'ci_pr' && card.consecutiveFails === 1;
    });
    assert.equal(preserved.cards.find(item => item.id === id).consecutiveFails, 1);

    const red = failureFacts({
      ci: { color: 'red', text: 'CI red (2)', failedNames: ['lint', 'unit'] },
    });
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(red));
    const failed = await until(board.base, data => data.cards.find(card => card.id === id)?.consecutiveFails === 2);
    const card = failed.cards.find(item => item.id === id);
    assert.equal(card.stage, 'development');
    assert.equal(card.counters.ciFails, 1);
    assert.equal(card.consecutiveFails, 2, 'the red head adds exactly one to the existing streak');
    assert.match(card.stageHistory.at(-1).reason, /red checks on abc123456789.*lint, unit/);
    assert.equal(card.stageHistory.at(-1).failureHead, red.prs[0].headSha);

    await settle(700);
    const again = await getJson(board.base, '/pipeline/data');
    const unchanged = again.body.cards.find(item => item.id === id);
    assert.equal(unchanged.consecutiveFails, 2, 'the unchanged red head is not counted by another sweep');
    assert.equal(unchanged.counters.ciFails, 1);
    assert.equal(unchanged.stage, 'development', 'the same failing head does not bounce forward and reset the streak');
    assert.equal(unchanged.stageHistory.filter(entry => entry.failureHead === red.prs[0].headSha && entry.failureCause === 'ci').length, 1);

    // A countable verdict may name GitHub's abbreviated SHA. It is still on
    // this head, and is a distinct failure cause from that head's red check.
    const noGo = {
      ...red,
      prs: red.prs.map(pr => ({
        ...pr,
        verdictOnHead: {
          round: 1,
          go: false,
          head: 'ABC12345',
          at: new Date().toISOString(),
          body: 'R1 — NO-GO\nhead ABC12345',
        },
      })),
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(noGo));
    const stuck = await until(board.base, data => data.cards.find(item => item.id === id)?.stage === 'stuck');
    const afterNoGo = stuck.cards.find(item => item.id === id);
    assert.equal(afterNoGo.consecutiveFails, 3);
    assert.equal(afterNoGo.stageHistory.at(-1).failureCause, 'review');
    assert.equal(afterNoGo.stageHistory.at(-1).failureHead, red.prs[0].headSha);
  } finally {
    await board.stop();
  }
});

test('a newer QUESTION comment sticks the unit with its first line and is ignored after unstuck', async () => {
  const facts = failureFacts();
  const board = await startBoard({
    port: 15013,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': facts },
    env: dir => ({ WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'), WATCHTOWER_SPRINT_SWEEP_MS: '200' }),
  });
  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Question sprint', spec: 'one unit' });
    const parent = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id: parent, links: { ticket: 'https://github.com/acme/web/issues/5151' } });
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'ticketed' });
    const spawned = await untilUnits(board.base, parent, 1);
    const id = spawned.cards.find(card => card.parent === parent).id;

    await settle(30);
    const reason = 'qUeStIoN #5152 contract mismatch';
    facts.unitIssues[5151][0].comments = [{ body: `${reason}\nThe generated type disagrees.`, createdAt: new Date().toISOString() }];
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(facts));
    const stuck = await until(board.base, data => data.cards.find(card => card.id === id)?.stage === 'stuck');
    const card = stuck.cards.find(item => item.id === id);
    assert.equal(card.consecutiveFails, 0, 'QUESTION does not need or consume the failure counter');
    assert.equal(card.stageHistory.at(-1).reason, reason);

    const unstuck = await postJson(board.base, '/pipeline/card/unstuck', { id });
    assert.equal(unstuck.body.card.stage, 'development');
    await settle(700);
    const after = await getJson(board.base, '/pipeline/data');
    assert.equal(after.body.cards.find(item => item.id === id).stage, 'development', 'the handled QUESTION predates the unstuck stage change');
  } finally {
    await board.stop();
  }
});
