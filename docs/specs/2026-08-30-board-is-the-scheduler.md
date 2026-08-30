# The board is the scheduler — spec

Date: 2026-08-30 (v2, afternoon). Owner: Anton. Status: **approved to build** (owner's word 2026-08-30 ~12:30:
"form the specs yourself, send the development to Codex, decide everything yourself; keep it simple").
v1 of this file was the morning draft; a panel of five re-read it against the owner's own words and the
recorded failures (`reports/panel-2026-08-30/`, local). Everything with no failure or owner's word behind it is cut.

## 0. In one paragraph

A ticket in the queue and a free lane meet on the board, not in an agent's head. The board — one Node process on
the owner's PC — starts every lane task with a standard file (the rules for that role + the ticket verbatim),
starts the reviewer when a PR opens, merges when the check is green and the reviewer said GO on that same head,
counts failures and, on the third in a row, parks the card and tells the owner on Telegram. No standing agent
watches anything. The rules live in one file, one section per role, and are pasted into every task from the
committed text. Cards move left to right by facts the board reads from GitHub and the lanes.

## 1. Who exists

| Who | Does |
|---|---|
| **Board** (`bin/watchtower.mjs`, 127.0.0.1:4878, one process from a Scheduled Task) | reads lanes, PRs, tickets; dispatches every lane task; starts reviews; merges; counts failures; sends the alarms |
| **Lanes** (8 Codex lanes: codex-dev ×3, hostinger ×2, mac ×3; `hzlane N` / `maclane N`; `ultra`) | one task per run in the role *lane* / *reviewer* / *fixer* / *qa*; a fresh run per task; nothing kept between tasks |
| **Owner** and his MLD session | the spec intake (grill, questions page, tickets — role *cutter*), the sprint order, hard decisions on stuck cards, the acceptance page, money, production |
| **Partner** | writes specs; answers the questions page; accepts the sprint on one page per sprint (decision 3). Sees Telegram and Lavish pages, never the board |

Nobody but the board starts a lane, a review or a merge. There is no orchestrator role and no window the board
opens: a decision the board cannot take goes to the owner as one Telegram line, and the owner opens a session if
he wants an agent to handle it.

## 2. The road and where the automation starts and ends

Stages do not change: `spec → grilled → ticketed → development → local_check → ci_pr → merged → done`, plus
`stuck` = "needs the owner". Unit cards move by facts only, as today (`syncSprintUnits`).

- `spec → grilled → ticketed` is judgment work and stays with the MLD session: grill, the Lavish questions page,
  the answers sewn in, the tickets cut. The board only rings the partner group when the page link appears and
  marks the card answered when the page is ended (`artifactAnswered`, exists).
- **The board's automation begins the moment unit tickets referencing the umbrella exist** (`ticketed`) and ends
  when the sprint is *ready for acceptance* (§8): one Telegram line to the owner.
- Acceptance: the MLD session writes one Lavish page ("what was done, how to check", one choice *accepted /
  remarks*); the board rings the group and waits for the answer; *accepted* → the MLD session closes the tickets
  and the umbrella (one command) → `done` by the existing facts. Automating the page itself is out of scope now.

## 3. Lane tasks — three kinds, one proof each

The board knows three kinds of lane task. Each has exactly one proof the board can see on GitHub — no report
files are read over ssh.

| Kind | When | Role | Proof |
|---|---|---|---|
| **develop** | a ticket of the sprint is open, has no lane and no PR, every dependency is merged, closed or on one open PR, the sprint card is in `ticketed`, `development`, `local_check`, `ci_pr` or `merged` | `lane` (label `qa-run` → `qa`, Mac lanes only, dependencies must be merged, base `origin/main`) | an open PR on the ticket's branch (`qa-run`: the ticket closed) |
| **review** | an open, non-draft PR of a unit has no verdict on its current head and no review launched for that head | `reviewer`, on a lane other than the one that wrote the PR | a comment `R<n> — GO` / `R<n> — NO-GO` + `head <sha>` where the sha is the PR head |
| **fix** | the PR's current head has a `NO-GO`, or its check is red, or GitHub says `CONFLICTING`; no fix launched for that head | `fixer` | a new head on the PR |

