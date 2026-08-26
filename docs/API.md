# Watchtower for agents

How to read the board without a browser and without screenshots — one command or
one request. The shape of the answer is pinned: the page lives on `/data` and its
fields change together with the layout, while an agent reads `/api/board`, so
editing the page never breaks it.

## One command

```
bin\wt.cmd                 the live board as short text
bin\wt.cmd --full          long texts in full, no clipping
bin\wt.cmd --json          the same shape as plain JSON
bin\wt.cmd --card <name>   one window in full
bin\wt.cmd pipeline        the delivery pipeline as short text
bin\wt.cmd --pipeline      the same as pipeline
bin\wt.cmd pipeline --full specs in full, no clipping
bin\wt.cmd pipeline --json the same shape as plain JSON
bin\wt.cmd card <id>       one pipeline card in full
bin\wt.cmd --help          help for every field
```

The command computes nothing itself — it asks the running server. The server has
to be up (`bin\watchtower.cmd`). If it does not answer, the command says so and
exits with code 1. If the port holds a board from an older build (without the
`/api/board` endpoint), the command says that and asks for a restart — it never
relays a foreign response body. `pipeline` and `--pipeline` read `/api/pipeline`;
`card <id>` reads `/api/pipeline/card/<id>`. An unknown flag or argument exits
with code 2 and lists the allowed ones. With `--json` errors arrive as JSON too
(`{"error": …, "help": …}`), so parsing never breaks. The port comes from
`WATCHTOWER_PORT` (the older `AUTOPASE_BOARD_PORT` is still read as a fallback),
4878 by default.

## One request

```
GET http://127.0.0.1:4878/api/board            short text (TOON-flavoured)
GET http://127.0.0.1:4878/api/board?format=json
GET http://127.0.0.1:4878/api/board?full=1
GET http://127.0.0.1:4878/api/board/card/<name> one card in full
GET http://127.0.0.1:4878/api/slots            CI slot occupancy (JSON)
GET http://127.0.0.1:4878/api/slots?format=toon
```

Parameters:

| parameter | values | default | what it does |
| --- | --- | --- | --- |
| `format` | `toon`, `json` | `toon` | shape of the answer: short text or JSON |
| `full` | `1`, `0` | `0` | `1` — long texts in full, no clipping (`/api/board` only) |

Any other parameter or value answers 400 with a short error and a hint. An empty
value (`?format=`, `?full=`) is 400 as well: a value is spelled out. The same
parameter twice (`?format=toon&format=json`) is 400 too — the board does not guess
which one you meant and will not silently drop the second. If the board could not
be collected (herdr not answering, say) it is 500 with the same short error.
Errors arrive as plain text and are read the same way as data.

Collection goes the same path as for the page: the slow sources (ssh to the lane
hosts, `gh`) refresh on their own timers inside the board and hand over what is
ready, so a request makes no extra call outward.

## What is in the answer

Four lines about the board itself first:

- `board` — the board's address;
- `generated` — when this snapshot was collected;
- `repo` — the repository PRs are counted from;
- `summary` — counters: **windows** (window cards), **waiting for you** (how many
  cards wait for a human), **lanes building** (how many lanes are busy),
  **open PRs**, **manual** (cards typed on the board by hand), **hidden** (windows
  taken off the board with the ×).

Then five sections. An empty section is written as an explicit zero in words
(`cards: 0 — no cards on the board`), never as emptiness.

### cards — one card per line

| field | meaning |
| --- | --- |
| `column` | board column: `ask` — needs you; `running` — working; `waiting` — the window is silent but its lane is building; `idle` — idle; `off` — window with no agent |
| `name` | window name (or the title of a card typed by hand). The same name is taken by `/api/board/card/<name>` and `--card` |
| `state` | agent state: `working`, `idle`, `blocked`, `done`, `unknown`; a hand-typed card is `manual` |
| `ask` | does this card wait for a human: `yes` / `no` |
| `pr` | newest open PR of the window and its CI colour (`green`, `red`, `running`, `no-checks`); `+N` — how many more the window has; `-` — none of its own |
| `lanes` | busy lanes of the window as `host/lane-N`, space separated; `-` — none |

### asks — who is waiting and why

`name` — the card; `why` — the reasons (window `blocked`, an ask marker in the
last words, an unanswered question in an umbrella issue, or — for a hand-typed
card — the column itself); `question` — a reference to an umbrella such as
`#1299`, the text sits in the `questions` section. A card with no umbrella has `-`.

