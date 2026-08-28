# Execution stages (Wave F)

Two processes run the **Local check** and **CI/PR** stages of a pipeline
**card**. Development-launch (branch + orchestrator on the assigned **lane**)
is already documented in [`DEVLAUNCH.md`](./DEVLAUNCH.md). This file is the
contract for the two that come after it.

Terms, from [`CONTEXT.md`](../CONTEXT.md):

| word | meaning here |
| --- | --- |
| **Card** | A persistent pipeline task. Not a herdr window. |
| **Stage** | The column the card sits in. Local-check only runs `local_check`; CI-slot only runs `ci_pr`. |
| **Lane** | The remote build slot already assigned to the card. Reused from Development. |
| **Slot** | A dedicated CI server from the pool. A card never waits for one. |
| **Spec** | The task text. Local-check does not rewrite it. |

Neither process has external packages. Heavy actions (ssh, git, gh) default
to dry-run and only run for real behind `--run`. Nothing here may touch a
live repo, a live lane, or live CI from a test.

The board's stage machine is [`bin/pipeline.mjs`](../bin/pipeline.mjs). These
runners call its existing endpoints; they do not duplicate the rules.

## Run

```
node bin/local-check.mjs --once <card-id>
node bin/local-check.mjs --once <card-id> --dry-run --config C:\temp\local-check.json
node bin/local-check.mjs --once <card-id> --run --config C:\temp\local-check.json

node bin/ci-slot.mjs --once <card-id>
node bin/ci-slot.mjs --once <card-id> --dry-run --config C:\temp\ci-slot.json --state-dir C:\temp\wt-state
node bin/ci-slot.mjs --once <card-id> --run --config C:\temp\ci-slot.json
```

| flag | who | effect |
| --- | --- | --- |
| `--once <id>` | both | One card by id. `--card <id>` and a positional id are the same thing. `--once` without an id is usage (exit 2). Without `--once` and without an id, the process picks the first card already in its stage. |
| `--dry-run` | both | Print every ssh/gh command and every POST that **would** run, then exit. **Do not** ssh, **do not** gh, **do not** POST, **do not** write occupancy. This is the default. |
| `--run` | both | Actually do the work. |
| `--config <file>` | both | Config JSON; defaults `state/local-check.json` and `state/ci-slot.json`. |
| `--state-dir <dir>` | CI-slot | Directory of `ci-slots.json` (holders). Default `state/`, or `WATCHTOWER_STATE_DIR`. |
| `--help` | both | Short help. |

An unknown flag, `--once` without an id, or `--dry-run` together with `--run`
exits `2`. A live `--run` that cannot proceed is a clear English error and
exit `1`.

`--dry-run` still talks to the board when `boardUrl` is set, so it can print
the real title, lane, branch and PR. It never ssh-es, never calls `gh`, and
never POSTs. If the config file is missing or pieces are empty, dry-run still
prints a command plan with placeholders and exits `0` — except the no-free-slot
case, which is exit `3` even in dry-run (see below).

Without `--run` nothing is started, even when the config is complete.

## Local check

File: `bin/local-check.mjs`. Config: `state/local-check.json`.

Over ssh to the card's assigned **lane**, start the project's local test
command detached with a log, then poll that log for `LOCAL_CHECK_EXIT=N`.

- pass (`N` is 0) → `POST /pipeline/card/move` `{ "id", "to": "ci_pr" }`
- fail → `POST /pipeline/card/fail` `{ "id", "kind": "local" }`

The board, not this process, increments `localFails` and `consecutiveFails`
and, on the third consecutive fail, moves the card to `stuck`.

### Config

```json
{
  "boardUrl": "https://watchtower.example",
  "apiToken": "the-same-token-agents-use-on-the-board",
  "localCheckCommand": "npm test",
  "pollMs": 5000,
  "timeoutMs": 1800000,
  "lanes": {
    "lane-1": {
      "ssh": "root@203.0.113.10",
      "key": "id_ed25519",
      "workdir": "~/kitchens/repo/lane-1",
      "localCheckCommand": "npm test"
    }
  }
}
```

