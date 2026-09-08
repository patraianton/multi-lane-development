# MLD — the board that runs product sprints

MLD is one Node process (`bin/watchtower.mjs`, no dependencies, Node ≥ 22) on the owner's Windows PC at
`http://127.0.0.1:4878`, scheduling a fleet of Codex lanes that build the product repo
`Baltic-OrangesLV/vincheck-latvia` (autopase.lv). It reads facts — busy lanes, open pull requests, GitHub tickets —
moves cards by them, puts work on free lanes, starts reviews, merges, counts failures and rings the owner. Nobody
else starts a lane, a review or a merge. This page is the whole process; a sprint runs it top to bottom, once.

| Who | Does |
|---|---|
| the partner (Lena) | writes the spec, answers the questions page |
| the MLD session | spec intake — grill, questions page, tickets — plus `hold-merge` merges and the watch |
| the board | everything from `ticketed` on: dispatch, review, fix, merge, QA, sprint close |
| 8 Codex lanes | one task per run: write the ticket, review a PR head, fix one round, walk QA on production |
| the owner | answers owner questions, unsticks cards, gets one line when the sprint closes |

A card sits in one stage at a time and the road is one-way:
`spec → grilled → ticketed → development → local_check → ci_pr → merged → done`.
`stuck` is not a stage of the road — it means a human has to look.

## 1. The spec arrives, and is grilled

The partner sends the spec to the owner over Telegram. The session copies it to
`C:\Users\panto\projects\_conveyor\autopase.lv\specs\<SPRINT>\SPEC.md` with a `MANIFEST.sha256` beside it, then creates
the card and moves it to `grilled`:

```
POST /pipeline/card/create   {"title":"<SPRINT> — <what the sprint delivers>","spec":"<the SPEC.md text>"}
POST /pipeline/card/move     {"id":"<card id>","to":"grilled"}
```

`<SPRINT>` is upper case, hyphenated, `<AREA>-<WHAT>-<NNN>` with a three-digit serial counting sprints in that area
— `AUTOPASE-SEARCH-UX-005`, `AUTOPASE-MANUAL-PUBLICATION-001`. `MANIFEST.sha256` is `sha256sum` run in the sprint
folder over `SPEC.md` and every attachment shipped with it (`sha256sum SPEC.md > MANIFEST.sha256`); it exists so a
lane or a later session can prove with `sha256sum -c MANIFEST.sha256` that the spec it reads is the spec that arrived.

Five lenses then interrogate the spec in parallel, each against the product code at `origin/main`: complexity and
slicing · acceptance subjects · external dependencies and money · landmines, read from `docs/history/LESSONS.md` and
from the `GRILL-OUTCOME.md` files of earlier sprints in the same specs folder · the user path and how the result is
proven on production. Every blocker has the shape "the spec says X, but `file:line` on
main says Y" — a finding without a code citation is an opinion. A spec that arrives finished and owner-approved is
grilled exactly like a draft: approval of the behaviour is not approval of the technical cut. The result is
`GRILL-OUTCOME.md` beside the spec — blockers folded in as mandatory amendments, the work breakdown, the questions,
and any drift between the spec's stated base commit and today's `origin/main` written down as a stated fact.

## 2. One questions page, and the owner zone

Every question for the owner or the partner goes on **one** Lavish page — multiple choice, no free text, the first
option is the default decision. Questions reach the owner this way and no other: never mid-sprint, never in a
separate message, never a second page.

The session writes that page itself as `grill-outcome.html` from `GRILL-OUTCOME.md` — a **single-file** HTML page
with every asset inlined (sibling files are not served), each question its own element with its options listed
inside it, because a founder answers by annotating an element and an unannotatable question cannot be answered.
Publish it, which also rings the doorbell:

```
node bin/lavish-publish.mjs publish grill-outcome.html --card <card id>
```

It prints the public `…/session/<16-hex-key>` URL and sets `links.artifact`; on a card in `grilled` whose artifact
link was empty, that first set is what tags both founders in the Telegram group — publishing and ringing the
doorbell are one command. `--key <16hex>` republishes to the same URL. The credentials are the `lavish` block
(`publicBaseUrl`, `apiToken`) in `state/autopase-board.json`, which is not in git. The board reads the page's state
every 30 s and marks the card answered as soon as founder annotations exist; the card cannot leave `grilled` before
that mark. Answers that arrived another way — Telegram, a call — are recorded by hand:

```
POST /pipeline/card/artifact-answered   {"id":"<card id>","answers":1,"by":"<who answered>"}
```