A hand-typed card the owner put into the `ask` column lands here next to the
windows and counts in **waiting for you**.

### questions — questions from umbrella issues

`umbrella` — the umbrella number (`#1299`); `text` — the question itself. Each
question is printed once, however many windows of the program point at it.

### words — the start of each window's last words

`name` — the window; `from` — where the words came from (`session log`,
`previous session log`, `window screen`, `typed by hand`); `text` — the first 80
characters with a note of the total. In full — `/api/board/card/<name>` (one
window) or `?full=1` (the whole board).

### problems — board sources that did not answer

`source` — what failed (`lanes`, `pull-requests`, `umbrella`, `lane host mac`,
`ci-slots`, and so on); `error` — the short reason. An empty section means every
source is alive. This is worth reading: an empty `lanes` cell with ssh down means
"the board does not know", not "there are no lanes". Before a project is chosen,
`problems` carries one row, `project: no project chosen yet` — open the board and
pick one.

When every CI slot is held by a card, `problems` carries `ci-slots: no free CI
slot — add capacity`. That is an alarm, not a wait: there is no queue. The same
sentence appears in the page header. Occupancy itself is `GET /api/slots`.

## Clipping of long texts

On a board sweep long texts are clipped and marked with their size
(`… (clipped, 412 chars total)`), so it is visible how much was not read:

- `text` in `words` — 80 characters (the bulkiest part of the answer, and the most
  reference-like);
- `why` in `asks` and `text` in `questions` — 200 characters.

`--full` / `?full=1` lifts the clipping for the whole board, `--card <name>` /
`/api/board/card/<name>` for one window. The board itself remembers the first 400
characters of the last words and the first 300 characters of an umbrella question,
so no request will ever show more than that.

## One card in full

```
bin\wt.cmd --card my-window
GET http://127.0.0.1:4878/api/board/card/my-window
```

It answers with plain `field: value` lines: `card`, `column`, `state`, `ask`,
`why`, `umbrella`, `question`, `pr`, `lanes`, `words-from`, `words` — all without
clipping. `?format=json` gives the same as JSON. A name spelled differently from
the `name` cell gets 404 and the list of names currently on the board. The `full`
parameter is not needed here and is rejected with 400: this view prints in full
anyway.

## Sample output

```
bin: ~\projects\watchtower\bin\wt.cmd
description: Watchtower: herdr windows, build lanes, PRs and who is waiting for you
board: http://127.0.0.1:4878
generated: 2026-08-26T12:51:41.610Z
repo: acme/web
summary: windows 10, waiting for you 3, lanes building 3, open PRs 7, manual 0, hidden 8
cards[5]{column,name,state,ask,pr,lanes}:
  running,grok,working,no,-,-
  running,coolify-migration,working,no,#1319 running,-
  ask,cards-popular,done,yes,-,-
  ask,cards-salon,working,yes,#1304 green,mac/lane-a
  waiting,cabinet-slow,done,no,#1318 running +1,builder/lane-1 builder/lane-2
asks[3]{name,why,question}:
  cards-popular,umbrella #1299 has a question with no answer,#1299
  cards-salon,umbrella #1299 has a question with no answer,#1299
  cabinet-messaging,window is blocked — waiting for an answer,-
questions[1]{umbrella,text}:
  #1299,"Which of the two layouts should ship first? … (clipped, 300 chars total)"
words[2]{name,from,text}:
  grok,window screen,\ Waiting… [stop]
  cards-salon,session log,"Round 2 review on B2: no blockers… (clipped, 400 chars total)"
problems[1]{source,error}:
  lane host builder,ssh did not answer
help[4]:
  words holds only the start of the last words; one window in full — /api/board/card/<name>, the whole board in full — ?full=1
  in asks the question cell is a reference to an umbrella; the text is in the questions section
  ?format=json — the same shape as plain JSON
  columns: ask — needs you, running — working, waiting — window is silent, its lane is building, idle — idle, off — no agent
```

## Pipeline

The board also carries the delivery pipeline: persistent **cards** that move from
a spec to acceptance. A card is not a window — it lives in the board's own state
(`state/pipeline-cards.json`), keeps its spec, its comments, its per-stage clocks
and its failure counters, and only leaves a stage through a validated transition.
The windows endpoints above are untouched by any of this; the pipeline has
endpoints of its own.

