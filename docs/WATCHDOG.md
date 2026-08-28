# Watchdog

The Watchdog is the board's built-in checker (Wave G). Every `intervalMin`
minutes it looks at each **active** pipeline **card**, gathers evidence, asks a
cheap language model for a one-line **Status** and a verdict, and writes that
back onto the card.

Terms, from [`CONTEXT.md`](../CONTEXT.md):

| word | meaning here |
| --- | --- |
| **Card** | A persistent pipeline task. Not a herdr window. |
| **Stage** | The column the card sits in (`development`, `local_check`, `ci_pr`, …). |
| **Status** | The one-line "what is happening right now", written by this process. Distinct from Stage. |
| **Watchdog** | This process. |
| **Lane** | The remote build slot assigned to the card. |

Active stages (the only cards that are scored): `development`, `local_check`,
`ci_pr`. A card in `spec`, `grilled`, `ticketed`, `acceptance`, `accepted` or
`stuck` is listed and skipped.

The Watchdog never moves a card, never starts a run and never talks to herdr.
It only reads evidence and POSTs Status.

This file is the contract. The process is `bin/watchdog.mjs`. It has no
external packages.

## Run

```
node bin/watchdog.mjs run
node bin/watchdog.mjs --once
node bin/watchdog.mjs --once --dry-run --config C:\temp\watchdog.json
node bin/watchdog.mjs run --dry-run --max-ticks 1
```

| flag / command | effect |
| --- | --- |
| `run` | the long-running loop (what the systemd unit starts). Without `--once` the process loops anyway; `run` is the documented name for that |
| `--once` | one sweep, then exit |
| `--dry-run` | fetch the pipeline; print the evidence and the prompt that **would** go to the language model; **do not** call ssh, `gh`, or the model; **do not** POST Status |
| `--max-ticks N` | loop at most N sweeps, then exit. For tests. Do not leave a loop running |
| `--config <file>` | config JSON; default `state/watchdog.json` |
| `--help` | short help |

An unknown flag exits `2`. A missing or incomplete config file is a clear
English error and exit `1`.

`--dry-run` still talks to the board (to list cards). It does **not** call
ssh, `gh`, or the model, and it does not POST Status. The plan it prints
says what those calls **would** have been.

Without `--once` the process loops forever, sleeping `intervalMin` minutes
between sweeps. It reloads the config file each cycle so a change of interval
or command takes effect without a restart. SIGINT / SIGTERM stop it.

This is a **separate process** from the board. The board (`watchtower.service`)
serves the page and the Status write endpoint. The Watchdog
(`watchtower-watchdog.service`) is the checker that POSTs Status. Do not fold
it into the board process.

Unit file: [`deploy/watchtower-watchdog.service`](../deploy/watchtower-watchdog.service).
Install only after `state/watchdog.json` exists — without that file the
process exits 1 and systemd would restart it every few seconds:

```
install -m 0644 /opt/watchtower/deploy/watchtower-watchdog.service /etc/systemd/system/watchtower-watchdog.service
systemctl daemon-reload
systemctl enable --now watchtower-watchdog
```

## Config

File: `state/watchdog.json` (next to the board's other state files, not in
git), or any path passed to `--config`.

```json
{
  "boardUrl": "https://watchtower.example",
  "apiToken": "the-same-token-agents-use-on-the-board",
  "intervalMin": 15,
  "llmCommand": "claude -p --model haiku",
  "lanes": {
    "lane-1": {
      "ssh": "root@203.0.113.10",
      "key": "id_ed25519",
      "command": "tail -n 80 /var/log/hzlane/lane-1.log"
    },
    "mac/lane-a": {
      "ssh": "mac",
      "log": "~/kitchens/autopase.lv/lane-a/watch.log"
    }
  }
}
```

| field | required | meaning |
| --- | --- | --- |
| `boardUrl` | yes | Board origin, `http://` or `https://`. A trailing slash is stripped. |
| `apiToken` | yes | Sent as `Authorization: Bearer …` on every board request. |
| `intervalMin` | no | Minutes between sweeps. Default `15`. Must be >= 1. |
| `llmCommand` | yes, except `--dry-run` | Shell command that reads the prompt on **stdin** and prints Status on stdout. A JSON array of argv is also accepted: `["claude", "-p", "--model", "haiku"]`. |
| `lanes` | no | Map of lane id → how to read that lane's log. Default `{}`. |

### Lane entries

The key is the same string the card stores in `lane` (`lane-1`,
`mac/lane-a`). If the card says `host/lane-1` and only `lane-1` is in the
map, the tail still matches.