**The owner zone — the one definition.** The owner decides, never the pipeline: money; strategy; anything outgoing
to external parties; the live bot and production environment variables or external access. Those questions carry
**no default** — a deadline produces a reminder, not an assumed answer. Production database writes are *not* an
owner checkpoint: they run under the backup regime (a verified restore net, a restore point taken right before the
write) and the owner is informed after a restore, never asked before a write. Every other reversible product
question the pipeline decides itself, in favour of the end user.

## 3. Answers become tickets — one work ticket per sprint

The founders' annotations are the authoritative answers; fold them into the spec first. Then write three issues in
the product repo. These formats are the same text as the `cutter` section of `docs/RULES.md`, which the lanes are
handed; the two must always agree.

- **The umbrella issue** — what the sprint delivers, the line `grill passed:`, the spec bundle path, and the line
  `Rules: docs/RULES.md @ <sha>` (`<sha>` = `git log -1 --format=%h -- docs/RULES.md` in this repo).
- **One work ticket for the whole sprint** — one ticket, one lane, one PR, start to finish (owner's rule,
  2026-09-04; a sprint is never cut into units, the eight-way cut of 03.09 cost 22 hours, and later QA findings
  fold into one fix ticket the same way). First line `Part of #<umbrella>`; then the whole scope, in the files it
  names; `depends on: none` unless another sprint's open PR must land first; a `Branch:` line only when
  `feat/<ticket>` will not do; never `Closes #`, `Fixes #` or `Resolves #` in the instructions.
- **The QA round-1 ticket** copied verbatim from `docs/QA-TICKET.md` — its viewport list and live-cabinet clause
  are the point of it — label `qa-run`, first line `Part of #<umbrella>`, `depends on: #<work ticket>`.

