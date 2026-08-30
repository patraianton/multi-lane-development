import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getJson, postJson, startBoard } from './helpers.mjs';

const UMBRELLA = 'https://github.com/acme/web/issues/1515';
const FACTS_AT = '2099-01-01T00:00:00Z';

const FACTS = {
  lanes: [{ host: 'alpha', lane: 'lane-1', busy: false, branch: 'main' }],
  prs: [],
  mergedPrs: [],
  unitIssues: {
    1515: [{
      number: 1516, title: 'PAY-U1: missing proof', url: 'https://github.com/acme/web/issues/1516',
      state: 'OPEN', branch: 'feat/1516', labels: [], createdAt: '2026-08-30T08:00:00Z', comments: [],
    }],
  },
  ciJobs: {},
  ciRunners: [],
  umbrellaStates: { 1515: 'OPEN' },
  staleSources: [],
  sourceAt: { lanes: FACTS_AT, prs: FACTS_AT, mergedPrs: FACTS_AT, tickets: FACTS_AT },
};

const TELEGRAM = {
  dryRun: true,
  chatId: '-100123',
  boardUrl: 'https://board.example',
  apiToken: 'board-token',
  founders: [{ name: 'Anton', tgUserId: 1001, tag: '@anton', owner: true }],
};

async function until(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}

async function addLaunch(file, parent, round) {
  let journal = { dispatched: {} };
  try { journal = JSON.parse(await readFile(file, 'utf8')); } catch { /* first launch */ }
  journal.dispatched[`1516:develop:${round}`] = {
    card: parent,
    title: 'Payments sprint',
    unit: 'U1',
    ticket: 1516,
    branch: 'feat/1516',
    lane: 'alpha/lane-1',
    host: 'alpha',
    kind: 'develop',
    round,
    head: null,
    at: '2026-08-30T08:00:00Z',
    result: 'launched',
  };
  await writeFile(file, JSON.stringify(journal, null, 2));
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

test('three freed develop lanes without proof fail once per round and notify Stuck once', async () => {
  const board = await startBoard({
    port: 14977,
    config: { source: 'probe', telegram: TELEGRAM },
    files: { 'sprint-facts.json': FACTS },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    }),
  });

  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Payments sprint', spec: 'the spec' });
    const parent = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id: parent, links: { ticket: UMBRELLA } });
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'ticketed' });

    const unit = await until(async () => {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      return data.cards.find(card => card.parent === parent && card.ticket === 1516) ?? null;
    });
    const journalFile = path.join(board.dir, 'auto-dispatch.json');

    for (let round = 1; round <= 3; round++) {
      await addLaunch(journalFile, parent, round);
      await until(async () => {
        try {
          const journal = JSON.parse(await readFile(journalFile, 'utf8'));
          return journal.dispatched[`1516:develop:${round}`]?.judged === 'no-proof' ? journal : null;
        } catch { return null; }
      });
      await until(async () => {
        const data = (await getJson(board.base, '/pipeline/data')).body;
        const current = data.cards.find(card => card.id === unit.id);
        return current?.consecutiveFails === round ? current : null;
      });
    }

    const final = (await getJson(board.base, '/pipeline/data')).body.cards.find(card => card.id === unit.id);
    assert.equal(final.stage, 'stuck');
    assert.equal(final.consecutiveFails, 3);
    assert.match(final.stageHistory.at(-1).reason, /no open or merged PR on feat\/1516 after alpha\/lane-1 freed/);
    await until(async () => board.output().includes('--- notifyStuck ---'));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(count(board.output(), '--- notifyStuck ---'), 1);
  } finally {
    await board.stop();
  }
});

test('a proved lane clears only the failure streak that predates its free observation', async () => {
  const heldFacts = {
    ...FACTS,
    sourceAt: {
      lanes: FACTS_AT,
      prs: '2020-01-01T00:00:00Z',
      mergedPrs: '2020-01-01T00:00:00Z',
      tickets: '2020-01-01T00:00:00Z',
    },
  };
  const board = await startBoard({
    port: 14978,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': heldFacts },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    }),
  });

  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Proof sprint', spec: 'the spec' });
    const parent = created.body.card.id;
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'grilled' });
    await postJson(board.base, '/pipeline/card/update', { id: parent, links: { ticket: UMBRELLA } });
    await postJson(board.base, '/pipeline/card/move', { id: parent, to: 'ticketed' });
    const unit = await until(async () => {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      return data.cards.find(card => card.parent === parent && card.ticket === 1516) ?? null;
    });

    await postJson(board.base, '/pipeline/card/move', { id: unit.id, to: 'development' });
    const failed = await postJson(board.base, '/pipeline/card/fail', {
      id: unit.id, kind: 'local', reason: 'an earlier attempt failed',
    });
    assert.equal(failed.body.card.consecutiveFails, 1);

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    await addLaunch(journalFile, parent, 1);
    await until(async () => {
      try {
        const journal = JSON.parse(await readFile(journalFile, 'utf8'));
        return journal.dispatched['1516:develop:1']?.firstSeenFree ? journal : null;
      } catch { return null; }
    });

    const provedFacts = {
      ...FACTS,
      prs: [{
        number: 1600,
        branch: 'feat/1516',
        headSha: 'abc1234567890000000000000000000000000000',
        url: 'https://github.com/acme/web/pull/1600',
        ci: { color: 'green', text: 'CI green (1)' },
      }],
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(provedFacts, null, 2));

    await until(async () => {
      const journal = JSON.parse(await readFile(journalFile, 'utf8'));
      return journal.dispatched['1516:develop:1']?.judged === 'ok' ? journal : null;
    });
    const reset = await until(async () => {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      const current = data.cards.find(card => card.id === unit.id);
      return current?.stage === 'ci_pr' && current.consecutiveFails === 0 ? current : null;
    });
    assert.equal(reset.consecutiveFails, 0);
  } finally {
    await board.stop();
  }
});
