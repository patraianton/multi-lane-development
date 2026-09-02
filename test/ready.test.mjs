import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyBlocker, readyForAcceptance } from '../bin/ready.mjs';

const run = (ticket, title, createdAt, closedAt) => ({
  ticket, title, qaRun: true, labels: ['qa-run'], createdAt,
  open: !closedAt, closedAt: closedAt ?? null,
});

const finding = (ticket, mergedAt, overrides = {}) => ({
  ticket, title: `QA finding ${ticket}`, labels: ['qa'], open: true,
  merged: mergedAt ? { number: ticket + 100, mergedAt } : null,
  ...overrides,
});

test('readyBlocker replays sprints 1863 and 1803 from the latest closed QA walk', () => {
  const sprint1863 = {
    units: [
      { ticket: 1867, merged: { number: 1877, mergedAt: '2026-09-02T02:37:09Z' } },
      { ticket: 1868, merged: { number: 1869, mergedAt: '2026-09-02T07:25:00Z' } },
    ],
    qaTickets: [
      run(1882, 'QA R2 — CABINET-ADD-FIX-002', '2026-09-02T07:56:00Z', '2026-09-02T11:37:05Z'),
      run(1883, 'QA R2 duplicate', '2026-09-02T08:09:00Z', '2026-09-02T08:17:00Z'),
      finding(1885, '2026-09-02T10:43:00Z'),
    ],
  };
  assert.equal(readyBlocker(sprint1863), null, 'the later-created duplicate is not the latest closed walk');
  assert.equal(readyForAcceptance(sprint1863), true);

  const sprint1803 = {
    units: [{ ticket: 1686, merged: { number: 1741, mergedAt: '2026-09-01T16:23:00Z' } }],
    qaTickets: [
      run(1826, 'QA R1 — CAF3-TAIL-001', '2026-09-01T01:17:00Z', '2026-09-02T05:50:30Z'),
      finding(1829, '2026-08-31T23:41:00Z'),
      finding(1856, '2026-09-02T05:23:00Z'),
      finding(1857, null, { open: false, closedAt: '2026-09-02T05:30:00Z' }),
    ],
  };
  assert.equal(readyBlocker(sprint1803), null, 'findings filed during the walk do not matter once their fixes predate its close');
  assert.equal(readyForAcceptance(sprint1803), true);
});

test('readyBlocker names the next fact or hand-cut QA ticket the sprint needs', () => {
  const base = () => ({
    units: [{ ticket: 4101, merged: { number: 501, mergedAt: '2026-09-02T09:00:00Z' } }],
    qaTickets: [run(4192, 'QA R2 — Sprint Four', '2026-09-02T10:00:00Z', '2026-09-02T11:00:00Z')],
  });

  const unitOpen = base();
  unitOpen.units[0].merged = null;
  assert.equal(readyBlocker(unitOpen), 'unit #4101 not merged');

  const findingOpen = base();
  findingOpen.qaTickets.unshift(finding(4191, null));
  assert.equal(readyBlocker(findingOpen), 'finding #4191 open');

  const walkOpen = base();
  walkOpen.qaTickets[0] = run(4192, 'QA R2 — Sprint Four', '2026-09-02T10:00:00Z', null);
  assert.equal(readyBlocker(walkOpen), 'QA run #4192 open');

  const noWalk = base();
  noWalk.qaTickets = [];
  assert.equal(readyBlocker(noWalk), 'no closed QA run');

  const fixedAfterWalk = base();
  fixedAfterWalk.qaTickets.unshift(finding(4193, '2026-09-02T11:01:00Z'));
  assert.equal(readyBlocker(fixedAfterWalk),
    'finding #4193 merged after QA R2 closed — no QA R3 ticket: cut it');
  assert.equal(readyForAcceptance(fixedAfterWalk), false);
});
