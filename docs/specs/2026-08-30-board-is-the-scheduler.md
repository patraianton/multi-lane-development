# The board is the scheduler — spec

Date: 2026-08-30. Owner: Anton. Status: under owner review.
Grounds: the 2026-08-29 review (`_conveyor/autopase.lv/reports/2026-08-29-reglament-review-finance-cards-R1.md`)
and the 2026-08-30 fact sheet (`…/reports/2026-08-30-board-as-orchestrator-facts.md`).

## 0. What changes, in one paragraph

Work is put on lanes by the board, not by an agent. The board already can (auto-dispatch, decision 16,
live since 2026-08-29); we remove the second dispatcher — the stream window — and build the rest the
board lacks: dispatch in every stage, the fix round, PR review, the merge, reading the lane's report,
and alarms. One agent remains — the **orchestrator** — and the board calls it for a specific case: cut
a spec into tickets, or resolve what the board cannot decide. The rules are one file, one section per
role, its version pinned to the sprint.

## 1. Who exists

| Who | Does | Started by | Retired |
|---|---|---|---|
| **Board** (Watchtower, 127.0.0.1:4878) | dispatches work, moves cards by facts, starts PR review, merges, raises alarms | one process, a Windows Scheduled Task | — |
| **Lane** (8: lanes-01 ×3, hostinger ×2, mac ×3) | one task from the board, in the role *developer* / *fixer* / *reviewer* / *conflict resolver* | `hzlane N "Read <file> and do it whole"` (Mac: `maclane N`), a fresh run per task | — |
| **Orchestrator** | cuts a spec into tickets (grill + cut); resolves the cases in the closed list of §9 | the board opens a fresh herdr tab with `TASK-ORCH-<case>.md`; the agent does the task and closes | the CTO window, the stream window |
| **Owner** | the spec, grill answers, the sprint's subscription, sprint order, acceptance, production | the board and Telegram | — |

Nobody but the board **ever** starts a lane. Stream windows and the CTO window are retired; their
duties are reassigned in §11.

## 2. The card's road

Stages do not change: `spec → grilled → ticketed → development → local_check → ci_pr → merged → done`,
plus `stuck`, which now means **"needs a decision"** (§9). The sprint card is the roll-up; unit cards
(one per ticket) are spawned by the board and move by facts only, forward only.

| Transition | Fact the board moves on |
|---|---|
| spec → grilled | the orchestrator finished the grill, the owner's answers are sewn in (as today) |
| grilled → ticketed | the owner assigned the subscription (as today); **new:** on entering `ticketed` the board gives the orchestrator the task "cut" (§9) |
| ticketed → development | the umbrella and the unit tickets exist, and the board dispatched the first unit itself (**new:** a person did this before) |
| development → local_check | the local check runs on the lane (as today) |
| local_check → ci_pr | the PR is open (as today) |
| ci_pr → merged | the board merged the PR (**new:** the stream window did this before) |
| merged → done | the ticket was closed by acceptance later than 2 minutes after the merge (as today, a person) |
| any → stuck | a case from §9 |
| stuck → previous | the orchestrator returned the card via `POST /pipeline/card/unstuck` (**new:** only a person could before) |

## 3. The queue and its priority

Three kinds of task compete for a lane. Dispatch order — **the owner's word, 2026-08-30**:

1. **Fix** on an open PR: a fresh `NO-GO` from the reviewer, or a red check after one automatic retry.
   Role *fixer*.
2. **New unit**: the ticket is open, has no lane and no PR, every dependency is merged or on one open PR,
   the ticket has a branch. Role *developer*.
3. **QA finding** after the merge (a ticket labelled `qa`, linked to the umbrella). Role *developer*.

PR review (role *reviewer*) is outside the queue: an open PR without a reviewer takes the first free lane
before anything else, because it is short and it unblocks the merge.

Between sprints: the top card on the board goes first; the owner orders cards by hand.
Within a sprint: the unit order from the umbrella.

## 4. The scheduler loop (every 30 seconds)

```
1. lane, PR or ticket data older than 10 minutes → do nothing
2. for every open PR with no reviewer and no verdict on its current head:
      a free lane → the "reviewer" task, start it
3. queue = fixes + new units + QA findings (order §3), sprints top to bottom
4. for every free lane: take the first item of the queue,
      build the task file (§5), copy it, start the lane, write the journal
5. for every PR: green check on the exact head AND GO on the same head → merge,
      card → merged
6. a lane became free: read the last line of REPORT-<ticket>.md (§8)
7. a case from §9 → card to stuck, task for the orchestrator
8. alarms (§8)
```