| field | required for `--run` | meaning |
| --- | --- | --- |
| `boardUrl` | yes | Board origin, `http://` or `https://`. A trailing slash is stripped. |
| `apiToken` | no | Sent as `Authorization: Bearer …` when set. Alias: `token`. |
| `localCheckCommand` | yes, unless the lane sets its own | Template for the test command. |
| `lanes` | yes, the card's lane | Map of lane id → how to reach that lane. Same lookup as Development-launch. |
| `pollMs` | no | How often to poll the log. Default 5000. |
| `timeoutMs` | no | Give up waiting for `LOCAL_CHECK_EXIT`. Default 30 minutes. |

A per-lane `localCheckCommand` overrides the top-level template.

Placeholders, replaced before the command is written to the runner script:

| placeholder | becomes |
| --- | --- |
| `{branch}` | `links.branch` on the card, or empty |
| `{workdir}` | the lane's workdir (`~/` rewritten as `$HOME/`) |

ssh options are the same as Watchtower: `BatchMode=yes`, `ConnectTimeout=10`,
`StrictHostKeyChecking=accept-new`. Override the binary with `LOCALCHECK_SSH`
or `WATCHTOWER_SSH`.

`--run` refuses if the card has no lane assigned, if that name is not in
`config.lanes`, if the lane has no `ssh` / `workdir`, if `localCheckCommand`
is empty, or if the card's stage is set and is not `local_check`. This
process will not pick a lane.

### What a local check does

1. `GET {boardUrl}/api/pipeline/card/{id}?format=json`.
2. Over ssh to the card's assigned lane, as one remote `sh -s` script: write
   `local-check-<id>.sh` in the workdir, start it with `nohup`, stdin closed,
   stdout/stderr in `local-check-<id>.log`. The runner prints
   `LOCAL_CHECK_EXIT=<code>` when the test command finishes.
3. Poll that log over ssh until the marker appears, or until `timeoutMs`.
4. POST move or fail as above.

`--dry-run` stops after step 1: it prints the start script, the poll script,
and **both** POSTs (pass and fail), then exits 0. No ssh, no POST.

## CI/PR (slots, no queue)

File: `bin/ci-slot.mjs`. Config: `state/ci-slot.json`. Holders:
`state/ci-slots.json`.

A pool of dedicated CI servers (three today) is sized so a card entering
CI/PR never waits. See [`adr/0005-ci-slots-no-queues.md`](./adr/0005-ci-slots-no-queues.md).

Given a card in `ci_pr`:

1. Pick a **free** slot. A slot is busy when another card holds it (the
   occupancy file). If this card already holds a slot, reuse it.
2. If no slot is free: **do not wait**. Print `no free CI slot — add capacity`,
   record the alarm in the occupancy file (the board reads it), assign
   nothing, exit `3`. That exit is clean — not a crash. There is no queue.
3. On a free slot: claim it (atomic write of `state/ci-slots.json`),
   `POST /pipeline/card/update` `{ "id", "slot" }`, open or reuse the PR
   (`gh`), pin CI by adding the slot's runner **label** on the PR, poll
   `gh pr checks`.
4. Green → `gh pr merge --squash` → `POST /pipeline/card/move`
   `{ "to": "done" }`.
5. Red → `POST /pipeline/card/fail` `{ "kind": "ci" }`.
6. Either way, **release the slot**.

### Config

```json
{
  "boardUrl": "https://watchtower.example",
  "apiToken": "the-same-token-agents-use-on-the-board",
  "repo": "owner/name",
  "baseBranch": "main",
  "pollMs": 15000,
  "timeoutMs": 1800000,
  "slots": [
    { "name": "ci-1", "label": "self-hosted-ci-1" },
    { "name": "ci-2", "label": "self-hosted-ci-2" },
    { "name": "ci-3", "label": "self-hosted-ci-3" }
  ]
}
```

