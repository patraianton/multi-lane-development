import { execFile } from 'node:child_process';

const RULES_PATH = 'docs/RULES.md';
const ROLES = new Set(['common', 'lane', 'reviewer', 'fixer', 'qa', 'cutter']);
const MARKER = /^[\t ]*<!--[\t ]*role:[\t ]*([a-z][a-z0-9-]*)[\t ]*-->[\t ]*(?:\r?\n|$)/gim;

function execGit(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`;
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out });
    });
  });
}

function commandOutput(result) {
  if (result === null || result === undefined) return { code: -1, out: '' };
  if (typeof result === 'string' || Buffer.isBuffer(result)) {
    return { code: 0, out: String(result) };
  }
  const code = result.code ?? result.exitCode ?? result.status ?? 0;
  const out = result.out ?? result.stdout ?? '';
  return { code, out: String(out) };
}

async function run(exec, args) {
  try {
    return commandOutput(await exec('git', args));
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : -1,
      out: String(error?.stdout ?? error?.stderr ?? error?.message ?? ''),
    };
  }
}

export async function readRules({ root, exec = execGit }) {
  const prefix = ['-C', root];
  const shown = await run(exec, [...prefix, 'show', `HEAD:${RULES_PATH}`]);
  if (shown.code !== 0) return null;

  const logged = await run(exec, [...prefix, 'log', '-1', '--format=%h', '--', RULES_PATH]);
  const sha = logged.out.trim();
  if (logged.code !== 0 || !sha) {
    throw new Error(`could not read the committed ${RULES_PATH} revision`);
  }
  return { sha, text: shown.out };
}

export function cutRules(text, role) {
  const name = String(role ?? '');
  if (!ROLES.has(name)) throw new Error(`unknown rules role: ${name}`);

  const source = String(text ?? '');
  const matches = [...source.matchAll(MARKER)];
  const sections = new Map();
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? source.length;
    if (!sections.has(matches[i][1])) sections.set(matches[i][1], source.slice(start, end));
  }

  const common = sections.get('common');
  const selected = sections.get(name);
  if (!common || !selected) throw new Error(`missing rules section for role: ${name}`);
  return name === 'common' ? common : common + selected;
}
