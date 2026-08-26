# Probe

The probe is a small process on the owner's Windows machine. It is the only
bridge between local herdr and the remote board (see
[`adr/0002-board-server-lives-on-hetzner.md`](./adr/0002-board-server-lives-on-hetzner.md)
and
[`adr/0003-cto-is-a-herdr-window-hooks-via-probe.md`](./adr/0003-cto-is-a-herdr-window-hooks-via-probe.md)).

The board never calls herdr. Every `intervalSec` seconds the probe:

1. Collects a herdr snapshot (windows, panes, agent states — the same local
   calls `bin/watchtower.mjs` makes).
2. `POST`s that snapshot to the board.
3. `GET`s the pending hook queue and delivers each hook into the target herdr
   pane with `herdr pane run <window> -- <text>`.
4. `POST`s an ack for the hooks it actually delivered.

Lanes, pull requests and CI are not part of this payload: the board host can
read those itself.

## Run

```
node bin\probe.mjs
bin\probe.cmd
```

Flags:

| flag | effect |
|---|---|
| `--once` | one cycle, then exit |
| `--dry-run` | collect and print what would be sent and delivered; no network calls; no `herdr pane run` |
| `--help` | short help |

`--once --dry-run` works without a config file: it talks to local herdr only
and prints a snapshot summary plus an empty hook-delivery plan.

## Config

`state/probe.json` (not in git), next to the other Watchtower state files:

```json
{
  "boardUrl": "https://board.example.com",
  "token": "replace-me",
  "intervalSec": 15
}
```

| field | required | meaning |
|---|---|---|
| `boardUrl` | yes (except `--dry-run`) | board origin, `http://` or `https://`, no trailing slash needed |
| `token` | yes (except `--dry-run`) | shared secret; sent as `Authorization: Bearer {token}` |
| `intervalSec` | no | seconds between cycles; default `15`; must be >= 1 |

A missing file, broken JSON, or a live run without `boardUrl` / `token` prints
a clear English error and exits `1`.

## Local herdr calls

Same binary lookup as Watchtower: `%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe`,
then `herdr` on `PATH`.

Each cycle:

```
herdr api snapshot
herdr workspace list
herdr agent list
```

Delivery of a hook:

```
herdr pane run <window> -- <text>
```

`<window>` is the herdr pane id (for example `w4Z:p1`). The `--` stops flag
parsing so `<text>` can start with a dash. `HERDR_ENV=1` is set on that call
(herdr control commands require it).

If the herdr binary is missing, the probe prints where it looked and exits `1`.
If herdr is installed but a call fails in loop mode, the probe logs one line
and tries again on the next interval.

## HTTP contract

The board implements this contract. The probe is the client; the endpoints
live on the board server (`bin/watchtower.mjs`). Unknown extra JSON fields on
either side are ignored.

Board-side config lives in `state/autopase-board.json` (the same file as the
rest of the board settings):

| field | default | meaning |
|---|---|---|
| `probeToken` | empty | shared secret; must match the probe's `token`. Empty — every `/probe/*` path and `POST /hooks/enqueue` answer `403` `probe access is not configured` |
| `source` | `"local"` | `"local"` — collect windows from herdr on this machine (unchanged). `"probe"` — collect windows/panes/agents from the last posted snapshot; lanes, PRs and CI still come from this host |
| `probeStaleSec` | `60` | a snapshot older than this many seconds (or missing) is stale: the board header shows `probe stale since <time>` and `/api/board` lists it under `problems` |

A posted snapshot is kept in memory and in `state/probe-snapshot.json` (atomic
write, survives a restart) together with a `receivedAt` stamp. The hook queue
is `state/hooks.json`.

Every request carries:

```
Authorization: Bearer {token}
```

`POST` bodies are `Content-Type: application/json`. Trailing slashes on
`boardUrl` are stripped before the path is joined. The probe treats any
network error, HTTP status other than 2xx, or a 15-second timeout as "board
unreachable": it logs one line and keeps looping. It does not crash.

The three endpoints below (plus `POST /hooks/enqueue`) are what the probe
and later waves actually call.

### `POST {boardUrl}/probe/snapshot`

Replace the board's view of this machine's herdr with the body. The body is
the full snapshot, not a delta.

Request body:

```json
{
  "generatedAt": "2026-08-26T12:00:00.000Z",
  "host": "DESKTOP-EXAMPLE",
  "herdr": { "version": "0.8.2", "protocol": 1 },
  "focused": {
    "workspaceId": "w4Z",
    "tabId": "w4Z:t1",
    "paneId": "w4Z:p1"
  },
  "windows": [
    {
      "workspace_id": "w4Z",
      "label": "autopase-cto",
      "number": 31,
      "agent_status": "idle",
      "pane_count": 1,
      "tab_count": 1,
      "focused": true,
      "active_tab_id": "w4Z:t1",
      "worktree": {
        "checkout_path": "C:\\Users\\…\\autopase-cto",
        "is_linked_worktree": true,
        "repo_name": "autopase.lv",
        "repo_root": "C:\\Users\\…\\autopase.lv",
        "repo_key": "\\\\?\\C:\\Users\\…\\autopase.lv\\.git"
      }
    }
  ],
  "tabs": [
    {
      "tab_id": "w4Z:t1",
      "workspace_id": "w4Z",
      "label": "1",
      "number": 1,
      "pane_count": 1,
      "agent_status": "idle",
      "focused": true
    }
  ],
  "panes": [
    {
      "pane_id": "w4Z:p1",
      "tab_id": "w4Z:t1",
      "workspace_id": "w4Z",
      "cwd": "C:\\Users\\…\\autopase-cto",
      "agent_status": "idle",
      "focused": true,
      "revision": 1,
      "terminal_id": "term_…"
    }
  ],
  "agents": [
    {
      "pane_id": "w4Z:p1",
      "tab_id": "w4Z:t1",
      "workspace_id": "w4Z",
      "agent": "claude",
      "agent_status": "idle",
      "cwd": "C:\\Users\\…\\autopase-cto",
      "focused": true,
      "revision": 1,
      "state_change_seq": 10,
      "terminal_id": "term_…",
      "terminal_title": "✳ Grill card 12",
      "terminal_title_stripped": "Grill card 12",
      "agent_session": {
        "agent": "claude",
        "kind": "id",
        "source": "herdr:claude",
        "value": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      }
    }
  ]
}
```

