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

// The ticket's dependencies (TICKETING.md §2.4): every line that says
// "depends on" — "**Depends on:** #1523 (reason), #1524 (reason)", a later
// "**Dependency added:** also depends on #1521 — …" — yields the tickets it
// names; "depends on: none" yields nothing.
export function parseUnitDeps(body) {
  const out = new Set();
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!/\bdepends?\s+on\b/i.test(line)) continue;
    for (const m of line.matchAll(/#(\d{3,5})\b/g)) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

// A "depends on (merged)" line says an open PR head is not enough: the unit
// starts only once every dependency is merged or closed (the final browser
// sweep runs on the merged build).
export function parseUnitDepsMerged(body) {
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/\bdepends?\s+on\b/i.test(line) && /\(\s*merged\s*\)/i.test(line)) return true;
  }
  return false;
}

// The fleet registry (docs/FLEET.md): lanes are named lane-1…lane-N across
// every server while the folders on the servers may still carry older names.
// registry: { "host/folder": { name, server } }. A probed lane keeps its
// folder, takes the fleet name and server label, and is marked `fleet`; a lane
// the registry does not know is shown by its folder name, fleet: false.
export function fleetLane(registry, host, l) {
  const reg = registry?.[`${host}/${l.lane}`];
  return { ...l, folder: l.lane, lane: reg?.name || l.lane, server: reg?.server || null, fleet: Boolean(reg) };
}

// The same registry idea for CI runners (FLEET.md "CI slots"): a runner keeps
// its name, takes the slot name (ci-slot-N) and its server label.
export function fleetSlot(registry, r) {
  const reg = registry?.[String(r?.name ?? '')];
  return { ...r, slot: reg?.name || r.name, server: reg?.server || null, fleet: Boolean(reg) };
}