Lines 1, 3 (partly), 4 and 5 (reading the verdict) exist in `bin/auto-dispatch.mjs`, `bin/idle-lanes.mjs`
and `bin/pipeline.mjs`. New: 2, 3 (fixes, QA, the `ticketed` and `merged` stages), 5 (the merge itself),
6, 7, 8.

## 5. The lane's task file

One file `TASK-<ticket>[-FIX-R<n>|-REVIEW-R<n>|-MERGE].md` in the lane's kitchen. Its shape (as today, with
two changes — the role and the rules version):

```
# TASK-<ticket> — <title>
Sprint …, umbrella #…, ticket #…
Lane: … Branch: … Base: <ref or sha>   Repository: …
Role: lane | fixer | reviewer | resolver
Rules: docs/RULES.md @ <sha>            ← the sprint's rules version (§10)
Spec bundle: <path> | none shipped
---
<the common section of RULES.md @ sha>
<the role's section of RULES.md @ sha>
---
# TICKET #<ticket> — verbatim
<the ticket body from GitHub, verbatim>
[for the fixer:]
---
# VERDICT R<n> — verbatim
<the reviewer's verdict from the PR, verbatim>
```

Rules:
- Only the board builds the file. A hand-written `BRIEF-COMMON-*.md` from the spec folder **is no longer
  substituted** (yesterday it replaced the rules wholesale and allowed `Closes #`).
- "The ticket wins" is about *what to build* only. The bans and the delivery order from `RULES.md` win
  over the ticket always.
- If the ticket has no `Branch:` line, the board names the branch `feat/<sprint>-<ticket>` itself and adds
  the line to the ticket with `gh issue edit`.
- The branch already exists on GitHub: if a merged PR carries it, the unit leaves the queue as done; if
  no PR does — once to stuck (§9), not a retry every 10 minutes.
- A lane keeps nothing between tasks: the branch lives on GitHub, a fix or a retry runs on any free lane.
  The reviewer runs on a lane other than the one that wrote the code (a second pair of eyes).
- A task for the no-build lane (`lane-3`): tickets labelled `no-build` only.

## 6. PR review and merge — by the board

- **The reviewer** is a lane task (Codex), one per PR, role `reviewer` from `RULES.md`. It starts on the
  fact "PR open" (at once, alongside CI) and again on the fact "new head after NO-GO". This retires the
  2026-08-23 rule "one Opus reviewer per PR" — the owner's word, 2026-08-30.
- The verdict is the first line of a PR comment, plain text: `R<n> — GO` / `R<n> — NO-GO`; the second line
  `head <sha>`. A verdict without `head`, or with another head, does not count.
- **The merge** is the board's: `gh pr merge --squash` only when the check is green on the exact head
  **and** GO is from the same head. No window or agent touches the merge; branch protection on GitHub
  requires the status "verdict on this head".
- `NO-GO` → the card goes back to `development`, a task for the fixer (§3 item 1). The third `NO-GO` in a
  row → stuck.
- A conflict with `main` at merge time → a task for the *resolver* (`-MERGE`): merge `origin/main`, touch
  no one else's files; cannot → stuck.

## 7. QA (decision 21, 2026-08-30)

QA is an ordinary ticket the board spawns from a template on the fact "every unit of the sprint is merged"
and dispatches like a unit (role *developer*, a Mac lane, label `qa-run`). QA findings are tickets labelled
`qa` on the umbrella; once they merge, the board spawns the second QA ticket (the final walk). The sprint
goes `merged → done` only after the second QA ticket is closed and the owner accepts.

## 8. Feedback and alarms

What does not exist at all today — the board learns the result only from the PR.

- A lane became free → the board reads the last line of `REPORT-<ticket>.md` over ssh.
  `DONE #<ticket> <PR> <sha>` and the PR exists → fine. No report or no PR → **a failure**: one automatic
  retry on another lane, a second failure → stuck (§9). The journal key is "ticket + round", not "ticket".
- A lane freed in under 3 minutes without a PR twice in a row on one host → the host is marked
  **unhealthy** (subscription limit, ban, broken home), leaves the rotation, one message to the owner.
