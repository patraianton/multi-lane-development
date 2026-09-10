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

// Two checks, two different jobs. `pr-ci` is the gate that runs on every push:
// since Sep 2026 an ordinary push runs it scoped (the affected tests only,
// ~7 min). `pr-ci-full` is not a test run at all — it is the receipt that the
// FULL pipeline (build + every test + the browser smoke) ran on this exact
// head, and the full pipeline only runs on a PR that carries the `full-ci`
// label. Both must be green on the head before the board merges.
export const REQUIRED_CHECKS = ['pr-ci', 'pr-ci-full'];
// A receipt that has not arrived is not a failure. `pr-ci-full` is red or
// absent for most of a PR's life — from the first push until the board labels
// the PR and the full run finishes — so a non-green evidence check colours the
// PR yellow (waiting), never red: no fix lane, no burnt merge attempt, no
// stuck card. A full run that genuinely fails turns `pr-ci` itself red, and
// that keeps today's behaviour.
export const EVIDENCE_CHECKS = ['pr-ci-full'];
// The label the board puts on the PR to make the full pipeline run.
export const FULL_CI_LABEL = 'full-ci';
export const MERGE_ATTEMPTS = 3;

export function isEvidenceCheck(name) {
  return EVIDENCE_CHECKS.includes(String(name ?? '').trim().toLowerCase());
}

const RED_STATES = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'];
const RUN_STATES = ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'];

function checkName(item) {
  return String(item?.name ?? item?.context ?? '');
}

export function ciColor(rollup, required = REQUIRED_CHECKS) {
  const items = rollup ?? [];
  const requiredNames = [...new Set((required ?? []).map(String))];
  const wanted = new Set(requiredNames);
  const selected = wanted.size ? items.filter(item => wanted.has(checkName(item))) : items;
  if (!selected.length) return { color: 'none', text: 'no checks', failedNames: [] };

  let fail = 0, run = 0, ok = 0;
  const failedNames = [];
  const waitingNames = [];
  for (const item of selected) {
    const value = String(item.conclusion || item.state || item.status || '').toUpperCase();
    const name = String(item.name ?? item.context ?? item.workflowName ?? 'check');
    const evidence = isEvidenceCheck(checkName(item));
    if (RED_STATES.includes(value)) {
      if (evidence) { run++; waitingNames.push(name); }
      else { fail++; failedNames.push(name); }
    } else if (RUN_STATES.includes(value)) {
      run++;
      if (evidence) waitingNames.push(name);
    } else {
      ok++;
    }
  }
  // A required check GitHub does not report at all is missing evidence, not an
  // absent requirement: `pr-ci-full` has no run of its own before the `full-ci`
  // label, and a green `pr-ci` beside it must never read as a mergeable head.
  for (const name of requiredNames) {
    if (selected.some(item => checkName(item) === name)) continue;
    run++;
    waitingNames.push(name);
  }
  if (fail) return { color: 'red', text: `CI red (${fail})`, failedNames };
  if (run) {
    const text = waitingNames.length === run
      ? `CI waiting for ${waitingNames.join(', ')}`
      : `CI running (${run})`;
    return { color: 'run', text, failedNames };
  }
  return { color: 'green', text: `CI green (${ok})`, failedNames };
}

// Parse all review comments once so the page can show their history while the
// scheduler separately uses only a verdict that names the current PR head.
// Two verdict families live in the same comment stream: the reviewer's
// `R<n> — GO|NO-GO` and the spec-check's `S<n> — GO|NO-GO` (owner,
// 2026-09-08: the spec-check reads a head before any review or full run).
// Both carry `head <sha>` on line 2; the spec family is returned under
// `spec*` names and never mixes with the review family.
export function prVerdictFacts(comments, headSha = null) {
  const verdicts = [];
  let verdict = null;
  let verdictOnHead = null;
  let verdictRounds = 0;
  const specVerdicts = [];
  let specVerdict = null;
  let specVerdictOnHead = null;
  let specRounds = 0;
  const stagings = [];
  let staging = null;
  let stagingOnHead = null;

  for (const comment of comments ?? []) {
    const raw = String(comment?.body ?? '');
    // A lane posting through a shell can flatten its verdict into one line with
    // literal "\n" between the parts (#90: R3 — NO-GO\nhead …). Unescape only
    // when the body has no real line break, so a multi-line comment that quotes
    // "\n" stays as written.
    const body = /\r?\n/.test(raw) ? raw : raw.replace(/\\r\\n|\\n/g, '\n');
    const lines = body.split(/\r?\n/);
    const first = lines[0].trim();
    const match = /^R(\d+)\s*[—–-]+\s*(GO|NO-GO)\b/i.exec(first);
    const specMatch = /^S(\d+)\s*[—–-]+\s*(GO|NO-GO)\b/i.exec(first);
    const fixMatch = /^fix\s+R(\d+)\s+pushed\b/i.exec(first);
    const round = Number(match?.[1] ?? fixMatch?.[1]);
    if (Number.isInteger(round)) verdictRounds = Math.max(verdictRounds, round);
    const specRound = Number(specMatch?.[1]);
    if (Number.isInteger(specRound)) specRounds = Math.max(specRounds, specRound);
    // The staging deploy's receipt (owner, 2026-09-10): a bot comment the
    // staging workflow edits in place — line 1 `STAGING head <sha>` or
    // `STAGING head <sha> FAILED — <step>`, line 2 the address, line 3
    // `data: copy of production from <when>`. The latest receipt that names
    // the current head is what the spec-check walks; a FAILED one is the
    // auditor's first finding (the head does not deploy).
    const stagingMatch = /^STAGING\s+head\s+([0-9a-f]{7,40})\b\s*(?:(FAILED)\b\s*[—–:-]*\s*(.*))?$/i.exec(first);
    if (stagingMatch) {
      const second = String(lines[1] ?? '').trim();
      const entry = {
        head: stagingMatch[1],
        failed: Boolean(stagingMatch[2]),
        step: stagingMatch[2] ? (String(stagingMatch[3] ?? '').trim() || null) : null,
        url: /^https?:\/\//i.test(second) ? second : null,
        data: String(lines[2] ?? '').replace(/^data:\s*/i, '').trim() || null,
        at: comment?.updatedAt ?? comment?.createdAt ?? null,
        body,
      };
      stagings.push(entry);
      staging = entry;
      if (prefixMatches(entry.head, headSha)) stagingOnHead = entry;
      continue;
    }
    const hit = match ?? specMatch;
    if (!hit) continue;

    const headMatch = /^head\s+([0-9a-f]{7,40})\b/i.exec(lines[1] ?? '');
    const entry = {
      round: Number(hit[1]),
      go: hit[2].toUpperCase() === 'GO',
      head: headMatch?.[1] ?? null,
      at: comment?.createdAt ?? null,
      body,
    };
    if (specMatch) {
      specVerdicts.push(entry);
      if (entry.head) specVerdict = entry;
      if (prefixMatches(entry.head, headSha)) specVerdictOnHead = entry;
      continue;
    }
    verdicts.push(entry);
    if (entry.head) verdict = entry;
    if (prefixMatches(entry.head, headSha)) verdictOnHead = entry;
  }

  return {
    verdicts, verdict, verdictOnHead, verdictRounds, specVerdicts, specVerdict, specVerdictOnHead, specRounds,
    stagings, staging, stagingOnHead,
  };
}

