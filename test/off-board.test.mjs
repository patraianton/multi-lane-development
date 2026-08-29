// Off the board: what is being built without a card — open PRs no card carries,
// tickets in work that reference no umbrella, busy lanes on unknown branches.
// Pure fixtures here; the board-level run is in pipeline-unit-cards.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offBoardFindings, isWorkTicket, updateLedger, ledgerMarkdown } from '../bin/off-board.mjs';

const cards = [
  { id: 'c1', title: 'U1 #1516 — readiness', ticket: 1516, parent: 'cs', links: { ticket: 'https://github.com/acme/web/issues/1516', branch: 'feat/salon-u01-readiness', pr: '' } },
  { id: 'c2', title: 'a hand card with a PR', ticket: 0, links: { ticket: '', branch: '', pr: 'https://github.com/acme/web/pull/1590' } },
  { id: 'cs', title: 'sprint', ticket: 0, links: { ticket: 'https://github.com/acme/web/issues/1515', branch: '', pr: '' } },
];

test('a PR is on the board by its branch or by its URL; anything else is off', () => {
  const prs = [
    { number: 1540, title: 'readiness', url: 'https://github.com/acme/web/pull/1540', branch: 'refs/heads/feat/salon-u01-readiness' },
    { number: 1590, title: 'attached by hand', url: 'https://github.com/acme/web/pull/1590', branch: 'fix/whatever' },
    { number: 1591, title: 'nobody knows this one', url: 'https://github.com/acme/web/pull/1591', branch: 'fix/salon-heading', draft: true },
    { number: 1592, title: 'bump', url: 'https://github.com/acme/web/pull/1592', branch: 'dependabot/npm/x' },
  ];
  const f = offBoardFindings({ cards, prs, at: 'T' });
  assert.deepEqual(f.map(x => [x.kind, x.ref, x.detail, x.at]), [['pr', 'PR #1591', 'fix/salon-heading · draft', 'T']]);
  assert.match(f[0].fix, /pin its branch/);
});

test('a ticket in work is one shaped like a unit; off the board when it references no umbrella or spawned no card', () => {
  assert.equal(isWorkTicket({ title: 'salon: heading fix', branch: 'fix/heading' }), true);
  assert.equal(isWorkTicket({ title: 'salon: heading fix', qa: true }), true);
  assert.equal(isWorkTicket({ title: 'SALON-U9: home module' }), true);
  assert.equal(isWorkTicket({ title: 'idea: something someday' }), false, 'a note is not work');
  const issues = [
    { number: 1516, title: 'SALON-U1: readiness', branch: 'feat/salon-u01-readiness', refs: [1515] },
    { number: 1572, title: 'salon home module: heading', qa: true, refs: [] },
    { number: 1573, title: 'salon cards: green label', branch: 'fix/salon-cards', refs: [1499] },
    { number: 1580, title: 'a thought for later', refs: [] },
  ];
  const f = offBoardFindings({ cards, issues });
  assert.deepEqual(f.map(x => x.ref), ['#1572', '#1573']);
  assert.match(f[0].reason, /references no umbrella/);
  assert.match(f[1].reason, /references #1499 but spawned no card/);
});

test('a busy lane is on the board by the branch a card carries or the TASK file it reads', () => {
  const lanes = [
    { host: 'mac', lane: 'lane-6', busy: true, branch: 'feat/salon-u01-readiness' },
    { host: 'mac', lane: 'lane-7', busy: true, branch: 'feat/salon-u05-x', task: 'TASK-1516.md' },
    { host: 'mac', lane: 'lane-8', busy: true, branch: 'fix/stray-work' },
    { host: 'lanes-01', lane: 'lane-1', busy: false, branch: 'fix/parked' },
    { host: 'lanes-01', lane: 'lane-2', busy: true, branch: 'main' },
  ];
  const f = offBoardFindings({ cards, lanes });
  assert.deepEqual(f.map(x => [x.kind, x.ref, x.title]), [['lane', 'mac/lane-8', 'fix/stray-work']]);
});

test('the ledger remembers first and last sight, marks what went back on the board, and writes the document', () => {
  const a = offBoardFindings({ cards, prs: [{ number: 1591, title: 'stray', url: 'u/1591', branch: 'fix/x' }], at: 't1' });
  let r = updateLedger({ seen: {} }, a, 't1');
  assert.equal(r.fresh.length, 1);
  assert.equal(r.ledger.seen['pr:1591'].first, 't1');
  const md = ledgerMarkdown(r.fresh, r.resolved, 't1');
  assert.match(md, /^## t1 — PR #1591 off the board \(pr\)/);
  assert.match(md, /Why it is off/);
  // Seen again: not fresh, last moves.
  r = updateLedger(r.ledger, a, 't2');
  assert.equal(r.fresh.length, 0);
  assert.equal(r.ledger.seen['pr:1591'].last, 't2');
  // Gone: resolved once, and a fresh sighting later starts a new entry.
  r = updateLedger(r.ledger, [], 't3');
  assert.equal(r.resolved.length, 1);
  assert.equal(r.ledger.seen['pr:1591'].resolved, 't3');
  assert.match(ledgerMarkdown([], r.resolved, 't3'), /resolved: PR #1591/);
  r = updateLedger(r.ledger, a, 't4');
  assert.equal(r.fresh.length, 1);
  assert.equal(r.ledger.seen['pr:1591'].resolved, null);
});
