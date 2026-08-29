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

| Lane | Host | Tooling | Caps |
|---|---|---|---|
| lane-3, lane-4, lane-5 | builder-1 | `hzlane` | 3 cores / 6 GB each |
| lane-1, lane-2 | builder-2 | `hzlane` | 3 cores / 6 GB each |
| lane-5, lane-6 | apps-1 | `hzlane` | shares host with production |
| lane-a, lane-b, lane-c | mac | kitchen `~/kitchens/autopase.lv` | 16 GB total, max 3 agents |

- `hzlane` hosts: status via `hzlane status` on the host. The Mac has no
  `hzlane`: a lane is a folder, busy = a `codex exec`/`claude` process working
  in it (the board probes exactly this way).
- Reservation: a `<lane>.reserved` file next to the lane dir; only the CTO
  writes it.
- **apps-1 lanes are reserve capacity.** That host runs production (scraper,
  copilot gateway, sister-project services) — use its lanes last, never for
  anything CPU-hungry alongside a scraper run.

## CI slots (PR checks, 7)

| Runner | Host | Labels | Role |
|---|---|---|---|
| hzci-1..3 | cipr-1 | `ci-fast`, `vps1` | primary — `pr-ci` targets `ci-fast` (PR #1543) |
| radar-runner-1..4 | builder-2 | `vps1`, `hetzner` | reserve pool |

- **No CI on apps-1, ever.** Its runners were removed 2026-08-27 after they ran
  gates 15–18× slower (production owns the cores) and failed random PRs; the
  dead runner registrations were deleted 2026-08-29.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.

## Naming (owner's scheme, 2026-08-29)

Builders are called builder, PR-check machines cipr, numbered; lanes get one
global sequence so "lane 4" means exactly one place. The table above already
uses the target host names; console renames are cosmetic and done by the owner
in the provider panels. Lane renumbering happens after the current sprint
lands:

| Host | Lanes after renumbering |
|---|---|
| builder-1 | lane-1, lane-2, lane-3 |
| builder-2 | lane-4, lane-5 |
| apps-1 | lane-6, lane-7 |
| mac | lane-8, lane-9, lane-10 |
| cipr-1 | — (CI only) |

Also queued for the same batch (announced in the sprint umbrella, 2026-08-29):
when a lane is freed, its copy returns to `main` and the finished branch is
deleted if already pushed — a leftover branch on a free lane reads as work.