- A lane "busy" for more than 3 hours without a push, or a lane log silent for 20 minutes → counted as
  hung: the board sends the card to stuck and the orchestrator the task "check the lane".
- **Exactly three alarms**, all to the owner on Telegram (the address is a required board setting):
  1. the queue has a task and no free lane for more than 5 minutes;
  2. a lane died without a PR (after the retry);
  3. a card in stuck with no movement for 30 minutes.
  One alarm repeats no more than once an hour. Window hooks stay only for starting the orchestrator (§9);
  alarms do not travel through them — they need an addressee away from the computer.

## 9. What the board does not decide → the orchestrator

A closed list. Anything not here is a rule in code, not a decision.

1. The lane wrote `QUESTION` in its report (the ticket's facts do not match the code).
2. A lane died without a PR for the second time.
3. A red check for the second time in a row after a fix.
4. Two dependencies of a unit on open PRs — no single base.
5. The resolver could not resolve a conflict.
6. The third `NO-GO` in a row.
7. A hung lane (§8).

How it is called: the board puts the card in stuck, writes `TASK-ORCH-<card>-<case>.md` (the header + the
`orchestrator` section of `RULES.md` @ sha + everything it knows: the ticket, the lane's report, the
verdict, the log tail) and, through the probe, opens a fresh herdr tab with the task "Read … and do it
whole". The orchestrator acts only through the board's API and `gh` (rewrite the ticket, split it, drop a
dependency, close the unit, return the card with `unstuck`). Done — the tab closes. 30 minutes without
movement — an alarm (§8). The orchestrator does not start lanes, does not merge, does not write to the
owner — only through the board.

Cutting a spec is the same mechanism: a card in `spec` with text → the task `TASK-ORCH-<card>-cut.md`.
The grill stays as it is (five lenses, questions to the owner through the artifact), but the orchestrator
does it in that tab, not a standing window.

## 10. The rules — one file

`docs/RULES.md` in the board's repo, 100–130 lines, six sections with a machine marker `<!-- role: … -->`:

