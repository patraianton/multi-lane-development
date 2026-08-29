# FLEET — lane and CI slot registry

The single reference for "which lanes and CI slots exist and where". Live
busy/free state is on the board (`/#pipeline`) or per server via
`hzlane status`; this file is the registry. Servers are listed as
**provider / server name** exactly as in the provider's panel; addresses and
keys live in the private ops annex.

**Keep it true:** any change to lanes, runners, or servers lands here in the
same commit or the same day.

Last verified: **2026-08-29** — cores counted AND single-core speed measured
(openssl sha256, same test everywhere).

## Servers

| Server | Cores | Single-core speed | Role |
|---|---|---|---|
| Hostinger / srv1487642 | 8 | 1 796 (fastest) | production services + 2 development lanes |
| Hetzner / codex-dev | 4 | 1 771 | development — 3 lanes |
| Hetzner / ci-runners-01 | 8 | 1 657 | PR checks — 3 slots (hzci-1…3) |
| Hetzner / autopase-ci | 16 | 212 — 8× slower per core | CI slots |
| Hetzner / autopase-scraper | — | — | production scraper |
| Mac mini | — | — | development — 3 lanes |

Speed is thousands of sha256 bytes/s on one core, bigger = faster. Builds and
checks are mostly single-core-bound, so per-core speed decides, not core
count — that is why gates on autopase-ci took 49 min vs 13 min on
ci-runners-01.

## Development lanes — as they are today (8)

| Lane today | Server | Notes |
|---|---|---|
| `lane-3` | Hetzner / codex-dev | 3 cores / 6 GB |
| `lane-4` | Hetzner / codex-dev | 3 cores / 6 GB |
| `lane-5` | Hetzner / codex-dev | 3 cores / 6 GB |
| `lane-5` | Hostinger / srv1487642 | fastest cores; production shares the box |
| `lane-6` | Hostinger / srv1487642 | fastest cores; production shares the box |
| `lane-a` | Mac mini | 16 GB shared, max 3 running |
| `lane-b` | Mac mini | 16 GB shared, max 3 running |
| `lane-c` | Mac mini | 16 GB shared, max 3 running |

After the current sprint lands, folders are renamed to one global sequence
(duplicate numbers and letters disappear): codex-dev → lane-1…3,
Hostinger → lane-4…5, Mac → lane-6…8. A running task's lane is never
renamed under it.

- Linux lanes are driven by `hzlane` (`hzlane status` shows busy/free); a Mac
  lane is a plain folder, busy = an agent process working in it (the board
  probes exactly this way).
- Lane reservation: a `<lane>.reserved` file next to the lane folder; only the
  CTO writes it.
- When a lane is freed, its copy returns to `main` and the finished branch is
  deleted if already pushed.

## CI slots (PR checks)

| Runner | Server | Labels | Notes |
|---|---|---|---|
| hzci-1 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | `pr-ci` targets `ci-fast` |
| hzci-2 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| hzci-3 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| ci-slot-4 | Hetzner / autopase-ci | to register | — |
| ci-slot-5 | Hetzner / autopase-ci | to register | — |

- CI never lands on a production machine. The Hostinger runners were removed
  2026-08-27 after gates next to production ran 15–18× slower and failed
  random PRs; registrations deleted 2026-08-29.
- If the CI server dies it is rebuilt from a snapshot.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.
