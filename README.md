# Multi-Lane Development (MLD)

MLD is a way of running software sprints with a fleet of coding agents, together with the board program built for
it. It ran the sprints of autopase.lv, a car-listings site for Latvia, Lithuania and Estonia. The site has two
founders: the partner writes the spec for each sprint, and the owner answers a few questions per sprint. A
Claude Code session (the session) checked each written spec against the current product code in five parallel
passes (the grill), put the founders' questions on one page and wrote the GitHub tickets. From there the board took
over: one Node program, `bin/watchtower.mjs` (Watchtower in the code). It handed the tickets to eight Codex lanes on
three machines, ran spec-check and review rounds, merged each change once the automatic tests (CI) passed, and ran a
QA pass on the live site.

A lane is a working copy of the product repository on a server, where one OpenAI Codex agent runs one task at a
time. A pull request (PR) is one proposed change to the code. In a spec-check, an agent that did not write the code
compares the PR with the spec, clause by clause. The board started every lane run and every review for a sprint's
tickets itself. Only risky PRs were merged by hand, by the session: changes to the database structure, logins,
deployment and its settings, payments or the scraper (the program that collects the listings).

The board's checks were added because a lane would write "done" while requirements were missed. Each check was a
fresh agent with no memory, so every round found new remarks on old code. A round is one verdict, GO or NO-GO, and
the fix after it. On the board's last sprints one PR took up to 13 Codex runs, each with five helper agents, and
18–24 hours from ticket to merge; a large PR took 12–26 rounds.

The board has been paused since 15 September 2026. Sprints now run on a shorter process (`docs/PILOT.md`, in
Russian): the lane that writes the code proves every requirement itself, one reviewer that keeps its memory from one
PR to the next checks the result, and a person looks at the screenshots. On the seven sprints since, each PR took
1–3 verdict rounds, and on six of those sprints at most 3 Codex runs. This repository keeps the board's code, its
264 tests and the measurements.

## What it does

- Keeps one card per sprint. The session moves it through `spec → grilled → ticketed` by hand; from `ticketed` on
  the board moves it by facts it reads from GitHub and the lanes:
  `development → local_check → ci_pr → merged → done`. `stuck` means a human has to look.
- Writes `TASK-<ticket>.md` for every lane run from the committed `docs/RULES.md` (the role's section at a named
  git sha) plus the ticket verbatim, copies it to the lane over `scp` and starts the run with `hzlane N` or
  `maclane N`, the one-line lane launchers of `docs/FLEET.md` (`hzlane` on the Linux servers, `maclane` on the Mac;
  neither launcher is in this repository).
- Merges with `gh pr merge --squash` only when the checks `pr-ci` and `pr-ci-full` are green on the PR's latest
  commit (its head), a `GO` comment names that same head, GitHub says mergeable and the ticket carries no
  `hold-merge` label. That label goes on a ticket touching migrations, schema, auth, deploy and env, payments or the
  scraper; the session merges such a PR by hand on green + GO.
- Counts failures per card. Three `NO-GO` verdicts or red checks in a row, or a ticket comment starting with
  `QUESTION`, park the card in `stuck` and send the owner one Telegram line.
- Tags both founders in the Telegram group once the session attaches the questions page to the card. The page is
  made with Lavish, a tool that publishes a local HTML page at a public link and sends the readers' answers back.
  The owner is asked once per sprint, on that page, and never mid-sprint. The board only sends Telegram messages
  and never reads them.

## How it works

| Piece | What it does |
|---|---|
| `bin/watchtower.mjs` | the HTTP server on `127.0.0.1:4878`; a sweep every 30 s, inside which the lanes are re-read over `ssh` every 45 s, the open PRs every minute and the tickets every 3 minutes through `gh`; `bin/watchtower.html` polls it every 3 s |
| `bin/pipeline.mjs`, `bin/sprint-facts.mjs` | `bin/pipeline.mjs` keeps the cards, their stage, a clock per stage and the failure counters; `bin/sprint-facts.mjs` ties each sprint card to its work tickets, the lanes building them, their PRs and CI jobs, from the facts `bin/watchtower.mjs` reads from GitHub and the lanes; the sprint close itself is `closeSprintSweep` in `bin/watchtower.mjs` |
| `bin/auto-dispatch.mjs` | matches a startable task with a free lane in the order spec-check, review, fix, develop; writes the task file, launches it, retries a failed launch on another host |
| `bin/rules.mjs` | cuts `docs/RULES.md` at a committed sha into `common` plus the role's section: `lane`, `spec-check`, `reviewer`, `fixer`, `qa` or `cutter` |
| `bin/merge.mjs` | the merge gate: which check runs count on a head, which labels hold a merge, when the board adds `full-ci` |
| `bin/lane-judge.mjs`, `bin/idle-lanes.mjs`, `bin/off-board.mjs` | a freed lane is judged by the proof it left; a free lane while work waits, or work running outside the board, is reported on the page |
| `bin/telegram-bot.mjs` | send-only Telegram: alarms to the owner's private chat, one-line notices to the founders' group |
| `bin/lavish-publish.mjs`, `deploy/lavish-worker/` | a self-hosted Lavish on a Cloudflare Worker (`docs/ARTIFACT.md`) that can serve the founders' questions page; not in use — the session publishes that page with the local `lavish-axi` editor (§2) |
| `docs/FLEET.md`, `docs/fleet-launch.example.json` (copied to `state/fleet-launch.json`, not in git) | the fleet: 3 lanes on a Hetzner server, 2 on a Hostinger server, 3 on a Mac mini; 4 CI runners on a separate Hetzner server |
| CI in the product repository | the scoped `pr-ci` on every push (the affected tests, 7–10 minutes); the full pipeline `pr-ci-full` (build, every test, browser smoke: 30–37 minutes plus 0–40 minutes of runner queue) only on the `full-ci` label, which the board adds itself |