```
GET http://127.0.0.1:4878/api/pipeline             short text (TOON-flavoured)
GET http://127.0.0.1:4878/api/pipeline?format=json
GET http://127.0.0.1:4878/api/pipeline?full=1
GET http://127.0.0.1:4878/api/pipeline/card/<id>   one card in full
```

`format` and `full` behave exactly as on `/api/board`, down to the wording of the
errors: an unknown parameter, an unknown value, an empty value or the same
parameter twice all answer 400 with a hint. `full` is rejected on the single-card
view — it prints in full anyway.

### Stages

A card sits in one stage at a time:

| stage | meaning |
| --- | --- |
| `spec` | a founder has written what is wanted; nothing is decided yet |
| `grilled` | the CTO has interrogated the spec and folded the answers back in |
| `development` | code is being written on the assigned lane |
| `local_check` | the local check runs on the same lane |
| `ci_pr` | a PR is open and CI runs on the assigned slot |
| `acceptance` | done as far as the pipeline is concerned; the owner decides |
| `accepted` | terminal; the card is finished |
| `stuck` | three failures in a row — the loop itself is the problem, a human has to look |

The road is one-way: `spec → grilled → development → local_check → ci_pr →
acceptance → accepted`. Nothing else is a move. A **failure** (`local`, `ci` or
`acceptance`) puts the card back into `development` and raises both its own
counter and `consecutiveFails`; the third consecutive failure sends it to `stuck`
instead. A failure can only be reported from a stage where something was actually
run — `development`, `local_check`, `ci_pr`, `acceptance`. From `spec` or
`grilled` it is a 400: nothing has been built yet, and answering it would carry
the card into `development` around the grill. Any stage passed successfully resets `consecutiveFails` to zero, and so
does a human pulling the card out of `stuck` — the decision buys the card a fresh
run of three.

### Clocks

Every clock is computed from `stageHistory` — the list of `{stage, enteredAt,
leftAt}` segments a card has been through. `clock` on the list is the card's
**delivery time**: the sum of every segment except `acceptance` and `accepted`.
Acceptance is the owner's decision, not the pipeline's work, so a card waiting
there does not age — its `clock` is printed with `(stopped)`. The wait itself is
still written into the history and is readable in `clock-by-stage`, so "the owner
sat on it for two days" is never lost, it is just not charged to delivery.

### What is in the answer

Three lines about the pipeline itself (`pipeline`, `generated`, `summary` —
counters: **cards**, **stuck**, **waiting for acceptance**, **accepted**,
**failures**), then:

- `cards` — one card per line: `id`, `title`, `stage`, `clock`, `fails`
  (`local 3 ci 1 (1 in a row)`, or `-`), `verdict` (the watchdog's word: `moving`,
  `stalled`, `looping`, or `-`);
- `stuck` — the cards waiting for a human, with how long they have been waiting;
- `specs` — under `?full=1` only, the spec text of every card that has one.

The long parts of a card — the spec as written, every comment, the whole stage
history — are not on the list at all. They are read one card at a time:

```
GET http://127.0.0.1:4878/api/pipeline/card/<id>
```

which answers with plain `field: value` lines (`card`, `title`, `stage`,
`created`, `clock`, `clock-by-stage`, `fails`, `consecutive-fails`, `lane`,
`subscription`, `slot`, `links`, `status`, `spec`) plus a `comments` table and a
`history` table. An unknown id gets 404 and the ids currently in the pipeline.

### Changing a card

Every change is a POST with a JSON body to `/pipeline/card/<action>`. All of them
except `create` need `id`. A body that does not say what it must gets 400 with
the reason in plain words; the store is left exactly as it was.

| action | body | what it does |
| --- | --- | --- |
| `create` | `title` (required), `spec` | a new card at the `spec` stage |
| `move` | `to` | one step along the road; anything else is 400 |
| `fail` | `kind`: `local` \| `ci` \| `acceptance` | counts the failure, back to `development` — or to `stuck` on the third in a row; only from `development`, `local_check`, `ci_pr`, `acceptance` |
| `unstuck` | — | a human returns the card to `development` and clears the streak |
| `accept` | — | `acceptance → accepted` |
| `comment` | `author`, `text` (`text` required; `author` required unless a founder is signed in) | one flat comment on the card. A signed-in founder who omits `author` is stored under that founder's name |
| `update` | `links` (`ticket`, `branch`, `pr`, `artifact`), `lane`, `subscription`, `slot`, `spec`, `status` (`text`, `verdict`) | attaches what the card points at; only the keys sent are touched, an empty string clears one |