function laneNo(name) {
  const m = /(\d+)/.exec(String(name ?? ''));
  return m ? Number(m[1]) : 999;
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

// The PR's own "Closes #N" shuts the ticket in the same second as the merge —
// that is not an acceptance, it is GitHub. A ticket closed later than this
// window after the merge (a person, after the acceptance run — for a rollout
// unit that is the production probe), or closed with no merge at all (dropped,
// or done by hand), is accepted: the unit is done. Merged and not accepted is
// QA. An auto-closed ticket is accepted by reopening it and closing it again.
const AUTO_CLOSE_WINDOW_MS = 2 * 60 * 1000;
function acceptedAt(u, at = null) {
  if (u.open || !u.closedAt) return null;
  if (u.merged?.mergedAt) {
    const gap = Date.parse(u.closedAt) - Date.parse(u.merged.mergedAt);
    return Number.isFinite(gap) && gap > AUTO_CLOSE_WINDOW_MS ? u.closedAt : null;
  }
  // No merge known. A close seconds old is more likely the PR's auto-close
  // seen before the merged-PR source caught up than a person's word — the
  // issue list refreshes faster than the merged list, and a card that reached
  // done that way never came back (U4, U6 on 29.08). Give the merged source
  // the same window before a close with no PR behind it counts.
  const age = at ? Date.parse(at) - Date.parse(u.closedAt) : NaN;
  if (Number.isFinite(age) && age < AUTO_CLOSE_WINDOW_MS) return null;
  return u.closedAt;
}

function unitState(u) {
  if (u.accepted) return 'accepted';
  if (u.merged) return 'merged';
  if (u.pr) {
    if (u.pr.verdict?.go === false) return 'pr no-go';
    if (u.pr.verdict?.go === true) return 'pr go';
    if (u.pr.ci?.color === 'green') return 'pr green';
    if (u.pr.ci?.color === 'red') return 'pr red';
    return 'pr open';
  }
  if (u.lane?.check) return 'local check';
  if (u.lane?.busy) return 'on lane';
  if (u.lane) return 'lane idle';
  if (!u.open) return 'closed';
  return u.qa ? 'open' : 'queued';
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

// lanes: [{ host, lane, busy, since, branch, task, check }] from every host —
//   check = the project's local check running on that lane right now
//   ({ pid, since, cmd }), else null/absent;
// ciJobs: Map(PR number -> [{ workflow, job, status, runner, startedAt }]) for PRs whose CI runs;
// ciRunners: the repo's self-hosted runners [{ name, status, busy, labels }];
// prs / mergedPrs: [{ number, url, branch, ci?, draft?, mergedAt? }];
// umbrellaStates: Map(umbrella number -> 'OPEN' | 'CLOSED') from the same issue
//   list, or null when unknown — a sprint is done only once its umbrella is closed;
// unitIssues: Map(umbrella number -> [{ number, title, url, state, closedAt, branch, deps, labels, qa }]) —
//   deps = the ticket numbers the unit's body says it depends on (parseUnitDeps);
//   qa = the issue carries the `qa` label: a QA ticket (the findings a sprint's
//   reviews left behind), listed apart from the work units as `qaTickets`.
// Returns Map(card id -> sprint) for every card whose ticket link is an umbrella.
export function sprintFactsFor(cards, { lanes = [], prs = [], mergedPrs = [], unitIssues = new Map(), ciJobs = new Map(), ciRunners = [], umbrellaStates = null, staleSources = [], at = null } = {}) {
  const out = new Map();
  const ciSlots = ciSlotSummary(ciRunners);
  for (const card of cards ?? []) {
    // A unit card links its own ticket, which other units may reference
    // ("depends on #1517") — that is not an umbrella.
    if (card?.parent) continue;
    const umbrella = umbrellaOf(card?.links?.ticket);
    if (!umbrella) continue;
    const units = (unitIssues.get(umbrella) ?? []).map(i => {
      const labels = Array.isArray(i.labels) ? i.labels.map(String) : [];
      const lowerLabels = labels.map(label => label.toLowerCase());
      const qaRun = lowerLabels.includes('qa-run');
      const qa = Boolean(i.qa) || qaRun || lowerLabels.includes('qa');
      return {
        unit: qa ? 'QA' : unitLabel(i.title),
        qa,
        ticket: i.number,
        title: i.title ?? '',
        url: i.url ?? '',
        branch: normBranch(i.branch) || `feat/${i.number}`,
        labels,
        open: String(i.state ?? 'OPEN').toUpperCase() !== 'CLOSED',
        closedAt: i.closedAt ?? null,
        depTickets: (Array.isArray(i.deps) ? i.deps : []).map(Number).filter(Number.isFinite),
        depsMerged: Boolean(i.depsMerged) || qaRun,
        deps: [],
        lane: null,
        pr: null,
        merged: null,
        state: 'queued',
      };
    });
    units.sort((a, b) => unitOrder(a) - unitOrder(b) || a.ticket - b.ticket);
    const byTicket = new Map(units.map(u => [u.ticket, u]));
    // Several tickets may pin one branch (one PR closing three QA findings):
    // the lane building that branch belongs to each of them, not to the last
    // one the map happened to keep.
    const byBranch = new Map();
    for (const u of units) {
      if (!u.branch) continue;
      if (!byBranch.has(u.branch)) byBranch.set(u.branch, []);
      byBranch.get(u.branch).push(u);
    }

    for (const l of lanes) {
      let hits = [];
      const branch = normBranch(l.branch);
      // The TASK file names the ticket the codex is reading right now — the
      // strongest evidence; the checked-out branch can be a leftover.
      if (l.task) {
        const m = /TASK-(\d{3,5})\b/.exec(String(l.task));
        if (m && byTicket.has(Number(m[1]))) hits = [byTicket.get(Number(m[1]))];
      }
      if (!hits.length && branch && byBranch.has(branch)) hits = byBranch.get(branch);
      if (!hits.length) continue;
      const rec = {
        host: l.host, lane: l.lane, busy: Boolean(l.busy), since: l.since ?? null,
        branch: branch || null, task: l.task ?? null, check: l.check ?? null,
        folder: l.folder ?? null, server: l.server ?? null, fleet: l.fleet !== false,
      };
      // A busy lane beats an idle one still parked on the unit's branch.
      for (const u of hits) if (!u.lane || (rec.busy && !u.lane.busy)) u.lane = rec;
    }

    for (const u of units) {
      if (u.branch) {
        const open = prs.find(p => sameBranch(p.branch, u.branch));
        if (open) {
          // headSha: the commit a dependent unit starts from (auto-dispatch).
          u.pr = { number: open.number, url: open.url ?? '', ci: open.ci ?? null, draft: Boolean(open.draft), headSha: open.headSha ?? null, verdict: open.verdict ?? null };
          // Where the check runs: the first job in progress (else queued) names
          // its runner — the CI slot — and the server behind it.
          const jobs = ciJobs.get(open.number) ?? [];
          const live = jobs.find(j => j.status === 'in_progress') ?? jobs.find(j => j.status === 'queued') ?? null;
          if (live) {
            const reg = ciRunners.find(r => r.name === live.runner);
            u.pr.runner = {
              name: live.runner || '',
              slot: reg?.slot || live.runner || '',
              server: reg?.server || '',
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
      u.accepted = acceptedAt(u, at);
      u.state = unitState(u);
    }
    // Dependencies resolved against the sprint's own units, so a card can say
    // "waits for U9 #1527 (pr red)" — met once the dependency is merged or its
    // ticket closed; a ticket outside this sprint stays unresolved (met: null).
    for (const u of units) {
      u.deps = u.depTickets.map(n => {
        const d = byTicket.get(n);
        return d
          ? { ticket: n, unit: d.unit, state: d.state, met: Boolean(d.merged || !d.open) }
          : { ticket: n, unit: '', state: 'outside the sprint', met: null };
      });
      delete u.depTickets;
    }

    // Every CI runner as one row: the slot (FLEET.md name), its server, whether
    // it is online and busy, and which PR — which unit of this sprint — its
    // job is running. Fleet slots first, by number.
    const ciTable = (ciRunners ?? []).map(r => {
      let pr = null, job = null;
      for (const [n, jobs] of ciJobs ?? new Map()) {
        const j = (jobs ?? []).find(x => x.runner === r.name && (x.status === 'in_progress' || x.status === 'queued'));
        if (j) { pr = Number(n); job = j.job ?? ''; break; }
      }
      const u = pr != null ? units.find(x => x.pr?.number === pr) : null;
      return {
        name: r.name, slot: r.slot || r.name, server: r.server || runnerHost(r.name, ciRunners) || '', fleet: r.fleet !== false,
        online: r.status === 'online', busy: Boolean(r.busy), pr, job, unit: u?.unit ?? null, ticket: u?.ticket ?? null,
      };
    }).sort((a, b) => Number(b.fleet) - Number(a.fleet) || laneNo(a.slot) - laneNo(b.slot) || String(a.name).localeCompare(String(b.name)));

    const bound = units.filter(u => u.lane).map(u => ({ ...u.lane, ticket: u.ticket, unit: u.unit }));
    const isBound = l => bound.some(x => x.host === l.host && x.lane === l.lane);
    const isBoundToUnmerged = l => units.some(u => u.lane && !u.merged && u.lane.host === l.host && u.lane.lane === l.lane);
    const name = l => `${l.host}/${l.lane}`;
    // Capacity is the fleet (FLEET.md): once a registry names lanes, only those
    // count as free; a lane outside it is still listed, but not as capacity.
    const inFleet = lanes.some(l => l.fleet === true) ? lanes.filter(l => l.fleet === true) : lanes;
    // Every lane as one row for the sprint band: who is on it, by facts.
    const laneTable = lanes.map(l => {
      const b = bound.find(x => x.host === l.host && x.lane === l.lane);
      return {
        host: l.host, lane: l.lane, folder: l.folder ?? null, server: l.server ?? null, fleet: l.fleet !== false,
        busy: Boolean(l.busy), state: l.state ?? null, since: l.since ?? null, branch: normBranch(l.branch) || null,
        check: Boolean(l.check), hostOk: l.hostOk !== false, remembered: Boolean(l.remembered),
        unit: b?.unit ?? null, ticket: b?.ticket ?? null,
      };
    }).sort((a, b) => Number(b.fleet) - Number(a.fleet) || laneNo(a.lane) - laneNo(b.lane) || String(a.host).localeCompare(String(b.host)));
    // QA tickets are not scope: they stand apart from the units and their
    // progress bar, and hold the sprint in QA while one is open.
    const qaTickets = units.filter(u => u.qa);
    const work = units.filter(u => !u.qa);
    out.set(card.id, {
      umbrella,
      umbrellaOpen: umbrellaStates instanceof Map && umbrellaStates.has(umbrella) ? umbrellaStates.get(umbrella) === 'OPEN' : null,
      units: work,
      qaTickets,
      lanes: bound,
      laneTable,
      ciTable,
      laneCount: inFleet.length,
      free: inFleet.filter(l => !l.busy && !isBoundToUnmerged(l)).map(name),
      busyElsewhere: lanes.filter(l => l.busy && !isBound(l)).map(name),
      ciSlots,
      counts: {
        units: work.length,
        onLane: work.filter(u => u.state === 'on lane').length,
        checking: work.filter(u => u.state === 'local check').length,
        pr: work.filter(u => u.pr && !u.merged).length,
        merged: work.filter(u => u.merged).length,
        accepted: work.filter(u => u.accepted).length,
        queued: work.filter(u => u.state === 'queued').length,
        qa: qaTickets.length,
        qaOpen: qaTickets.filter(u => u.open && !u.merged).length,
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
  return sprint.lanes.map(l => `${l.host}/${l.lane}${l.folder && l.folder !== l.lane ? ' (folder ' + l.folder + ')' : ''} ${l.unit ? l.unit + ' ' : ''}#${l.ticket}${l.busy ? '' : ' (idle)'}`)
    .join(', ');
}