| field | required for `--run` | meaning |
| --- | --- | --- |
| `boardUrl` | yes | Board origin. |
| `apiToken` | no | Bearer token. |
| `repo` | yes | `owner/name` for `gh --repo`. |
| `baseBranch` | no | PR base. Default `main`. |
| `slots` | yes | The pool. `name` is what the card stores in `slot`. `label` is the GitHub Actions runner label pinned on the PR. |
| `pollMs` / `timeoutMs` | no | CI poll. Defaults 15s / 30 minutes. |
| `occupancyFile` | no | Override path of `ci-slots.json`. Otherwise `--state-dir` / `WATCHTOWER_STATE_DIR` / `state/`. |

Override the `gh` binary with `CISLOT_GH` or `WATCHTOWER_GH`.

Pinning: this process adds the slot's `label` to the PR (`gh pr create --label`
or `gh pr edit --add-label`). The slot's machine is the GitHub Actions
runner that listens for that label. This process does not edit workflow
files.

`--run` refuses if `repo` is missing, if `slots` is empty, if the card has
no `links.branch`, or if the card's stage is set and is not `ci_pr`.

### Occupancy file

`state/ci-slots.json`, atomic writes through `bin/state-file.mjs`. Shape:

```json
{
  "slots": [
    { "name": "ci-1", "label": "self-hosted-ci-1", "card": "cci1", "since": "2026-08-26T12:00:00.000Z" },
    { "name": "ci-2", "label": "self-hosted-ci-2", "card": null, "since": null },
    { "name": "ci-3", "label": "self-hosted-ci-3", "card": null, "since": null }
  ],
  "alarm": null
}
```

The board does not claim or release slots. It **reads** this file:

- `GET /api/slots` → `{ "slots": [{ "name", "card", "since" }] }` (`card` and
  `since` are `null` when the slot is free). When every slot has a holder,
  the JSON also has `"alarm": "no free CI slot — add capacity"`.
- `/api/board` `problems` gets a row `source: ci-slots` with that same
  sentence when every listed slot is held.
- The page header flag (`#board-warn`) shows the same sentence, next to the
  probe-stale and hooks-queued notices.

The occupancy helpers live in `bin/ci-slot.mjs` (`configureSlots`,
`slotsForBoard`, `slotsAlarmMessage`). `bin/watchtower.mjs` only routes and
surfaces them.

A missing occupancy file is not an alarm: there is no pool on disk yet, so
the board shows an empty slot list. The alarm fires only when the pool is
non-empty and every slot has a holder. The fix is adding a slot, not waiting.

### No-queue alarm — exit 3

When every slot is held by another card (and this card does not already
hold one):

- stdout prints `no free CI slot — add capacity` and the holder list
- nothing is assigned
- occupancy is not changed in dry-run; on `--run` the alarm timestamp is
  written so the board can show it
- exit code is **3** — documented, clean, not a crash

Dry-run against a busy occupancy file is the same: print the alarm, assign
nothing, exit 3, do not write.

## Failure loops

Owned by [`bin/pipeline.mjs`](../bin/pipeline.mjs). These runners only POST
the endpoints below; they do not move a card themselves.

A card sits in one stage. The road is one-way:

`spec → grilled → ticketed → development → local_check → ci_pr → done`

A **failure** is one of three kinds. Each has its own counter. A failure
can only be reported from a stage where something was actually run
(`development`, `local_check`, `ci_pr`):

| POST | body | who sends it | counter |
| --- | --- | --- | --- |
| `/pipeline/card/fail` | `{ "id", "kind": "local" }` | Local-check, when the log says `LOCAL_CHECK_EXIT` ≠ 0 | `localFails` |
| `/pipeline/card/fail` | `{ "id", "kind": "ci" }` | CI-slot, when `gh pr checks` is red | `ciFails` |
| `/pipeline/card/fail` | `{ "id", "kind": "review" }` | a human (or a later runner) when the review says NO-GO, not these two | `reviewFails` |

The board then:

1. increments that kind's counter **and** `consecutiveFails`
2. moves the card back to `development` — unless `consecutiveFails` has
   reached **3**, in which case the card goes to `stuck` and waits for a
   human (`POST /pipeline/card/unstuck` returns it to `development` and
   clears the streak)

A successful move along the road (Local-check's pass to `ci_pr`, CI-slot's
pass to `done`) resets `consecutiveFails` to zero.
So does a human pulling the card out of `stuck`. The decision buys the card
a fresh run of three.

These two processes never call `unstuck`, never call `accept`, never pick a
lane, and never assign a subscription.

## HTTP contracts

Every request may carry `Authorization: Bearer {apiToken}` when the token is
set. POST bodies are `Content-Type: application/json`. A network error, a
non-2xx status, a 20-second timeout or a non-JSON body is a failure of that
call.

`GET {boardUrl}/api/pipeline/card/{id}?format=json` is the same card contract
as [`DEVLAUNCH.md`](./DEVLAUNCH.md) and [`API.md`](./API.md) — except that
these two processes do not ask for `spec=1`: they never read the spec text,
and the default answer (with `spec-lines` instead of `spec`) is enough. Empty
optional fields may be `""` or `"-"` — both mean "not set". `links` may be an
object or the board's flattened string.

Local-check POSTs:

```json
POST /pipeline/card/move     { "id": "clocal1", "to": "ci_pr" }
POST /pipeline/card/fail     { "id": "clocal1", "kind": "local" }
```

CI-slot POSTs:

```json
POST /pipeline/card/update   { "id": "cci1", "slot": "ci-1" }
POST /pipeline/card/update   { "id": "cci1", "links": { "pr": "https://github.com/owner/name/pull/12" } }
POST /pipeline/card/move     { "id": "cci1", "to": "done" }
POST /pipeline/card/fail     { "id": "cci1", "kind": "ci" }
```

## Exit codes

| code | who | meaning |
| --- | --- | --- |
| 0 | both | Plan printed (dry-run) or the stage finished. |
| 1 | both | Could not proceed (`--run` blockers, ssh/gh/board failed). |
| 2 | both | Bad usage. |
| 3 | CI-slot | No free CI slot — add capacity. Clean. Assigned nothing. |

## Safety

Dry-run never ssh-es, never calls `gh`, never POSTs, never writes
occupancy, even with a complete config. `--run` is the only way a remote
command starts. Tests of these modules must not pass `--run`.

---

# Process policy

Merged 2026-08-28 from the fast-mode playbook (§2–§5, §8, §10) and the 28.08
conveyor rules, by the owner's approved plan. Where the playbook contradicted
the pipeline above, the pipeline wins; every superseded rule is listed in the
merge commit and in the playbook's pointer page. Machine names, addresses,
accounts and credentials live in the private annex (`INFRA.md` in the ops
repo), never here.

## Merge rule

**Merge = green `pr-ci` on the exact head SHA + a review trace.** The order is
fixed: local check → push → green `pr-ci` → review → merge. Nobody reviews a
red PR — a review fleet on a PR that has not gone green is the most expensive
way to find a type error CI reports in minutes.

- The first verdict must be countable: the first review or acceptance comment
  starts with `R1 — GO` or `R1 — NO-GO` (later rounds `R2 — …`). A verdict
  written any other way counts as "no verdict" and the PR is not mergeable.
- The review leaves a trace: one line in the PR (comment or merge body) saying
  what was checked.
- "Green" means a `pr-ci` run of the CURRENT workflow on the head SHA — never
  a stale green from before a CI restructuring.
- Where the board's CI-slot runner drives CI/PR (above), it merges on green
  itself, so the GO review must come before it is pointed at the PR — same two
  ingredients, different order ([TICKETING.md](./TICKETING.md) §2.10).

**Protected areas** — the places where mistakes have cost real money:

- database migrations and schema;
- authorization (auth provider integration);
- hosting cache and deployment settings;
- the scraper.

