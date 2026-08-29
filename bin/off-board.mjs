// Everything that is being built lives on the board (decision 14). This
// module finds what does not: an open PR no card carries, a ticket in work
// that references no umbrella (so no card was spawned), a busy lane building
// a branch no card carries. Each finding names the fix. The server runs it
// every sprint sweep, shows the findings on the page and in /api/pipeline,
// and writes each new one into state/edge-cases.md — the list the process
// is corrected from.
//
// Pure: watchtower.mjs feeds it the live sources; tests feed it fixtures.

function normBranch(b) {
  return String(b ?? '').trim().replace(/^refs\/heads\//, '');
}

const TRUNKS = new Set(['', 'main', 'master', 'HEAD']);
const BOT_BRANCH = /^(dependabot|renovate)\//;

function ticketOf(link) {
  const m = /\/issues\/(\d+)\b/.exec(String(link ?? ''));
  return m ? Number(m[1]) : null;
}

// A ticket "in work" is one shaped like a unit or a QA ticket: a pinned
// branch, a depends-on line, a unit label in the title, or the qa label.
// A plain note with none of these is not work and is not flagged.
export function isWorkTicket(issue) {
  if (!issue) return false;
  if (issue.qa) return true;
  if (issue.branch) return true;
  if (Array.isArray(issue.deps) && issue.deps.length) return true;
  if (issue.dependsLine) return true;
  return /\bU\d{1,3}\b/i.test(String(issue.title ?? ''));
}

// cards: the pipeline's cards (links, ticket, parent, stage, title, lane).
// prs: open PRs [{ number, title, url, branch, draft }].
// issues: open issues that are neither umbrellas nor parked
//   [{ number, title, url, branch, deps, qa, refs: [numbers referenced in body or comments], dependsLine }].
// lanes: [{ host, lane, busy, branch, task }].
export function offBoardFindings({ cards = [], prs = [], issues = [], lanes = [], at = null } = {}) {
  const branches = new Set();
  const prUrls = new Set();
  const tickets = new Set();
  for (const c of cards ?? []) {
    const b = normBranch(c?.links?.branch);
    if (b) branches.add(b);
    if (c?.links?.pr) prUrls.add(String(c.links.pr).trim());
    if (c?.ticket) tickets.add(Number(c.ticket));
    const t = ticketOf(c?.links?.ticket);
    if (t) tickets.add(t);
  }
  const findings = [];

  for (const p of prs ?? []) {
    const branch = normBranch(p.branch);
    if (!branch || BOT_BRANCH.test(branch)) continue;
    if (branches.has(branch) || (p.url && prUrls.has(String(p.url).trim()))) continue;
    findings.push({
      kind: 'pr', key: `pr:${p.number}`, ref: `PR #${p.number}`, title: String(p.title ?? ''), url: p.url ?? '',
      detail: branch + (p.draft ? ' · draft' : ''),
      reason: 'an open PR no card carries — no card has this branch pinned or this PR attached',
      fix: 'the PR belongs to a unit ticket: pin its branch there (Branch: …) so the unit card carries it, or attach the PR to its card (links.pr)',
    });
  }

  for (const i of issues ?? []) {
    if (!isWorkTicket(i)) continue;
    if (tickets.has(Number(i.number))) continue;
    const refs = Array.isArray(i.refs) ? i.refs : [];
    findings.push({
      kind: 'ticket', key: `issue:${i.number}`, ref: `#${i.number}`, title: String(i.title ?? ''), url: i.url ?? '',
      detail: i.qa ? 'label qa' : (i.branch ? 'branch ' + i.branch : 'unit-shaped ticket'),
      reason: refs.length
        ? `a ticket in work that references ${refs.map(n => '#' + n).join(' ')} but spawned no card — none of those is a sprint on the board`
        : 'a ticket in work that references no umbrella — the board only spawns cards for tickets that name their umbrella (body or comment)',
      fix: 'write the umbrella number into the ticket ("continuation of #NNNN"); an after-sprint fix gets the qa label as well — TICKETING.md §7',
    });
  }

  for (const l of lanes ?? []) {
    if (!l?.busy) continue;
    const branch = normBranch(l.branch);
    if (TRUNKS.has(branch)) continue;
    if (branches.has(branch)) continue;
    const m = /TASK-(\d{3,5})\b/.exec(String(l.task ?? ''));
    if (m && tickets.has(Number(m[1]))) continue;
    findings.push({
      kind: 'lane', key: `lane:${l.host}/${l.lane}`, ref: `${l.host}/${l.lane}`, title: branch, url: '',
      detail: l.task ? 'task ' + l.task : '',
      reason: 'a busy lane building a branch no card carries',
      fix: 'the branch must be the pinned branch of a unit ticket on the board; work off the board is stopped or given its ticket',
    });
  }

  return findings.map(f => ({ ...f, at }));
}

// The edge-case ledger: which findings were seen when, which are gone. Pure
// too — the caller reads and writes the files.
//   ledger: { seen: { key: { kind, ref, title, reason, first, last, resolved } } }
// Returns { ledger, fresh: [findings never seen], resolved: [entries just closed] }.
export function updateLedger(ledger, findings, at) {
  const seen = { ...(ledger?.seen ?? {}) };
  const now = at ?? new Date().toISOString();
  const fresh = [];
  const live = new Set();
  for (const f of findings) {
    live.add(f.key);
    const prev = seen[f.key];
    if (!prev || prev.resolved) {
      seen[f.key] = { kind: f.kind, ref: f.ref, title: f.title, url: f.url, reason: f.reason, fix: f.fix, first: now, last: now, resolved: null };
      fresh.push(f);
    } else {
      seen[f.key] = { ...prev, last: now, title: f.title, reason: f.reason };
    }
  }
  const resolved = [];
  for (const [key, e] of Object.entries(seen)) {
    if (!e.resolved && !live.has(key)) { seen[key] = { ...e, resolved: now }; resolved.push({ key, ...seen[key] }); }
  }
  return { ledger: { seen }, fresh, resolved };
}

// One dated block per new edge case, one line per resolution — the document
// the process is corrected from (TICKETING.md §7).
export function ledgerMarkdown(fresh, resolved, at) {
  const out = [];
  for (const f of fresh) {
    out.push(`## ${at} — ${f.ref} off the board (${f.kind})`, '',
      `- **What:** ${f.title || '(no title)'}${f.detail ? ' — ' + f.detail : ''}${f.url ? ' — ' + f.url : ''}`,
      `- **Why it is off:** ${f.reason}`,
      `- **Fix:** ${f.fix}`,
      `- **Rule to fold in:** (fill in when the case is understood — TICKETING.md §7)`, '');
  }
  for (const r of resolved) out.push(`- ${at} — resolved: ${r.ref} (${r.kind}) is on the board again`, '');
  return out.join('\n');
}
