# Watchtower

A live board for a coding-agent fleet, and a delivery pipeline those agents run.

The page has two views, served by one process (`bin/watchtower.mjs`):

- **Windows** — the original monitoring board. Every herdr window on a chosen project: what the agent is doing, which build lane is compiling, which pull requests are open and what CI says, and — first column, always — who is waiting for a human.
- **Pipeline** — persistent **cards** in the board's own state. A founder writes a spec; the card then moves spec → grilled → ticketed → development → local check → CI/PR → done, while live data (windows, lanes, branches, PRs) attaches to it.

A **card** is not a herdr **window**. Windows are evidence of work; cards are the work items. Terms are pinned in [`CONTEXT.md`](CONTEXT.md).

This repository grew from the windows board through waves A–G (pipeline store, remote board, sign-in, Telegram, CTO hooks, execution stages, Watchdog). The contracts live under [`docs/`](docs/). This README describes the code and those contracts as they stand. It does not claim a production run or a production test.

---

## Pipeline stages

A card sits in one stage at a time. The road is one-way:

`spec → grilled → ticketed → development → local_check → ci_pr → done`

| Stage | Meaning |
| --- | --- |
| `spec` | A founder has written what is wanted; nothing is decided yet |
| `grilled` | The CTO has interrogated the spec and folded the answers back in |
| `ticketed` | The CTO is writing the GitHub tickets — one per work unit — before any development starts |
| `development` | Code is being written on the assigned lane |
| `local_check` | The local check runs on the same lane |
| `ci_pr` | A pull request is open and CI runs on an assigned slot |
| `done` | Terminal; the PR is merged, the card is finished |
| `stuck` | Three failures in a row — a human has to look |

`ticketed` records the phase between the grill and the code: the CTO writes the GitHub tickets (one per work unit) there, and the board refuses `ticketed → development` until the card carries a `links.ticket`. Entering `ticketed` from `grilled` requires the linked review artifact, if there is one, to be marked answered — the board marks it itself when founder answers appear ([`docs/GRILL.md`](docs/GRILL.md) §2).