Another product needs its own settings (the repository, hosts and lanes, Telegram chats and GitHub identity in
`state/autopase-board.json` and `state/fleet-launch.json`) and its own `docs/RULES.md`. Its CI must report checks
named `pr-ci` and `pr-ci-full` (and run a workflow named `Staging` if the staging walk is on), and each Linux lane
host needs the `hzlane` launcher, which is not in this repository.

| Who | Does |
|---|---|
| the partner | writes the spec, answers the questions page |
| the session (a Claude Code session) | spec intake: the grill, the questions page, the tickets; merges `hold-merge` PRs by hand; watches the board while the sprint runs and unsticks stuck cards (`AGENTS.md`) |
| the board | everything from `ticketed` on: dispatch, spec-check, review, fix, merge, QA, sprint close |
| 8 Codex lanes | one task per run: build the ticket's code on a branch and open the PR, check a PR head against the spec, review it, fix one round, walk QA on production |
| the owner | answers owner-zone questions (money, strategy, production, anything outgoing); gets a Telegram line when a card is stuck and one when the sprint closes |

## What was measured, and what replaced the board

The board's process was measured on its last sprints, 10–15 September (`docs/PILOT.md` §1 and §7): on one PR up to
13 Codex runs at the `ultra` reasoning-effort setting, each with five helper agents, so up to 65 helper agents;
12–26 verdict rounds on a large PR; 18–24 hours from ticket to merge; about 2 `pr-ci-full` runs per PR; and CI on
the critical path only 5 % of the time, so 95 % of those hours went to agent rounds and the waits between them.

