// Sprint facts: units bound to lanes and PRs by branch / TASK file, never by
// announcement. Fixtures mirror what hzlane status, the Mac kitchen probe,
// gh pr list and gh issue list return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintFactsFor, parseUnitBranch, parseUnitDeps, unitLabel, umbrellaOf, lanesLine, runnerHost, ciSlotSummary, fleetLane, fleetSlot, parseUnitDepsMerged } from '../bin/sprint-facts.mjs';

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
    // Closed an hour after its merge: accepted by a person, not by the PR.
    { number: 1518, title: 'SALON-U3: reserve reader', url: 'u/1518', state: 'CLOSED', closedAt: '2026-08-28T21:00:00Z', branch: 'feat/salon-u03-reserve-reader' },
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
    { lanes, prs, mergedPrs, unitIssues, ciJobs, ciRunners, umbrellaStates: new Map([[1515, 'OPEN']]), staleSources: ['umbrella'], at: '2026-08-28T21:00:00Z' });
  assert.equal(facts.has('plain'), false, 'a card without an umbrella link is not a sprint');
  const s = facts.get('csprint');
  assert.equal(s.umbrella, 1515);
  assert.equal(s.umbrellaOpen, true);
  assert.deepEqual(s.units.map(u => u.unit), ['U0', 'U1', 'U2', 'U3', 'U4', 'U5'], 'sorted by unit number; the QA ticket is not a unit');
  assert.deepEqual(s.qaTickets.map(u => [u.unit, u.ticket, u.state, u.open]), [['QA', 1525, 'open', true]]);

  const by = Object.fromEntries(s.units.map(u => [u.unit, u]));
  // Branch binding, busy lane, PR running → the PR wins the state.
  assert.deepEqual({ host: by.U2.lane.host, lane: by.U2.lane.lane, busy: by.U2.lane.busy }, { host: 'radar', lane: 'lane-1', busy: true });
  assert.equal(by.U2.pr.number, 1541);
  assert.equal(by.U2.state, 'pr open');
  assert.equal(by.U1.state, 'pr green');
  // The CI slot: the job in progress names the runner and its server.
  assert.deepEqual(by.U1.pr.runner, { name: 'radar-runner-2', slot: 'radar-runner-2', server: '', host: 'hetzner', status: 'in_progress', since: '2026-08-28T20:50:00Z', job: 'browser-smoke' });
  assert.equal(by.U2.pr.runner, undefined, 'no job facts for that PR');
  assert.deepEqual(s.ciSlots, { total: 4, online: 3, busy: 2, offline: 1, byHost: { hetzner: { total: 2, online: 2, busy: 2 }, hzci: { total: 1, online: 1, busy: 0 }, hostinger: { total: 1, online: 0, busy: 0 } } });
  assert.equal(runnerHost('vps1-runner-3', ciRunners), 'vps1-runner', 'unknown runner: name without its number');
  // Every runner is a row: the PR whose job it runs and the unit behind it.
  assert.deepEqual(s.ciTable.map(r => [r.name, r.online, r.busy, r.pr, r.unit]), [
    ['hzci-1', true, false, null, null],
    ['radar-runner-1', true, true, null, null],
    ['vps1-runner', false, false, null, null],
    ['radar-runner-2', true, true, 1540, 'U1'],
  ], 'by the first number in the name when no registry names the slots');
  assert.equal(s.ciTable[3].job, 'browser-smoke');
  assert.equal(ciSlotSummary([]).total, 0);
  // TASK-file binding on the Mac; the branch there belongs to another unit.
  assert.deepEqual({ host: by.U0.lane.host, lane: by.U0.lane.lane }, { host: 'mac', lane: 'lane-a' });
  assert.equal(by.U0.state, 'on lane');
  assert.equal(by.U5.lane.lane, 'lane-b', 'the busy lane reading TASK-1519 beats the idle branch match');
  assert.equal(by.U5.state, 'on lane');
  // Merged PR on a ticket closed an hour later: accepted.
  assert.equal(by.U3.state, 'accepted');
  assert.equal(by.U3.accepted, '2026-08-28T21:00:00Z');
  assert.equal(by.U3.merged.number, 1530);
  assert.equal(by.U3.lane, null);
  // Nothing yet.
  assert.equal(by.U4.state, 'queued');
  // Dependencies resolved against the sprint: merged → met, open PR → not met,
  // a ticket from elsewhere → unresolved.
  assert.deepEqual(by.U5.deps, [
    { ticket: 1518, unit: 'U3', state: 'accepted', met: true },
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
  assert.deepEqual(s.counts, { units: 6, onLane: 2, checking: 0, pr: 2, merged: 1, accepted: 1, queued: 1, qa: 1, qaOpen: 1 });
  assert.deepEqual(s.stale, ['umbrella']);
  assert.equal(lanesLine(s), 'mac/lane-a U0 #1521, lanes-01/lane-3 U1 #1516, radar/lane-1 U2 #1517, mac/lane-b U5 #1519');
  // Every lane is a row of the table: bound unit, busy, sorted by lane number.
  assert.equal(s.laneTable.length, 7);
  assert.deepEqual(s.laneTable.map(l => l.lane + ':' + (l.unit || '-')), ['lane-1:U2', 'lane-2:-', 'lane-3:U1', 'lane-5:-', 'lane-6:-', 'lane-a:U0', 'lane-b:U5']);
});

