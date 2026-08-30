import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getJson, postJson, startBoard } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';
const TELEGRAM = {
  dryRun: true,
  chatId: '-100123',
  ownerChatId: '4242',
  boardUrl: 'https://board.example',
  apiToken: 'board-token',
  founders: [{ name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true }],
};

function readyFacts(extraQa = []) {
  return {
    lanes: [],
    prs: [],
    mergedPrs: [
      { number: 1600, branch: 'feat/1516', url: 'https://github.com/acme/web/pull/1600', mergedAt: '2026-08-30T09:00:00Z' },
    ],
    unitIssues: {
      1515: [
        {
          number: 1516, title: 'PAY-U1: shipped', url: 'https://github.com/acme/web/issues/1516',
          state: 'OPEN', branch: 'feat/1516', labels: [], createdAt: '2026-08-30T08:00:00Z',
        },
        {
          number: 1590, title: 'QA: earlier finding', url: 'https://github.com/acme/web/issues/1590',
          state: 'CLOSED', closedAt: '2026-08-30T09:10:00Z', branch: 'feat/1590',
          labels: ['qa'], qa: true, createdAt: '2026-08-30T08:30:00Z',
        },
        {
          number: 1591, title: 'QA R1', url: 'https://github.com/acme/web/issues/1591',
          state: 'CLOSED', closedAt: '2026-08-30T10:10:00Z', branch: 'feat/1591',
          labels: ['qa-run'], qa: true, createdAt: '2026-08-30T10:00:00Z',
        },
        ...extraQa,
      ],
    },
    ciJobs: {},
    ciRunners: [],
    umbrellaStates: { 1515: 'OPEN' },
    staleSources: [],
  };
}

async function until(base, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = (await getJson(base, '/pipeline/data')).body;
    if (predicate(last)) return last;
    if (Date.now() > deadline) throw new Error(`condition not reached: ${JSON.stringify(last)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

test('the watchtower persists one readyAt notification and clears it for a later QA ticket', async () => {
  const board = await startBoard({
    port: 14976,
    config: { source: 'probe', telegram: TELEGRAM },
    files: { 'sprint-facts.json': readyFacts() },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    }),
  });

  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Payments sprint', spec: 'the spec' });
    const id = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
    await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });

    const ready = await until(board.base, data => Boolean(data.cards.find(card => card.id === id)?.readyAt));
    const readyAt = ready.cards.find(card => card.id === id).readyAt;
    assert.match(readyAt, /^\d{4}-\d\d-\d\dT/);
    await until(board.base, () => board.output().includes('--- notifyReady ---'));
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(count(board.output(), '--- notifyReady ---'), 1);
    assert.match(board.output(), new RegExp(`Sprint Payments sprint is ready for acceptance — ${UMBRELLA}`));

    const laterFinding = {
      number: 1592, title: 'QA: found after the walk', url: 'https://github.com/acme/web/issues/1592',
      state: 'CLOSED', closedAt: '2026-08-30T11:10:00Z', branch: 'feat/1592',
      labels: ['qa'], qa: true, createdAt: '2026-08-30T11:00:00Z',
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(readyFacts([laterFinding]), null, 2));
    const reset = await until(board.base, data => data.cards.find(card => card.id === id)?.readyAt === null);
    assert.equal(reset.cards.find(card => card.id === id).readyAt, null);
    assert.equal(count(board.output(), '--- notifyReady ---'), 1);
  } finally {
    await board.stop();
  }
});