A **sprint** — a card whose `links.ticket` is an umbrella issue — splits into **unit cards** once it has left `grilled` and its unit tickets exist: one card per ticket, bound to the sprint, moved by facts alone (busy lane → `development`, the lane running the project's local check → `local_check`, PR open → `ci_pr`, PR merged → `done`). The sprint card then leaves the columns for the **sprint band** above them, and its own stage follows the units: `development` once any unit has started, `done` once every unit is merged or closed. Details: [`docs/API.md`](docs/API.md) (Unit cards).

`stuck` is not a step of the road. A **failure** (`local`, `ci`, or `review`) sends the card back to `development` and raises that kind's counter plus `consecutiveFails`. The third consecutive failure sends it to `stuck` instead. A failure can only be reported from a stage where something actually ran (`development`, `local_check`, `ci_pr`). From `spec`, `grilled` or `ticketed` it is a 400: nothing has been built yet.

A successful step along the road resets `consecutiveFails` to zero. So does a human pulling the card out of `stuck` (`POST /pipeline/card/unstuck`).

Each card keeps spec text, flat comments, links (`ticket`, `branch`, `pr`, `artifact`), lane, subscription, slot, per-stage clocks, and failure counters in `state/pipeline-cards.json`. The **clock** on the list is delivery time: every segment except `done`, which is terminal — a finished card shows `(stopped)`.

**Status** is a different field: a one-line "what is happening right now", written by the Watchdog, with a verdict `moving` / `stalled` / `looping`. It is not the stage.

How a card is created, moved, failed, commented, and updated: [`docs/API.md`](docs/API.md).

---

## Moving parts

Each piece is a small Node process with no extra packages. Development-launch, local-check and CI-slot default to dry-run: they only ssh, call `gh`, or POST when you pass `--run`.

| Piece | Process | What it does |
| --- | --- | --- |
| **Board server** | `bin/watchtower.mjs` | Serves the page, `/api/*`, pipeline mutations, probe endpoints, and the hook queue. Listens on `127.0.0.1:4878`. |
| **Probe** | `bin/probe.mjs` | Runs on the owner's machine, next to herdr. Every `intervalSec` seconds it POSTs a herdr snapshot to the board, pulls queued hooks, delivers each with `herdr pane run`, and acks what it delivered. Lanes, PRs and CI are not in this payload — the board host reads those itself. |
| **CTO hook queue** | `POST /hooks/enqueue`, `state/hooks.json` | The CTO stays a herdr window on the owner's machine. The board never calls it. Work is queued as hooks; the probe delivers them. A hook waiting more than ten minutes shows `hooks queued, oldest Nm` in the header. |
| **Telegram bot** | `bin/telegram-bot.mjs` | One group, two founders. The **board** posts four notifications (artifact ready, assign subscription, stuck, done). A **separate** poller long-polls button presses and POSTs `assign-subscription` back. Do not start two pollers on the same bot. |
| **Development-launch** | `bin/dev-launch.mjs` | For a card in `development`: on the assigned lane, fetch the product repo, create `feat/card-<id>-…`, write `TASK-<id>.md`, start the lane's `launchCommand` detached, then POST the branch onto the card. It never picks a lane, never assigns a subscription, and never waits for the orchestrator. |
| **Local-check** | `bin/local-check.mjs` | For a card in `local_check`: on the same lane, run the project's local test command, poll the log for `LOCAL_CHECK_EXIT=N`. Pass → move to `ci_pr`. Fail → `POST /pipeline/card/fail` `{ "kind": "local" }`. |
| **CI-slot** | `bin/ci-slot.mjs` | For a card in `ci_pr`: claim a **free** slot from the pool, pin that slot's GitHub Actions runner label on the PR, poll `gh pr checks`. Green → squash-merge → move to `done`. Red → fail `{ "kind": "ci" }`. Either way, release the slot. **There is no queue.** If no slot is free, it prints `no free CI slot — add capacity`, assigns nothing, and exits 3. Occupancy is `state/ci-slots.json`; the board only reads it (`GET /api/slots`). |
| **Watchdog** | `bin/watchdog.mjs` | A separate process from the board. Every `intervalMin` minutes (default 15) it scores each **active** card (`development`, `local_check`, `ci_pr`): lane log tail, CI via `gh` if the card has a PR link, then a cheap language-model command writes Status and a verdict. It never moves a card and never talks to herdr. |
| **Artifact instance** | `deploy/lavish-worker/`, `bin/lavish-publish.mjs`, `bin/lavish-deploy.mjs` | Self-hosted Lavish on Cloudflare Workers: a published grill page gets a stable public HTTPS URL where the founders annotate; the CLI publishes, polls the answers in, and can set `links.artifact` on the card in the same command. See [`docs/ARTIFACT.md`](docs/ARTIFACT.md). |

The grill itself (Artifact page, collecting founder answers, writing the GitHub tickets under the CTO's GitHub App) is work the CTO window does — ticket-writing is the `ticketed` stage, and `links.ticket` is what lets the card enter `development`. This repository stores the Artifact and ticket as `links` on the card, queues hooks, and notifies Telegram when `links.artifact` first lands. It does not contain the CTO agent.

Contracts: [`docs/PROBE.md`](docs/PROBE.md), [`docs/TELEGRAM.md`](docs/TELEGRAM.md), [`docs/DEVLAUNCH.md`](docs/DEVLAUNCH.md), [`docs/EXECUTION.md`](docs/EXECUTION.md), [`docs/WATCHDOG.md`](docs/WATCHDOG.md).

---

## Quick start

Requirements for a local windows board: Node.js, herdr. Optional: `gh` (logged in) for pull requests and issues, and an ssh key for hosts that run build lanes. The Linux install kit requires Node.js 22 or newer; see [Deploy on a Linux host](#deploy-on-a-linux-host).

```
node bin/watchtower.mjs
```

The board serves `http://127.0.0.1:4878` and the page polls every three seconds. On Windows, `bin\watchtower.cmd` starts the same server and opens the page (`--open`). To run without a console window (autostart on logon), `bin\watchtower-hidden.vbs`.

Another port: set `WATCHTOWER_PORT` before starting (the older `AUTOPASE_BOARD_PORT` is still read as a fallback). Default is 4878.

If `ssh` or `gh` are not on the default path, point at them with `WATCHTOWER_SSH` and `WATCHTOWER_GH`. A second instance, or tests, can keep their own files with `WATCHTOWER_STATE_DIR` instead of `state/`.

The probe, Telegram poller, Watchdog, and the execution helpers are separate commands. They need their own config files under `state/` (not in git). Dry-run first:

```
node bin/probe.mjs --once --dry-run
node bin/dev-launch.mjs <card-id> --dry-run
node bin/local-check.mjs --once <card-id> --dry-run
node bin/ci-slot.mjs --once <card-id> --dry-run
node bin/watchdog.mjs --once --dry-run
node bin/telegram-bot.mjs --selftest
```

The test suite is plain `node --test` with no packages: `npm test`.

---

## Pick a project on first run

On the first run the board asks which project to watch. It groups the windows herdr currently has by project — the worktree root (`~/.herdr/worktrees/<project>/…`) or the repository the window sits in — and shows each one with how many windows it has. Pick a project and the board shows every window and every worktree of it. There is also **All windows**, which applies no filter at all.

The choice is saved to `state/autopase-board.json`. The gear in the header opens the same screen again — to change the project and to restore windows you have hidden.

Until a project is chosen, slow sources (ssh, `gh`) are not asked, and `/api/board` lists `project: no project chosen yet` under `problems`.

---

## Windows board

**Header:** Watchtower, the project being watched, counters, a **windows** / **pipeline** toggle, `+` (hand-typed window card) / **+ Card** (pipeline card), and the gear.

**Columns:**

| Column | What is in it |
| --- | --- |
| **Needs you** | Window `blocked`, an ask marker in its last words, or an unanswered question in its umbrella issue. Always first |
| **Working** | The agent is working right now |
| **Lane is building** | The window is silent but its lane is busy |
| **Idle** | Live agent, no work and no lanes |
| **No agent** | A window with no agent in it |

Clicking a window card is the board's only herdr action: it focuses that tab. It does not start or stop agents.

Window cards are assembled from live sources on each refresh. You can still hide a window (restore it behind the gear) or add a card of your own with `+`.

| What | Source | How often |
| --- | --- | --- |
| Windows, tabs, agent state | `herdr api snapshot`, `herdr workspace list`, `herdr agent list` — or the last probe snapshot when `source` is `"probe"` | every 3 s locally |
| The rule behind a state | `herdr agent explain <pane>` | every 12 s (local herdr only) |
| Model, account, effort, context, PR numbers on screen | `herdr pane read <pane> --source visible` | every 12 s (local herdr only) |
| Lanes on an hzlane host | `ssh … hzlane status` | every 45 s |
| Lanes in a Mac kitchen | `ssh mac` — branch of each `<kitchen>/lane-*` folder plus live `codex exec` working directories | every 45 s |
| Open PRs and CI colour | `gh pr list --repo <repo>` | every 60 s |
| Umbrella issues and questions | `gh issue list --label umbrella` + `gh issue view` | every 120 s |
| Which window owns which lanes | the `streamWatch` JSON file | every 30 s |
| Umbrella number of a program | `<specsDir>/<PROGRAM>/PROGRAM-STATE.md`, line `umbrella: #NNNN` | every 30 s |
| The window's last words | Claude session log (`*.jsonl`); else the previous session; else the last meaningful line on screen | every 3 s (by file mtime) |

Every source refreshes on its own timer, so one dead source does not take the board down — it shows up as "sources not answering" / `problems`. In `probe` mode a snapshot older than `probeStaleSec` (default 60) is flagged `probe stale since …`.

What herdr itself exposes: [`docs/herdr-api.md`](docs/herdr-api.md).

---

## Agent API and `wt`

Agents read the board without a browser. The page lives on `/data` and can change with the layout; agents read `/api/board` and `/api/pipeline`, whose fields are pinned.

```
node bin/wt.mjs                 live windows board as short text
node bin/wt.mjs --full          long texts in full, no clipping
node bin/wt.mjs --json          the same shape as plain JSON
node bin/wt.mjs --card <name>   one window in full
node bin/wt.mjs pipeline        the delivery pipeline as short text
node bin/wt.mjs pipeline --json
node bin/wt.mjs card <id>       one pipeline card in full
node bin/wt.mjs --help
```

On Windows, `bin\wt.cmd` is the same command. `wt` computes nothing itself — it asks the running server. If the server is down it says so and exits 1.

HTTP (default port 4878):

```
GET /api/board
GET /api/board?format=json
GET /api/board?full=1
GET /api/board/card/<name>
GET /api/pipeline
GET /api/pipeline?format=json
GET /api/pipeline?full=1
GET /api/pipeline/card/<id>
GET /api/slots
GET /api/slots?format=toon
```

`format` is `toon` (short text) or `json`. `full=1` lifts clipping on the list views. Unknown parameters, empty values, or the same parameter twice answer 400 with a hint.

When every listed CI slot has a holder, `/api/slots` includes `"alarm": "no free CI slot — add capacity"`, `/api/board` `problems` carries the same sentence, and the page header flags it. That is an alarm, not a wait.

Field-by-field contract, pipeline mutations, probe endpoints, and errors: [`docs/API.md`](docs/API.md).

---

## Auth

Founder sign-in is off until `auth.founders` is a non-empty list in `state/autopase-board.json`. With no `auth` block the board is an open page on localhost, which is the desktop mode.

When the list is set:

- The page and read APIs need a founder session, localhost-as-owner, or (on `/api/*` and `/pipeline/data`) `Authorization: Bearer <apiToken>`.
- Window-board mutations (`/card/*`, `/project/select`, `/focus`) need a session or localhost-as-owner.
- Pipeline mutations and `POST /hooks/enqueue` also accept `apiToken`.
- `/probe/*` uses `probeToken` only, as before.

`POST /auth/request` with `{ "email" }` always answers `{ "ok": true, "sent": "if that address is on the list" }`. If the email is listed, a one-time token is stored for 15 minutes and the server prints `login link for <email>: <url>` on stdout. **The board does not send email.** Login-link delivery by mail or Telegram is not implemented. `GET /auth/link?token=…` sets the `wt_session` cookie.

`allowLocalhost` is off by default. Turn it on only when nothing forwards to the port: `ssh -L`, a bare nginx `proxy_pass`, `socat`, or a tunnel client all look like loopback to the board, and every visitor on the far end would silently become the owner. The service prints an `auth warning:` line at start-up while it is on.

Set `auth.publicUrl` to the public HTTPS base before exposing the port. Without it, login links fall back to `http://127.0.0.1:<port>` for any non-loopback `Host` header.

Full flow, cookie flags, rate limits, and what the board trusts: [`docs/API.md`](docs/API.md) (Auth) and [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Configuration

Built-in defaults live in `bin/watchtower.mjs` (`DEFAULTS`). Overrides go in `state/autopase-board.json`, which is not in git:

```json
{
  "project": "my-project",
  "allWindows": false,
  "hide": ["marketing"],
  "repo": "acme/web",
  "streamWatch": "C:\\path\\to\\STREAM-WATCH.json",
  "specsDir": "C:\\path\\to\\specs",
  "askWords": ["QUESTION FOR THE CTO", "QUESTION FOR THE OWNER"],
  "answerWords": ["CTO ANSWER", "OWNER SAYS"],
  "hosts": {
    "builder": { "target": "root@203.0.113.10", "key": "id_ed25519", "kind": "hzlane" },
    "mac":     { "target": "mac", "kind": "mac", "kitchen": "~/kitchens/my-project", "connectTimeoutSec": 30 }
  },
  "source": "local",
  "probeStaleSec": 60,
  "probeToken": "the probe's shared secret",
  "apiToken": "a long random secret for agents",
  "subscriptions": ["cx1", "initech", "hz1"],
  "auth": {
    "founders": [
      { "email": "owner@example.com", "name": "Ada", "owner": true },
      { "email": "partner@example.com", "name": "Bob", "owner": false }
    ],
    "sessionDays": 30,
    "allowLocalhost": false,
    "trustProxy": true,
    "publicUrl": "https://board.example.com",
    "cookieSecure": true
  },
  "telegram": {
    "botToken": "123456:ABC…",
    "chatId": "-1001234567890",
    "boardUrl": "https://board.example.com",
    "apiToken": "the-same-token-agents-use-on-the-board",
    "dryRun": false,
    "founders": [
      { "name": "Ada", "tgUserId": 1001, "tag": "@ada", "owner": true },
      { "name": "Bob", "tgUserId": 1002, "tag": "@bob", "owner": false }
    ]
  }
}
```

- `project` / `allWindows` — set by the onboarding screen.
- `hide` — windows never shown, by folder name or window label.
- `repo` — `owner/name` for `gh`. Empty means GitHub is skipped.
- `streamWatch`, `specsDir` — optional; without them there are no lane bindings and no umbrella numbers.
- `askWords` / `answerWords` — exact protocol markers your windows and issues use, in whatever language the team types. Until an answer marker appears after a question in the umbrella issue, the question counts as open.
- `hosts` — where code is built. `kind: "hzlane"` asks `hzlane status` over ssh; `kind: "mac"` reads `<kitchen>/lane-*` folders and live `codex exec` processes. `connectTimeoutSec` (default 10) is ssh's handshake limit — raise it for a host behind a mesh VPN that drops the first packets.
- `source` — `"local"` talks to herdr on this machine; `"probe"` uses the last posted snapshot. Lanes, PRs and CI still come from this host.
- `subscriptions` — names the owner may assign (Telegram buttons and `POST /pipeline/assign-subscription`).
- `telegram` — outbound pipeline notifications. Missing, or present without `botToken` and without `dryRun: true` → no sends, one log line at start-up. The poller reads a separate `state/telegram.json`.

Other processes have their own files next to that one, also not in git: `state/probe.json`, `state/dev-launch.json`, `state/local-check.json`, `state/ci-slot.json`, `state/watchdog.json`, `state/telegram.json`.

The board also writes `state/autopase-seen.json` (when each pane was first seen in its current state — herdr does not keep that), `state/autopase-cards.json` (hidden and hand-typed window cards), `state/pipeline-cards.json`, `state/hooks.json`, `state/auth.json`, `state/probe-snapshot.json`, and reads `state/ci-slots.json`.

---

## Deploy on a Linux host

The board is meant to run as a systemd service on a Linux host so the partner can reach cards without the owner's desktop. Local herdr stays on that desktop and is pushed up by the probe ([`docs/adr/0002-board-server-lives-on-hetzner.md`](docs/adr/0002-board-server-lives-on-hetzner.md)).

Layout:

```
/opt/watchtower/          application tree — overwrite on every update
/opt/watchtower/state/    persistent state — must survive updates
/etc/watchtower.env       environment overrides (created once)
/etc/systemd/system/watchtower.service
```

From the machine that holds the repository:

```
rsync -a --exclude state/ --exclude .git/ ./ root@HOST:/opt/watchtower/
```

Then on the host:

```
bash /opt/watchtower/deploy/setup.sh
```

`setup.sh` is idempotent. It requires Node.js 22 or newer already on `PATH`. It does not install Node, a reverse proxy, or TLS certificates. The board listens on `127.0.0.1:4878`; put a reverse proxy with TLS in front if anyone outside this host should open the page.

Set `auth.founders` in `/opt/watchtower/state/autopase-board.json` **before** the reverse proxy is reachable from the internet. With an empty founders list, anyone who can hit the proxy can read and mutate cards.

Units in `deploy/`:

| Unit | Command | Installed by `setup.sh`? |
| --- | --- | --- |
| `watchtower.service` | `node bin/watchtower.mjs` | Yes |
| `watchtower-bot.service` | `node bin/telegram-bot.mjs run` | No — enable by hand when `state/telegram.json` is in place |
| `watchtower-watchdog.service` | `node bin/watchdog.mjs run` | No — enable by hand after `state/watchdog.json` exists (without it the process exits 1 and systemd would restart it in a loop) |

Operator guide: [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Docs and decisions

| File | Contents |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | Language: card, window, stage, slot, subscription, Watchdog, Status, lane, spec, grill, Artifact, probe, ticket, founder |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Waves A–G |
| [`docs/API.md`](docs/API.md) | Agent API, pipeline mutations, slots, auth, probe endpoints |
| [`docs/GRILL.md`](docs/GRILL.md) | The grill: lens method, outcome, Lavish-on-Cloudflare requirements |
| [`docs/ARTIFACT.md`](docs/ARTIFACT.md) | The artifact pipeline: deploying the Lavish worker to Cloudflare, publishing, polling answers |
| [`docs/PROBE.md`](docs/PROBE.md) | Probe cycle, snapshot shape, hook delivery |
| [`docs/TELEGRAM.md`](docs/TELEGRAM.md) | Bot, the four notifications, assign-subscription |
| [`docs/DEVLAUNCH.md`](docs/DEVLAUNCH.md) | Development-launch |
| [`docs/EXECUTION.md`](docs/EXECUTION.md) | Local-check and CI-slot, failure loops, exit 3 |
| [`docs/WATCHDOG.md`](docs/WATCHDOG.md) | Watchdog sweep, Status contract, stale Status |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Linux install |
| [`docs/herdr-api.md`](docs/herdr-api.md) | What herdr provides and what it accepts back |

Architecture notes:

- [`docs/adr/0001-watchtower-becomes-the-pipeline.md`](docs/adr/0001-watchtower-becomes-the-pipeline.md) — the pipeline is built into Watchtower, not as a second app or on GitHub Issues
- [`docs/adr/0002-board-server-lives-on-hetzner.md`](docs/adr/0002-board-server-lives-on-hetzner.md) — board on a Linux host; probe pushes local herdr
- [`docs/adr/0003-cto-is-a-herdr-window-hooks-via-probe.md`](docs/adr/0003-cto-is-a-herdr-window-hooks-via-probe.md) — CTO stays a window; hooks wait on the board
- [`docs/adr/0004-grill-outcome-becomes-one-github-ticket.md`](docs/adr/0004-grill-outcome-becomes-one-github-ticket.md) — one GitHub ticket after the grill, written by the CTO's GitHub App
- [`docs/adr/0005-ci-slots-no-queues.md`](docs/adr/0005-ci-slots-no-queues.md) — dedicated CI slots; "all busy" is an alarm, not a wait

---

## License

MIT — see [`LICENSE`](LICENSE). Watchtower started as a fork of [sheepdog](https://github.com/patraianton/sheepdog).
