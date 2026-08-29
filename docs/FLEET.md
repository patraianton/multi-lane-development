# FLEET — lane and CI slot registry

The single reference for "which lanes and CI slots exist and where". Answering
"what lanes do we have?" starts HERE, not with probing servers. Live busy/free
state is on the board (`/#pipeline` sprint band) or per server via
`hzlane status`; this file is the registry: what exists and where.

Servers are listed as **provider / server name** exactly as named in the
provider's panel. Addresses, ssh targets, and keys live in the private ops
annex, keyed by the same names.

**Keep it true:** any change to lanes, runners, or servers lands here in the
same commit or the same day. A registry that lags becomes worse than no
registry.

Last verified against the live servers: **2026-08-29**.

## Development lanes (10)

One global sequence — "lane 4" means exactly one place. Folders on the servers
still carry the old per-server names; they are renamed to the global numbers
right after the current sprint lands (a running task's lane is never renamed
under it).

| Lane | Server | Folder on the server today | Limits |
|---|---|---|---|
| lane-1 | Hetzner / codex-dev | `lane-3` | 3 cores / 6 GB |
| lane-2 | Hetzner / codex-dev | `lane-4` | 3 cores / 6 GB |
| lane-3 | Hetzner / codex-dev | `lane-5` | 3 cores / 6 GB |
| lane-4 | Hetzner / autopase-ci | `lane-1` | 3 cores / 6 GB |
| lane-5 | Hetzner / autopase-ci | `lane-2` | 3 cores / 6 GB |
| lane-6 | Hostinger / srv1487642 | `lane-5` | shares the server with production |
| lane-7 | Hostinger / srv1487642 | `lane-6` | shares the server with production |
| lane-8 | Mac mini | `lane-a` | 16 GB shared, max 3 agents |
| lane-9 | Mac mini | `lane-b` | 16 GB shared, max 3 agents |
| lane-10 | Mac mini | `lane-c` | 16 GB shared, max 3 agents |

- On the Linux servers lanes are driven by the `hzlane` tool (`hzlane status`
  shows busy/free); on the Mac a lane is a plain folder, busy = an agent
  process working in it (the board probes exactly this way).
- Reservation: a `<lane>.reserved` file next to the lane folder; only the CTO
  writes it.
- **Hostinger lanes are reserve capacity.** That server runs production
  services — use its lanes last, never for anything CPU-hungry.
- When a lane is freed, its copy returns to `main` and the finished branch is
  deleted if already pushed (rule announced 2026-08-29; automation lands with
  the renaming batch).

## CI slots (PR checks, 7)

| Runner | Server | Labels | Role |
|---|---|---|---|
| hzci-1 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | primary — `pr-ci` targets `ci-fast` |
| hzci-2 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | primary |
| hzci-3 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | primary |
| radar-runner-1 | Hetzner / autopase-ci | `vps1`, `hetzner` | reserve |
| radar-runner-2 | Hetzner / autopase-ci | `vps1`, `hetzner` | reserve |
| radar-runner-3 | Hetzner / autopase-ci | `vps1`, `hetzner` | reserve |
| radar-runner-4 | Hetzner / autopase-ci | `vps1`, `hetzner` | reserve |

- **No CI on the Hostinger server, ever.** Its runners were removed 2026-08-27
  after they ran gates 15–18× slower (production owns the cores) and failed
  random PRs; the dead runner registrations were deleted 2026-08-29.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.

## Servers

| Server | Role |
|---|---|
| Hetzner / codex-dev | development lanes |
| Hetzner / autopase-ci | development lanes + reserve CI runners |
| Hetzner / ci-runners-01 | PR checks only |
| Hetzner / autopase-scraper | production scraper — no lanes, no CI |
| Hostinger / srv1487642 | production services + 2 reserve lanes |
| Mac mini | development lanes (Codex bridge) |
