# BOARD — how the board works and how to run it

The board is one Node process (`bin/watchtower.mjs`, no dependencies, Node ≥ 22) on the owner's Windows PC,
`http://127.0.0.1:4878`. It is the scheduler of a coding-agent fleet: it reads facts (lanes, PRs, tickets),
moves cards by those facts, puts work on free lanes, starts reviews, merges, counts failures and alarms the
owner. The design and its reasons: `docs/specs/2026-08-30-board-is-the-scheduler.md`. The rules every agent
gets: `docs/RULES.md`. The lanes: `docs/FLEET.md`. The HTTP API: `docs/API.md`.

## 1. Who exists

| Who | Does |
|---|---|
| the board | everything below, every 30 seconds, by itself |
| 8 Codex lanes | one task per run: `lane` (write a ticket), `reviewer` (read one PR head), `fixer` (one round on an open PR), `qa` (walk production) |
| the owner and his MLD session | spec intake (grill → questions page → tickets), the sprint order, stuck cards, the acceptance page |
| the partner | writes specs, answers the questions page, accepts on one page per sprint |

Nobody but the board starts a lane, a review or a merge. There is no orchestrator window.

A lane belongs to whoever launched the task on it. Before stopping a lane, read its `TASK-<n>.md` (or the
branch checked out in the folder): a task you did not launch is not yours to stop — write on the ticket instead.
Hand-run work takes a reserved lane (`<lane>.reserved`, FLEET.md) and a line in the umbrella; a hand queue never
competes with the board for a free lane. Edge case 2026-08-30: a sprint window's stop script killed the board's
U2b #1685 on hostinger/lane-4 by lane number.

## 2. The road

`spec → grilled → ticketed → development → local_check → ci_pr → merged → done`, plus `stuck` = needs the owner.

- `spec`, `grilled`, `ticketed`: paper work, the MLD session. The board rings the partner group when a
  questions page is linked (`links.artifact`) and marks the card answered when the page is ended.
- From `ticketed` the board runs everything: unit cards (one per ticket referencing the umbrella) move by facts —
  lane busy → `development`, local check → `local_check`, PR open → `ci_pr`, PR merged → `merged`, ticket closed
  after the merge → `done`. The sprint card follows its units.
- The board's work ends at **ready for acceptance** (every unit merged, every `qa` ticket merged or closed, the
  latest QA walk closed with no finding after it): one Telegram line to the owner.

## 3. Lane tasks and their proofs

| Kind | The board starts it when | Role | Proof the board waits for |
|---|---|---|---|
| develop | a ticket is open, has no lane and no PR, its dependencies are merged, closed or on one open PR, and main's latest `pr-ci` run is not red | `lane` (`qa-run` label → `qa`, Mac only, merged dependencies only) | an open PR on the ticket's branch (`qa-run`: the ticket closed) |
| review | an open, non-draft PR has no verdict on its current head, unless the ticket carries `no-review` | `reviewer`, another lane than the writer's | a comment `R<n> — GO|NO-GO` + `head <sha>` for that head |
| fix | the PR head has `NO-GO`, a red check, or GitHub says `CONFLICTING` | `fixer` | a new head on the PR |

Queue order when lanes are few: **review, fix, develop**; sprints top to bottom as the owner orders the cards,
units in umbrella order. A QA finding is a ticket, so it is develop.

One live lane per PR head: while the board's own review of a head is running, a fix on that head waits (its
hold names the reason) — otherwise the fixer moves the head under the reviewer and the verdict lands on a dead
head. A NO-GO on the head releases the fix at once. Mirrored: while a fix of a head is running, that head is
not sent to review; the new head reviews freely once it appears.

Branch = the ticket's `Branch:` line, else `feat/<ticket number>`. Base = `origin/main`, or the head of the one
dependency's open PR. An existing branch is continued from.

A ticket labelled `hold-merge` is never merged by the board (migrations, schema, auth, deploy/env, payments, the
scraper — the cutter labels them); the owner merges it by hand. A ticket labelled `no-build` may go to the light
lane (lane-3). A ticket labelled `main-fix` is dispatched even while `main` is red — it is the ticket that repairs it.
A ticket labelled `no-review` (styles, texts or documentation only — RULES.md, cutter 7) gets no reviewer and
merges on the green check alone (§5); `hold-merge` always wins over it.

While `main`'s own `pr-ci` is red the board holds every lane task that would branch from `main` — the table says
`held: main is red since <time> (<run url>)`. Reviews, fix rounds and merges keep running: they are what makes
`main` green again. An unknown or stale answer is not red — a GitHub hiccup never stops the board.

## 4. The task file

