// A successful reviewer launch is owned end to end by the board: head-keyed
// journal entry, reviewer task file, and the live badge on the unit card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executable, postJson, startBoard, until } from './helpers.mjs';

const HEAD = 'abc12345abcdef0123456789abcdef0123456789';
const UMBRELLA = 'https://github.com/acme/web/issues/1600';
const OWNER_TELEGRAM = {
  dryRun: true,
  chatId: '-1',
  ownerChatId: '1',
  founders: [{ name: 'Owner', tgUserId: 1, tag: '@owner', owner: true }],
};
const FLEET = {
  prompt: 'Read {taskFile} and do it whole',
  hosts: { mac: { kitchen: '~/kitchens/web', launch: 'maclane {n} "{prompt}"' } },
  lanes: {
    'lane-6': { host: 'mac', n: 6 },
    'lane-7': { host: 'mac', n: 7 },
  },
};
const FACTS = {
  lanes: [
    { host: 'mac', lane: 'lane-6', busy: false, branch: 'main' },
    { host: 'mac', lane: 'lane-7', busy: false, branch: 'main' },
  ],
  prs: [{
    number: 1632,
    url: 'https://github.com/acme/web/pull/1632',
    branch: 'feat/1624',
    headSha: HEAD,
    title: 'Review fixture #3',
    body: 'Ticket: #1624',
    draft: false,
    mergeable: 'MERGEABLE',
    labels: [],
    ci: { color: 'green', text: 'CI green (1)', headSha: HEAD },
    verdict: null,
    verdicts: [],
    verdictOnHead: null,
    verdictRounds: 0,
  }],
  mergedPrs: [],
  openIssues: [],
  unitIssues: {
    1600: [{
      number: 1624,
      title: 'UNIT-U1: reviewer fixture',
      url: 'https://github.com/acme/web/issues/1624',
      state: 'OPEN',
      branch: 'feat/1624',
      labels: [],
    }],
  },
  ciJobs: {},
  ciRunners: [],
  umbrellaStates: { 1600: 'OPEN' },
  staleSources: [],
};

async function createTicketed(board) {
  const made = await postJson(board.base, '/pipeline/card/create', { title: 'REVIEW sprint', spec: 'fixture' });
  const id = made.body.card.id;
  await postJson(board.base, '/pipeline/card/move', { id, to: 'grilled' });
  await postJson(board.base, '/pipeline/card/update', { id, links: { ticket: UMBRELLA } });
  await postJson(board.base, '/pipeline/card/move', { id, to: 'ticketed' });
  return id;
}

test('the board launches a reviewer off the writer lane and sets the unit review badge', async () => {
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-review-tools-'));
  let board;
  try {
    const ticket = {
      number: 1624,
      title: 'UNIT-U1: reviewer fixture',
      url: 'https://github.com/acme/web/issues/1624',
      body: 'Part of #1600.\n\nReview this exact head.',
    };
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      `if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});`,
    ].join('\n'));
    const fakeSsh = await executable(toolsDir, 'ssh', '#!/usr/bin/env node\n');
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const at = new Date().toISOString();
    const ledger = {
      dispatched: {
        '1624:develop:1': {
          card: 'old', title: 'REVIEW sprint', unit: 'U1', ticket: 1624,
          branch: 'feat/1624', lane: 'mac/lane-6', host: 'mac', base: 'main',
          kind: 'develop', round: 1, head: null, at, result: 'launched', error: null,
        },
      },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        hosts: { mac: { target: 'mock-mac' } },
      },
      files: {
        'sprint-facts.json': FACTS,
        'fleet-launch.json': FLEET,
        'auto-dispatch.json': ledger,
      },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: fakeSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
    const sprintId = await createTicketed(board);
    const api = await until(board.base, body => {
      const card = body.cards.find(candidate => candidate.parent === sprintId && candidate.ticket === 1624);
      return card?.review?.running === true ? true : false;
    });
    const unitCard = api.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    assert.deepEqual(
      { running: unitCard.review.running, round: unitCard.review.round, by: unitCard.review.by },
      { running: true, round: 1, by: 'mac/lane-7' },
    );
    assert.ok(unitCard.review.since);

    const journal = JSON.parse(await readFile(path.join(board.dir, 'auto-dispatch.json'), 'utf8'));
    assert.deepEqual(
      [journal.dispatched['1624:review:abc12345'].result, journal.dispatched['1624:review:abc12345'].lane],
      ['launched', 'mac/lane-7'],
    );
    assert.ok(api.autoDispatch.some(row => row.kind === 'review R1'
      && row.unit === 'U1 #1624' && row.lane === 'mac/lane-7'));

    const task = await readFile(path.join(board.dir, 'auto-dispatch', 'TASK-1624-REVIEW-R1.md'), 'utf8');
    assert.match(task, /^Role: reviewer$/m);
    assert.match(task, new RegExp(`^Head: ${HEAD}  Round: R1$`, 'm'));
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a no-review unit gets no reviewer while its ordinary sibling does', async () => {
  const OTHER = 'def12345abcdef0123456789abcdef0123456789';
  const toolsDir = await mkdtemp(path.join(tmpdir(), 'watchtower-no-review-skip-tools-'));
  let board;
  try {
    const ticket = {
      number: 1625,
      title: 'UNIT-U2: ordinary sibling',
      url: 'https://github.com/acme/web/issues/1625',
      body: 'Part of #1600.\n\nReview this exact head.',
    };
    const fakeGh = await executable(toolsDir, 'gh', [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      `if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(${JSON.stringify(JSON.stringify(ticket))});`,
    ].join('\n'));
    const fakeSsh = await executable(toolsDir, 'ssh', '#!/usr/bin/env node\n');
    const fakeScp = await executable(toolsDir, 'scp', '#!/usr/bin/env node\n');
    const twoUnitFacts = {
      ...FACTS,
      prs: [
        {
          // Green and verdict-free: without the label this PR would be first
          // in the reviewer queue. `mergeable` UNKNOWN keeps the merge away.
          ...FACTS.prs[0],
          mergeable: 'UNKNOWN',
        },
        {
          ...FACTS.prs[0],
          number: 1633,
          url: 'https://github.com/acme/web/pull/1633',
          branch: 'feat/1625',
          headSha: OTHER,
          title: 'Review fixture #4',
          body: 'Ticket: #1625',
          ci: { color: 'green', text: 'CI green (1)', headSha: OTHER },
        },
      ],
      unitIssues: {
        1600: [
          { ...FACTS.unitIssues[1600][0], labels: ['no-review'] },
          {
            number: 1625,
            title: 'UNIT-U2: ordinary sibling',
            url: 'https://github.com/acme/web/issues/1625',
            state: 'OPEN',
            branch: 'feat/1625',
            labels: [],
          },
        ],
      },
    };
    const at = new Date().toISOString();
    const ledger = {
      dispatched: {
        '1625:develop:1': {
          card: 'old', title: 'REVIEW sprint', unit: 'U2', ticket: 1625,
          branch: 'feat/1625', lane: 'mac/lane-6', host: 'mac', base: 'main',
          kind: 'develop', round: 1, head: null, at, result: 'launched', error: null,
        },
      },
    };
    board = await startBoard({
      config: {
        source: 'probe', autoDispatch: true, repo: 'acme/web', telegram: OWNER_TELEGRAM,
        hosts: { mac: { target: 'mock-mac' } },
      },
      files: {
        'sprint-facts.json': twoUnitFacts,
        'fleet-launch.json': FLEET,
        'auto-dispatch.json': ledger,
      },
      env: dir => ({
        WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
        WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
        WATCHTOWER_SPRINT_SWEEP_MS: '200',
        WATCHTOWER_GH: fakeGh,
        WATCHTOWER_SSH: fakeSsh,
        WATCHTOWER_SCP: fakeScp,
      }),
    });
    const sprintId = await createTicketed(board);
    const api = await until(board.base, body => {
      const card = body.cards.find(candidate => candidate.parent === sprintId && candidate.ticket === 1625);
      return card?.review?.running === true;
    });

    const journal = JSON.parse(await readFile(path.join(board.dir, 'auto-dispatch.json'), 'utf8'));
    assert.equal(journal.dispatched['1625:review:def12345'].result, 'launched');
    assert.ok(!Object.keys(journal.dispatched).some(key => key.startsWith('1624:review')),
      'the labelled unit never enters the review journal');
    assert.ok(api.autoDispatch.some(row => row.kind === 'review R1' && row.unit === 'U2 #1625'));
    assert.ok(!api.autoDispatch.some(row => row.kind.startsWith('review') && row.unit.includes('#1624')),
      'the table shows no planned or waiting review for the labelled unit');
    const labelledCard = api.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    assert.notEqual(labelledCard.review?.running, true);
  } finally {
    if (board) await board.stop();
    await rm(toolsDir, { recursive: true, force: true });
  }
});