A separate path assigns who pays for the run and **walks the card forward**:

```
POST /pipeline/assign-subscription
{ "cardId", "subscription", "by" }
```

Valid only while the card is in `grilled` and `subscription` is empty.
`subscription` must be one of the names in the board config's
`subscriptions` array. The board sets it, records a comment
`subscription <name> assigned by <by>`, and moves the card to
`development`. `by` is a string or `{ "name", "tag", "tgUserId" }`
(what the Telegram bot sends). Wrong stage, unknown name, already
assigned, or a missing field → `400`. Auth is the same as the other
pipeline mutations.

When `auth.founders` is empty or missing, the windows and pipeline endpoints
stay open — the board listens on `127.0.0.1` only, as before. When the list
is set, those paths need a founder session, a localhost-as-owner request, or
(for agents) `apiToken`. See **Auth** below. The probe endpoints use
`probeToken`, as they always did.

## CI slots

A pool of dedicated CI servers. Holders live in `state/ci-slots.json`, written
by [`bin/ci-slot.mjs`](../bin/ci-slot.mjs) (see [`EXECUTION.md`](./EXECUTION.md)).
The board only reads the file.

```
GET http://127.0.0.1:4878/api/slots
GET http://127.0.0.1:4878/api/slots?format=json
GET http://127.0.0.1:4878/api/slots?format=toon
```