`TASK-<ticket>[-REVIEW-R<n>|-FIX-R<n>].md` in the lane's kitchen (a copy in `state/auto-dispatch/`): a header
(sprint, umbrella, ticket, `Lane:`, `Branch:`, `Base:`, `Role:`, `Head:`/`Round:` for reviewer and fixer,
`Check:`, `Rules: docs/RULES.md @ <sha>`, `Spec bundle:`), then the `common` section and the role's section of
`docs/RULES.md` as committed in this repo (`git show HEAD:docs/RULES.md`; the sha is the last commit that touched
the file), then the ticket verbatim, then — for the fixer — the verdict verbatim, the red check names, or
"merge origin/main". No committed `docs/RULES.md` → nothing is dispatched and the table says so. The lanes never
see the working copy; edit the rules, commit, and the next task carries the new sha.

## 5. Review and merge

- The verdict is plain text in a PR comment: line 1 `R<n> — GO` or `R<n> — NO-GO`, line 2 `head <sha>`. Without
  the head line, or with another head, it is not a verdict.
- The board merges with `gh pr merge --squash` when the check is green on the exact head, GO is on that head,
  the PR is not draft, GitHub says mergeable, the ticket has no `hold-merge` label, and GitHub does not refuse the
  merge because the branch has fallen behind `main`. It refuses because `main` requires branches to be up to date
  (branch protection, `strict`, administrators included); the board then sends `gh pr update-branch` itself — no
  lane — and `pr-ci` runs again on the new head. The old head's merge budget closes as `superseded` (all attempts
  spent, no gave-up alarm — the new head merges on its own budget), and the PR snapshot is re-read on the next
  tick. A GO the old head already had is carried to the new head as a board comment (`R<n+1> — GO / head <new>`):
  the board's own update changes no PR diff — only main was pulled in, and that combination is exactly what
  `pr-ci` re-checks — so no review round is spent on it. A `no-review` PR carries nothing: it merges on the green
  check alone. At most one branch is updated per sweep. Before
  merging it rewrites `Closes/Fixes/Resolves #N` in the body to `Ticket: #N` — the ticket stays open: merged is not
  accepted. The squash subject and body go to `gh` as a file, never on the command line.
- On a `no-review` ticket the GO requirement is dropped — the green check on the exact head, not draft, mergeable
  and no `hold-merge` are enough. A `NO-GO` on that head still blocks the merge and gets its fix round: dropped is
  the requirement, never a standing stop order. On a PR shared by several tickets every one of them must carry
  `no-review`, and `hold-merge` on any of them still wins.
- `NO-GO`, a red check or a conflict → a fix task on the same branch; then the reviewer runs again on the new head.
- A merge GitHub refuses is written to the journal as `merge-failed` with GitHub's own message and a `merge:` line
  in the log; after three attempts the owner gets one line. The board never abandons a merge in silence. An
  update the board could not make says `behind main — update-branch failed` on the table, never that the branch
  was updated.

## 6. Failure, stuck, the owner

One counter per card, `consecutiveFails`: +1 on `NO-GO`, on a red check, and on a lane the board sent that is
free again — or that other work has taken over — without its proof. A lane is taken over when, twenty minutes
after the launch, it is busy on someone else's `TASK-<n>` or, where the lane cannot say, on a branch that is
neither the unit's, nor its base, nor a trunk. The task re-enters the queue as the next round, another host
first. The third failure in a row → `stuck`. The streak is broken only by real progress — a develop PR, a
closed qa-run ticket, a current-head GO; a judged fix ("the head changed") or review ("a verdict exists")
does not break it, so a review→fix carousel stops itself on the third NO-GO. A comment on the ticket whose first line starts with `QUESTION` → `stuck` at once.
`stuck` → one Telegram line to the owner. To return the card:

```
POST /pipeline/card/unstuck { "id": "<card id>" }     # the counter resets, the facts place the card
```

(or move it from the page). Fix the ticket first — the board will send it again.

## 7. QA and acceptance

- The QA round-1 ticket is cut with the sprint from `docs/QA-TICKET.md` (label `qa-run`, depends on every unit).
  When every unit is merged the board sends it to a Mac lane (a real browser on production). The walker files
  findings as `qa` tickets (the full road: local check, PR, review, board merge) and, if there were any, the
  round-2 ticket. Round 3 with findings → `QUESTION` → stuck.
- Ready for acceptance → the owner's MLD session writes one Lavish page ("what was done, how to check",
  *accepted / remarks*), publishes it with `node bin/lavish-publish.mjs publish <html> --card <id>`; the board
  rings the partner group and marks the answer. *Accepted* → close the tickets and the umbrella; the cards reach
  `done` by the facts.

## 8. Messages

To the owner (private chat with the bot): `stuck`; idle lanes (a free lane with a non-empty queue for 5 minutes
AND no reason from the planner — a unit the planner holds is not idle, its reason stands in the auto-dispatch
table); `main` turned red and `main` is green again; a merge the board gave up on after three attempts; ready for
acceptance. To the partner group: a page is ready; a sprint is done. The board only sends; nothing polls the bot
from the board.