**Queue order** when several tasks wait and lanes are few: **review, then fix, then develop.** Sprints top to
bottom as the owner orders the cards; units in umbrella order. A QA finding is a ticket, so it is develop — there
is no third queue. Why not "develop first": a fix is one short run that lets a card leave the board and keeps the
heads other units build on true; a new unit is three hours plus a review plus, on 29.08, a 71 % chance of a fix
round. One sort line flips it if a week of numbers says otherwise.

**Branch** = the ticket's `Branch:` line, else `feat/<ticket number>`. Nothing is written to the ticket.
**Base** as today: `origin/main`, or the head of the single dependency's open PR. A branch that already exists on
origin is continued from, not held.

## 4. The loop (every 30 seconds)

```
1. facts: lanes (ssh, 45 s), open PRs (60 s: head, check colour, verdicts with head, mergeable, draft, labels,
   body), merged PRs (120 s), tickets (180 s: state, labels, branch line, depends-on, comments, createdAt)
2. any fact older than 10 minutes → do nothing this sweep (unknown is not free)
3. move the cards by the facts (exists)
4. judge the lanes the board sent that are free again, once the PR list is newer than the lane's free time:
   proof present → journal entry done;  proof missing → failure (§7), the task re-enters the queue
5. merge: for every open unit PR — check green on the exact head AND a GO whose `head` is that head AND not draft
   AND mergeable AND the ticket has no `hold-merge` label → rewrite `Closes/Fixes/Resolves #N` to `Ticket: #N`
   in the body, `gh pr merge --squash` with that title and body. The merged list moves the card.
6. queue = reviews + fixes + develops (§3); for every free lane: take the first task, write the task file (§5),
   copy it, start the lane, journal `<ticket>:<kind>:<round or head>`; one launch per lane per sweep
7. stuck (§7) → one Telegram line to the owner;  ready for acceptance (§8) → one Telegram line to the owner;
   a free lane with a non-empty queue for 5 minutes → the idle-lanes alarm (exists)