test('one branch pinned by three tickets: the lane building it shows on every one of them', () => {
  // Three QA findings fixed by one PR on one branch (salon, 29.08): the board
  // used to hand the lane to whichever ticket the branch map kept last, so two
  // of the three looked abandoned while the lane was busy on their fix.
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1586, title: 'salon cards: marker text', url: 'u/1586', state: 'OPEN', branch: 'preview/salon-card-av01', qa: true },
    { number: 1587, title: 'salon cards: tighten the gaps', url: 'u/1587', state: 'OPEN', branch: 'preview/salon-card-av01', qa: true },
    { number: 1598, title: 'salon cards: drop the TOP-6 badge', url: 'u/1598', state: 'OPEN', branch: 'preview/salon-card-av01', qa: true },
    { number: 1599, title: 'FIN gap: MobilleCard', url: 'u/1599', state: 'OPEN', branch: 'feat/fin-1599' },
  ]]]);
  const lanes = [
    { host: 'lanes-01', lane: 'lane-3', busy: true, since: 'Sat 12:00', branch: 'preview/salon-card-av01' },
    { host: 'lanes-01', lane: 'lane-1', busy: true, since: 'Sat 12:26', branch: 'feat/fin-1599' },
    { host: 'lanes-01', lane: 'lane-2', busy: false, since: null, branch: 'main' },
  ];
  const facts = sprintFactsFor([card], { lanes, prs: [], mergedPrs: [], unitIssues, umbrellaStates: new Map([[1515, 'OPEN']]), at: '2026-08-29T13:00:00Z' });
  const s = facts.get('csprint');
  assert.deepEqual(s.qaTickets.map(u => [u.ticket, u.lane?.lane ?? null, u.state]),
    [[1586, 'lane-3', 'on lane'], [1587, 'lane-3', 'on lane'], [1598, 'lane-3', 'on lane']],
    'every ticket pinned to the branch carries the lane');
  assert.deepEqual(s.units.map(u => [u.ticket, u.lane?.lane ?? null]), [[1599, 'lane-1']], 'the other lane binds as before');
});

test('a unit without a pinned branch defaults to feat/<ticket>', () => {
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1600, title: 'SALON-U1: default branch', url: 'u/1600', state: 'OPEN', branch: '', labels: ['qa-run'] },
  ]]]);
  const lanes = [{ host: 'lanes-01', lane: 'lane-1', busy: true, branch: 'feat/1600' }];
  const prs = [{ number: 1601, url: 'pr/1601', branch: 'refs/heads/feat/1600' }];

  const unit = sprintFactsFor([card], { lanes, prs, unitIssues }).get('csprint').qaTickets[0];
  assert.equal(unit.branch, 'feat/1600');
  assert.deepEqual(unit.labels, ['qa-run']);
  assert.equal(unit.qa, true, 'qa-run is QA scope rather than an ordinary work unit');
  assert.equal(unit.depsMerged, true, 'qa-run never starts from an open dependency PR');
  assert.equal(unit.lane.lane, 'lane-1', 'the default branch binds the lane');
  assert.equal(unit.pr.number, 1601, 'the default branch binds the PR');
});

