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
bin\wt.cmd --help          help for every field
```

The command computes nothing itself — it asks the running server. The server has
to be up (`bin\watchtower.cmd`). If it does not answer, the command says so and
exits with code 1. If the port holds a board from an older build (without the
`/api/board` endpoint), the command says that and asks for a restart — it never
relays a foreign response body. An unknown flag exits with code 2 and lists the
allowed ones. With `--json` errors arrive as JSON too (`{"error": …, "help": …}`),
so parsing never breaks. The port comes from `WATCHTOWER_PORT` (the older
`AUTOPASE_BOARD_PORT` is still read as a fallback), 4878 by default.

## One request

```
GET http://127.0.0.1:4878/api/board            short text (TOON-flavoured)
GET http://127.0.0.1:4878/api/board?format=json
GET http://127.0.0.1:4878/api/board?full=1
GET http://127.0.0.1:4878/api/board/card/<name> one card in full
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
and so on); `error` — the short reason. An empty section means every source is
alive. This is worth reading: an empty `lanes` cell with ssh down means "the board
does not know", not "there are no lanes". Before a project is chosen, `problems`
carries one row, `project: no project chosen yet` — open the board and pick one.

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
| `comment` | `author`, `text` (both required) | one flat comment on the card |
| `update` | `links` (`ticket`, `branch`, `pr`, `artifact`), `lane`, `subscription`, `slot`, `spec`, `status` (`text`, `verdict`) | attaches what the card points at; only the keys sent are touched, an empty string clears one |

There is no authentication yet — the board listens on `127.0.0.1` only. Sign-in
arrives in a later wave.

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
