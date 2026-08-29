# FLEET — lane and CI slot registry

The single reference for "which lanes and CI slots exist and where". Live
busy/free state is on the board (`/#pipeline`) or per server via
`hzlane status`; this file is the registry. Servers are listed as
**provider / server name** exactly as in the provider's panel; addresses and
keys live in the private ops annex.

**Keep it true:** any change to lanes, runners, or servers lands here in the
same commit or the same day.

Last verified against the live servers: **2026-08-29** (cores measured).

## Servers — one machine, one role, fully used

| Server | Cores / RAM | Role |
|---|---|---|
| Hetzner / autopase-ci | 16 / 30 GB | development — 5 lanes × 3 cores / 6 GB (15 of 16 cores allocated) |
| Hetzner / ci-runners-01 | 8 / 15 GB | PR checks — 3 slots (hzci-1…3) |
| Hetzner / autopase-scraper | — | production scraper |
| Hostinger / srv1487642 | 8 / 32 GB | production services (scraper jobs, copilot gateway, sister project). After production moves to the new hosting, this box becomes the CI machine and ci-runners-01 is cancelled |
| Hetzner / codex-dev | 4 / 7 GB | finishes the current sprint, then the server is cancelled (it was a stop-gap bought while the 16-core box was clogged with CI runners) |
| Mac mini | 16 GB RAM | development — 3 lanes |

No "reserve" machines: every box has a paying job.

## Development lanes (target: 8)

One global sequence — "lane 4" means exactly one place. "Folder today" is the
current name on disk; folders are renamed/created in one batch right after the
current sprint lands (a running task's lane is never touched).

| Lane | Server | Folder today | Per lane |
|---|---|---|---|
| lane-1 | Hetzner / autopase-ci | `lane-1` | 3 cores / 6 GB |
| lane-2 | Hetzner / autopase-ci | `lane-2` | 3 cores / 6 GB |
| lane-3 | Hetzner / autopase-ci | created in the batch | 3 cores / 6 GB |
| lane-4 | Hetzner / autopase-ci | created in the batch | 3 cores / 6 GB |
| lane-5 | Hetzner / autopase-ci | created in the batch | 3 cores / 6 GB |
| lane-6 | Mac mini | `lane-a` | shares 16 GB, max 3 running |
| lane-7 | Mac mini | `lane-b` | shares 16 GB, max 3 running |
| lane-8 | Mac mini | `lane-c` | shares 16 GB, max 3 running |

Removed in the same batch: the 3 folders on codex-dev (server cancelled after
the sprint) and the 2 lanes on Hostinger (that server does production, not
development).

- Linux lanes are driven by `hzlane` (`hzlane status` shows busy/free); a Mac
  lane is a plain folder, busy = an agent process working in it (the board
  probes exactly this way).
- Reservation of a lane: a `<lane>.reserved` file next to the lane folder;
  only the CTO writes it.
- When a lane is freed, its copy returns to `main` and the finished branch is
  deleted if already pushed.

## CI slots (PR checks)

| Runner | Server | Labels | Role |
|---|---|---|---|
| hzci-1 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | `pr-ci` targets `ci-fast` |
| hzci-2 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| hzci-3 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| radar-runner-1…4 | Hetzner / autopase-ci | `vps1`, `hetzner` | removed in the after-sprint batch (the box becomes dev-only) |

- CI never lands on a build or production machine. The Hostinger runners were
  removed 2026-08-27 after gates ran 15–18× slower next to production and
  failed random PRs; registrations deleted 2026-08-29.
- If the CI server dies it is rebuilt from a snapshot.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.
