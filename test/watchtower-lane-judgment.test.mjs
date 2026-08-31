import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { executable, getJson, postJson, startBoard } from './helpers.mjs';

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
  ownerChatId: '4242',
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

async function journalUntil(file, check, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let journal = null;
    try { journal = JSON.parse(await readFile(file, 'utf8')); } catch { /* not written yet */ }
    if (journal && check(journal)) return journal;
    if (Date.now() > deadline) throw new Error(`journal condition not reached: ${JSON.stringify(journal)}`);
    await new Promise(resolve => setTimeout(resolve, 40));
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
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-lane-judgment-'));
  let board;

  try {
    const ticket = {
      number: 1516,
      title: 'PAY-U1: missing proof',
      url: 'https://github.com/acme/web/issues/1516',
      body: 'Part of #1515.\n\nDeliver the unit and open its PR.',
    };
    const fakeGh = await executable(toolsDir, 'gh', `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === 'issue' && a[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});\n`);
    const fakeSsh = await executable(toolsDir, 'ssh', '#!/usr/bin/env node\n');
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const fleet = {
      prompt: 'Read {taskFile} and do it whole',
      hosts: {
        alpha: { kitchen: '/tmp/acme-alpha', launch: 'alpha-lane {n} "{prompt}"' },
        beta: { kitchen: '/tmp/acme-beta', launch: 'beta-lane {n} "{prompt}"' },
      },
      lanes: {
        'lane-1': { host: 'alpha', n: 1 },
        'lane-6': { host: 'beta', n: 6 },
      },
    };
    const facts = {
      ...FACTS,
      lanes: [
        { host: 'alpha', lane: 'lane-1', busy: false, branch: 'main' },
        { host: 'beta', lane: 'lane-6', busy: false, branch: 'main' },
      ],
    };
    board = await startBoard({
      port: 14977,
      config: {
        source: 'probe', autoDispatch: true, telegram: TELEGRAM, repo: 'acme/web',
        hosts: { alpha: { target: 'fake-alpha' }, beta: { target: 'fake-beta' } },
      },
      files: { 'sprint-facts.json': facts, 'fleet-launch.json': fleet },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '500',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: fakeSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
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

    await journalUntil(journalFile, journal => journal.dispatched['1516:develop:1']?.result === 'launched');
    const second = await journalUntil(journalFile, journal =>
      journal.dispatched['1516:develop:1']?.judged === 'no-proof'
      && journal.dispatched['1516:develop:2']?.result === 'launched');
    assert.deepEqual(
      [second.dispatched['1516:develop:1'].host, second.dispatched['1516:develop:2'].host],
      ['alpha', 'beta'],
      'the durable no-proof judgment launches R2 on another host',
    );
    const afterOne = await until(async () => {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      const current = data.cards.find(card => card.id === unit.id);
      return current?.consecutiveFails >= 1 ? current : null;
    });
    assert.equal(afterOne.consecutiveFails, 1);

    await journalUntil(journalFile, value => value.dispatched['1516:develop:3']?.judged === 'no-proof');
    const final = await until(async () => {
      const data = (await getJson(board.base, '/pipeline/data')).body;
      const current = data.cards.find(card => card.id === unit.id);
      return current?.stage === 'stuck' ? current : null;
    });
    assert.equal(final.stage, 'stuck');
    assert.equal(final.consecutiveFails, 3);
    assert.match(final.stageHistory.at(-1).reason, /no open or merged PR on feat\/1516 after alpha\/lane-1 freed/);
    await until(async () => board.output().includes('--- notifyStuck ---'));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(count(board.output(), '--- notifyStuck ---'), 1);
    const settled = JSON.parse(await readFile(journalFile, 'utf8'));
    assert.deepEqual(Object.keys(settled.dispatched), [
      '1516:develop:1', '1516:develop:2', '1516:develop:3',
    ], 'a stuck card does not receive R4 on the sweep after its third failure');
    assert.deepEqual(
      Object.values(settled.dispatched).map(entry => [entry.round, entry.host, entry.judged]),
      [[1, 'alpha', 'no-proof'], [2, 'beta', 'no-proof'], [3, 'alpha', 'no-proof']],
      'each missing proof becomes the next launched round and alternates hosts first',
    );
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a judged-ok fix (the head changed) does not clear the failure streak', async () => {
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
    port: 15029,
    config: { source: 'probe' },
    files: { 'sprint-facts.json': heldFacts },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '250',
    }),
  });

  try {
    const created = await postJson(board.base, '/pipeline/card/create', { title: 'Carousel sprint', spec: 'the spec' });
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
      id: unit.id, kind: 'review', reason: 'R1 — NO-GO',
    });
    assert.equal(failed.body.card.consecutiveFails, 1);

    const journalFile = path.join(board.dir, 'auto-dispatch.json');
    const oldHead = 'abc1234567890000000000000000000000000000';
    const journal = { dispatched: {} };
    journal.dispatched['1516:fix:abc12345'] = {
      card: parent,
      title: 'Carousel sprint',
      unit: 'U1',
      ticket: 1516,
      branch: 'feat/1516',
      lane: 'alpha/lane-1',
      host: 'alpha',
      kind: 'fix',
      round: 1,
      head: oldHead,
      at: '2026-08-30T08:00:00Z',
      result: 'launched',
    };
    await writeFile(journalFile, JSON.stringify(journal, null, 2));
    await until(async () => {
      try {
        const current = JSON.parse(await readFile(journalFile, 'utf8'));
        return current.dispatched['1516:fix:abc12345']?.firstSeenFree ? current : null;
      } catch { return null; }
    });

    // The fixer pushed a new head: the fix's proof is real, the judgment is ok.
    const provedFacts = {
      ...FACTS,
      prs: [{
        number: 1600,
        branch: 'feat/1516',
        headSha: 'def9876543210000000000000000000000000000',
        url: 'https://github.com/acme/web/pull/1600',
        ci: { color: 'green', text: 'CI green (1)' },
      }],
    };
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify(provedFacts, null, 2));

    await until(async () => {
      const current = JSON.parse(await readFile(journalFile, 'utf8'));
      return current.dispatched['1516:fix:abc12345']?.judged === 'ok' ? current : null;
    });
    // Judged ok says only "the head changed" — the streak survives; the next
    // two failures make three in a row and the card goes stuck.
    await new Promise(resolve => setTimeout(resolve, 600));
    const data = (await getJson(board.base, '/pipeline/data')).body;
    const afterFix = data.cards.find(card => card.id === unit.id);
    assert.equal(afterFix.consecutiveFails, 1, 'a judged-ok fix must not reset the streak');

    await postJson(board.base, '/pipeline/card/fail', { id: unit.id, kind: 'review', reason: 'R2 — NO-GO' });
    const third = await postJson(board.base, '/pipeline/card/fail', { id: unit.id, kind: 'review', reason: 'R3 — NO-GO' });
    assert.equal(third.body.card.stage, 'stuck', 'three NO-GOs across ok fixes reach Stuck');
    assert.equal(third.body.card.consecutiveFails, 3);
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
