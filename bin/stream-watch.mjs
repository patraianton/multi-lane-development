// Reading STREAM-WATCH.json without trusting it.
//
// The file is maintained by hand elsewhere; the board only reads it. A record
// whose branch_prefix was written as a plain string (instead of a list) used to
// take the whole board down with "(stream.branch_prefix ?? []).some is not a
// function" — so every record is rebuilt here. Whatever the file holds, the
// worst it can do is lose its own record, and each loss is said out loud: the
// caller shows the `problems` lines under /api/board problems as `stream-watch`.
//
// The rules, record by record:
//   - branch_prefix as a string     → a one-element list;
//   - branch_prefix as a list       → its string items (non-strings are dropped
//                                     and reported, the record stays);
//   - branch_prefix null or rubbish → the record is skipped and reported;
//   - a record that is not an object, or a file that is not the expected shape,
//     is reported the same way — never thrown.

export function normStreamWatch(raw) {
  const out = { byPane: new Map(), byId: new Map(), ctoPane: null, repo: null, problems: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.problems.push('the file is not an object — every record was ignored');
    return out;
  }
  out.ctoPane = raw.cto_pane ?? null;
  if (raw.repo !== undefined && raw.repo !== null && raw.repo !== '') {
    if (typeof raw.repo === 'string') out.repo = raw.repo.trim() || null;
    else out.problems.push('repo is not a text — ignored');
  }
  if (raw.streams !== undefined && !Array.isArray(raw.streams)) {
    out.problems.push('streams is not a list — every record was ignored');
    return out;
  }
  (raw.streams ?? []).forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      out.problems.push(`record #${i + 1} is not an object — record skipped`);
      return;
    }
    const name = String(s.id ?? '').trim() || String(s.pane ?? '').trim() || `record #${i + 1}`;
    const bp = s.branch_prefix;
    let prefixes = [];
    if (typeof bp === 'string') prefixes = [bp];
    else if (Array.isArray(bp)) {
      prefixes = bp.filter(p => typeof p === 'string');
      if (prefixes.length !== bp.length) {
        out.problems.push(`${name}: branch_prefix has non-string entries — they were ignored`);
      }
    } else if (bp !== undefined) {
      out.problems.push(`${name}: branch_prefix must be a list of prefixes or one string — record skipped`);
      return;
    }
    if (s.disabled) return;
    const stream = { ...s, branch_prefix: prefixes };
    if (stream.pane) out.byPane.set(stream.pane, stream);
    if (stream.id) out.byId.set(String(stream.id).toLowerCase(), stream);
  });
  return out;
}