test('a launched review journal repairs a missing board badge', async () => {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const ledger = {
    dispatched: {
      '1624:review:abc12345': {
        card: 'old', title: 'REVIEW sprint', unit: 'U1', ticket: 1624,
        branch: 'feat/1624', lane: 'mac/lane-7', host: 'mac', base: 'main',
        kind: 'review', round: 1, head: HEAD, at, result: 'launched', error: null,
      },
    },
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web' },
    files: { 'sprint-facts.json': FACTS, 'auto-dispatch.json': ledger },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '200',
    }),
  });
  try {
    const sprintId = await createTicketed(board);
    const api = await until(board.base, body => {
      const card = body.cards.find(candidate => candidate.parent === sprintId && candidate.ticket === 1624);
      return card?.review?.running === true;
    });
    const unitCard = api.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    assert.deepEqual(unitCard.review, { running: true, round: 1, since: at, by: 'mac/lane-7' });
    assert.deepEqual(JSON.parse(await readFile(path.join(board.dir, 'auto-dispatch.json'), 'utf8')), ledger);
  } finally {
    await board.stop();
  }
});

test('stale PR facts never restore a review badge from the journal', async () => {
  const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const entry = {
    card: 'old', title: 'REVIEW sprint', unit: 'U1', ticket: 1624,
    branch: 'feat/1624', lane: 'mac/lane-7', host: 'mac', base: 'main',
    kind: 'review', round: 1, head: HEAD, at, result: 'launching', error: null,
  };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web' },
    files: {
      'sprint-facts.json': FACTS,
      'auto-dispatch.json': { dispatched: { '1624:review:abc12345': entry } },
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '200',
    }),
  });
  try {
    const sprintId = await createTicketed(board);
    await until(board.base, body => body.cards.some(card => card.parent === sprintId
      && card.ticket === 1624 && card.stage === 'ci_pr'));

    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify({
      ...FACTS,
      staleSources: ['pull-requests'],
    }));
    await until(board.base, body => body.cards.find(card => card.id === sprintId)?.sprint?.stale?.includes('pull-requests'));
    await writeFile(path.join(board.dir, 'auto-dispatch.json'), JSON.stringify({
      dispatched: { '1624:review:abc12345': { ...entry, result: 'launched' } },
    }));

    const api = await until(board.base, body => body.autoDispatch?.some(row => row.kind === 'review R1'
      && String(row.state).startsWith('launched')));
    const unitCard = api.cards.find(card => card.parent === sprintId && card.ticket === 1624);
    assert.notEqual(unitCard.review?.running, true);
  } finally {
    await board.stop();
  }
});
