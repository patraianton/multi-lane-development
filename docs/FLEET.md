# FLEET — lane and CI slot registry

The single reference for "which lanes and CI slots exist and where". Live
busy/free state is on the board (`/#pipeline`) or per server via
`hzlane status` (Linux) / `maclane status` (Mac); this file is the registry.
Servers are listed as **provider / server name** exactly as in the provider's
panel; addresses and keys live in the private ops annex.

**Keep it true:** any change to lanes, runners, or servers lands here in the
same commit or the same day.

Last verified: **2026-08-29** — cores counted AND single-core speed measured
(openssl sha256, same test everywhere); lanes renumbered and autopase-ci
lanes retired the same day, every row below checked live.

## Servers

| Server | Cores | Single-core speed | Role |
|---|---|---|---|
| Hostinger / srv1487642 | 8 | 1 796 (fastest) | production services + 2 development lanes |
| Hetzner / codex-dev | 4 | 1 771 | development — 3 lanes |
| Hetzner / ci-runners-01 | 8 | 1 657 | PR checks — 3 slots (hzci-1…3) |
| Hetzner / autopase-ci | 16 | 212 — 8× slower per core | CI slots — 2 (hzci-4, hzci-5); no lanes since 2026-08-29 |
| Hetzner / autopase-scraper | — | — | production scraper |
| Mac mini | 10 | — | development — 3 lanes |

Speed is thousands of sha256 bytes/s on one core, bigger = faster. Builds and
checks are mostly single-core-bound, so per-core speed decides, not core
count — that is why gates on autopase-ci took 49 min vs 13 min on
ci-runners-01.

## Development lanes (8)

Folder on the server = `lane-<N>` under the kitchen (`/root/kitchens/autopase.lv`
on Linux, `~/kitchens/autopase.lv` on the Mac). Names match this table since
2026-08-29.

| Lane | Server | Launcher | Limits |
|---|---|---|---|
| lane-1 | Hetzner / codex-dev | `hzlane 1` | 6 GB memory, no core cap |
| lane-2 | Hetzner / codex-dev | `hzlane 2` | 6 GB memory, no core cap |
| lane-3 | Hetzner / codex-dev | `hzlane 3` | **light lane: 2.5 GB, no builds** (`pnpm build` dies) — tests and small edits only |
| lane-4 | Hostinger / srv1487642 | `hzlane 4` | 3 cores / 6 GB, nice 5 — production shares the box |
| lane-5 | Hostinger / srv1487642 | `hzlane 5` | 3 cores / 6 GB, nice 5 — production shares the box |
| lane-6 | Mac mini | `maclane 6` | 16 GB shared, max 3 running |
| lane-7 | Mac mini | `maclane 7` | 16 GB shared, max 3 running |
| lane-8 | Mac mini | `maclane 8` | 16 GB shared, max 3 running |

- Linux lanes are driven by `hzlane` (`hzlane status` shows busy/free, busy =
  the `codex-lane-N` systemd scope is active). Mac lanes are driven by
  `maclane` (busy = the pid in `reports/lane-N.pid` is alive; the board probes
  for an agent process working in the folder, so a lane started by hand is
  seen as busy too).
- One gate at a time per Linux server: the local check takes
  `flock /opt/autopase-ci-local.lock`, so three lanes on codex-dev share one gate.
- Lane reservation: a `<lane>.reserved` file next to the lane folder; only the
  CTO writes it.
- When a task ends, the launcher runs `lane-free-cleanup`: if the branch is
  pushed and the tree is clean, the copy returns to `main` and the local
  branch is deleted; unpushed or dirty work is left in place. The remote
  branch is never touched.

## CI slots (PR checks)

| Slot | Runner | Server | Labels | Notes |
|---|---|---|---|---|
| ci-slot-1 | hzci-1 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | `pr-ci` targets `ci-fast` |
| ci-slot-2 | hzci-2 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| ci-slot-3 | hzci-3 | Hetzner / ci-runners-01 | `ci-fast`, `vps1` | — |
| ci-slot-4 | hzci-4 | Hetzner / autopase-ci | `vps1`, `hetzner` | registered 2026-08-29; no core cap, 8 GB swap added |
| ci-slot-5 | hzci-5 | Hetzner / autopase-ci | `vps1`, `hetzner` | registered 2026-08-29 |

- Who needs which label: `pr-ci` → `ci-fast`; `nightly-quality` → `vps1` (any
  slot); `garage-osm-import`, the `daily-health` disk check and
  `vps1-maintenance` → `hetzner` (slots 4–5 only). Without slots 4–5 those
  three queue forever — that is why autopase-ci keeps two slots even though
  its cores are slow.
- CI never lands on a production machine. The Hostinger runners were removed
  2026-08-27 after gates next to production ran 15–18× slower and failed
  random PRs; registrations deleted and runner folders/units purged
  2026-08-29. The `hostinger` matrix leg in `daily-health` / `vps1-maintenance`
  is being dropped from the workflows.
- If the CI server dies it is rebuilt from a snapshot.
- Old PR branches may still pin `runs-on: [self-hosted, vps1]` — that label
  stays on every live runner.