| field | meaning |
| --- | --- |
| `ssh` | ssh target (`root@host` or a Host alias). `target` is accepted as the same thing. |
| `key` | Optional private-key **name** under `~/.ssh` (same convention as Watchtower's `hosts`). |
| `command` | Remote command. Typical value: `tail -n 80 /path/to.log`. |
| `log` | Shorthand: used as `tail -n 80 <log>` when `command` is omitted. |

If `ssh` is omitted, `command` runs on this machine (a local `tail`). A live
lane should always set `ssh`.

ssh options are the same as Watchtower: `BatchMode=yes`,
`ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`. Override the binary
with `WATCHDOG_SSH` or `WATCHTOWER_SSH`. Override `gh` with `WATCHDOG_GH` or
`WATCHTOWER_GH`.

A missing file, invalid JSON, or an incomplete object is a clear English
error and exit code 1. Restart after you edit the file, or wait for the next
cycle if the process is already looping.

## What a sweep does

1. `GET {boardUrl}/api/pipeline?format=json` (contract below).
2. For each card whose Stage is `development`, `local_check` or `ci_pr`:
   1. Tail the lane log (ssh command from `lanes`, if the card has a lane).
   2. If the card has `links.pr`, ask `gh` for that pull request and its
      checks. If `gh` is not installed, the evidence says so.
   3. Build a compact prompt (card identity, previous Status, lane tail, CI).
   4. Run `llmCommand` with that prompt on stdin.
   5. Parse one Status line and a verdict `moving` \| `stalled` \| `looping`.
   6. `POST {boardUrl}/pipeline/card/{id}/status` with `{ text, verdict }`.
3. Sleep `intervalMin` minutes (unless `--once` or `--max-ticks` is reached).

`--dry-run` stops after step 2.3: it prints the evidence (what ssh / `gh`
**would** have been asked) and the prompt, then moves on. No ssh, no `gh`,
no model, no POST.

## Evidence

Failures here become evidence, not a skipped card. The model can still write
a Status from "ssh did not answer".

| source | when | on failure |
| --- | --- | --- |
| Lane log | card has `lane` and that id is in `lanes` | "ssh failed: …" / "no ssh command configured for lane …" |
| CI | card has `links.pr` (a URL, `owner/repo#N`, or `#N`) | "gh CLI is not available" / "gh failed: …" / "no PR link on the card" |

The log tail is clipped to 3000 characters before it goes into the prompt.
CI is a few lines: PR number, title, state, green / red / running.

## Language-model command

`llmCommand` is whatever cheap model you already have on the machine. The
Watchdog does not pick a vendor. Examples:

```
claude -p --model haiku
claude -p --model claude-haiku-4-5
["claude", "-p", "--model", "haiku"]
```

The prompt is written to stdin (it is never interpolated into the command
line). The process must print, and nothing else of importance:

```
STATUS: Codex is running the local check on lane-2; last log line is "3 passing".
VERDICT: moving
```

A JSON object `{"text":"…","verdict":"moving"}` (or `"status"` instead of
`"text"`) is also accepted. `text` is stored as the card's Status, clipped to
400 characters, one line.

If the model returns neither a Status nor a verdict, that **card** is logged
and skipped; the rest of the sweep continues.

A live run without `llmCommand` is a config error and the process refuses to
start. `--dry-run` does not need it.

## HTTP contracts

Every request carries:

```
Authorization: Bearer {apiToken}
```

`POST` bodies are `Content-Type: application/json`. Trailing slashes on
`boardUrl` are stripped before the path is joined. A network error, a
non-2xx status, a 20-second timeout or a non-JSON body is a failure of that
call.

The board must implement the two endpoints below so this process can talk to
it. Unknown extra JSON fields on either side are ignored.

### `GET {boardUrl}/api/pipeline?format=json`

The list of pipeline cards. Query `format=json` is required; the Watchdog
does not parse the short text form.

**Contract: a JSON array of cards**, each with at least:

```json
[
  {
    "id": "c-dev",
    "title": "Ship the Watchdog",
    "stage": "development",
    "lane": "lane-2",
    "links": {
      "ticket": "https://github.com/org/repo/issues/12",
      "branch": "feat/watchdog",
      "pr": "https://github.com/org/repo/pull/34",
      "artifact": "https://example.com/artifact"
    }
  }
]
```

| field | meaning |
| --- | --- |
| `id` | Pipeline card id. Required. A row without `id` is dropped. |
| `title` | Shown in the prompt. |
| `stage` | Pipeline column. Compared case-insensitively; spaces and slashes become `_`, so `"Local check"` and `"CI/PR"` match `local_check` and `ci_pr`. |
| `lane` | Lane id; looked up in config `lanes`. Empty means no log tail. |
| `links` | Object. `pr` is what CI evidence uses (URL, `owner/repo#N`, or `#N`). |

Optional extras the Watchdog will put in the prompt when present: `status`
(`text`, `verdict`, `at`), `slot`, `subscription`, `consecutiveFails`. A
wrapper `{ "cards": [ … ] }` is also accepted, so a board that already
returns an object with a `cards` array does not need a second endpoint.

A 2xx JSON body of any other shape is an error for the **sweep** (logged; in
`--once` the process exits 1). It is not a per-card skip.

### `POST {boardUrl}/pipeline/card/{id}/status`

Write the Watchdog's Status onto that card. `{id}` is URL-encoded.

Headers:

```
Content-Type: application/json
Authorization: Bearer {apiToken}
```

Body:

```json
{
  "text": "Codex is running the local check on lane-2; last log line is \"3 passing\".",
  "verdict": "moving"
}
```

| field | meaning |
| --- | --- |
| `text` | The Status line. One sentence, plain English. The Watchdog clips it to 400 characters. |
| `verdict` | `moving`, `stalled`, or `looping`. No other word is sent. |

`moving` — work is progressing. `stalled` — nothing useful has happened
recently. `looping` — the same failure or the same step is repeating.

A 2xx response is success. The board should store `text` and `verdict` on
the card (and a timestamp) and show them as Status, not as Stage. Any other
HTTP status is a failure of **this card**: the Watchdog logs it and moves
on. Posting the same Status twice should be treated as a refresh, not as a
second event.

The Watchdog does not call any other board path. It does not POST
`/pipeline/card/update`; the path above is the Status contract. The board
implements this exact path (auth: founder session / localhost-as-owner /
Bearer `apiToken`, same as the other pipeline writes). `verdict` must be
one of `moving` \| `stalled` \| `looping` or the board answers 400. `text`
is clipped to 400 characters. The card is stored as
`status: { text, verdict, at }`.

`POST /pipeline/card/update` with a `status` object can write the same
fields. The Watchdog does not use it.

## Stale Status

The Watchdog is meant to refresh every `intervalMin` minutes (default 15).
An **active** card (`development`, `local_check`, `ci_pr`) whose Status is
missing, or older than twice that interval, is **stale** — the checker
itself is the signal.

- `/api/pipeline` summary carries `stale status N`.
- `/api/board` `problems` carries a `watchdog` row when N > 0.
- The pipeline card on the page colours the verdict (`moving` = ok,
  `stalled` = warn, `looping` = alarm), shows how long ago Status was
  written, and marks it stale.

Without a `watchdog.json` the missing-Status case is silent: the surface
shows nothing until a Status exists. An old Status is still marked.

## Resilience

- One card throwing (bad model output, ssh hung past the timeout and then
  the parser failed, the Status POST 500'd) is logged as
  `card {id}: skipped: …` and the sweep continues.
- Evidence failures (ssh down, `gh` missing) stay on the card as evidence.
- The board being unreachable fails the **sweep**. In loop mode that is one
  log line and a wait until the next interval. With `--once` it is exit `1`.
- ssh and `gh` each have their own timeout (~20–25 s). The model call is
  killed after 90 s.

## Dry-run output

`--once --dry-run` prints a plan on stdout (logs go to stderr). ssh and
`gh` are not actually run:

```
Watchdog dry-run plan
board: http://127.0.0.1:4878
intervalMin: 15
llmCommand: claude -p --model haiku  (NOT called in dry-run)
lanes: lane-1
GET http://127.0.0.1:4878/api/pipeline?format=json
cards: 3  (active 2, skipped 1)
active stages: development, local_check, ci_pr

--- card c-dev  "Ship the Watchdog"  stage=development ---
lane: lane-2
evidence:
  laneLog: no ssh command configured for lane "lane-2" (known: lane-1)
  ci: no PR link on the card
prompt that WOULD be sent to llmCommand on stdin:
-----
You are the Watchtower Watchdog. …
-----
would POST http://127.0.0.1:4878/pipeline/card/c-dev/status
  { "text": "(llm would write this)", "verdict": "moving|stalled|looping" }

--- card c-spec  "Not active"  stage=spec ---
skipped: stage "spec" is not active
active stages: development, local_check, ci_pr

done. no LLM call, no ssh, no POSTs.
```

Exit code 0 if the pipeline was read. Use this with a stub config in a
scratch directory; do not write a test file into `state/`.
