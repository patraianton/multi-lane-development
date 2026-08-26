// State files on disk: read softly, write atomically.
//
// Both the windows view and the pipeline keep their state in plain JSON files
// under state/. They share this one write queue on purpose — two writers of the
// same file must never race, whichever part of the board they belong to.

import { readFile, writeFile, rename, rm } from 'node:fs/promises';

// A state file that cannot be read (missing, half-written, hand-edited into
// garbage) must never take the board down: the caller gets its fallback and
// carries on with an empty state.
export async function readJsonSoft(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

// Writing a state file: to a temporary file first, then a rename. Two details
// already paid for:
//   1. the temporary name is unique — otherwise two concurrent writes share one
//      <file>.tmp and the second one renames a half-written stub;
//   2. writes of one file are queued — renames never overtake each other and
//      never trip over an already renamed temporary file.
const writeQueues = new Map();

export async function writeJsonAtomic(file, obj) {
  const text = JSON.stringify(obj, null, 2);
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tmp, text);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  });
  // The queue holds a version that never rejects: one failed write must not
  // cancel the next one.
  const tail = run.catch(() => {});
  writeQueues.set(file, tail);
  tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return run;
}
