// Everything that is being built lives on the board (decision 14). This
// module finds what does not: an open PR no card carries, a ticket in work
// that references no umbrella (so no card was spawned), a busy lane building
// a branch no card carries. Each finding names the fix. The server runs it
// every sprint sweep and shows the findings on the page and in /api/pipeline.
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
        : 'a ticket in work that references no umbrella — the board only spawns cards for tickets that say Part of #<umbrella> (body or comment)',
      fix: 'write Part of #<umbrella> into the ticket; an after-sprint fix gets the qa label as well — TICKETING.md §7',
    });
  }

  // A ticket in work that IS on the board but pins no branch: the board binds
  // a lane and a PR to a card only through the ticket's pinned branch, so the
  // card never moves while the code is being written (TICKETING.md §2.3).
  for (const i of issues ?? []) {
    if (!isWorkTicket(i) || !tickets.has(Number(i.number))) continue;
    if (normBranch(i.branch)) continue;
    findings.push({
      kind: 'ticket', key: `issue-branch:${i.number}`, ref: `#${i.number}`, title: String(i.title ?? ''), url: i.url ?? '',
      detail: i.qa ? 'label qa · no pinned branch' : 'no pinned branch',
      reason: 'a ticket in work with no pinned branch — the board cannot bind its lane or PR, so its card never leaves ticketed while the code is written',
      fix: 'add a "**Branch:** `feat/…`" line to the ticket body (TICKETING.md §2.3) — the exact branch the lane builds and the PR carries',
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