| Section | For | Lines | Content |
|---|---|---|---|
| `common` | everyone | 12–18 | where to work; four bans (production, the database, deploy/env, the merge); "never ask a human — take the safe reading and put a line in the report"; the report format and the `DONE` line |
| `lane` | developer | 25–30 | start from the base in the header; push only after a green full check; the four-step self-check; PR as draft, first line `Ticket: #N`; never merge |
| `reviewer` | reviewer | 20–25 | what to read (the head from the header), what not to; the verdict `R<n> — GO/NO-GO` + `head <sha>`; findings with file:line; a finding out of scope → a ticket labelled `qa` |
| `fixer` | fixer | 12–15 | the same branch; every verdict item = a test, red on the old code; nothing beyond the list |
| `resolver` | resolver | 10–12 | merge `origin/main`; touch no one else's files; a conflict in someone else's code → stop and "needs a person" |
| `orchestrator` | orchestrator | 25–30 | the cut: ≤600 lines, one protected zone, dependencies, acceptance as commands with a negative case; the §9 cases: what it may use (the board's API, `gh`) and may not (lanes, the merge, production) |

Form: numbered commands and bans only, no "why". An agent of any role sees `common` plus its own section.

**Version.** When a sprint enters `development`, the board writes `rulesSha` on the card — the commit that
holds `RULES.md`. Every task of that sprint reads the text with `git show <rulesSha>:docs/RULES.md`, never
from the working copy. Uncommitted rules = no rules: the board refuses to dispatch. Edits to `RULES.md`
apply to new sprints only; changing the version of a running sprint is an explicit owner action
(`POST /pipeline/card/update { rulesSha }`) and lands in the card's history.

**Requests in text → checks in code:**
- `Closes #` / `Fixes #` in a PR body → the `pr-ci` check goes red, the board shows the PR as an error.
- A verdict counts only on the head that is being merged.
- A ticket without `Branch:` → the board names the branch (§5).
- A ticket linked to the umbrella after `merged` without the `qa` label → "off the board", no card is spawned.
- Stage moves and gate overrides (`/pipeline/card/move`, `/artifact-answered`) — only with the owner's key
  or from the board itself.

## 11. What we delete and change in texts and processes

- From `MANDATE.md`, `PROGRAM-ORCHESTRATION.md`, `CTO-REGLAMENT.md`, `EXECUTION.md`, `RUNBOOK.md`: lane
  dispatch, starting reviewers, the merge, waking windows — the board does all of it. No text for a
  "stream window" is needed: there is no stream window.
- The four contradictions close with one answer each: ultracode — **no** (lanes and the orchestrator are
  plain sessions); PR review — **on open**, alongside CI; who merges — **the board**; the ceiling — **the
  third failure in a row → stuck**.
- Of the 17 documents in `docs/`, four remain: `RULES.md` (norms), `BOARD.md` (how the board works: stages,
  the loop, tasks, alarms — from this spec), `FLEET.md` (lanes), `API.md`. `DECISIONS.md`, `LESSONS.md`,
  `TICKETING.md`, `GRILL.md` and the rest go to `docs/history/` as sources, not norms; their normative part
  moves into `RULES.md` (`orchestrator`).
- In autopase-ops: `CTO-REGLAMENT.md`, `PROGRAM-ORCHESTRATION.md`, `FAST-MODE-PLAYBOOK.md` → one pointer
  page to `RULES.md` and `BOARD.md`; the old texts go to `history/`.
- `ACTIVE-SESSIONS.md` and `STREAM-WATCH.json` (window registries) are no longer kept: there are no windows,
  the board sees the lanes.
- The manual `bin/dev-launch.mjs` and `bin/ci-slot.mjs`: delete, or fold into the one auto-dispatch path
  (they use a different task format and branch naming).

## 12. Operations

- One board process from a Windows Scheduled Task (at logon + repetition); the extra ones on 4881/4882 go down.
- The dispatch switch is the field `autoDispatch: true` in `state/autopase-board.json`, not an environment variable.
- The probe `bin/probe.mjs` is a Scheduled Task; it also opens the orchestrator's tabs.
- The owner's Telegram address is a required setting; without it the board does not start dispatch.
- One lane registry (merge `hosts/lanes` in `state/autopase-board.json` and `state/fleet-launch.json`).
- A lane sitting on an already merged branch is free (today mac lane-7/8 are "busy" with merged branches).
- A timestamp on every line of `state/board.log`; the live process writes to that same file.

## 13. Out of scope

- Subscription (Codex home) selection by the board: the home stays hard-wired in each host's `hzlane`; the
  card's `subscription` field is informational. A separate task.
- Automating the grill itself and the owner's answers.
- New columns, a new board, moving the board to a server.
- The second sprint `WT-CTO-CANARY-01` and the off-board litter — a manual clean-up before switching on.

## 14. Signs of success (checked after a week)

1. In a week, no branch or PR created by a window off the board: `state/auto-dispatch.json` covers 100 %
   of the sprint's PRs.
2. A free lane with a non-empty queue for no longer than 5 minutes (hours today; yesterday the owner
   noticed idle lanes 5 times himself).
3. A green PR with GO merges within 10 minutes (2 h 33 min yesterday).
4. Zero PRs with a `Closes #` line (18 of 18 yesterday).
5. Every task file in a lane's kitchen carries `Rules: docs/RULES.md @ <sha>`, and the sha is in git.
6. Every card in stuck got an orchestrator task within 1 minute and movement within 30.
7. The rules get no more than one commit into a running sprint per week (43 in one day yesterday).

## 15. Order of work — in parallel

**Lane A (board code, tickets in the board's repo, ~25–30 h):**
1. Dispatch in every stage (`ticketed`, `merged`), the journal key "ticket + round", branch auto-naming,
   the end of the eternal hold, a lane on a merged branch is free, the `no-build` label — 6–8 h.
2. The role and the rules version in the task file: `loadBrief(role, sha)` from `git show`, the `rulesSha`
   field, refusal without a commit; drop `BRIEF-COMMON*` — 3–4 h.
3. The fix round after NO-GO and the reviewer on the fact "PR open" — 8–10 h.
4. The merge by the board + head check + branch protection — 3–4 h.
5. Reading the lane's report, the "unhealthy host", the hung lane — 3–4 h.
6. Stuck → orchestrator task through the probe; Telegram; the switch and autostart; one registry — 4–5 h.

**Lane B (texts, by hand, one day):** `RULES.md` with six sections, the four answers to the contradictions,
`BOARD.md` from this spec, the clean-up of `docs/` and autopase-ops per §11.

**Switch-on:** when both lanes are done — one commit of `RULES.md`, `autoDispatch: true`, stream windows
closed. Until then windows **do not start lanes** (or there are two dispatchers again).
