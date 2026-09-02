import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getJson, postJson, startBoard, until } from './helpers.mjs';

const OWNER_TELEGRAM = {
  dryRun: true,
  chatId: '-1',
  ownerChatId: '1',
  founders: [{ name: 'Owner', tgUserId: 1, tag: '@owner', owner: true }],
};

const FLEET = {
  prompt: 'Read {taskFile} and do it whole',
  hosts: {
    mac: { kitchen: '~/kitchens/web', browser: true, launch: 'maclane {n} "{prompt}"' },
  },
  lanes: {
    'lane-6': { host: 'mac', n: 6 },
    'lane-7': { host: 'mac', n: 7 },
  },
};

const SPRINT_ID = 'tail-sprint';
const enteredAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
const prUrl = 'https://github.com/acme/web/pull/1854';

function facts() {
  return {
    lanes: [
      { host: 'mac', lane: 'lane-6', busy: false, since: null, branch: 'main' },
      { host: 'mac', lane: 'lane-7', busy: false, since: null, branch: 'main' },
    ],
    prs: [{
      number: 1854, url: prUrl, branch: 'feat/1850',
      headSha: '18faeb2700000000000000000000000000000000', mergeable: 'MERGEABLE',
      ci: { color: 'green' }, verdictOnHead: null, verdictRounds: 0,
    }],
    mergedPrs: [],
    openIssues: [],
    unitIssues: {
      1803: [
        { number: 1850, title: 'TAIL-U1: market card', url: 'https://github.com/acme/web/issues/1850', state: 'OPEN', branch: 'feat/1850', labels: [] },
        { number: 1826, title: 'QA R3 — tail walk', url: 'https://github.com/acme/web/issues/1826', state: 'OPEN', branch: 'feat/1826', labels: ['qa', 'qa-run'], qa: true, deps: [1850] },
        { number: 1851, title: 'TAIL-U2: ribbon', url: 'https://github.com/acme/web/issues/1851', state: 'OPEN', branch: 'feat/1851', labels: [], deps: [1850] },
        { number: 1852, title: 'TAIL-U3: footer', url: 'https://github.com/acme/web/issues/1852', state: 'OPEN', branch: 'feat/1852', labels: [] },
      ],
    },
    ciJobs: {},
    ciRunners: [],
    umbrellaStates: { 1803: 'OPEN' },
    staleSources: [],
  };
}

function cards() {
  const status = { text: '', at: null };
  const base = { spec: '', createdAt: enteredAt, counters: {}, consecutiveFails: 0, lane: '', status };
  return [
    {
      ...base, id: SPRINT_ID, title: 'CAF3-TAIL sprint', spec: 'the spec', stage: 'development',
      stageHistory: [{ stage: 'development', enteredAt, leftAt: null }],
      links: { ticket: 'https://github.com/acme/web/issues/1803' },
    },
    {
      ...base, id: 'tail-u1', title: 'U1 #1850 — market card', stage: 'ci_pr', parent: SPRINT_ID, ticket: 1850, unit: 'U1',
      stageHistory: [{ stage: 'ci_pr', enteredAt, leftAt: null }],
      links: { ticket: 'https://github.com/acme/web/issues/1850', branch: 'feat/1850', pr: prUrl },
    },
    {
      ...base, id: 'tail-qa', title: 'QA #1826 — tail walk', stage: 'stuck', parent: SPRINT_ID, ticket: 1826, unit: 'QA',
      stageHistory: [
        { stage: 'ticketed', enteredAt, leftAt: enteredAt },
        { stage: 'development', enteredAt, leftAt: enteredAt },
        { stage: 'stuck', enteredAt, leftAt: null, reason: 'QUESTION #1826 QA R3 is blocked by open dependency #1850' },
      ],
      links: { ticket: 'https://github.com/acme/web/issues/1826', branch: 'feat/1826', pr: '' },
    },
    {
      ...base, id: 'tail-u2', title: 'U2 #1851 — ribbon', stage: 'ticketed', parent: SPRINT_ID, ticket: 1851, unit: 'U2',
      stageHistory: [{ stage: 'ticketed', enteredAt, leftAt: null }],
      links: { ticket: 'https://github.com/acme/web/issues/1851', branch: 'feat/1851', pr: '' },
    },
    {
      ...base, id: 'tail-u3', title: 'U3 #1852 — footer', stage: 'stuck', parent: SPRINT_ID, ticket: 1852, unit: 'U3',
      stageHistory: [{ stage: 'stuck', enteredAt, leftAt: null, reason: 'R3 — NO-GO' }],
      links: { ticket: 'https://github.com/acme/web/issues/1852', branch: 'feat/1852', pr: 'https://github.com/acme/web/pull/1899' },
    },
  ];
}

