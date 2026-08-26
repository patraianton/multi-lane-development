# Development-launch

Development-launch starts a **Development** run for one pipeline **card**
(Wave F). It reads the card from the board, derives a branch name, and on
`--run` talks to the card's assigned **lane** over ssh: fetch the product
repository, create the branch, write the **spec** to `TASK-<id>.md`, and
start the orchestrator from the lane's `launchCommand` template, detached,
with a log file. After ssh succeeds it POSTs the branch onto the card.

Terms, from [`CONTEXT.md`](../CONTEXT.md):

| word | meaning here |
| --- | --- |
| **Card** | A persistent pipeline task. Not a herdr window. |
| **Stage** | The column the card sits in. This process only starts a run for `development`. |
| **Lane** | The remote build slot already assigned to the card. |
| **Subscription** | The coding-agent account that pays for the run. Put in `{subscription}` and, when configured, exported as env. |
| **Spec** | The task text written into `TASK-<id>.md` on the lane. |

This file is the contract. The process is `bin/dev-launch.mjs`. It has no
external packages.

It never moves the card's stage, never picks a lane, never assigns a
subscription, never talks to herdr, and never waits for the orchestrator to
finish.

## Run

```
node bin/dev-launch.mjs <card-id>
node bin/dev-launch.mjs <card-id> --dry-run --config C:\temp\dev-launch.json
node bin/dev-launch.mjs <card-id> --run --config C:\temp\dev-launch.json
```

| flag | effect |
| --- | --- |
| `--dry-run` | Print every ssh/git command that **would** run, then exit. **Do not** ssh. **Do not** POST. This is the default. |
| `--run` | Actually ssh to the assigned lane and POST the branch onto the card. |
| `--config <file>` | Config JSON; default `state/dev-launch.json`. |
| `--card <id>` | Card id (same as the positional argument). |
| `--help` | Short help. |

An unknown flag, a missing card id, or `--dry-run` together with `--run`
exits `2`. A live `--run` that cannot proceed (no lane, incomplete config,
board down, ssh failed) is a clear English error and exit `1`.

`--dry-run` still talks to the board when `boardUrl` is set, so it can print
the real title, spec and lane. It never ssh-es and never POSTs. If the
config file is missing or pieces are empty, dry-run still prints a command
plan with placeholders and exits `0`.

Without `--run` nothing is started, even when the config is complete.

## Config

File: `state/dev-launch.json` (next to the board's other state files, not in
git), or any path passed to `--config`.

```json
{
  "boardUrl": "https://watchtower.example",
  "apiToken": "the-same-token-agents-use-on-the-board",
  "product": {
    "gitUrl": "git@github.com:org/repo.git",
    "defaultBranch": "main"
  },
  "lanes": {
    "lane-1": {
      "ssh": "root@203.0.113.10",
      "key": "id_ed25519",
      "workdir": "~/kitchens/repo/lane-1",
      "launchCommand": "codex exec --dangerously-bypass-approvals-and-sandbox \"Read {taskFile} and implement on {branch}\""
    },
    "mac/lane-a": {
      "ssh": "mac",
      "workdir": "~/kitchens/repo/lane-a",
      "launchCommand": "claude -p \"Read {taskFile} and implement on {branch} using {subscription}\""
    }
  },
  "subscriptions": {
    "cx1": { "CODEX_HOME": "/root/.codex-homes/cx1" },
    "claude-opus": { "CLAUDE_CONFIG_DIR": "/root/.claude-homes/opus" },
    "hz1": { "env": { "CODEX_HOME": "/root/.codex-homes/hz1" } }
  }
}
```

| field | required for `--run` | meaning |
| --- | --- | --- |
| `boardUrl` | yes | Board origin, `http://` or `https://`. A trailing slash is stripped. |
| `apiToken` | no | Sent as `Authorization: Bearer …` when set. Alias: `token`. |
| `product.gitUrl` | yes | Git URL the lane clones or fetches. |
| `product.defaultBranch` | no | Parent branch for the new feature branch. Default `main`. |
| `lanes` | yes, the card's lane | Map of lane id → how to reach that lane. |
| `subscriptions` | no | Map of subscription name → env hint. |

`product` may also be written as `repo`. A top-level `gitUrl` /
`defaultBranch` is accepted as the same thing.

A missing file, invalid JSON, or a live `--run` without the pieces above is
a clear English error. Dry-run against a missing file still prints a plan
and exits 0. Invalid JSON is always exit 1: that is a broken file, not a
missing piece.

### Lane entries

The key is the same string the card stores in `lane` (`lane-1`,
`mac/lane-a`). If the card says `host/lane-1` and only `lane-1` is in the
map, the lookup still matches.