**Independent acceptance — one pass, at most 5 agents — applies ONLY to
protected areas. Ordinary PRs get ONE reviewer.** The acceptance verdict is a
PR comment on the exact head SHA; without it a protected-area PR is not
mergeable even on green CI. Acceptance is dispatched only AFTER `pr-ci` is
green on the head — no tokens burned on heads that may not pass.

## Two CI tiers

**Fast gate `pr-ci`** — mandatory on every PR: lint over changed files → prod
schema check → double migration replay → build → unit tests → quality contract
check → browser smoke. Contract tests guard the scheme (the smoke cannot be
disabled or exempted); changing the contract requires an owner decision
recorded in an issue.

**Nightly full run** — the entire quality sheet against main every night. It is
**advisory**: it blocks nothing; failures are triaged in the morning — triage
= a comment/issue naming the run id and what fails, plus an update of the
known-issues file.

Queueing: each PR has its own concurrency group; a fresh push to a branch
cancels its stale run. **The post-merge check of `main` is never cancelled by
the next merge** — a red `main` is a signal, not silence.

Red hygiene (conveyor rule 7): a red `pr-ci` does not hold a PR if ALL failing
tests are foreign — "foreign" defined narrowly: the test file is unchanged in
this PR AND the same test is red on the current head of `main` (or the last
nightly). A failure on another branch is never proof. The path is one:
quarantine the test name in the known-failing list by a separate small PR (the
line must carry a task number), rerun, merge. **A red `main` freezes merges** —
nothing lands except the fixing or quarantining PR, and the first free hand
takes the fix before any new unit. Runs of `main` are never cancelled.

Flakiness (conveyor rule 4): a rerun is button-only, on the same commit, and
one per head. If a rerun goes green with no change, the test is flaky: same
day its name goes to quarantine with a task number and a fix task is opened. A
second red on the same head means "needs analysis", not another rerun.

Time-bomb tests (conveyor rule 15): test files must not compare the machine's
real clock against a literal date — such a file fails the quality suite unless
listed in an in-check exception list, each line with a task number. The
nightly additionally runs the suite with the clock shifted forward; a red
shifted run against a green normal run is a time bomb and opens a task.

Time limits (conveyor rule 2, the process half): every CI time limit derives
from measurement — the larger of 2× the week's median and the week's slowest
green run + 5 minutes. A limit changes only in the same PR that updates the
measurement doc.

## Roles: the orchestrator dispatches, lanes write code

The orchestrator session writes unit tickets, hands them to a lane, reads
reports, opens PRs, reviews diffs, merges, and runs the tracker. Code is
written by **lanes** — remote build slots — **never on the owner's desktop
machine** ("it takes the computer away from me"). Builds and browser suites do
not run on the owner's machine either; unit tests for touched files are fine.

- The orchestrator may make small edits itself (docs, a one-line fix, workflow
  YAML); anything bigger goes to a lane.
- **Thin orchestrator:** the orchestrator window keeps facts, not material.
  Reading logs, diffs, reports and test output is delegated to short-lived
  subagents; the window receives the verdict and the numbers.
- **Push discipline:** a lane pushes only after a green local check. While
  iterating it runs only the tests the change touches; the full local CI runs
  at most ONCE, at the end of the round. After the final push the writer does
  not wait for CI — watchers and the orchestrator do. A second push to the
  same branch waits until the previous run has finished (a push mid-run
  cancels it and the minutes are gone).
- **Draft from the first push** (conveyor rule 3): the lane opens a draft PR
  in the same breath as the first push of a branch. A branch ahead of `main`
  for longer than 30 minutes without an open PR is a violation.
- **Self-check before the PR leaves draft:** green local CI on the head; the
  ticket's acceptance criteria re-read one by one, each answered
  `met / not met / not applicable` with evidence; the lane's own diff review
  (what a reviewer would flag first). Reviewers and acceptance lanes are NOT
  shown the self-check — they review from the ticket and the diff, so the
  check stays independent.