**Every spec image goes into the ticket bodies inline** (owner's rule, 2026-09-07) — both the work ticket and the
QA ticket carry every file the spec's `assets/` folder ships, each under its one-line meaning from the spec. The
repo is private, so external links break: the images must be uploaded through the issue editor in the browser
(user-attachments), not pasted as `raw.githubusercontent.com` URLs and not left as kitchen paths. The kitchen
copy of `assets/` stays as the lanes' working copy; the inline gallery is what proves nothing was dropped —
before moving the card to `ticketed`, count the `user-attachments` links in each body against `MANIFEST.sha256`.

Acceptance criteria are commands with expected output, at least one of them red on `main` today; a visible result
names the mock path and the verbatim spec line. A ticket touching migrations, schema, auth, deploy/env, payments or
the scraper gets the label `hold-merge`; one that repairs a red `main` gets `main-fix`; one that changes only
styles, texts or documentation may get `no-review`, but never together with `hold-merge` — `hold-merge` wins; one
that needs no build may get `no-build`, which lets it run on the light lane (lane-3, `docs/FLEET.md`).

Finish by hanging the **umbrella's** issue URL on the card and moving it — the board reads the umbrella number out
of that URL, so it must be a full `…/issues/<n>` link, not a number and not the work ticket:

```
POST /pipeline/card/update   {"id":"<card id>","links":{"ticket":"https://github.com/Baltic-OrangesLV/vincheck-latvia/issues/1923"}}
POST /pipeline/card/move     {"id":"<card id>","to":"ticketed"}
```

From here the board takes over. Nothing is built off the board: an open PR no card carries, a ticket in work naming
no umbrella, or a busy lane on an unknown branch all show up in the amber **Off the board** zone.

## 4. The board dispatches the lane

The board builds `TASK-<ticket>.md` — a header (`Lane:`, `Branch:`, `Base:`, `Role:`, `Check:`,
`Rules: docs/RULES.md @ <sha>`), then the `common` section plus the role's section of `docs/RULES.md` **as
committed in this repo**, then the ticket verbatim — copies it to the lane's kitchen over `scp` and starts the
lane. The lanes never see the working copy: edit the rules, commit, and the next task carries the new sha; no
committed `docs/RULES.md` means nothing is dispatched at all, and the board says so on the page. Branch is the
ticket's `Branch:` line, else `feat/<ticket number>`; base is `origin/main`. While `main`'s own `pr-ci` is red the
board holds every task that would branch from `main` — reviews, fixes and merges keep running, because they are
what makes `main` green again. An unknown or stale answer from GitHub is not red.

When lanes are short the queue order is **spec-check, review, fix, develop**: an open PR is finished before a new
one starts, and a head is checked against the spec before anyone reviews it.
A lane belongs to whoever launched the task on it — before stopping a lane read its `TASK-<n>.md`, because a task
you did not launch is not yours to stop; write on the ticket instead. (On 2026-08-30 a sprint window's stop script
killed the board's own task on hostinger/lane-4 by lane number.) Hand-run work takes a reserved lane
(`reserved` in `state/fleet-launch.json`) and never competes with the board for a free one.

## 5. CI on every push — two modes

An ordinary push to the PR runs the **scoped** gate: check `pr-ci`, the affected tests only, 7–10 minutes. The
**full** pipeline — build, every test, the browser smoke, 35–50 minutes — runs only on a PR labelled `full-ci`, and
check `pr-ci-full` is its receipt on that head. The board adds the `full-ci` label itself the moment a card it will
merge is ready and only that evidence is missing. A `pr-ci-full` that is red, pending or not reported yet is
**waiting**, never a red check: no fix task, no merge attempt spent, no stuck card. A full run that really fails
turns `pr-ci` red, and that is an ordinary red check.

## 6. Spec-check, review, fix, merge

**The spec-check reads every PR head first** (owner, 2026-09-08: compliance with the spec is proven before any
test round is spent, or the rounds run forty times over code that never did what the spec said). The moment a PR
head appears the board sends the `spec-check` role of `docs/RULES.md` to a free lane with the spec bundle: an
auditor that did not write the code reads `SPEC.md` clause by clause against that head and answers with one
plain-text PR comment: line 1 `S<n> — GO` or `S<n> — NO-GO`, line 2 `head <sha>`, then every deviation as
`SEVERITY — §ref — spec says — code does — path:line`. A `NO-GO` (any HIGH or MEDIUM deviation) is a fix round on
the same branch carrying that comment verbatim as `SPEC-CHECK`; the new head is spec-checked again. Only a head
with `S<n> — GO` is reviewed, labelled `full-ci` or merged. `no-review` tickets keep their road: no reader at all.
The scoped `pr-ci` still runs on every push — GitHub starts it, 7–10 minutes, and it is the only check spent
before the spec verdict. `specCheck: false` in the settings restores the pre-2026-09-08 road.

The review verdict is one plain-text PR comment: line 1 `R<n> — GO` or `R<n> — NO-GO`, line 2 `head <sha>`. Without
the head line, or with another head, it is not a verdict. A `NO-GO`, a red check or a conflict sends a fix round to
the same branch; the spec-check and then the reviewer run again on the new head. One live lane per PR head — a fix
waits while a spec-check or a review of that head runs, and the other way round.

The board merges with `gh pr merge --squash` when **both** `pr-ci` and `pr-ci-full` are green on the exact same
head, the GO is on that head, the PR is not draft, GitHub says mergeable, and the ticket has no `hold-merge`. On a
`no-review` ticket the GO requirement is dropped; a `NO-GO` on that head still blocks. On a PR shared by several
tickets every one of them must carry `no-review`, and `hold-merge` on any of them still wins. A merge GitHub refuses is
journalled with GitHub's own message; after three attempts the owner gets one line. **`hold-merge` PRs are merged
by the session, by hand**, on green + GO — green meaning both checks on the current head. The board never adds
`full-ci` to a `hold-merge` PR, so add it first and wait for the full run:
`gh pr edit <n> -R Baltic-OrangesLV/vincheck-latvia --add-label full-ci`.

## 7. The QA walk, then the close

Once the work is merged the board sends the `qa-run` ticket to a Mac lane — a real headed browser on **production**,
every locale and viewport the ticket lists, content counted rather than status codes. Cabinet surfaces are walked in
the **live** cabinet as the QA account, never on the internal preview page, and the account is left clean.

One finding = one ticket, filed at once, labelled `qa`; the exact title and body format is the `qa` role text in
`docs/RULES.md`, which the walker is handed with its task. Those tickets are the **record** of the round, not the
work order.

The **fix** for a round is one ticket, the same rule as the sprint: the session folds the round's findings into a
single `qa` ticket titled `QA R<n> findings — one fix on one lane (folds #…)`, whose body lists `Folds: #…` and
appends every folded body verbatim as the spec, and closes those tickets as folded so the board runs one lane once
instead of a serial chain of them. A finding already carried by an open PR with a GO stays separate. The folded
ticket walks the full road — PR, review, board merge — before the next QA round. Round 3 still finding defects →
`QUESTION` → the card goes `stuck`.

A sprint closes when the work is merged, every QA finding is merged or closed, a QA walk is closed clean and
nothing merged after that walk. **The board closes the remaining merged tickets, then the umbrella, itself**, and it
is the board — not the session — that sends the closing line with the numbers to the owner's private Telegram chat.
Whenever the session itself has to report to the owner — an incident, an answer he asked for — it uses that same
shape: one line, numbers, plain words, no ticket numbers and no board jargon.

## When something goes wrong

Each card counts `consecutiveFails`: +1 on a `NO-GO`, a red check, or a lane freed without its proof. Only real
progress breaks the streak — a develop PR, a closed `qa-run` ticket, a GO on the current head — so a review→fix
carousel stops itself on the third `NO-GO`. Three in a row, or any ticket comment starting with `QUESTION`, sends
the card to `stuck` and one Telegram line to the owner. That line is a **notification, not a question** — the board
tells the owner a card stopped; it never asks him anything. The owner is asked exactly once per sprint, on the
intake questions page of §2, and never again while the sprint runs. The session reads the ticket, fixes what
stopped the card and unsticks it from the page or with

```
POST /pipeline/card/unstuck   {"id":"<card id>"}
```

and the board sends it again. The board also reports idle lanes, `main` turning red and green again, and a merge it
gave up on. It only sends; nothing polls the bot.

## Running the board

`node bin/watchtower.mjs` serves the page and `/api/*` on `127.0.0.1:4878`, and the page polls every 3 s;
`bin\watchtower-hidden.vbs` is the same with no console window (a Scheduled Task starts it at logon).
`node bin/wt.mjs pipeline` asks the running server for the pipeline as short text. Tests are plain `npm test`.

Settings live in `state/autopase-board.json` (not in git, re-read every 30 s). `autoDispatch` is the only switch —
`false` and the board only says what it would do. `repo`, `specsDir`, `hosts`, `lanes`, `ciSlots` describe the
fleet; `check` is the local check written into task files; `telegram: { botToken, chatId, ownerChatId }` is the
founders' group and the owner's private chat; `github: { account, tokenFile }` pins the identity every `gh` call
runs as. That one **fails closed**: a missing or empty token file, or `gh api user` answering with another login,
holds every GitHub sweep — sources, merges, dispatch — and alarms the owner; nothing ever falls back to whatever
account the keyring holds (on 31.08 the keyring's active account turned out to be a banned one and every sweep
died silently for hours). To rotate the token write the new one into the same file
(`gh auth token -u <account> > state/github-token.txt`, `state/` is not in git); the board picks it up within 30 s,
no restart. `state/fleet-launch.json` says which lane lives on which host and how it is launched.

**Switching it on:** `npm test` green and `docs/RULES.md` committed; exactly one process on 4878
(`netstat -ano | findstr :4878`) with the Scheduled Task registered; **`"autoDispatch": true` in
`state/autopase-board.json`** — with it false the board narrates and sends nothing, and the dispatch rows read
`would dispatch`, so check it every time (`grep autoDispatch state/autopase-board.json`, or `autoDispatchOn` in
`GET /api/pipeline`); the `telegram` block and `check` in the same file, and `browser: true` on the Mac host in
`state/fleet-launch.json`; the product repo with GitHub auto-merge off, no PR armed and stale tickets parked behind
the label `wave-next` (the board ignores it) so the **Off the board** zone is empty.

The board and herdr run on the same machine and no probe executable pushes desktop data anywhere, though the
probe source mode remains for loading a posted snapshot in tests. The systemd units in `deploy/` install the same
one process on a Linux host; it still listens on `127.0.0.1:4878`, so put TLS in front of it if anyone outside
that host is to open the page.

## The rest of the repo

- `AGENTS.md` — the job file for the session watching the board: what to check before accepting a sprint.
- `docs/RULES.md` — the road text the lanes receive, pasted into every task file. **Its path and its six
  `<!-- role: … -->` markers are read by code — never rename the file, never drop a marker.**
- `docs/FLEET.md` — the servers, the 8 lanes and the CI slots; named on the board page itself.
- `docs/API.md` — the HTTP contract: `/api/board`, `/api/pipeline`, card mutations, field shapes.
- `docs/QA-TICKET.md`, `docs/ARTIFACT.md`, `docs/TELEGRAM.md` — the QA ticket template, the Lavish worker on
  Cloudflare, the Telegram config; runtime error messages point at these exact paths.
- `docs/history/`, `docs/adr/`, `docs/specs/` — archive: how things used to work, and why. Not required reading.

MIT — see [`LICENSE`](LICENSE). Watchtower started as a fork of [sheepdog](https://github.com/patraianton/sheepdog).