async function fixture() {
  const source = facts();
  const journal = { dispatched: {
    '1826:develop:1': {
      ticket: 1826, kind: 'develop', round: 1, result: 'launched', judged: 'no-proof',
      lane: 'mac/lane-6', host: 'mac', at: new Date(Date.now() - 60 * 60_000).toISOString(),
      unit: 'QA', card: SPRINT_ID, title: 'CAF3-TAIL-001',
    },
  } };
  const board = await startBoard({
    config: { source: 'probe', autoDispatch: false, repo: 'acme/web', telegram: OWNER_TELEGRAM },
    files: {
      'sprint-facts.json': source, 'fleet-launch.json': FLEET,
      'pipeline-cards.json': { cards: cards() }, 'auto-dispatch.json': journal,
    },
    env: dir => ({
      WATCHTOWER_SPRINT_FACTS_FILE: path.join(dir, 'sprint-facts.json'),
      WATCHTOWER_FLEET_LAUNCH_FILE: path.join(dir, 'fleet-launch.json'),
      WATCHTOWER_SPRINT_SWEEP_MS: '300',
    }),
  });
  return { board, source };
}

test('unstuck lands by the PR, and a queued card says what the planner holds it for (#1826)', async () => {
  const { board } = await fixture();
  try {
    await until(board.base, body => /^waiting for the owner — QUESTION #1826/.test(body.cards?.find(c => c.ticket === 1826)?.status?.text ?? ''), { pathName: '/pipeline/data' });

    const noPr = await postJson(board.base, '/pipeline/card/unstuck', { id: 'tail-qa' });
    assert.equal(noPr.body.card.stage, 'ticketed');
    const rememberedPr = await postJson(board.base, '/pipeline/card/unstuck', { id: 'tail-u3' });
    assert.equal(rememberedPr.body.card.stage, 'development');

    const page = await until(board.base, body => body.cards?.find(c => c.ticket === 1826)?.status?.text === 'queued — waits for #1850 (pr green)', { pathName: '/pipeline/data' });
    assert.match(page.cards.find(c => c.ticket === 1851).status.text, /^queued — would dispatch to mac\/lane-[67] \(auto-dispatch is off\)$/);
    assert.match(page.cards.find(c => c.ticket === 1850).status.text, /^PR #1854 open — review R1 would dispatch to mac\/lane-[67] \(auto-dispatch is off\)$/);
    const u3 = await until(board.base, body => body.cards?.find(c => c.ticket === 1852)?.status?.text === 'PR closed without a merge — close the ticket or reopen the PR', { pathName: '/pipeline/data' });
    assert.equal(u3.cards.find(c => c.ticket === 1852).stage, 'development');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const afterThreeSweeps = (await getJson(board.base, '/pipeline/data')).body;
    assert.equal(afterThreeSweeps.cards.find(c => c.ticket === 1852).stage, 'development');

    const firstAt = afterThreeSweeps.cards.find(c => c.ticket === 1826).status.at;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const unchanged = (await getJson(board.base, '/pipeline/data')).body.cards.find(c => c.ticket === 1826);
    assert.equal(unchanged.status.at, firstAt);

    const agent = (await getJson(board.base, '/api/pipeline?format=json')).body;
    assert.ok(agent.autoDispatch.some(r => r.unit === 'QA #1826' && r.state === 'held: waits for #1850 (pr green)'));
    assert.ok(agent.autoDispatch.some(r => r.unit === 'QA #1826' && r.state.startsWith('launched')));
    assert.match(board.output(), /card QA #1826[^\n]*: ticketed — queued — waits for #1850 \(pr green\)$/m);
    assert.doesNotMatch(board.output(), /card QA #1826[^\n]*: ticketed — queued — (no lane has taken it yet|auto-dispatch is off)/);
    assert.match(board.output(), /by hand: unstuck QA #1826[^\n]* → ticketed/);
    assert.match(board.output(), /by hand: unstuck U3 #1852[^\n]* → development/);
  } finally {
    await board.stop();
  }
});

test('a stale source keeps the sentence and its clock', async () => {
  const { board, source } = await fixture();
  try {
    const page = await until(board.base, body => body.cards?.find(c => c.ticket === 1850)?.status?.text?.startsWith('PR #1854 open —'), { pathName: '/pipeline/data' });
    const before = page.cards.find(c => c.ticket === 1850);
    const linesBefore = (board.output().match(/card U1 #1850/g) ?? []).length;
    await writeFile(path.join(board.dir, 'sprint-facts.json'), JSON.stringify({
      ...source, staleSources: ['pull-requests'], prs: [],
    }, null, 2));
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = (await getJson(board.base, '/pipeline/data')).body.cards.find(c => c.ticket === 1850);
    assert.equal(after.stage, before.stage);
    assert.equal(after.status.text, before.status.text);
    assert.equal(after.status.at, before.status.at);
    assert.equal((board.output().match(/card U1 #1850/g) ?? []).length, linesBefore);
  } finally {
    await board.stop();
  }
});
