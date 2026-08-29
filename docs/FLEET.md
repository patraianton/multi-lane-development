# FLEET — lane and CI slot registry

The single reference for "which lanes and CI slots exist and where". Answering
"what lanes do we have?" starts HERE, not with probing servers. Live busy/free
state is on the board (`/#pipeline` sprint band) or per host via `hzlane status`;
this file is the registry: what exists, where, and under what name.

This repo is public: hosts appear by NAME only. Addresses, ssh targets, and
keys live in the private annex (`autopase-ops/INFRA.md`), keyed by the same
host names.

**Keep it true:** any change to lanes, runners, or hosts lands here in the same
commit or the same day. A registry that lags becomes worse than no registry.

Last verified against the live hosts: **2026-08-29**.

## Development lanes (10)

One global sequence — "lane 4" means exactly one place. The "on disk today"
column shows the legacy folder name until the renumbering batch lands (queued
for right after the current sprint; a running task's lane is never renamed
under it).

| Lane | Host | On disk today | Tooling | Caps |
|---|---|---|---|---|
| lane-1 | builder-1 | `lane-3` | `hzlane` | 3 cores / 6 GB |
| lane-2 | builder-1 | `lane-4` | `hzlane` | 3 cores / 6 GB |
| lane-3 | builder-1 | `lane-5` | `hzlane` | 3 cores / 6 GB |
| lane-4 | builder-2 | `lane-1` | `hzlane` | 3 cores / 6 GB |
| lane-5 | builder-2 | `lane-2` | `hzlane` | 3 cores / 6 GB |
| lane-6 | apps-1 | `lane-5` | `hzlane` | shares host with production |
| lane-7 | apps-1 | `lane-6` | `hzlane` | shares host with production |
| lane-8 | mac | `lane-a` | kitchen `~/kitchens/autopase.lv` | 16 GB shared, max 3 agents |
| lane-9 | mac | `lane-b` | kitchen | 16 GB shared, max 3 agents |
| lane-10 | mac | `lane-c` | kitchen | 16 GB shared, max 3 agents |

- `hzlane` hosts: status via `hzlane status` on the host. The Mac has no
  `hzlane`: a lane is a folder, busy = a `codex exec`/`claude` process working
  in it (the board probes exactly this way).
- Reservation: a `<lane>.reserved` file next to the lane dir; only the CTO
  writes it.
- **apps-1 lanes are reserve capacity.** That host runs production (scraper,
  copilot gateway, sister-project services) — use its lanes last, never for
  anything CPU-hungry alongside a scraper run.
- When a lane is freed, its copy returns to `main` and the finished branch is
  deleted if already pushed (rule announced in the sprint umbrella 2026-08-29;
  automation lands with the renumbering batch).

## CI slots (PR checks, 7)

| Slot | Runner | Host | Labels | Role |
|---|---|---|---|---|
| cipr-1 | hzci-1 | cipr-1 | `ci-fast`, `vps1` | primary — `pr-ci` targets `ci-fast` (PR #1543) |
| cipr-2 | hzci-2 | cipr-1 | `ci-fast`, `vps1` | primary |
| cipr-3 | hzci-3 | cipr-1 | `ci-fast`, `vps1` | primary |
| reserve-1 | radar-runner-1 | builder-2 | `vps1`, `hetzner` | reserve pool |
| reserve-2 | radar-runner-2 | builder-2 | `vps1`, `hetzner` | reserve pool |
| reserve-3 | radar-runner-3 | builder-2 | `vps1`, `hetzner` | reserve pool |
| reserve-4 | radar-runner-4 | builder-2 | `vps1`, `hetzner` | reserve pool |

- The "Runner" column is the registered GitHub runner name today; runners get
  re-registered under their slot names (`cipr-N`, `reserve-N`) in the
  renumbering batch.
- **No CI on apps-1, ever.** Its runners were removed 2026-08-27 after they ran
  gates 15–18× slower (production owns the cores) and failed random PRs; the
  dead runner registrations were deleted 2026-08-29.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.

## Hosts

| Host | Provider console name today | Role |
|---|---|---|
| builder-1 | codex-dev | development lanes |
| builder-2 | autopase-ci | development lanes + reserve CI |
| cipr-1 | ci-runners-01 | PR checks only |
| apps-1 | (Hostinger VPS) | production services + 2 reserve lanes |
| mac | Mac mini | development lanes (Codex bridge) |

Console renames are cosmetic (everything connects by address, kept in the
private annex) and are done by the owner in the provider panels.