| field | meaning |
| --- | --- |
| `ssh` | ssh target (`root@host` or a Host alias). `target` is accepted as the same thing. |
| `key` | Optional private-key **name** under `~/.ssh` (same convention as Watchtower's `hosts`). |
| `workdir` | Directory on the lane that holds (or will hold) the product checkout. `~/` is `$HOME/` on the remote. |
| `launchCommand` | Shell command started **after** the branch exists and `TASK-<id>.md` is written. |

`launchCommand` is a template. These placeholders are replaced before the
command is written to the runner script:

| placeholder | becomes |
| --- | --- |
| `{branch}` | `feat/card-<id>-<slug of the title>` |
| `{taskFile}` | `{workdir}/TASK-<id>.md` (`~/` rewritten as `$HOME/`) |
| `{subscription}` | The subscription name on the card, or empty |

Do not wrap `{taskFile}` in single quotes if the path starts with `$HOME/`
— single quotes would stop the remote shell expanding it. Double quotes are
fine.

ssh options are the same as Watchtower: `BatchMode=yes`,
`ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`. Override the binary
with `DEVLAUNCH_SSH` or `WATCHTOWER_SSH`.

### Subscription entries

The key is the name stored on the card (`cx1`, `claude-opus`). A string
value is treated as `CODEX_HOME`. An object may set:

| field | meaning |
| --- | --- |
| `CODEX_HOME` | Exported on the runner. Alias: `codexHome`. |
| `CLAUDE_CONFIG_DIR` | Exported on the runner. Alias: `claudeConfigDir`. |
| `env` | Extra `NAME=value` pairs, exported as well. |

The name still goes into `{subscription}` even when the map has no extra
env. An unknown name is a note in dry-run, not a hard failure: the run
still starts, with no extra env.

## What a launch does

1. `GET {boardUrl}/api/pipeline/card/{id}?format=json` (contract below).
2. Derive `feat/card-<id>-<slug(title)>`. The slug is the title in
   lowercase, with anything that is not a letter or a digit turned into
   `-`, clipped so the whole branch name stays short. No title →
   `feat/card-<id>`.
3. Over ssh to the card's assigned lane, as one remote `sh -s` script:
   1. `mkdir -p` the workdir. If it has no `.git`, `git clone` the product
      URL (first with `--branch defaultBranch`, then without). If it is
      already a repo, leave the files and `git fetch --prune origin`.
   2. Create the feature branch from `origin/<defaultBranch>` when the
      branch does not exist; if it already exists, check it out and do
      **not** reset it.
   3. Write `TASK-<id>.md` in the workdir (title, card id, branch, then
      the spec).
   4. Write `dev-launch-<id>.sh` (cd into the workdir, export subscription
      env, run the expanded `launchCommand`) and start it with `nohup`,
      stdin closed, stdout/stderr in `dev-launch-<id>.log`. Print
      `started pid …`.
4. `POST {boardUrl}/pipeline/card/update` with `{ id, links: { branch } }`.

`--dry-run` stops after step 2: it prints the plan, including the full
remote script, then exits 0. No ssh, no POST.

The process does not wait for the orchestrator. A later Wave F piece
(Local check) and the Watchdog look at the lane log and the card.

## Safety

**Never `--run` without a lane assigned.** If the card's `lane` is empty,
`--run` exits 1 and says so. This process will not pick a free lane, will
not round-robin, and will not wait for one. The same is true of a lane
name that is not in `config.lanes`.

Also refused on `--run`:

- card stage is set and is not `development`
- `product.gitUrl` missing
- the lane entry has no `ssh`, no `workdir`, or no `launchCommand`
- `boardUrl` missing
- `--dry-run` and `--run` together (that is usage, exit 2)

Dry-run never ssh-es, even with a complete config. `--run` is the only
way a remote command starts.

If ssh succeeds and the POST then fails, the process exits 1 and says the
lane run **has already started**. The branch name and the JSON body are in
the error so a human can POST the link by hand.

## HTTP contracts

Every request may carry:

```
Authorization: Bearer {apiToken}
```

when `apiToken` is set. `POST` bodies are `Content-Type: application/json`.
Trailing slashes on `boardUrl` are stripped before the path is joined. A
network error, a non-2xx status, a 20-second timeout or a non-JSON body is
a failure of that call.

The board must implement the two endpoints below. Unknown extra JSON
fields on either side are ignored.

### `GET {boardUrl}/api/pipeline/card/{id}?format=json`

One pipeline card, in full. Query `format=json` is required; this process
does not parse the short text form. `{id}` is URL-encoded.

**Contract: a JSON object for one card**, with at least:

```json
{
  "id": "cdev1",
  "title": "Ship the login page",
  "stage": "development",
  "lane": "lane-1",
  "subscription": "cx1",
  "spec": "Add a login page with email and password.",
  "links": {
    "ticket": "https://github.com/org/repo/issues/12",
    "branch": "",
    "pr": "",
    "artifact": ""
  }
}
```

| field | meaning |
| --- | --- |
| `id` | Pipeline card id. Required. |
| `title` | Used in the branch slug and as the `TASK-<id>.md` heading. |
| `stage` | Pipeline column. Compared case-insensitively; spaces and slashes become `_`, so `"Local check"` matches `local_check`. `--run` only accepts `development`. |
| `lane` | Lane id; looked up in config `lanes`. Empty or `"-"` means no lane. |
| `subscription` | Subscription name; looked up in config `subscriptions`. Empty or `"-"` means none. |
| `spec` | Written into `TASK-<id>.md`. Empty or `"-"` becomes `(no spec on the card)`. |
| `links` | Object, or the board's flattened string `"branch feat/foo, ticket https://…"`. Only `branch` is written back, after the launch. |

A wrapper `{ "card": { … } }` is also accepted. Empty optional fields may
be `""` or `"-"` — both mean "not set".

A 404 is "there is no card with that id". A 2xx body that is not an object
with `id` is an error for the whole process (dry-run and `--run` both
exit 1 when `boardUrl` was set and the fetch failed).

This is the same path as [`docs/API.md`](./API.md) (Pipeline, one card in
full). The live board's JSON view currently flattens `links` into a
string and prints `"-"` for an empty lane; both shapes are accepted.

### `POST {boardUrl}/pipeline/card/update`

Attach the new branch to the card. Same action as in [`docs/API.md`](./API.md)
**Changing a card**: `id` is required; only the keys sent are touched; an
omitted field keeps its value.

Headers:

```
Content-Type: application/json
Authorization: Bearer {apiToken}
```

Body:

```json
{
  "id": "cdev1",
  "links": {
    "branch": "feat/card-cdev1-ship-the-login-page"
  }
}
```

| field | meaning |
| --- | --- |
| `id` | Pipeline card id. Required by the board on every action except `create`. |
| `links.branch` | The branch this launch created (or checked out). Allowed link keys on the board are `ticket`, `branch`, `pr`, `artifact`. This process sends **only** `branch`. |

A 2xx response is success. The board should store `links.branch` and leave
stage, lane, subscription and spec alone. Posting the same branch twice is
a refresh, not a second event.

This process does not call `/pipeline/card/move`, `/pipeline/card/fail`, or
the Watchdog Status path. It does not invent a CI slot.

## Resilience

- Dry-run with a missing config file or empty `boardUrl` / `lanes` /
  `product` still prints a plan and exits 0.
- `--run` without a lane assigned is always a hard stop.
- ssh has a 180-second timeout (clone can be slow). The board calls have
  a 20-second timeout.
- The remote script is sent on ssh **stdin** (`sh -s`), so a long spec
  does not hit the Windows command-line length limit.
- `GIT_TERMINAL_PROMPT=0` on the remote, so a missing git credential
  fails instead of hanging.
- One failure is one English sentence on stderr, then a non-zero exit.
  There is no retry loop and no queue.

## Dry-run output

A default run (or `--dry-run`) prints a plan on stdout:

```
Development-launch dry-run plan
card: cdev1
title: Ship the login page
stage: development
lane: lane-1
subscription: cx1
branch: feat/card-cdev1-ship-the-login-page
taskFile: /root/kitchens/repo/lane-1/TASK-cdev1.md
logFile: /root/kitchens/repo/lane-1/dev-launch-cdev1.log
runnerFile: /root/kitchens/repo/lane-1/dev-launch-cdev1.sh

board: http://127.0.0.1:4890
config: C:\temp\dev-launch.json
GET http://127.0.0.1:4890/api/pipeline/card/cdev1?format=json

product:
  gitUrl: git@github.com:org/repo.git
  defaultBranch: main

lane config (lane-1):
  ssh: root@203.0.113.10
  workdir: /root/kitchens/repo/lane-1
  launchCommand: codex exec … {taskFile} … {branch}

launchCommand after {branch} {taskFile} {subscription}:
codex exec … /root/kitchens/repo/lane-1/TASK-cdev1.md … feat/card-cdev1-ship-the-login-page

git commands that WOULD run on the lane:
  mkdir -p /root/kitchens/repo/lane-1
  git clone --branch main git@github.com:org/repo.git /root/kitchens/repo/lane-1   # if … has no .git
  git -C … fetch --prune origin
  git -C … checkout -b feat/card-cdev1-ship-the-login-page origin/main

ssh command that WOULD run (remote script on stdin):
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@203.0.113.10 sh -s
----- remote script -----
#!/bin/sh
set -eu
…
----- end remote script -----

POST that WOULD run after ssh succeeds:
  POST http://127.0.0.1:4890/pipeline/card/update
  Authorization: Bearer <apiToken>
  {"id":"cdev1","links":{"branch":"feat/card-cdev1-ship-the-login-page"}}

done. no ssh, no POSTs.
```

Exit code 0 if the plan was printed. Use this with a stub config in a
scratch directory; do not write a test file into `state/`.
