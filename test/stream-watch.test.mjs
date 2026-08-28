// normStreamWatch: whatever STREAM-WATCH.json holds, the worst outcome is a
// lost record with a problem line — never an exception.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normStreamWatch } from '../bin/stream-watch.mjs';

test('a string branch_prefix becomes a one-element list', () => {
  const out = normStreamWatch({
    streams: [{ id: 'coolify', pane: 'w1:p1', branch_prefix: 'fix/coolify-' }],
  });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.byId.get('coolify').branch_prefix, ['fix/coolify-']);
  assert.deepEqual(out.byPane.get('w1:p1').branch_prefix, ['fix/coolify-']);
});

test('a list branch_prefix stays a list', () => {
  const out = normStreamWatch({
    streams: [{ id: 's', branch_prefix: ['feat/a-', 'fix/b-'] }],
  });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.byId.get('s').branch_prefix, ['feat/a-', 'fix/b-']);
});

test('a missing branch_prefix is an empty list, no problem', () => {
  const out = normStreamWatch({ streams: [{ id: 's', pane: 'w1:p1' }] });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.byId.get('s').branch_prefix, []);
});

test('null or rubbish branch_prefix skips the record and names it', () => {
  const out = normStreamWatch({
    streams: [
      { id: 'good', branch_prefix: 'ok-' },
      { id: 'bad-null', branch_prefix: null },
      { id: 'bad-number', branch_prefix: 42 },
      { id: 'bad-object', branch_prefix: { a: 1 } },
    ],
  });
  assert.ok(out.byId.has('good'));
  assert.ok(!out.byId.has('bad-null'));
  assert.ok(!out.byId.has('bad-number'));
  assert.ok(!out.byId.has('bad-object'));
  assert.equal(out.problems.length, 3);
  assert.ok(out.problems[0].includes('bad-null'));
  assert.ok(out.problems[1].includes('bad-number'));
  assert.ok(out.problems[2].includes('bad-object'));
});

test('non-string entries inside a list are dropped, the record stays', () => {
  const out = normStreamWatch({
    streams: [{ id: 's', branch_prefix: ['ok-', 42, null] }],
  });
  assert.deepEqual(out.byId.get('s').branch_prefix, ['ok-']);
  assert.equal(out.problems.length, 1);
  assert.ok(out.problems[0].includes('s'));
});

test('a record that is not an object is skipped and reported', () => {
  const out = normStreamWatch({ streams: ['what', null, 7] });
  assert.equal(out.byId.size, 0);
  assert.equal(out.problems.length, 3);
  assert.ok(out.problems[0].includes('record #1'));
  assert.ok(out.problems[2].includes('record #3'));
});

test('streams that is not a list, and a file that is not an object', () => {
  for (const raw of [{ streams: 'junk' }, 'junk', 7, [1, 2], null]) {
    const out = normStreamWatch(raw);
    assert.equal(out.byId.size, 0);
    assert.equal(out.byPane.size, 0);
    assert.equal(out.problems.length, 1);
  }
});

test('disabled records are skipped silently whatever they hold, as before', () => {
  const out = normStreamWatch({
    streams: [
      { id: 'off', branch_prefix: 'x-', disabled: true },
      { id: 'off-rubbish', branch_prefix: 42, lanes: 'junk', disabled: true },
    ],
  });
  assert.deepEqual(out.problems, []);
  assert.ok(!out.byId.has('off'));
  assert.ok(!out.byId.has('off-rubbish'));
});

test('an empty prefix is dropped and reported — it would match every branch', () => {
  const asString = normStreamWatch({ streams: [{ id: 's', branch_prefix: '' }] });
  assert.deepEqual(asString.byId.get('s').branch_prefix, []);
  assert.equal(asString.problems.length, 1);
  assert.ok(asString.problems[0].includes('empty'));
  const inList = normStreamWatch({ streams: [{ id: 's', branch_prefix: ['ok-', '', '  '] }] });
  assert.deepEqual(inList.byId.get('s').branch_prefix, ['ok-']);
  assert.equal(inList.problems.length, 1);
});

test('rubbish lanes lose themselves, the record stays', () => {
  const notList = normStreamWatch({ streams: [{ id: 's', lanes: 'junk' }] });
  assert.deepEqual(notList.byId.get('s').lanes, []);
  assert.equal(notList.problems.length, 1);
  assert.ok(notList.problems[0].includes('lanes'));
  const badEntry = normStreamWatch({
    streams: [{ id: 's', lanes: [null, { host: 'mac', task_match: 'T-' }, 'x'] }],
  });
  assert.deepEqual(badEntry.byId.get('s').lanes, [{ host: 'mac', task_match: 'T-' }]);
  assert.equal(badEntry.problems.length, 1);
});

test('a rubbish state_file loses itself, the record stays', () => {
  const out = normStreamWatch({ streams: [{ id: 's', state_file: 42 }] });
  assert.equal(out.byId.get('s').state_file, '');
  assert.equal(out.problems.length, 1);
  assert.ok(out.problems[0].includes('state_file'));
  const ok = normStreamWatch({ streams: [{ id: 's', state_file: 'C:\\x\\PROGRAM-STATE.md' }] });
  assert.equal(ok.byId.get('s').state_file, 'C:\\x\\PROGRAM-STATE.md');
  assert.deepEqual(ok.problems, []);
});

test('cto_pane and repo come through; a rubbish repo is ignored and reported', () => {
  const ok = normStreamWatch({ cto_pane: 'w4Z:p1', repo: 'owner/name', streams: [] });
  assert.equal(ok.ctoPane, 'w4Z:p1');
  assert.equal(ok.repo, 'owner/name');
  assert.deepEqual(ok.problems, []);
  const bad = normStreamWatch({ repo: { url: 'x' }, streams: [] });
  assert.equal(bad.repo, null);
  assert.equal(bad.problems.length, 1);
});