// The spec-check's GO on this exact head. With `specCheck` on, a unit that is
// not `no-review` neither reviews, labels `full-ci` nor merges without it.
export function specGoOnHead(pr) {
  const spec = pr?.specVerdictOnHead;
  return Boolean(spec) && spec.go === true && prefixMatches(spec.head, pr?.headSha);
}

// Compatibility for callers that only need the latest headed verdict.
export function prVerdict(comments) {
  return prVerdictFacts(comments).verdict;
}

// Conditions are deliberately checked in scheduler order. `why` is stable
// enough for both the dispatch table and focused policy tests.
// `specCheck` (the board's setting, default true there; false here only so the
// fixtures written before 2026-09-08 still read as they did): the spec-check's
// `S<n> — GO` on the head comes before the reviewer's GO.
export function canMerge({ pr, unit, specCheck = false } = {}) {
  if (ciColorOf(pr) !== 'green') return { ok: false, why: 'check green' };
  if (!exactHead(ciHeadOf(pr), pr?.headSha)) return { ok: false, why: 'check head' };
  return mergeReadyBesidesCi({ pr, unit, specCheck });
}

// Every merge condition except the checks, in the same order.
function mergeReadyBesidesCi({ pr, unit, specCheck = false } = {}) {
  // A no-review ticket (styles, texts or documentation only — RULES.md,
  // cutter 7) merges on the green check alone: the GO requirement is dropped,
  // never a standing stop order — a NO-GO on this exact head is a fix round,
  // not a merge. hold-merge below still wins.
  const verdict = pr?.verdictOnHead;
  const verdictOnHead = Boolean(verdict) && prefixMatches(verdict.head, pr?.headSha);
  if (labelsOf(unit).includes('no-review')) {
    if (verdictOnHead && verdict.go === false) return { ok: false, why: 'NO-GO' };
  } else {
    if (specCheck && !specGoOnHead(pr)) {
      return { ok: false, why: pr?.specVerdictOnHead?.go === false ? 'SPEC NO-GO' : 'spec-check' };
    }
    if (!verdictOnHead) return { ok: false, why: 'verdict head' };
    if (verdict.go !== true) return { ok: false, why: 'NO-GO' };
  }
  if (pr?.draft) return { ok: false, why: 'draft — waiting for the author' };
  if (pr?.mergeable === 'UNKNOWN') return { ok: false, why: 'GitHub has not computed mergeability yet' };
  if (pr?.mergeable !== 'MERGEABLE') return { ok: false, why: 'GitHub says the PR is not mergeable' };
  if (labelsOf(unit).includes('hold-merge') || labelsOf(pr).includes('hold-merge')) {
    return { ok: false, why: 'hold-merge' };
  }
  return { ok: true, why: '' };
}

// The one merge blocker the board can clear itself: the full pipeline never
// ran because the PR carries no `full-ci` label. True when the card is ready
// to merge except for that evidence — the GO is on the head (or the ticket is
// no-review), the PR is not draft, GitHub calls it mergeable, nothing holds
// it, and the label is not there yet. A red `pr-ci` means a fixer owns this
// head first: labelling it would only burn a full run on code about to change.
export function needsFullCiLabel({ pr, unit, specCheck = false } = {}) {
  if (labelsOf(pr).includes(FULL_CI_LABEL)) return false;
  if (ciColorOf(pr) === 'red') return false;
  return mergeReadyBesidesCi({ pr, unit, specCheck }).ok;
}
