// A pipeline card whose links.ticket is an umbrella issue is a sprint: its
// units are the tickets that reference the umbrella, and each unit is bound to
// the lane that builds it and the PR that carries it — by facts only. The lane
// says which branch it has checked out (`hzlane status`, the Mac kitchen
// folders) or which TASK-<ticket> file its codex is reading; the PR says its
// head branch; the ticket says its pinned branch. Nobody announces "U5 is on
// lane-b" — the lane does.
//
// Pure functions: watchtower.mjs feeds them the live sources and hands the
// result to the pipeline (setCardSprints); tests feed them fixtures.

export function umbrellaOf(link) {
  const m = /\/issues\/(\d+)\b/.exec(String(link ?? ''));
  return m ? Number(m[1]) : null;
}

// "SALON-U5: migration 133" → "U5"; "U16 rollout" → "U16"; else ''.
export function unitLabel(title) {
  const m = /\bU(\d{1,3})\b/i.exec(String(title ?? ''));
  return m ? `U${Number(m[1])}` : '';
}

// The ticket's pinned branch (TICKETING.md §2.3): "**Branch:** `feat/…`" or a
// plain "Branch: feat/…" line. Empty when the body has none.
export function parseUnitBranch(body) {
  const text = String(body ?? '');
  let m = /\*\*Branch:?\*\*:?\s*`([^`\n]+)`/i.exec(text);
  if (!m) m = /^\s*(?:[-*]\s*)?Branch:\s*`?([\w./-]+)`?\s*$/im.exec(text);
  return m ? m[1].trim() : '';
}

function normBranch(b) {
  return String(b ?? '').trim().replace(/^refs\/heads\//, '');
}

function sameBranch(a, b) {
  const x = normBranch(a); const y = normBranch(b);
  return Boolean(x) && x === y;
}

function unitOrder(u) {
  const n = Number(String(u.unit).slice(1));
  return Number.isFinite(n) && u.unit ? n : 9999;
}

function unitState(u) {
  if (u.merged) return 'merged';
  if (u.pr) {
    if (u.pr.ci?.color === 'green') return 'pr green';
    if (u.pr.ci?.color === 'red') return 'pr red';
    return 'pr open';
  }
  if (u.lane?.busy) return 'on lane';
  if (u.lane) return 'lane idle';
  if (!u.open) return 'closed';
  return 'queued';
}

// Which server a CI runner belongs to: its GitHub labels name the host
// (hetzner, hostinger); otherwise the runner name without its number.
export function runnerHost(name, runners = []) {
  const r = runners.find(x => x.name === name);
  const labels = (r?.labels ?? []).map(l => String(l).toLowerCase());
  for (const h of ['hetzner', 'hostinger', 'mac']) if (labels.includes(h)) return h;
  return String(name ?? '').replace(/-\d+$/, '') || '';
}

// The CI slot pool in numbers: [{ name, status, busy, labels }] → totals per host.
export function ciSlotSummary(runners = []) {
  const byHost = {};
  let online = 0, busy = 0, offline = 0;
  for (const r of runners) {
    const host = runnerHost(r.name, runners) || 'ci';
    const h = byHost[host] ?? (byHost[host] = { total: 0, online: 0, busy: 0 });
    h.total += 1;
    if (r.status === 'online') { h.online += 1; online += 1; if (r.busy) { h.busy += 1; busy += 1; } }
    else offline += 1;
  }
  return { total: runners.length, online, busy, offline, byHost };
}

// lanes: [{ host, lane, busy, since, branch, task }] from every host;
// ciJobs: Map(PR number -> [{ workflow, job, status, runner, startedAt }]) for PRs whose CI runs;
// ciRunners: the repo's self-hosted runners [{ name, status, busy, labels }];
// prs / mergedPrs: [{ number, url, branch, ci?, draft?, mergedAt? }];
// unitIssues: Map(umbrella number -> [{ number, title, url, state, branch }]).
// Returns Map(card id -> sprint) for every card whose ticket link is an umbrella.
export function sprintFactsFor(cards, { lanes = [], prs = [], mergedPrs = [], unitIssues = new Map(), ciJobs = new Map(), ciRunners = [], staleSources = [], at = null } = {}) {
  const out = new Map();
  const ciSlots = ciSlotSummary(ciRunners);
  for (const card of cards ?? []) {
    // A unit card links its own ticket, which other units may reference
    // ("depends on #1517") — that is not an umbrella.
    if (card?.parent) continue;
    const umbrella = umbrellaOf(card?.links?.ticket);
    if (!umbrella) continue;
    const units = (unitIssues.get(umbrella) ?? []).map(i => ({
      unit: unitLabel(i.title),
      ticket: i.number,
      title: i.title ?? '',
      url: i.url ?? '',
      branch: normBranch(i.branch),
      open: String(i.state ?? 'OPEN').toUpperCase() !== 'CLOSED',
      lane: null,
      pr: null,
      merged: null,
      state: 'queued',
    }));
    units.sort((a, b) => unitOrder(a) - unitOrder(b) || a.ticket - b.ticket);
    const byTicket = new Map(units.map(u => [u.ticket, u]));
    const byBranch = new Map(units.filter(u => u.branch).map(u => [u.branch, u]));

    for (const l of lanes) {
      let u = null;
      const branch = normBranch(l.branch);
      // The TASK file names the ticket the codex is reading right now — the
      // strongest evidence; the checked-out branch can be a leftover.
      if (l.task) {
        const m = /TASK-(\d{3,5})\b/.exec(String(l.task));
        if (m && byTicket.has(Number(m[1]))) u = byTicket.get(Number(m[1]));
      }
      if (!u && branch && byBranch.has(branch)) u = byBranch.get(branch);
      if (!u) continue;
      const rec = {
        host: l.host, lane: l.lane, busy: Boolean(l.busy), since: l.since ?? null,
        branch: branch || null, task: l.task ?? null,
      };
      // A busy lane beats an idle one still parked on the unit's branch.
      if (!u.lane || (rec.busy && !u.lane.busy)) u.lane = rec;
    }

    for (const u of units) {
      if (u.branch) {
        const open = prs.find(p => sameBranch(p.branch, u.branch));
        if (open) {
          u.pr = { number: open.number, url: open.url ?? '', ci: open.ci ?? null, draft: Boolean(open.draft) };
          // Where the check runs: the first job in progress (else queued) names
          // its runner — the CI slot — and the server behind it.
          const jobs = ciJobs.get(open.number) ?? [];
          const live = jobs.find(j => j.status === 'in_progress') ?? jobs.find(j => j.status === 'queued') ?? null;
          if (live) {
            u.pr.runner = {
              name: live.runner || '',
              host: live.runner ? runnerHost(live.runner, ciRunners) : '',
              status: live.status,
              since: live.startedAt ?? null,
              job: live.job ?? '',
            };
          }
        }
        const merged = mergedPrs.find(p => sameBranch(p.branch, u.branch));
        if (merged) u.merged = { number: merged.number, url: merged.url ?? '', mergedAt: merged.mergedAt ?? null };
      }
      u.state = unitState(u);
    }

    const bound = units.filter(u => u.lane).map(u => ({ ...u.lane, ticket: u.ticket, unit: u.unit }));
    const isBound = l => bound.some(x => x.host === l.host && x.lane === l.lane);
    const name = l => `${l.host}/${l.lane}`;
    out.set(card.id, {
      umbrella,
      units,
      lanes: bound,
      laneCount: lanes.length,
      free: lanes.filter(l => !l.busy && !isBound(l)).map(name),
      busyElsewhere: lanes.filter(l => l.busy && !isBound(l)).map(name),
      ciSlots,
      counts: {
        units: units.length,
        onLane: units.filter(u => u.state === 'on lane').length,
        pr: units.filter(u => u.pr && !u.merged).length,
        merged: units.filter(u => u.merged).length,
        queued: units.filter(u => u.state === 'queued').length,
      },
      stale: [...staleSources],
      at,
    });
  }
  return out;
}

// One line for the agent views: "radar/lane-1 U2 #1517, mac/lane-b U5 #1519".
export function lanesLine(sprint) {
  if (!sprint) return '-';
  if (!sprint.lanes.length) return sprint.laneCount ? `none of ${sprint.laneCount} lanes` : 'no lanes known';
  return sprint.lanes.map(l => `${l.host}/${l.lane} ${l.unit ? l.unit + ' ' : ''}#${l.ticket}${l.busy ? '' : ' (idle)'}`)
    .join(', ');
}