```

## 5. The task file

`TASK-<ticket>[-REVIEW-R<n>|-FIX-R<n>].md` in the lane's kitchen; only the board writes it; a copy stays in
`state/auto-dispatch/`.

```
# TASK-<ticket>[-REVIEW-R<n>|-FIX-R<n>] — <title>
Sprint …, umbrella issue #…, ticket #… (url)
Lane: <kitchen>/lane-N (host/lane-N). Branch: <branch>. Repository: <owner/repo>.
Base: … (as today)
Role: lane | reviewer | fixer | qa      Head: <sha>  Round: R<n>      (Head/Round for reviewer and fixer)
Check: <the full local check command>   (from the board's settings)
Rules: docs/RULES.md @ <sha>
Spec bundle: …
Dispatched by the board at … ; this file is …
---
<the `common` section of RULES.md @ sha>
<the role's section of RULES.md @ sha>
---
# TICKET #<n> — verbatim
<the ticket body from GitHub>
---                                   (fixer only, one of:)
# VERDICT R<n> — verbatim   |   # CI — red checks on <sha>: <names>   |   # CONFLICT — merge origin/main into <branch>
```

The rules text comes from `git show HEAD:docs/RULES.md` in the board's own repo, cut at the `<!-- role: … -->`
markers; the sha is `git log -1 --format=%h -- docs/RULES.md`. No committed `docs/RULES.md` → nothing is
dispatched and the table says why. Lanes never see the working copy. The hand-written `BRIEF-COMMON*.md` is no
longer substituted (it replaced the rules and put `Closes #` into 18 of 18 PRs on 29.08).

## 6. Review and merge — by the board

- The reviewer starts on the fact "PR open, not draft, no verdict on this head". Again on every new head.
  The verdict is plain text in a PR comment: line 1 `R<n> — GO` or `R<n> — NO-GO`, line 2 `head <sha>`.
  A verdict without a `head` line, or with another head, is not a verdict.
- Only the board merges (`gh pr merge --squash`, §4 step 5). GitHub auto-merge is switched off in the product
  repo; no window, agent or lane merges. The ticket stays open after the merge: merged ≠ accepted (decision 13).
- `NO-GO` on the head → the card goes back to `development` (exists) and a fix task is queued with the verdict
  verbatim. A red check on the head → a fix task with the check names. `CONFLICTING` → a fix task "merge
  `origin/main`". After the fix's push the reviewer runs again on the new head.
- A ticket labelled `hold-merge` (migrations, schema, auth, deploy/env, payments, the scraper — the cutter labels
  it) is never merged by the board; the owner merges it by hand.

## 7. Failure, stuck, the owner

- One counter per card, `consecutiveFails` (exists, ceiling 3): +1 on `NO-GO`, on a red check, on a conflict the
  fixer could not resolve, and on **a lane the board sent that is free again without its proof** (a lane died,
  Codex quit, the subscription wall, a pushed branch with no PR). A failed task re-enters the queue as the next
  round, another host first.
- The third failure in a row → `stuck`. A comment on the ticket whose first line starts with `QUESTION` → `stuck`
  at once (the lane says the ticket's facts do not match the code).
- `stuck` → one Telegram line to the owner (`notifyStuck`, exists). The owner — or a session he opens — repairs the
  ticket and returns the card with the existing move API; the counter resets. The board never opens a tab.

## 8. QA — twice, and "ready for acceptance"

- The QA round-1 ticket is cut with the sprint (`docs/QA-TICKET.md`): label `qa-run`, `depends on:` every unit;
  startable only when every unit is **merged**. The board dispatches it to a Mac lane in the role `qa` (a headed
  browser on production). Its proof is its own close.
- The walker files every finding as a ticket labelled `qa` on the umbrella (develop, the full road: local check,
  PR, review, board merge — a green check merged a non-fix on 29.08, so nothing is skipped). If it filed at least
  one, it creates the next round `QA R<n+1>` (`qa-run`, depends on its findings) before closing its own ticket.
  Round 3 with findings → `QUESTION` → stuck.
- **Ready for acceptance** = every unit merged, every `qa` ticket merged or closed, the latest `qa-run` ticket
  closed and no `qa` ticket created after it. One Telegram line to the owner. The MLD session writes the
  acceptance page; the board rings the group when its link is set on the card (the doorbell fires for a card in
  `merged` too) and marks the answer.

## 9. The rules — one file

`docs/RULES.md` in this repo: sections `common`, `lane`, `reviewer`, `fixer`, `qa`, `cutter`, ≤ 100 lines,
numbered commands and bans, no "why". Every agent sees `common` plus its own section, pasted by the board (§5); the
cutter is the MLD session and reads its section itself. Rules that can be checks are checks:

| Rule | Check |
|---|---|
| never `Closes #` | the board rewrites the body before the merge; the reviewer names it |
| a verdict counts only on the head being merged | `head` line required and compared |
| every ticket has a branch | `feat/<ticket>` by rule |
| only the board merges | auto-merge off; `hold-merge` label honoured |
| a QA finding is on the board | the `qa` label + the umbrella reference (exists) |

## 10. Alarms and messages

To the **owner** (private chat with the bot): `stuck` (one line per card), idle lanes (a free lane with a
non-empty queue for 5 minutes, exists), *ready for acceptance*. To the **partner group**: "page ready" when a
questions or acceptance page link is set on a card (exists), and the sprint-done line (exists). Nothing else. The
board only sends; it never polls the bot. Every message is one line; no board links in messages to the partner.

## 11. Operations

- The switch is `autoDispatch: true` in `state/autopase-board.json`, re-read every 30 s; no environment variable.
- Telegram is a block in the same file: `botToken`, `chatId` (the group), `ownerChatId`; without `ownerChatId`
  the board does not dispatch (alarms need an addressee). The sender needs no board URL or API token.
- One board process from a Windows Scheduled Task; a second listener is a bug. Every log line carries a time.
  The sweep runs every 30 s regardless of open pages.
- A lane parked on a merged branch is free. The lane launchers on the servers run Codex with
  `model_reasoning_effort=ultra` and `agents.max_concurrent_threads_per_session=5` (decision 2 of 30.08).
- GitHub auto-merge off in `Baltic-OrangesLV/vincheck-latvia`; the board's `gh` is the machine's default login.

## 12. Deleted

`bin/dev-launch.mjs`, `bin/ci-slot.mjs` (+ `/api/slots`), `bin/hooks.mjs` (+ `/hooks/*`), `bin/stream-watch.mjs`
(+ its tests, `streamsSource`, `streamWatch`), `COMMON_BRIEF` and `loadBrief`, the hook typed into a CTO pane on
idle lanes, the `assignSubscription` buttons and the bot update loop, the env switch. The CTO window, the stream
window and their registries (`ACTIVE-SESSIONS.md`, `STREAM-WATCH.json`) are not kept. Of the docs, four stay
normative — `RULES.md`, `BOARD.md`, `FLEET.md`, `API.md`; the rest move to `docs/history/` unchanged.

## 13. Out of scope

The board building the acceptance page or creating issues; the board opening agent tabs; the Cloudflare Lavish
worker (pages go through the existing tunnel until the owner's key exists); subscription selection by the board;
moving the board to a server; the clean-up of the canary sprint and off-board PRs (by hand before switch-on).

## 14. Build — four tickets for Codex lanes, in this repo

| # | Ticket | Contents | After |
|---|---|---|---|
| T1 | entry and rules | dispatch in `ticketed` and `merged`; rules from `git show HEAD:docs/RULES.md` with the sha in the header, `COMMON_BRIEF`/`loadBrief` gone; `Role:`/`Check:` header lines; default branch; task file names and journal keys per kind and round; `launching` written before the launch; the switch in settings; `facts` passed to the sweep; the "branch exists" hold gone; a lane on a merged branch is free; `qa-run` → Mac only, merged dependencies only; labels carried into units | — |
| T2 | review and merge | verdict with `head`; review tasks on open heads on another lane; the review badge set by the board; `mergeable`, `labels`, `body` read; the merge sweep with the body rewrite and `hold-merge` | T1 |
| T3 | fix round, failure, stuck | fix tasks (verdict / red check / conflict); freed-lane judgment by proof; the failure counter fed by all four causes; `QUESTION` → stuck; `qa-run` proof = closed; "ready for acceptance" and the doorbell in `merged` | T1 |
| T4 | ops and deletions | Telegram block (`ownerChatId`, no board URL/API token needed, no board links to the partner); log timestamps; the sweep reset removed; the deletions of §12 with their tests | T2, T3 |

Each ticket: one branch, one PR, `npm test` green, one pass (decision 7: internal tooling is built fast), merged by
the MLD session. Texts by the MLD session in parallel: this spec, `RULES.md`, `QA-TICKET.md`, `BOARD.md`, the
`docs/` move.

**Switch-on**, after T4: kill stray board processes; register the Scheduled Task; `ultra` in `hzlane` (codex-dev,
hostinger) and `maclane`; auto-merge off; `autoDispatch: true` + the Telegram block; the finance sprint's stale
QA tickets and the canary sprint parked by hand; then the smoke test: one throw-away ticket on a test umbrella goes
`ticketed → lane → PR → review → merge → merged` with no hand, and `state/auto-dispatch.json` holds exactly
`<t>`, `<t>:review:<head>`, `<t>:merge:<head>`.

## 15. Signs of success (after a week)

1. Every sprint PR is in `state/auto-dispatch.json` — none opened by a window.
2. A free lane with a startable task waits under 5 minutes (hours on 29.08).
3. A green PR with GO is merged within 10 minutes (2 h 33 min on 29.08).
4. Zero PRs merged with `Closes #` (18 of 18 on 29.08).
5. Every task file in a lane's kitchen carries `Rules: docs/RULES.md @ <sha>` and the sha is in `git log`.

## 16. The 17 spec-vs-docs discrepancies of the morning, closed

1 board on Windows (ADR-0002 retired) · 2 hooks deleted, alarms on Telegram · 3 `ci-slot` deleted, slots read
from GitHub · 4–5 Claude ultracode no, Codex ultra yes · 6 the review badge is set by the board · 7 subscription =
the Codex home on the host, informational · 8 one merge path: the board · 9 decision 20 · 10 decision 19 · 11
`MANDATE`/`RUNBOOK` stream parts → history · 12 the road ends `merged → done` · 13 reviewer rule 2 · 14 `common` 4,
`cutter` 1 and 5 · 15 `cutter` section; `TICKETING.md` → history · 16 grill and cut are the MLD session's, the board
waits between them · 17 sprints queue as cards in board order; the top sprint with a startable task gets the lanes.
