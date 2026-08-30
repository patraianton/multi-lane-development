// Pure merge policy for the board. The watchtower supplies facts for the
// current PR head; this module only decides whether those facts are safe to
// merge and removes GitHub's issue-closing keywords from the squash body.

function prefixMatches(prefix, full) {
  const short = String(prefix ?? '').toLowerCase();
  const head = String(full ?? '').toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(short)
    && /^[0-9a-f]{7,40}$/.test(head)
    && head.startsWith(short);
}

function ciColorOf(pr) {
  return String(pr?.ciColor ?? pr?.ci?.color ?? '').toLowerCase();
}

function ciHeadOf(pr) {
  return pr?.ciHeadSha ?? pr?.ci?.headSha ?? null;
}

function exactHead(left, right) {
  const a = String(left ?? '').toLowerCase();
  const b = String(right ?? '').toLowerCase();
  return Boolean(a && b && a === b);
}

function labelsOf(unit) {
  return Array.isArray(unit?.labels)
    ? unit.labels.map(label => String(label?.name ?? label).toLowerCase())
    : [];
}

// Parse all review comments once so the page can show their history while the
// scheduler separately uses only a verdict that names the current PR head.
export function prVerdictFacts(comments, headSha = null) {
  const verdicts = [];
  let verdict = null;
  let verdictOnHead = null;

  for (const comment of comments ?? []) {
    const body = String(comment?.body ?? '');
    const lines = body.split(/\r?\n/);
    const match = /^R(\d+)\s*[—–-]+\s*(GO|NO-GO)\b/i.exec(lines[0].trim());
    if (!match) continue;

    const headMatch = /^head\s+([0-9a-f]{7,40})\b/i.exec(lines[1] ?? '');
    const entry = {
      round: Number(match[1]),
      go: match[2].toUpperCase() === 'GO',
      head: headMatch?.[1] ?? null,
      at: comment?.createdAt ?? null,
      body,
    };
    verdicts.push(entry);
    if (entry.head) verdict = entry;
    if (prefixMatches(entry.head, headSha)) verdictOnHead = entry;
  }

  return { verdicts, verdict, verdictOnHead, verdictRounds: verdicts.length };
}

// Compatibility for callers that only need the latest headed verdict.
export function prVerdict(comments) {
  return prVerdictFacts(comments).verdict;
}

// Conditions are deliberately checked in scheduler order. `why` is stable
// enough for both the dispatch table and focused policy tests.
export function canMerge({ pr, unit } = {}) {
  if (ciColorOf(pr) !== 'green') return { ok: false, why: 'check green' };
  if (!exactHead(ciHeadOf(pr), pr?.headSha)) return { ok: false, why: 'check head' };

  // A no-review ticket (styles, texts or documentation only — RULES.md,
  // cutter 7) merges on the green check alone: the GO requirement is dropped,
  // never a standing stop order — a NO-GO on this exact head is a fix round,
  // not a merge. hold-merge below still wins.
  const verdict = pr?.verdictOnHead;
  const verdictOnHead = Boolean(verdict) && prefixMatches(verdict.head, pr?.headSha);
  if (labelsOf(unit).includes('no-review')) {
    if (verdictOnHead && verdict.go === false) return { ok: false, why: 'NO-GO' };
  } else {
    if (!verdictOnHead) return { ok: false, why: 'verdict head' };
    if (verdict.go !== true) return { ok: false, why: 'NO-GO' };
  }
  if (pr?.draft) return { ok: false, why: 'draft' };
  if (pr?.mergeable !== 'MERGEABLE') return { ok: false, why: 'mergeable' };
  if (labelsOf(unit).includes('hold-merge')) return { ok: false, why: 'hold-merge' };
  return { ok: true, why: '' };
}

// GitHub recognises these words and closes the referenced ticket as part of
// the merge. Acceptance happens later in this pipeline, so retain only the
// ticket reference. A qualified owner/repo#N reference is handled too.
export function bodyFix(body) {
  const original = String(body ?? '');
  const fixed = original.replace(
    /^(?:Closes|Fixes|Resolves)[^\S\r\n]+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/gim,
    'Ticket: #$1',
  );
  return { body: fixed, changed: fixed !== original };
}
