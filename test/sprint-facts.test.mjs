// Sprint facts: units bound to lanes and PRs by branch / TASK file, never by
// announcement. Fixtures mirror what hzlane status, the Mac kitchen probe,
// gh pr list and gh issue list return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintFactsFor, parseUnitBranch, parseUnitDeps, unitLabel, umbrellaOf, lanesLine, runnerHost, ciSlotSummary } from '../bin/sprint-facts.mjs';

test('the ticket body yields the pinned branch; titles yield the unit label', () => {
  assert.equal(parseUnitBranch('**Base:** `main` @ `bd69`.\n**Branch:** `feat/salon-u05-migration-133`\n**Protected area:** DB'),
    'feat/salon-u05-migration-133');
  assert.equal(parseUnitBranch('Branch: feat/salon-u02-paid-reader\nDepends on: none'), 'feat/salon-u02-paid-reader');
  assert.equal(parseUnitBranch('no branch here'), '');
  assert.equal(unitLabel('SALON-U5: migration 133 - daily rotation set'), 'U5');
  assert.equal(unitLabel('SALON-U16: rollout'), 'U16');
  assert.equal(unitLabel('a ticket without a unit'), '');
  assert.equal(umbrellaOf('https://github.com/acme/web/issues/1515'), 1515);
  assert.equal(umbrellaOf('https://github.com/acme/web/pull/12'), null);
});

test('the ticket body yields its dependencies: every "depends on" line, none is nothing', () => {
  assert.deepEqual(parseUnitDeps('**Branch:** `feat/x`\n**Depends on:** #1527 (needs its contract/tables merged first), #1529 (needs its contract/tables merged first)'),
    [1527, 1529]);
  assert.deepEqual(parseUnitDeps('**Depends on:** #1523 (contract first)\n\n- **Dependency added:** also depends on #1521 — the tag revalidation hooks the activation built there.'),
    [1521, 1523]);
  assert.deepEqual(parseUnitDeps('**Dependencies added:** also depends on #1516 (readiness) and #1526 (nightly job).'), [1516, 1526]);
  assert.deepEqual(parseUnitDeps('Branch: feat/salon-u02-paid-reader\nDepends on: none'), []);
  assert.deepEqual(parseUnitDeps('Umbrella #1515 — see #1516 for the contract'), [], 'a reference is not a dependency');
  assert.deepEqual(parseUnitDeps(''), []);
});