On the shorter process one ticket carries the spec's requirements as a table with an empty "proved by" column. One
lane run writes the code, puts a screenshot of every surface next to its mock-up in the
`Baltic-OrangesLV/autopase-evidence` repository and posts `DONE #<ticket> <sha>` with the table filled in. A GitHub
Actions workflow in the product repository wakes one Amp thread (Amp is a third-party coding agent; the same thread
is reused for every PR, so this reviewer keeps the memory the board's fresh agents lacked), which posts one `GO` or
`NO-GO` within 30 minutes; there is at most one fix round. The PR merges on a green scoped `pr-ci`; the full
pipeline runs on `main` after the merge and every night, and only a PR touching migrations, auth, deploy or the
scraper waits for `full-ci` and an independent acceptance. The partner accepts the finished sprint on a Lavish page
with "accepted" or "return" per item.

## Seven sprints on the shorter process

| Sprint (requirements; design mock-ups) | Codex runs on the PR | Reviewer verdicts | Time to merge |
|---|---|---|---|
| #2334, listing card v12 (36) | 3 | 2, both NO-GO; 28/36 proved, the last 8 moved to #2344 | 6 h 38 min |
| #2344, follow-up of the card (8) | 2 | NO-GO 6/8 → GO 8/8; the partner returned 0 items | 4 h 47 min |
| #2376, a mobile-only row that showed on desktop (3) | 2 | NO-GO → GO 3/3 | 2 h 09 min |
| #2425, General Fix, four PRs (42) | 0; four Claude Opus agents wrote the code | 7 on four PRs, rounds 2, 2, 2, 1 | 10 h 43 min to the last merge |
| #2454, Contacts R1 (33) | 3 fix runs; three Claude Opus agents wrote the code | NO-GO 30/33 → GO 33/33 | 27 h 25 min, 17.5 h of it idle |
| #2461, Garage v1.0 (58; 13 mock-ups) | 14, eleven of them layout rounds | 46/58 → 53/58 → GO 58/58 | 30 h 40 min to production, 10.5 h of it idle |
| #2522, site chat, three PRs (27; 12 mock-ups) | 1, 1 and 2 | GO 7/7; GO 13/13 on the first pass; 6/6 plus an independent acceptance | 1 h 30 min; 2 h 20 min; 6 h 50 min |

In the "Reviewer verdicts" column, x/y is the number of the spec's requirements the reviewer found proved, out of
the total; an arrow leads to the next verdict on the fixed code.

Against the board's numbers (`docs/PILOT.md` §7): Codex runs per PR went from up to 13, each with five helpers, to
at most 3 on six of the seven sprints, and 14 on the sprint whose lane could not open the page it was building
(target 2); verdict rounds from 12–26 to 1–3 (target 3 or fewer); ticket to merge from 18–24 hours to between
1 h 30 min and 6 h 50 min on the six PRs that hit neither an idle night nor the four-PR staging queue (target 8
hours or fewer).

The idle hours on #2454 and #2461 were a closed session with no background watcher on the running lane. The eleven
layout rounds on #2461 were a lane writing CSS without seeing its own page; since then the Hetzner lane server
(lanes 1–3 in `docs/FLEET.md`) runs a live-reload copy of the site, `tools/look/look.mjs` in the product repository
screenshots the lane's page in about 7 seconds, and the task file carries the sizes, gaps and colours from the
mock-up. The chat window in #2522 was built that way: 0 layout rounds and a GO on the first pass.

Several rules of the shorter process came from 77 recorded agent sessions of the Garage sprint (`docs/PILOT.md`
§7): 11 runs polled CI every 30 seconds, 9 sessions wrote CSS without ever opening the built page, 3 fell at the
first `gh` call for want of a default repository, 2 ran the test suite against the shared database and got 29 false
failures, 2 re-cloned 3.1 GB of mock-ups, one of them filling `/tmp`. Each became a rule in the product
repository's `AGENTS.md` or a line of the task template.

## Run it

```
npm test                    # 264 tests in 32 files (9.8k lines of tests, 9.9k of code), node --test, no dependencies
node bin/watchtower.mjs     # the board on http://127.0.0.1:4878, Node 22 or newer; settings in state/autopase-board.json
node bin/wt.mjs pipeline    # the pipeline as short text, read from the running server
```

The rest of this page is the board's process as it ran before the pause, section by section.

## 1. The spec arrives, and is grilled

The partner sends the spec to the owner over Telegram. The session copies it to
`<specsDir>\<SPRINT>\SPEC.md` with a `MANIFEST.sha256` beside it, then creates
the card and moves it to `grilled`:

```
POST /pipeline/card/create   {"title":"<SPRINT> — <what the sprint delivers>","spec":"<the SPEC.md text>"}
POST /pipeline/card/move     {"id":"<card id>","to":"grilled"}
```

`<SPRINT>` is upper case, hyphenated, `<AREA>-<WHAT>-<NNN>` with a three-digit serial counting sprints in that area
— `AUTOPASE-SEARCH-UX-005`, `AUTOPASE-MANUAL-PUBLICATION-001`. **The title must start with that id and the folder
must carry the same name**: the board finds the spec bundle it ships to every lane by that id under `specsDir`
(or by a `spec dir: <path>` line at the top of the card's spec text). A card whose folder the board cannot find
dispatches with `Spec bundle: none shipped`, and every reader then audits the revision pasted into the ticket —
on 2026-09-10 three spec-checks of AUTOPASE-STAGING-001 judged revision 2 while revision 3 sat in the folder.
Since that day the bundle is re-copied on every dispatch, so an amended `SPEC.md` reaches the next reader. `MANIFEST.sha256` is `sha256sum` run in the sprint
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
with every asset inlined (sibling files are not served). **A founder answers by clicking, never by annotating**
(owner, 2026-09-11 — a page whose options were plain elements opened the annotation box on every click): each
question is a native form built after `lavish-axi playbook input` — `<form data-lavish-question="Qn">` with
`<input type="radio">` options (a product question has its first option pre-checked and marked «по умолчанию»; an
owner-zone question has nothing pre-checked), an optional text field for an address or a date, one «Записать
ответ» submit that calls `window.lavish.queuePrompt(...)` exactly once with `queueKey`, and one sticky «Отправить
все ответы» button at the foot calling `window.lavish.sendQueuedPrompts()`. Never an `alert()`. The builder that
produced the first such page is kept in the owner's `reports/` folder (not in git) — copy it, do not start from prose.

Publish with the local editor (the Cloudflare-worker path `bin/lavish-publish.mjs` needs a `lavish` block in
`state/autopase-board.json` that has never been filled — do not reach for it):

```
cd <specs folder> && lavish-axi grill-outcome.html --no-open          # prints url + public_url
curl -sI <public_url>                                                  # must answer 200/302 — a dead link cannot be recalled from Telegram
POST /pipeline/card/update   {"id":"<card id>","links":{"artifact":"<public_url>"}}
```

`public_url` is `https://<your-lavish-host>/session/<16-hex-key>` (named Cloudflare tunnel, open without a login
since 2026-09-11; `~/.lavish-axi/config.json` holds the `publicUrl`; a `*.trycloudflare.com` link is a dead quick
tunnel). On a card in `grilled` whose artifact link was empty, that first set is what tags both founders in the
Telegram group (the partner's Telegram account); the card stamps `notified.artifact` and never repeats it — a
second ring is `notifyArtifactReady(card)` from `bin/telegram-bot.mjs` after `configureTelegram(<telegram block>)`.
Edits to the HTML reach the founders on their next reload of the same link; `curl` cannot fetch the artifact body
(per-load token, 409), so verify the file on disk. Answers come back through `lavish-axi poll <file>` (run it under
the Monitor tool, output to a file); the session records them by hand:

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
  **A spec amended after ticketing is re-pasted into the ticket body at once** — the task header tells every
  lane that the inline text wins over the bundle, so a stale body is what the spec-check audits (2026-09-10:
  S4 and S6 of AUTOPASE-STAGING-001 judged revision 2 from the ticket while revision 3 sat in the bundle).
- **The QA round-1 ticket** copied verbatim from `docs/QA-TICKET.md` — its viewport list and live-cabinet clause
  are the point of it — label `qa-run`, first line `Part of #<umbrella>`, `depends on: #<work ticket>`.

**Every spec image goes into the ticket bodies inline** (owner's rule, 2026-09-07) — both the work ticket and the
QA ticket carry every file the spec's `assets/` folder ships, each under its one-line meaning from the spec. The
repo is private, so external links break: the images must be uploaded through the issue editor in the browser
(user-attachments), not pasted as `raw.githubusercontent.com` URLs and not left as kitchen paths. The kitchen
copy of `assets/` stays as the lanes' working copy; the inline gallery is what proves nothing was dropped —
before moving the card to `ticketed`, count the `user-attachments` links in each body against `MANIFEST.sha256`.

**Every spec image also goes into the evidence repository at intake** (owner's rule, 2026-09-10): the same
`assets/` files, unchanged, plus `SPEC.md`, committed to `Baltic-OrangesLV/autopase-evidence` under
`<SPRINT>/spec/` before the card moves to `ticketed`. The spec-check's and the QA walker's screenshots land in
sibling folders (`<SPRINT>/S<n>/`, `<SPRINT>/QA-R<n>/`) and name the mock as `../spec/<file>`, so one folder
shows "as designed" next to "as built". Until 2026-09-10 the mocks never reached that repository and the walk's
"matches / differs" column had nothing beside it to compare with.

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
**full** pipeline — build, every test, the browser smoke; 30–37 minutes of work (build 5–7, tests 16–19, smoke
5–8, measured 2026-09-10) plus whatever the runner queue adds, 0–40 minutes when `main`'s own full run and a
production build are on the same four runners — runs only on a PR labelled `full-ci`, and
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

**The staging walk** (owner, 2026-09-10: the code is seen on a staging, not on production, before a single
test round is spent). Every push to the sprint's PR deploys that head — with no check in front of it — to one
staging stack on the CI host, serving a nightly copy of production data behind HTTP basic auth
(AUTOPASE-STAGING-001). The deploy writes one PR comment it keeps editing: line 1 `STAGING head <sha>`, or
`STAGING head <sha> FAILED — <step>`, or — since 2026-09-12 (product PR #2274) — `STAGING head <sha> PREEMPTED — …` when a newer staging run took the single slot before this head was proven either way (the board re-requests the deploy and waits again; it is never a NO-GO), line 2 the address, line 3 `data: copy of production from <when>`. With
`staging: { enabled: true, url, user, password, waitMinutes }` in the settings the board holds the spec-check of a
head until that receipt names it (up to `waitMinutes` from the PR's last change), then sends the spec-check to a
`browser: true` lane with a `Staging:` header line — the auditor walks the surfaces the spec names, puts every
screenshot beside its mock in `autopase-evidence/<sprint>/S<n>/` and reads the code as before. A FAILED receipt is
read at once on any lane: the head does not deploy, and that is HIGH. No receipt after the wait = a code-only
round that says so. A mismatch with a mock is a NO-GO (owner, 2026-09-10). `enabled: false` = the road above.

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
account the keyring holds (on 31.08 the keyring's active account turned out to be the wrong one and every sweep
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