test('sprint facts count verdict history but accept only a verdict on the current head', () => {
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1611, title: 'SALON-U1: wrong head', url: 'u/1611', state: 'OPEN', branch: 'feat/wrong' },
    { number: 1612, title: 'SALON-U2: no head', url: 'u/1612', state: 'OPEN', branch: 'feat/headless' },
    { number: 1613, title: 'SALON-U3: current head', url: 'u/1613', state: 'OPEN', branch: 'feat/current' },
  ]]]);
  const head = 'abc12345abcdef0123456789abcdef0123456789';
  const prs = [
    { number: 1621, branch: 'feat/wrong', headSha: head, verdict: { round: 1, go: false, head: 'def12345' } },
    { number: 1622, branch: 'feat/headless', headSha: head, verdict: { round: 1, go: false, head: null } },
    { number: 1623, branch: 'feat/current', headSha: head, verdicts: [{ round: 1, go: false, head: 'def12345' }, { round: 2, go: true, head: 'abc12345' }] },
  ];

  const units = sprintFactsFor([card], { prs, unitIssues }).get('csprint').units;
  assert.deepEqual(units.map(unit => [unit.state, unit.pr.verdictOnHead, unit.pr.verdictRounds]), [
    ['pr open', null, 1],
    ['pr open', null, 1],
    ['pr go', prs[2].verdicts[1], 2],
  ]);
});

test('an idle lane parked on a merged branch is free but keeps its table binding', () => {
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1601, title: 'SALON-U1: merged', url: 'u/1601', state: 'OPEN', branch: 'feat/merged' },
    { number: 1602, title: 'SALON-U2: still building', url: 'u/1602', state: 'OPEN', branch: 'feat/building' },
  ]]]);
  const lanes = [
    { host: 'lanes-01', lane: 'lane-1', busy: false, branch: 'feat/merged' },
    { host: 'lanes-01', lane: 'lane-2', busy: false, branch: 'feat/building' },
  ];
  const mergedPrs = [{ number: 1603, url: 'pr/1603', branch: 'feat/merged', mergedAt: '2026-08-30T08:00:00Z' }];

  const sprint = sprintFactsFor([card], { lanes, mergedPrs, unitIssues }).get('csprint');
  assert.deepEqual(sprint.free, ['lanes-01/lane-1'], 'an unmerged branch still reserves its idle lane');
  assert.deepEqual(sprint.laneTable.map(l => [l.lane, l.branch, l.unit]), [
    ['lane-1', 'feat/merged', 'U1'],
    ['lane-2', 'feat/building', 'U2'],
  ]);
});

test('a close with no merge behind it counts as accepted only once it is older than the auto-close window', () => {
  // The issue list refreshes faster than the merged-PR list: for a minute a
  // ticket the PR just auto-closed looks closed with no merge — a person's
  // word, accepted, done. U4 and U6 reached done that way on 29.08.
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const issue = { number: 1516, title: 'SALON-U1: readiness', url: 'u/1516', state: 'CLOSED', closedAt: '2026-08-29T10:00:00Z', branch: 'feat/salon-u01-readiness' };
  const facts = at => sprintFactsFor([card], { unitIssues: new Map([[1515, [issue]]]), umbrellaStates: new Map([[1515, 'OPEN']]), at }).get('csprint').units[0];
  const fresh = facts('2026-08-29T10:00:30Z');
  assert.equal(fresh.accepted, null, 'thirty seconds old: the merged list may not have caught up');
  assert.equal(fresh.state, 'closed');
  const old = facts('2026-08-29T10:05:00Z');
  assert.equal(old.accepted, '2026-08-29T10:00:00Z');
  assert.equal(old.state, 'accepted');
});

test('merged is not accepted: the ticket closed by the PR does not count, a later close does, and no merge means the close is the word', () => {
  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    // Closed in the same second as the merge — GitHub's "Closes #N".
    { number: 1516, title: 'SALON-U1: readiness', url: 'u/1516', state: 'CLOSED', closedAt: '2026-08-29T07:03:46Z', branch: 'feat/salon-u01' },
    // Closed 40 minutes after the merge — the acceptance.
    { number: 1517, title: 'SALON-U2: reader', url: 'u/1517', state: 'CLOSED', closedAt: '2026-08-29T07:45:00Z', branch: 'feat/salon-u02' },
    // No PR at all, closed: dropped or done by hand — the ticket is the word.
    { number: 1518, title: 'SALON-U3: note', url: 'u/1518', state: 'CLOSED', closedAt: '2026-08-29T08:00:00Z', branch: '' },
    // Merged, still open.
    { number: 1519, title: 'SALON-U4: rollout', url: 'u/1519', state: 'OPEN', branch: 'feat/salon-u04' },
  ]]]);
  const mergedPrs = [
    { number: 1601, url: 'pr/1601', branch: 'feat/salon-u01', mergedAt: '2026-08-29T07:03:45Z' },
    { number: 1602, url: 'pr/1602', branch: 'feat/salon-u02', mergedAt: '2026-08-29T07:03:45Z' },
    { number: 1604, url: 'pr/1604', branch: 'feat/salon-u04', mergedAt: '2026-08-29T07:03:45Z' },
  ];
  const s = sprintFactsFor([card], { mergedPrs, unitIssues, umbrellaStates: new Map() }).get('csprint');
  const by = Object.fromEntries(s.units.map(u => [u.unit, u]));
  assert.deepEqual([by.U1.state, by.U1.accepted], ['merged', null], 'auto-closed by the PR: merged, not accepted');
  assert.deepEqual([by.U2.state, by.U2.accepted], ['accepted', '2026-08-29T07:45:00Z']);
  assert.deepEqual([by.U3.state, by.U3.accepted], ['accepted', '2026-08-29T08:00:00Z']);
  assert.deepEqual([by.U4.state, by.U4.accepted], ['merged', null]);
  assert.equal(s.umbrellaOpen, null, 'an umbrella outside the list is unknown, never closed');
  assert.equal(s.counts.accepted, 2);
});