test('units bind to lanes by branch or TASK file, to PRs by head branch, and the states follow', () => {
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1519, title: 'SALON-U5: migration 133', url: 'u/1519', state: 'OPEN', branch: 'feat/salon-u05-migration-133', deps: [1518, 1517, 1499] },
    { number: 1517, title: 'SALON-U2: paid-placements reader', url: 'u/1517', state: 'OPEN', branch: 'feat/salon-u02-paid-reader', deps: [] },
    { number: 1516, title: 'SALON-U1: readiness', url: 'u/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
    { number: 1521, title: 'SALON-U0: free-promo checkout', url: 'u/1521', state: 'OPEN', branch: '' },
    { number: 1522, title: 'SALON-U4: composition', url: 'u/1522', state: 'OPEN', branch: 'feat/salon-u04-composition' },
    { number: 1518, title: 'SALON-U3: reserve reader', url: 'u/1518', state: 'CLOSED', branch: 'feat/salon-u03-reserve-reader' },
    // The reviews' leftovers, labelled qa: a QA ticket, not a unit.
    { number: 1525, title: 'SALON tails carried out of the sprint', url: 'u/1525', state: 'OPEN', branch: '', qa: true },
  ]]]);
  const lanes = [
    { host: 'radar', lane: 'lane-1', busy: true, since: 'Fri 18:44', branch: 'feat/salon-u02-paid-reader' },
    { host: 'radar', lane: 'lane-2', busy: false, since: null, branch: 'main' },
    { host: 'lanes-01', lane: 'lane-3', busy: true, since: 'Fri 18:44', branch: 'feat/salon-u01-readiness' },
    { host: 'lanes-01', lane: 'lane-5', busy: false, since: null, branch: 'seo/phase4-linking' },
    // The Mac lane still sits on U5's branch but its codex reads U0's task:
    // the TASK file wins for the busy binding, the branch keeps U5 as idle.
    { host: 'mac', lane: 'lane-a', busy: true, since: '01:02 ago', branch: 'feat/salon-u05-migration-133', task: 'TASK-1521.md' },
    { host: 'mac', lane: 'lane-b', busy: true, since: '00:40 ago', branch: 'feat/salon-u05-migration-133', task: 'TASK-1519.md' },
    { host: 'hostinger', lane: 'lane-6', busy: true, since: 'Fri 19:00', branch: 'fix/other-stream' },
  ];
  const prs = [
    { number: 1540, url: 'pr/1540', branch: 'feat/salon-u01-readiness', ci: { color: 'green', text: 'CI green (5)' } },
    { number: 1541, url: 'pr/1541', branch: 'refs/heads/feat/salon-u02-paid-reader', ci: { color: 'run', text: 'CI running (1)' }, draft: true },
  ];
  const mergedPrs = [{ number: 1530, url: 'pr/1530', branch: 'feat/salon-u03-reserve-reader', mergedAt: '2026-08-28T20:00:00Z' }];

  const ciRunners = [
    { name: 'radar-runner-1', status: 'online', busy: true, labels: ['self-hosted', 'vps1', 'hetzner'] },
    { name: 'radar-runner-2', status: 'online', busy: true, labels: ['self-hosted', 'vps1', 'hetzner'] },
    { name: 'hzci-1', status: 'online', busy: false, labels: ['self-hosted', 'vps1'] },
    { name: 'vps1-runner', status: 'offline', busy: false, labels: ['self-hosted', 'vps1', 'hostinger'] },
  ];
  const ciJobs = new Map([[1540, [
    { workflow: 'pr-ci', job: 'pr-ci', status: 'completed', runner: 'hzci-1', startedAt: '2026-08-28T20:00:00Z' },
    { workflow: 'pr-ci', job: 'browser-smoke', status: 'in_progress', runner: 'radar-runner-2', startedAt: '2026-08-28T20:50:00Z' },
  ]]]);
  const facts = sprintFactsFor([card, { id: 'plain', links: { ticket: '' } }],
    { lanes, prs, mergedPrs, unitIssues, ciJobs, ciRunners, staleSources: ['umbrella'], at: '2026-08-28T21:00:00Z' });
  assert.equal(facts.has('plain'), false, 'a card without an umbrella link is not a sprint');
  const s = facts.get('csprint');
  assert.equal(s.umbrella, 1515);
  assert.deepEqual(s.units.map(u => u.unit), ['U0', 'U1', 'U2', 'U3', 'U4', 'U5'], 'sorted by unit number; the QA ticket is not a unit');
  assert.deepEqual(s.qaTickets.map(u => [u.unit, u.ticket, u.state, u.open]), [['QA', 1525, 'open', true]]);

  const by = Object.fromEntries(s.units.map(u => [u.unit, u]));
  // Branch binding, busy lane, PR running → the PR wins the state.
  assert.deepEqual({ host: by.U2.lane.host, lane: by.U2.lane.lane, busy: by.U2.lane.busy }, { host: 'radar', lane: 'lane-1', busy: true });
  assert.equal(by.U2.pr.number, 1541);
  assert.equal(by.U2.state, 'pr open');
  assert.equal(by.U1.state, 'pr green');
  // The CI slot: the job in progress names the runner and its server.
  assert.deepEqual(by.U1.pr.runner, { name: 'radar-runner-2', host: 'hetzner', status: 'in_progress', since: '2026-08-28T20:50:00Z', job: 'browser-smoke' });
  assert.equal(by.U2.pr.runner, undefined, 'no job facts for that PR');
  assert.deepEqual(s.ciSlots, { total: 4, online: 3, busy: 2, offline: 1, byHost: { hetzner: { total: 2, online: 2, busy: 2 }, hzci: { total: 1, online: 1, busy: 0 }, hostinger: { total: 1, online: 0, busy: 0 } } });
  assert.equal(runnerHost('vps1-runner-3', ciRunners), 'vps1-runner', 'unknown runner: name without its number');
  assert.equal(ciSlotSummary([]).total, 0);
  // TASK-file binding on the Mac; the branch there belongs to another unit.
  assert.deepEqual({ host: by.U0.lane.host, lane: by.U0.lane.lane }, { host: 'mac', lane: 'lane-a' });
  assert.equal(by.U0.state, 'on lane');
  assert.equal(by.U5.lane.lane, 'lane-b', 'the busy lane reading TASK-1519 beats the idle branch match');
  assert.equal(by.U5.state, 'on lane');
  // Merged PR on a closed ticket.
  assert.equal(by.U3.state, 'merged');
  assert.equal(by.U3.merged.number, 1530);
  assert.equal(by.U3.lane, null);
  // Nothing yet.
  assert.equal(by.U4.state, 'queued');
  // Dependencies resolved against the sprint: merged → met, open PR → not met,
  // a ticket from elsewhere → unresolved.
  assert.deepEqual(by.U5.deps, [
    { ticket: 1518, unit: 'U3', state: 'merged', met: true },
    { ticket: 1517, unit: 'U2', state: 'pr open', met: false },
    { ticket: 1499, unit: '', state: 'outside the sprint', met: null },
  ]);
  assert.deepEqual(by.U2.deps, []);
  assert.deepEqual(by.U4.deps, [], 'no deps field on the issue is no dependencies');
  assert.equal(by.U5.depTickets, undefined);

  assert.deepEqual(s.lanes.map(l => `${l.host}/${l.lane}=${l.unit}`),
    ['mac/lane-a=U0', 'lanes-01/lane-3=U1', 'radar/lane-1=U2', 'mac/lane-b=U5']);
  assert.deepEqual(s.free, ['radar/lane-2', 'lanes-01/lane-5']);
  assert.deepEqual(s.busyElsewhere, ['hostinger/lane-6']);
  assert.equal(s.laneCount, 7);
  assert.deepEqual(s.counts, { units: 6, onLane: 2, checking: 0, pr: 2, merged: 1, queued: 1, qa: 1, qaOpen: 1 });
  assert.deepEqual(s.stale, ['umbrella']);
  assert.equal(lanesLine(s), 'mac/lane-a U0 #1521, lanes-01/lane-3 U1 #1516, radar/lane-1 U2 #1517, mac/lane-b U5 #1519');
});

test('an umbrella with no unit tickets yet is a sprint with an empty table', () => {
  const facts = sprintFactsFor([{ id: 'c1', links: { ticket: 'https://github.com/acme/web/issues/9' } }],
    { lanes: [{ host: 'h', lane: 'lane-1', busy: false, branch: 'main' }] });
  const s = facts.get('c1');
  assert.deepEqual(s.units, []);
  assert.deepEqual(s.lanes, []);
  assert.deepEqual(s.free, ['h/lane-1']);
  assert.equal(lanesLine(s), 'none of 1 lanes');
});
