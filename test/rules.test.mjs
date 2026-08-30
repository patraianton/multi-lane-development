import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutRules, readRules } from '../bin/rules.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runFile = promisify(execFile);
const roles = ['common', 'lane', 'reviewer', 'fixer', 'qa', 'cutter'];

async function git(root, ...args) {
  const { stdout } = await runFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  return stdout;
}

async function exec(bin, args) {
  const { stdout } = await runFile(bin, args, { encoding: 'utf8', timeout: 10_000 });
  return { code: 0, out: stdout };
}

async function initRepo(root) {
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Rules Test');
  await git(root, 'config', 'user.email', 'rules@example.test');
}

test('cutRules returns common plus each of the six committed rule sections', async () => {
  const text = await git(ROOT, 'show', 'HEAD:docs/RULES.md');
  const blocks = new Map();
  for (let i = 0; i < roles.length; i += 1) {
    const marker = `<!-- role: ${roles[i]} -->`;
    const start = text.indexOf(marker);
    const end = i + 1 < roles.length ? text.indexOf(`<!-- role: ${roles[i + 1]} -->`) : text.length;
    assert.notEqual(start, -1, `${roles[i]} is present in the committed rulebook`);
    blocks.set(roles[i], text.slice(start, end));
  }

  for (const role of roles) {
    const expected = role === 'common' ? blocks.get('common') : blocks.get('common') + blocks.get(role);
    assert.equal(cutRules(text, role), expected, role);
  }
});

test('cutRules throws with the unknown or missing role name', () => {
  assert.throws(() => cutRules('<!-- role: common -->\ncommon\n', 'pilot'), /pilot/);
  assert.throws(() => cutRules('<!-- role: common -->\ncommon\n', 'qa'), /qa/);
});

test('readRules returns only committed content and its abbreviated revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rules-git-'));
  try {
    await initRepo(root);
    await mkdir(path.join(root, 'docs'));
    const committed = '# committed rules\n\n<!-- role: common -->\nkeep this\n';
    await writeFile(path.join(root, 'docs', 'RULES.md'), committed);
    await git(root, 'add', 'docs/RULES.md');
    await git(root, 'commit', '-m', 'add rules');
    const sha = (await git(root, 'log', '-1', '--format=%h', '--', 'docs/RULES.md')).trim();

    await writeFile(path.join(root, 'docs', 'RULES.md'), '# uncommitted replacement\n');
    assert.deepEqual(await readRules({ root, exec }), { sha, text: committed });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRules returns null when docs/RULES.md exists only in the working copy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rules-uncommitted-'));
  try {
    await initRepo(root);
    await writeFile(path.join(root, 'README.md'), '# fixture\n');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'initial commit');
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'RULES.md'), '# working copy only\n');

    assert.equal(await readRules({ root, exec }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