test('the fleet registry renames lanes and only fleet lanes count as capacity', () => {
  const registry = {
    'lanes-01/lane-3': { name: 'lane-1', server: 'Hetzner / codex-dev' },
    'mac/lane-a': { name: 'lane-6', server: 'Mac mini' },
  };
  const named = fleetLane(registry, 'lanes-01', { host: 'lanes-01', lane: 'lane-3', busy: true, branch: 'feat/x' });
  assert.deepEqual({ lane: named.lane, folder: named.folder, server: named.server, fleet: named.fleet, busy: named.busy },
    { lane: 'lane-1', folder: 'lane-3', server: 'Hetzner / codex-dev', fleet: true, busy: true });
  const slot = fleetSlot({ 'hzci-1': { name: 'ci-slot-1', server: 'Hetzner / ci-runners-01' } }, { name: 'hzci-1', status: 'online', busy: true });
  assert.deepEqual({ slot: slot.slot, server: slot.server, fleet: slot.fleet, busy: slot.busy }, { slot: 'ci-slot-1', server: 'Hetzner / ci-runners-01', fleet: true, busy: true });
  assert.equal(fleetSlot({}, { name: 'x-runner' }).slot, 'x-runner');
  const unknown = fleetLane(registry, 'hetzner', { host: 'hetzner', lane: 'lane-1', busy: false });
  assert.deepEqual({ lane: unknown.lane, folder: unknown.folder, server: unknown.server, fleet: unknown.fleet }, { lane: 'lane-1', folder: 'lane-1', server: null, fleet: false });

  const card = { id: 'csprint', links: { ticket: 'https://github.com/acme/web/issues/1515' } };
  const unitIssues = new Map([[1515, [
    { number: 1516, title: 'SALON-U1: readiness', url: 'u/1516', state: 'OPEN', branch: 'feat/salon-u01-readiness' },
  ]]]);
  const lanes = [
    fleetLane(registry, 'lanes-01', { host: 'lanes-01', lane: 'lane-3', busy: true, since: 'Fri', branch: 'feat/salon-u01-readiness' }),
    fleetLane(registry, 'mac', { host: 'mac', lane: 'lane-a', busy: false, branch: 'main' }),
    fleetLane(registry, 'hetzner', { host: 'hetzner', lane: 'lane-1', busy: false, branch: 'main' }),
  ];
  const s = sprintFactsFor([card], { lanes, unitIssues }).get('csprint');
  assert.equal(s.units[0].lane.lane, 'lane-1', 'the unit sits on the fleet name');
  assert.equal(s.units[0].lane.folder, 'lane-3');
  assert.equal(s.laneCount, 2, 'only registry lanes are capacity');
  assert.deepEqual(s.free, ['mac/lane-6']);
  assert.deepEqual(s.laneTable.map(l => [l.lane, l.fleet, l.unit]), [['lane-1', true, 'U1'], ['lane-6', true, null], ['lane-1', false, null]], 'fleet lanes first, the unknown lane last');
  assert.equal(lanesLine(s), 'lanes-01/lane-1 (folder lane-3) U1 #1516');
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

test('"depends on (merged)" marks a unit that needs its dependencies merged, not just on a PR', () => {
  assert.equal(parseUnitDepsMerged('**Depends on:** #1575, #1576'), false);
  assert.equal(parseUnitDepsMerged('**Depends on (merged):** #1575, #1576 — runs on the merged build'), true);
  assert.equal(parseUnitDepsMerged('nothing here'), false);
});