Auth is the same as the other `/api/*` reads: open while `auth.founders` is
empty; otherwise a founder session, localhost-as-owner, or `apiToken`. `format`
defaults to `json` (this endpoint's shape is a small object). `full` is not
accepted. An unknown parameter, an unknown value, an empty value or the same
parameter twice answers 400 with a hint, same words as `/api/board`.

JSON:

```json
{
  "slots": [
    { "name": "ci-1", "card": "cci1", "since": "2026-08-26T12:00:00.000Z" },
    { "name": "ci-2", "card": null, "since": null },
    { "name": "ci-3", "card": null, "since": null }
  ]
}
```

| field | meaning |
| --- | --- |
| `name` | Slot id, the same string the card stores in `slot` |
| `card` | Pipeline card id holding the slot, or `null` when free |
| `since` | When that holder was claimed, or `null` when free |

When every listed slot has a `card`, the object also has
`"alarm": "no free CI slot — add capacity"`. That is not a queue: the CI-slot
process exits 3 and assigns nothing; the fix is adding a slot. The same
sentence is a `problems` row (`source: ci-slots`) on `/api/board` and the page
header flag. A missing occupancy file is an empty `slots` array and no alarm —
there is no pool on disk yet.

## Auth

Founder sign-in is off until `auth.founders` is a non-empty list in
`state/autopase-board.json`. With no `auth` block the board is unchanged: every
path that was open stays open.

```json
{
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
  "apiToken": "a long random secret for agents",
  "probeToken": "the probe's shared secret"
}
```

| field | default | meaning |
| --- | --- | --- |
| `auth.founders` | empty | allow-list. Email match is case-insensitive. `owner: true` marks the account localhost-as-owner uses |
| `auth.sessionDays` | `30` | how long a `wt_session` cookie lasts |
| `auth.allowLocalhost` | `false` | when `true`, a request from `127.0.0.1` / `::1` with **no** forwarding headers counts as the first `owner: true` founder. Read the warning below before turning it on |
| `auth.trustProxy` | `false` | when `true` **and** the connection arrives over loopback, `X-Forwarded-For` / `X-Real-IP` name the client for rate limiting and `X-Forwarded-Proto` may set the login-link scheme. Otherwise those headers are ignored |
| `auth.publicUrl` | empty | absolute `http(s)://host[:port]` base for login links. Set it: without it the `Host` header is used only when it names loopback, and everything else falls back to `http://127.0.0.1:<port>` |
| `auth.cookieSecure` | `true` | the session cookie carries `Secure`. Browsers still accept it on `http://localhost`; set `false` only for a plain-HTTP deployment |
| `apiToken` | empty | Bearer token accepted on `/pipeline/*`, `/api/*` and `POST /hooks/enqueue` when sign-in is on |
| `probeToken` | empty | unchanged: Bearer token for every `/probe/*` path |
| `subscriptions` | empty | array of subscription names the owner may assign (Telegram buttons and `POST /pipeline/assign-subscription`) |
| `telegram` | missing | outbound Telegram notifications; see [`TELEGRAM.md`](./TELEGRAM.md). Missing, or present without `botToken` and without `dryRun: true` → no sends, one log line at start-up |

This wave does **not** send email or Telegram. `POST /auth/request` stores a
one-time token and prints `login link for <email>: <url>` on the server's
stdout. Real delivery is a later wave.

### Flow

| endpoint | body | what it does |
| --- | --- | --- |
| `POST /auth/request` | `{ "email" }` | always answers `{ "ok": true, "sent": "if that address is on the list" }`. If the email is on the list, a 32-byte hex token is stored in `state/auth.json` for 15 minutes, single use, and the link is logged. Unlisted emails get the same answer, store nothing — and take the same code path (token generated, one atomic write, answer sent, log line only afterwards) so the response time does not reveal the list. Two limits, both 5 per 10 minutes: one per connecting socket address, one per requested email → `429` |
| `GET /auth/link?token=…` | — | valid unused unexpired token → `Set-Cookie: wt_session=…` (`HttpOnly`, `Secure` unless `cookieSecure:false`, `Path=/`, `SameSite=Lax`, `Max-Age` from `sessionDays`) and redirect `302` to `/`. Invalid, used or expired → `400` English text |
| `POST /auth/logout` | — | drops the session from the store and clears the cookie |
| `GET /auth/me` | — | `{ "founder": { "email", "name", "owner" }, "via": "session" \| "localhost" }` or `{ "founder": null, "via": null }` |

`state/auth.json` shape:

```json
{
  "tokens": [
    { "token": "hex", "email": "owner@example.com", "createdAt": "…", "expiresAt": "…", "used": false }
  ],
  "sessions": [
    { "id": "hex", "email": "owner@example.com", "createdAt": "…", "expiresAt": "…" }
  ]
}
```

Writes go through the same atomic queue as the rest of the board.

### Enforcement (only when `auth.founders` is non-empty)

- **Page** `GET /` and `GET /board`: session or localhost-as-owner → the board.
  Otherwise a minimal English sign-in page (email field → `POST /auth/request` →
  "Check your link."). The sign-in HTML does not contain board data.
- **Read APIs** `/data`, `/pipeline/data`, `/api/*`: session or localhost-as-owner
  (and, on `/api/*` and `/pipeline/data`, `apiToken`) → `200`. Otherwise `401`
  `{ "error": "unauthorized" }`. A forged `wt_session` cookie is `401`.
- **Mutations** `/card/*`, `/project/select`, `/focus`: session or
  localhost-as-owner.
- **Mutations** `/pipeline/*` and `POST /hooks/enqueue`: session, localhost-as-owner,
  or `Authorization: Bearer <apiToken>`.
- **`/probe/*`**: still `probeToken` only, exactly as before. Missing token
  config → `403`; wrong token → `401` plain text.

The page header shows the signed-in founder's name and a sign-out link when
sign-in is on and the viewer arrived with a session cookie (not when the viewer
is localhost-as-owner).

### What the board trusts

Nothing the client sends decides who it is. In detail:

- **`allowLocalhost` is off by default and is not a security boundary.** A
  request counts as localhost-as-owner only when the socket is loopback on both
  ends and carries no `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-IP` /
  `Forwarded` header — but a plain TCP forwarder adds no headers at all. A bare
  `proxy_pass` in nginx, `ssh -L`, `socat`, or a tunnel client hands an outside
  visitor a loopback connection, and the board cannot tell the difference. Turn
  `allowLocalhost` on **only** when nothing forwards to this port; otherwise
  leave it off and sign in with a link like everyone else. The server prints a
  warning line at start-up while it is on.
- **Rate limiting counts sockets, not headers.** `X-Forwarded-For` only names
  the client when `trustProxy` is on *and* the connection came over loopback.
  The second limit, per requested email, holds even then.
- **Login links never come from the `Host` header** unless that header names
  loopback. Set `auth.publicUrl` and the header is ignored entirely, so a
  request with `Host: evil.example.net` cannot aim a founder's one-time token at
  someone else's server.
- **Secrets are compared in constant time** — session id, login token and
  `apiToken` all go through a SHA-256 + `timingSafeEqual` comparison, and the
  lookups walk every stored row instead of stopping at the first match.
- **A malformed cookie is a `401`, not a `500`.** A `wt_session` value with
  broken percent-encoding is treated as a bad cookie: the visitor gets the
  sign-in page and can sign in again.

## Probe

The probe on the owner's machine pushes herdr window data up and pulls queued
hooks down. The HTTP contract the probe already speaks is in
[`PROBE.md`](./PROBE.md); this section is the board side of the same contract.

Auth: every `/probe/*` path and `POST /hooks/enqueue` require
`Authorization: Bearer <probeToken>`. Missing or wrong token → `401`
`unauthorized` (plain English text). If `probeToken` is not set in
`state/autopase-board.json` → `403` `probe access is not configured`.

| endpoint | body | what it does |
| --- | --- | --- |
| `POST /probe/snapshot` | the snapshot from [`PROBE.md`](./PROBE.md) | stores it in memory and in `state/probe-snapshot.json` with a `receivedAt` stamp. Entries of `windows` / `tabs` / `panes` / `agents` that are not objects are dropped before storing. Larger than 2 MB → `413` (also for a chunked body with no `Content-Length`: the answer is `413`, not a dropped connection). Broken JSON / wrong shape → `400` |
| `GET /probe/hooks` | — | `{ "hooks": [ { id, window, text, queuedAt }, … ] }`, oldest first. Empty queue is `{ "hooks": [] }` |
| `POST /probe/hooks/ack` | `{ "ids": ["hk_…"] }` | drops those entries; unknown ids are ignored. Answers `{ "ok": true, "removed": N }` |
| `POST /hooks/enqueue` | `{ "window", "text" }` (both required; `window` must be a herdr id — `w4Z:p1` or `w4Z:t1` — anything else is `400`) | queues a hook for the probe to deliver. Answers `{ "ok": true, "hook": { id, window, text, queuedAt } }` |

Config fields on `state/autopase-board.json`:

| field | default | meaning |
| --- | --- | --- |
| `probeToken` | empty | shared secret; must match the probe's `token` |
| `apiToken` | empty | shared secret agents send as `Authorization: Bearer` on `/pipeline/*`, `/api/*` and `POST /hooks/enqueue` when `auth.founders` is set |
| `source` | `"local"` | `"local"` — windows come from herdr on this machine, as before. `"probe"` — windows, panes and agents come from the last posted snapshot. Lanes, PRs and CI still come from this host |
| `probeStaleSec` | `60` | in `probe` mode, a snapshot older than this (or missing) is stale: the header shows `probe stale since <time>` and `/api/board` lists `{ "source": "probe", "error": "probe stale since …" }` under `problems`. The rest of `/api/board` is unchanged |

A hook that has been waiting more than ten minutes shows `hooks queued, oldest Nm`
in the board header.

`WATCHTOWER_STATE_DIR` points the board at another folder instead of `state/`
(tests, a second instance). Unset — `state/` next to the repo, as before.

### Sample output

```
pipeline: http://127.0.0.1:4878
generated: 2026-08-26T17:36:54.960Z
summary: cards 3, stuck 1, waiting for acceptance 0, accepted 1, failures 7
cards[3]{id,title,stage,clock,fails,verdict}:
  cmtadl1k48ian,Ship the pipeline view,accepted,3h 12m (stopped),local 3 ci 1,moving
  cmtadlv1j63cm,Grill the copilot spec,spec,41m,-,-
  cmtadlv3hrpww,Stuck example,stuck,2h 4m,ci 3 (3 in a row),-
stuck[1]{id,title,fails,waiting}:
  cmtadlv3hrpww,Stuck example,ci 3 (3 in a row),1h 9m
help[4]:
  one card in full (spec, comments, history) — /api/pipeline/card/<id>, the whole pipeline in full — ?full=1
  stages: spec, grilled, development, local_check, ci_pr, acceptance, accepted; stuck — three failures in a row, waiting for a human
  clock is the delivery time; acceptance is the owner's decision and does not count — a card waiting there shows "(stopped)"
  ?format=json — the same shape as plain JSON
```

## A paragraph for a watchdog agent's instructions

```markdown
## How to look at Watchtower

The board is read with one command, no browser and no screenshots:
`<path to the repo>\bin\wt.cmd`
(`--card <name>` — one window in full, `--full` — the whole board in full,
`--json` — JSON, `--help` — what the fields mean).
Read first: the `summary` line and the `asks` section — those are the cards
waiting for a human (hand-typed ones included); the question itself is in
`questions` under the `#number` reference. A non-empty `problems` section means
part of the board is blind (ssh or gh did not answer) and its empty cells cannot
be trusted. If the command says the board is not running, start it with
`bin\watchtower.cmd`; if it says the build is older, close that window and start
the same `bin\watchtower.cmd` again.
```