Field notes:

- `windows` come from `herdr workspace list` (falling back to the snapshot's
  workspaces). This is the herdr window list; the board attaches them to
  cards. `worktree` is omitted when the window is not bound to git.
- `tabs` and `panes` come from `herdr api snapshot`. Pane `scroll` is dropped
  so the payload stays small.
- `agents` come from `herdr agent list` (falling back to the snapshot's
  agents). Only panes with a recognized agent appear here; a window with no
  agent has panes but no agent row.
- `agent_status` is one of `idle`, `working`, `blocked`, `done`, `unknown`.
- Ids (`w4Z`, `w4Z:t1`, `w4Z:p1`) are stable until that window/tab/pane is
  closed; they are not reused.

Response: `200` or `204`. Body is ignored. `401` (English text `unauthorized`)
if the token is missing or wrong; `403` `probe access is not configured` if
the board has no `probeToken`. A body larger than 2 MB is `413`
`payload too large` — including a chunked body with no `Content-Length`: the
rest of it is read and dropped so the answer still arrives, the connection is
not torn down. Broken JSON or a body that is not an object (or whose
`windows` / `tabs` / `panes` / `agents` fields are present but not arrays)
is `400`. Entries inside those four lists that are not objects (a `null`, a
number, a string) are dropped on the way in and are not stored.

### `GET {boardUrl}/probe/hooks`

The queue of hooks waiting to be typed into a herdr pane. Oldest first.

Response `200`, `Content-Type: application/json`. The board sends a wrapped
object; the probe also accepts a bare array:

```json
{ "hooks": [ { "id": "hk_01", "window": "w4Z:p1", "text": "Grill card 12" } ] }
```

An empty queue is `{ "hooks": [] }`, never a missing body. Oldest first.
Each entry also carries `queuedAt` (ISO timestamp); the probe ignores extra
fields.

| field | type | meaning |
|---|---|---|
| `id` | string | durable id of this hook; the ack names it |
| `window` | string | herdr pane id to run in (`w4Z:p1`) |
| `text` | string | command/text passed after `--` to `herdr pane run` |

Leave a hook on the queue until it is acked. Delivery is at-least-once: if
the probe delivers and then fails to ack, it will try the same hook again on
the next cycle. The board should treat a repeated ack of the same `id` as
success, not as an error.

### `POST {boardUrl}/probe/hooks/ack`

Mark hooks as delivered so they leave the queue.

Request body:

```json
{ "ids": ["hk_01", "hk_02"] }
```

The probe only lists ids it actually ran successfully. It does not ack
malformed hooks (missing `id` or `window`) or hooks whose `pane run` failed.
It does not call this endpoint when `ids` would be empty.

Response: `200` or `204`. Unknown ids are ignored (idempotent). The board
answers `{ "ok": true, "removed": N }` — how many entries actually left the
queue. The probe ignores the body.

### `POST {boardUrl}/hooks/enqueue`

Not called by the probe. Later waves (and anything holding the same token)
queue a hook for delivery:

```json
{ "window": "w4Z:p1", "text": "Grill card 12" }
```

Same Bearer auth as `/probe/*`. `window` and `text` are required (non-empty);
otherwise `400`. `window` must be a herdr id — `w4Z:p1` or `w4Z:t1`; anything
else (an object, a title, a path) is `400`, because the probe could never
deliver it and the entry would sit on the queue for ever. Response `200` with the queued entry `{ id, window, text, queuedAt }`.

When a hook has been sitting on the queue for more than ten minutes the board
header shows `hooks queued, oldest Nm`.

## Failure behaviour

| situation | what the probe does |
|---|---|
| no `state/probe.json` on a live run | English error, exit `1` |
| herdr binary missing | English error listing the paths tried, exit `1` |
| herdr call fails in a loop | one log line, try again next interval |
| board down, timeout, non-2xx | one log line, keep looping |
| one hook's `pane run` fails | that id is not acked; others still are |
| `--dry-run` | no HTTP, no `pane run`; prints the snapshot summary and an empty delivery plan |

Every log line starts with an ISO timestamp.

## Example dry-run

```
node bin\probe.mjs --once --dry-run
```

```
[2026-08-26T12:00:00.000Z] dry-run: would POST {boardUrl}/probe/snapshot
generatedAt 2026-08-26T12:00:00.000Z
host        DESKTOP-EXAMPLE
payload     12345 bytes, windows 44, tabs 54, panes 54, agents 38
window states  blocked=4 idle=20 unknown=8 working=12
agent states   blocked=4 done=2 idle=20 working=12
focused     workspace=w4Z tab=w4Z:t1 pane=w4Z:p1
windows:
  w4Z   autopase-cto                      idle      panes=1  focused
  …
[2026-08-26T12:00:00.000Z] dry-run: would GET {boardUrl}/probe/hooks
[2026-08-26T12:00:00.000Z] dry-run: hook-delivery plan: 0 pending (no board contact in dry-run)
```
