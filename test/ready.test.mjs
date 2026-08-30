import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReadyAt, readyForAcceptance } from '../bin/ready.mjs';

function readySprint() {
  return {
    units: [
      { ticket: 4101, merged: { number: 501 } },
      { ticket: 4102, merged: { number: 502 } },
    ],
    qaTickets: [
      {
        ticket: 4191,
        labels: ['qa'],
        createdAt: '2026-08-30T10:00:00.000Z',
        open: true,
        merged: { number: 591 },
      },
      {
        ticket: 4192,
        labels: ['QA-RUN'],
        createdAt: '2026-08-30T11:00:00.000Z',
        open: false,
        closedAt: '2026-08-30T11:30:00.000Z',
      },
    ],
  };
}

test('ready for acceptance requires each of its four conditions independently', () => {
  assert.equal(readyForAcceptance(readySprint()), true);

  const unitNotMerged = readySprint();
  unitNotMerged.units[0].merged = null;
  assert.equal(readyForAcceptance(unitNotMerged), false, 'every work unit must be merged');

  const findingNotFinished = readySprint();
  findingNotFinished.qaTickets[0].merged = null;
  assert.equal(readyForAcceptance(findingNotFinished), false, 'every QA finding must be merged or closed');

  const latestWalkOpen = readySprint();
  latestWalkOpen.qaTickets[1].open = true;
  latestWalkOpen.qaTickets[1].closedAt = null;
  assert.equal(readyForAcceptance(latestWalkOpen), false, 'the latest QA run must be closed');

  const findingAfterWalk = readySprint();
  findingAfterWalk.qaTickets.push({
    ticket: 4193,
    labels: ['qa'],
    createdAt: '2026-08-30T11:01:00.000Z',
    open: false,
    closedAt: '2026-08-30T11:20:00.000Z',
  });
  assert.equal(readyForAcceptance(findingAfterWalk), false, 'a QA finding created after the latest walk requires another walk');
});

test('readyAt is applied once, cleared by a post-walk QA ticket, and reset after the next walk', () => {
  const original = { id: 'sprint-4', title: 'Sprint Four', readyAt: null };
  const first = applyReadyAt(original, readySprint(), '2026-08-30T12:00:00Z');
  assert.equal(original.readyAt, null, 'the pure helper does not mutate pipeline state');
  assert.deepEqual(first, {
    card: { ...original, readyAt: '2026-08-30T12:00:00.000Z' },
    becameReady: true,
    cleared: false,
  });

  const kept = applyReadyAt(first.card, readySprint(), '2026-08-30T12:30:00Z');
  assert.equal(kept.card.readyAt, first.card.readyAt);
  assert.equal(kept.becameReady, false, 'a later sweep does not ring again');
  assert.equal(kept.cleared, false);

  const incompleteFacts = readySprint();
  incompleteFacts.units[0].merged = null;
  const preserved = applyReadyAt(kept.card, incompleteFacts, '2026-08-30T12:30:30Z');
  assert.equal(readyForAcceptance(incompleteFacts), false);
  assert.equal(preserved.card.readyAt, kept.card.readyAt, 'an unrelated false condition does not erase prior readiness');
  assert.equal(preserved.becameReady, false);
  assert.equal(preserved.cleared, false);

  const afterWalk = readySprint();
  afterWalk.qaTickets.push({
    ticket: 4193,
    labels: ['qa'],
    createdAt: '2026-08-30T11:05:00.000Z',
    open: false,
    closedAt: '2026-08-30T11:20:00.000Z',
  });
  const cleared = applyReadyAt(kept.card, afterWalk, '2026-08-30T12:31:00Z');
  assert.equal(cleared.card.readyAt, null);
  assert.equal(cleared.becameReady, false);
  assert.equal(cleared.cleared, true);

  afterWalk.qaTickets.push({
    ticket: 4194,
    qaRun: true,
    labels: ['qa-run'],
    createdAt: '2026-08-30T13:00:00.000Z',
    open: false,
    closedAt: '2026-08-30T13:30:00.000Z',
  });
  const reset = applyReadyAt(cleared.card, afterWalk, '2026-08-30T14:00:00Z');
  assert.equal(reset.card.readyAt, '2026-08-30T14:00:00.000Z');
  assert.equal(reset.becameReady, true, 'a later closed walk creates a fresh notification edge');
  assert.equal(reset.cleared, false);
});

test('readiness is not guessed without a QA run or ticket creation times', () => {
  const noWalk = readySprint();
  noWalk.qaTickets = noWalk.qaTickets.filter(ticket => !ticket.labels.includes('QA-RUN'));
  assert.equal(readyForAcceptance(noWalk), false);

  const noWalkTime = readySprint();
  delete noWalkTime.qaTickets[1].createdAt;
  assert.equal(readyForAcceptance(noWalkTime), false);

  const noFindingTime = readySprint();
  delete noFindingTime.qaTickets[0].createdAt;
  assert.equal(readyForAcceptance(noFindingTime), false);
});