- **Queue depth two** (conveyor rule 1): every live stream keeps at least two
  ready units queued; the next unit is written while the previous one is still
  in checking. A question never stops a lane — defaults are embedded in the
  ticket ([TICKETING.md](./TICKETING.md) §2.8) and the lane keeps working.
- **Two acceptance rounds are the limit** (conveyor rule 9): a second NO-GO
  closes the PR and sends the unit back to be re-sliced into smaller pieces.
  A third round exists only by an explicit CTO label with a one-line reason.
- Decisions and verdicts go **only as comments in the tracker's issues/PRs** —
  chat conversations are invisible to the other participants.

**Evening sweep** (conveyor rule 12): once each evening the orchestrator walks
every open PR and leaves each in exactly one of three states: (1) auto-merge
armed; (2) a rework task issued to a lane; (3) a "parked until morning:
reason" line in the program record. An open PR outside the three states 30
minutes after the sweep is a violation.

**One merge watchdog** (conveyor rule 14): every automatic duty around merging
— open the forgotten draft, rerun a red with GO, disarm auto-merge on red
`main`, merge the overdue green, check the queue — belongs to ONE named
watchdog script in one place, with a rights registry (action → token →
minimal rights → owner) and a heartbeat line in every periodic readout. An
absent heartbeat is itself an alarm ("prove the watchdog has not gone deaf").
After every merge to `main` the watchdog probes production **by content**, not
by status code — an empty page on a green pipeline is an alarm.

## Agent-model policy

- Every Claude agent involved — orchestrators, writing lanes, reviewers,
  acceptance agents, mechanical support agents — runs in `ultracode`. Verify
  before dispatch; if a session is not in `ultracode`, relaunch it.
- Non-Claude writer engines have no `ultracode`; the Claude orchestrator that
  dispatches them still runs in it. Never label a non-Claude process
  `ultracode`.
- Only the CTO window runs on the top-tier model (Fable); stream orchestrator
  windows run on Opus. Review and protected-area acceptance agents are set
  explicitly to Opus — never top-tier, never inherited. Mechanical agents may
  use smaller models, still inside an `ultracode` session.
- **The checker is a different model than the writer** (conveyor rule 16): the
  writer self-checks with its own list; independent acceptance runs on a
  different model; the GO/NO-GO verdict is signed by the orchestrator.
- The rules keeper reports `ultracode` compliance as a number each round.

## Standing prohibitions (process)

- Secrets are never committed — not in the repo, not in commits, not in card
  or ticket content.
- No coding, builds, or browser suites on the owner's desktop machine.
- Empty `ci:` commits and slicing one round of fixes into a push series — a
  history with them does not get a GO.
- Merging `main` into a branch more than once per PR lifetime.
- Holding a green, ready PR to wait for a neighbor — order is fixed by
  migration numbers, not merge timing.
- A unit without a ticket, or coding before the ticket exists
  ([TICKETING.md](./TICKETING.md) §6).

## CTO standing orders (process)

- **Resume, do not interview.** For a listed stream these are resume-now
  signals, not owner questions: a failed local gate with an idle orchestrator;
  a finished writer with the next step not started; a dead claimed monitor; an
  idle orchestrator. Wake the existing orchestrator with the exact evidence
  (SHA, log path, next step), then verify first real activity. Do not
  interrupt a working agent. Do not inject a second writer onto the same
  branch.
- **What the CTO may tell the owner:** facts, violations, numbers, and the
  rare owner-zone decision ([GRILL.md](./GRILL.md), "The owner zone").
  "Should I wake it?" is forbidden for listed streams.
- **Daily first-round-GO readout:** every evening, the share of PRs whose
  first verdict was `R1 — GO`, with the NO-GO list and blockers. A PR merged
  without a countable verdict is reported as a merge-rule violation with the
  merger's name. The row exists even on a day with zero PRs.
- **Process ideas are written down first** (`docs/process-candidates/`), and
  promoted into the rulebook only when the owner says so or a week of combat
  numbers supports it. An incident that changes no instruction, check, or
  signal is not closed.