## 9. Settings

`state/autopase-board.json` (re-read every 30 s):

```
autoDispatch: true                      — the switch; false = the board only says what it would do
telegram: { botToken, chatId, ownerChatId }   — the group and the owner's private chat; no ownerChatId = no dispatch
check: "bash ../ci-local-and-stamp.sh"  — the default full local check written into task files
github: { account, tokenFile }          — the pinned GitHub identity (see below); absent = the gh keyring account
repo, project, specsDir, hosts, lanes, ciSlots — as before (FLEET.md)
```

Main's health is read from GitHub once a minute and never stored; `autoDispatch` remains the only switch.

### The board GitHub identity

On 31.08 the keyring's "active" gh account turned out to be a banned one, and every GitHub sweep died
silently for hours. The `github` block makes that impossible:

- `account` — the login the board must act as; `tokenFile` — an absolute path to a file holding that
  account's token (get it once with `gh auth token -u <account> > state/github-token.txt`; `state/` is
  not in git). Every `gh` the board spawns then runs with `GH_TOKEN` from that file — inside gh the
  token wins over the keyring — re-read from disk at most once every 30 s, never printed anywhere.
- **Fail closed.** The token file missing or empty, or `gh api user` answering with a different login
  (checked at start and then once an hour), holds every gh sweep — sources, merges, dispatch — and
  alarms the owner once a day. Nothing ever falls back silently to whatever account the keyring holds.
- **To replace the token**: write the new token into the same file (`gh auth token -u <account> >
  state/github-token.txt`). The board picks it up within 30 s; no restart needed. To change the
  account, edit both fields in the settings — the identity is re-verified at once.
- **No block at all** — the keyring account is used exactly as before (other installs keep working),
  and the board says `github identity is not pinned` once at start.

`state/fleet-launch.json`: per host `kitchen`, `launch` (`hzlane {n} "{prompt}"` / `maclane {n} "{prompt}"`),
optional `shell`, `check`, `browser: true` (the Mac — QA walks); per lane `host`, `n`, optional `noBuilds`,
`reserved`. The lane launchers on the servers run Codex with `model_reasoning_effort=ultra` and five helper
threads (`/usr/local/bin/hzlane` on codex-dev and hostinger, `~/.local/bin/maclane` on the Mac).

## 10. Running it

- One process. Autostart: a Windows Scheduled Task at logon running `bin/watchtower-hidden.vbs` (no console
  window). A second listener on 4878 is a bug; a second board on another port with the same `state/` is two
  dispatchers.
- The journal of every launch, review and merge: `state/auto-dispatch.json` (keys `<ticket>:<kind>:<round>`);
  the task files: `state/auto-dispatch/`. The log: `state/board.log`, every line with a time.
- The dispatch table on the page and in `GET /api/pipeline` (`autoDispatch` rows) shows every decision: launched,
  held (and why), would-dispatch when the switch is off, merged.
- GitHub auto-merge is off in the product repo; branch protection on `main` — set and changed by hand by the
  owner — requires the `pr-ci` check AND that branches are up to date before merging (`strict`), administrators
  included, so no dispatcher — the board, a hand, another window — can merge a branch that has not been rebuilt on
  the current `main`. The board's `gh` acts as the identity pinned in the settings (§9); without a `github`
  block it is the machine's default login.

## 11. Switch-on checklist

1. `npm test` green on `main`; `docs/RULES.md` committed.
2. Exactly one board process (`netstat -ano | findstr :4878`); the Scheduled Task registered.
3. `state/autopase-board.json`: `autoDispatch: true`, the `telegram` block, `check`;
   `state/fleet-launch.json`: `browser: true` on the Mac host.
4. Product repo: auto-merge off; no PR armed; the canary sprint and stale tickets parked (label `wave-next` is
   ignored by the board) so the off-board list is empty.
5. Smoke test (spec §14): a throw-away umbrella + one trivial ticket in the product repo → the sprint card in
   `ticketed` → within a minute a lane is launched → the PR opens → a reviewer lane is launched → `R1 — GO` +
   `head` → the board merges → the card is `merged`; `state/auto-dispatch.json` holds exactly `<t>:develop:1`,
   `<t>:review:<head8>`, `<t>:merge:<head8>`. Then set `autoDispatch: false` and see the rows turn to
   "would dispatch".

## 12. What was retired on 2026-08-30

The CTO window and the stream window; the hook queue typed into windows; `bin/dev-launch.mjs`, `bin/ci-slot.mjs`,
`bin/hooks.mjs`, `bin/stream-watch.mjs`; the hand-written `BRIEF-COMMON*.md` in spec folders; the env switch
`WATCHTOWER_AUTO_DISPATCH`; the Telegram buttons and update loop. The old contracts are in `docs/history/` as
sources, not norms.
