# Ticketing — the `ticketed` stage contract

The `ticketed` stage sits between the grill and development:

`spec → grilled → ticketed → development → local_check → ci_pr → done`

Purpose: **everything that can stall, derail, or invalidate development is settled inside
the tickets, before any lane starts.** The 9-sprint benchmark (23–28.08) measured 139 h of
coding against 278 h of checking and waiting — two hours of pipeline for every hour of
code. The losses this stage can reach — review rework 61 h, lane idle 45 h, green PRs
waiting for a button 33 h, waiting on the owner 20 h, dependency ordering ~19 h — all
trace to things left unsettled when development started: undefined acceptance subjects,
missing default decisions, unordered dependencies, an unarmed definition of done. (The
other large losses of that week — night with nobody merging 47 h, runner queues 34 h —
are infrastructure, cured elsewhere.) This stage closes the reachable half on paper,
where closing costs minutes.

Two reading notes. The loss figures overlap between requirements and must not be summed —
several requirements chip at the same hours. And the numbered "conveyor rules" cited
below are the private operating rules distilled on 28.08 from the same benchmark; they
live with the benchmark reports outside this public repo, so each citation inlines the
rule's substance where it is used.

**Status.** This contract is the definition of the stage, and the stage is live on the
board: `bin/pipeline.mjs` runs `spec → grilled → ticketed → development`, and the move
`ticketed → development` is refused until `links.ticket` is set on the card. The owner's
subscription answer stays valid from `grilled` and auto-advances the card to `ticketed`
(not `development`; refused while a linked review artifact is still unanswered); the CTO moves the card onward only after the §4 checklist is green —
the `links.ticket` gate is the machine-enforced floor, the checklist is the contract.

Input: a `grilled` card — the grill outcome ([GRILL.md](./GRILL.md) §2) with the unit
breakdown U0..Un, blockers folded into the spec, and default decisions. The review
artifact (GRILL.md §3) is published and answered **while the card sits in `grilled`**:
the founders' answers are part of the grill outcome, and the card enters `ticketed`
only after they are folded into the spec — tickets are written from a spec with no
open questions left. Output: the full
ticket set on GitHub, written under the CTO's own GitHub App identity
([ADR-0004](./adr/0004-grill-outcome-becomes-one-github-ticket.md)), linked from the card.
A unit with no ticket does not exist for the board
([ADR-0006](./adr/0006-the-board-decides-the-stage-itself.md)).

## 1. The ticket set

One card produces:

- **One umbrella ticket** — the durable public record of the finished spec. This is the
  single ticket of ADR-0004; this contract extends that decision with mandatory per-unit
  tickets, the binding ADR-0006 already reads. The umbrella's URL goes on the card as
  `links.ticket`.
- **One unit ticket per grill unit** U0..Un. Each unit ticket references the umbrella
  number in its title or body — the primary of the bindings the board uses to compute
  scope (ADR-0006 also reads native sub-issues and a ticket column in an umbrella
  table: "the scope is the set of live tickets").

Never: one ticket shared by two units; a unit without a ticket; a ticket written after
coding started. Evidence: S7 started from a spec on 23.08 and got its umbrella on 24.08
retroactively — 34 h of attributed setup, and half the session's volume (34 PRs,
+39.5k lines) ran ahead of any trackable scope.

## 2. Required content of a unit ticket

Every field below is mandatory. One missing field = the set is not done and the card does
not move. Each requirement names the loss it kills.

### 2.1 Size and one protected area — inherited from the grill

The unit is ≤600 added lines (generated files excluded) and touches at most **one**
protected area (migrations/DB schema, auth, cache and deploy, scraper) — conveyor rule 13,
sliced by grill lens 1. The ticket names the protected area, or states `protected area:
none`. If honest implementation would exceed either bound, the ticket set is wrong: the
card goes back to `grilled`, the grill outcome is amended with the new U0..Un breakdown,
and ticketing restarts from it — never plan an oversized PR.
Evidence: oversized, multi-round PRs fed the 61 h of review rework (#1351 — 6 NO-GO
rounds, 18.7 h on one PR); S7's unsliced bulk produced 131 PR-hours of waiting and an
85 h calendar.

### 2.2 Base pinned: branch + exact commit SHA

The ticket states the base branch (`main`) **and the exact commit SHA** the unit was
planned against. Development-launch itself branches from the current head of
`origin/main` ([DEVLAUNCH.md](./DEVLAUNCH.md) has no SHA input), so the pin is enforced
by the lane, as the first verification command of the round (§2.9): confirm the pinned
SHA is an ancestor of the branch head, and that `git diff --name-only <SHA>..HEAD --
<the unit's files>` is empty. A non-empty diff means the plan is stale — the ticket goes
back to ticketing; the lane does not silently absorb the drift. After branching, `main`
is merged in at most once per PR lifetime, right before merge (conveyor rule 4).
Evidence: unpinned bases produced mechanical catch-up merges — #1324 merged `main` 10
times in a row; mechanical merges and empty `ci:` commits cost 24 h across the week, and
in S1 alone 18 of 37 CI runs were mechanical commits (~11 machine-hours).

### 2.3 Branch name pinned

The ticket states the full branch name, `feat/card-<id>-<slug>`. Development-launch's own
derivation is authoritative ([DEVLAUNCH.md](./DEVLAUNCH.md) builds it from the card
title, with its own clipping) — the CTO copies the name from a `--dry-run` plan into the
ticket rather than reconstructing the slug by hand. The name is what binds PR ↔ ticket ↔
card automatically.
Evidence: without a machine-readable binding the board cannot compute scope and the card
can never reach done automatically (ADR-0006) — S7's 34 PRs ran ahead of any
trackable scope; and an unbound PR cannot have auto-merge armed for it, feeding the 33 h
of "green waited for the button" and the 47 h of night losses.

### 2.4 Dependencies and order explicit

The ticket carries `depends on: none` or `depends on: #<ticket>` **with the reason named**
— "just in case" is not a reason (conveyor rule 5). A dependent ticket is not handed to a
lane until its base is merged to `main`. Two changes that must land on production together
are **one unit and one ticket**, never two tickets holding each other's green PR. If the
unit touches DB migrations, the migration number is reserved in the ticket at writing
time.
Evidence: dependency ordering losses cost ~19 h/week; #1329 + #1333 held each other green
for 4.5 + 5 h inside the 33 h of "green waited for the button"; unreserved migration
numbers caused the registry races of landmines 120/121 and 127.

### 2.5 Acceptance criteria machine-provable, with negative cases

Every acceptance criterion is a **command plus its expected output** — provable by a
machine, not by reading prose. Anything acceptance could later call NO-GO must already be
named here as a criterion (grill lens 2). Include negative cases: what must NOT happen,
each also as a command.
Evidence: undefined acceptance subjects drove the 61 h of review rework — #1340 went
5 rounds (8.1 h) over a single guard because the subject was never defined before coding;
#1368 went 5 rounds over the email-subject cleanup.

### 2.6 Red probe

At least one criterion is a **red probe**: a command that must FAIL on the base SHA
(before the change) and pass after. A check that was never seen red proves nothing.
Evidence: on 28.08 a task reported success while actually writing zeros — caught only
because acceptance re-ran the commands itself (conveyor rule 10: negative examples
required; the writer's quoted output is not proof).

### 2.7 Forbidden zones and landmines folded in, not referenced

Every recorded landmine the grill flagged for this unit (grill lens 4) is **pasted into
the ticket body** — the trap and the disarming line — not linked. The lane works from the
ticket text alone and follows no links. The same goes for forbidden zones: name the exact
files/paths the unit must not touch.
Evidence: recorded but unfolded lessons kept detonating — a hard-coded test date reddened
ALL branches on 28.08, part of the 26 h flaky/foreign-test loss (the recorded-trap part;
the pre-existing flaky tests in that row are cured by quarantine rules, not by tickets);
the "registry ≠ database" trap recurred after being recorded, as landmines 120/121 and
then 127 (conveyor rule 5).

### 2.8 Default decisions embedded — a lane never asks

Every open question in the unit is written as: **question · default decision · deadline ·
addressee**. The lane applies the default and keeps working; it never stops to ask a
human. Asking is lane death: the answer arrives hours later and the lane stands the whole
time.
Evidence: S9 waited 10.8 h for the Railway key — 82 % of that sprint's 19.3 h calendar
was waiting (15.8 h), the key alone more than half of it; in S7, Block 0 stood 9 h
waiting for the owner and the CTO ended up deciding anyway; owner-waiting cost 20 h
across the week. Owner-zone questions (defined once in [GRILL.md](./GRILL.md) §2a:
money, strategy, outgoing to external parties, live external access) have **no default**
(conveyor rule 1) — they must be answered before the card leaves `ticketed`, and they
were already sent as one packet at grill time (rule 11: requested at posting, not at the
wall).

### 2.9 Exact local verification commands

The ticket lists the exact commands the lane runs locally (with working directory),
starting with the base-pin check of §2.2, mirroring the grill's acceptance subjects: the
affected tests per round, and the full local CI **at most once, at the end of the round**
(conveyor rule 10). The lane's report is a pass through this list with real command
output — without it, acceptance does not open.
Evidence: unscoped re-running poisoned the week — 174 CI runs (47.7 machine-hours) were
killed by the next push to the same branch.

### 2.10 Definition of done

Done = **green pr-ci on the exact head + a GO review verdict**, and the merge is
automatic from that moment — auto-merge armed at GO (conveyor rule 6), or the board's
CI-slot runner where it drives CI/PR ([EXECUTION.md](./EXECUTION.md) merges on green
itself; the GO review must come before it is pointed at the PR). Under neither mechanism does a finished PR
wait for a human's morning, and a green PR never waits for a neighbor (rule 5).
Evidence: nights cost 47 h (#1356 and #1267 alone ~20 h); 23 PRs hung open longer than
6 h, almost all opened in the evening of 26.08 and merged next morning (9–23 h each);
finished-and-green #1481 lay ready for 8.5 h.

### 2.11 QA tickets — where the reviews' leftovers go

A finding from a unit's review that is judged not worth a round **now** does not go into a
"tails" note and does not stay in the sprint log: it goes into a **QA ticket** — an issue
labelled `qa` that references the umbrella. One QA ticket per finding worth fixing
(a fix is a PR like any other, bound by branch); findings that are cosmetics may share
one ticket, closed when the decision to drop them is written. The board puts a QA ticket
in the `qa` column the day it is written and holds the sprint in `qa` after its last unit
merges until every QA ticket is closed (decision 11). A leftover with no `qa` label is a
unit ticket in the board's eyes and lands in `ticketed` as work that never starts.
Evidence: the AUTO-SALON close-out (#1562, 29.08) bundled six findings — one of them the
two live readers that lost their schema guard — into one unlabelled note referencing the
umbrella; the board spawned it as a queued unit of a sprint already marked done.

## 3. Required content of the umbrella ticket

- The unit table: every unit ticket number, its one-line goal, its dependency, in
  execution order. This is the sprint scope the board reads (ADR-0006).
- The external-dependencies table from the grill: everything only the owner or a third
  party can give, each row with request date and received date, or the word `none`
  (conveyor rule 11 — S9's key was requested at 17:15 when the work was known at 15:32;
  10.8 h lost).
- The line `grill passed: <date>, <outcome document>` (conveyor rule 19: no task is issued
  without it).

## 4. The CTO checklist — run before moving the card

Minutes, not hours. All boxes or the card stays in `ticketed`:

- [ ] Every grill unit U0..Un has exactly one ticket; every ticket references the umbrella.
- [ ] Each ticket: ≤600 added lines planned, exactly one (or zero) protected area named.
- [ ] Each ticket: base SHA + full branch name stated (branch name copied from a
      dev-launch `--dry-run` plan).
- [ ] Each ticket: `depends on:` filled with a reason, or `none`; no pair of tickets
      waits on each other; migration numbers reserved where touched.
- [ ] Each acceptance criterion is command + expected output; negative cases present;
      at least one red probe per ticket.
- [ ] Landmines and forbidden zones pasted into the body — the ticket reads standalone,
      zero links required to start.
- [ ] Every open question has default · deadline · addressee; zero owner-zone questions
      left unanswered.
- [ ] Local verification commands listed (base-pin check first); definition of done
      states green pr-ci + GO + automatic merge.
- [ ] Umbrella: unit table, external-dependencies table (or `none`), grill-passed line.
- [ ] The card's stream-watch entry carries the `units: "issues"` promise — without it
      the unit tickets are invisible to the board and the card can never reach
      done automatically (ADR-0006).

## 5. What the board records

- `links.ticket` on the card = the umbrella ticket URL (`POST /pipeline/card/update`,
  allowed link keys per [API.md](./API.md)).
- The card moves `ticketed → development` only after the checklist above is green — the
  CTO moves it; the board never walks the human stages itself (ADR-0006). From there,
  development-launch refuses any card whose stage is set and is not `development`
  ([DEVLAUNCH.md](./DEVLAUNCH.md), Safety).
- Unit tickets are the board's scope: once ADR-0006's rollout step 3 is enabled, a new
  open unit ticket on a done card sends it back through the `reopen` path — so
  closing tickets is part of finishing a unit, not bookkeeping.

## 6. Forbidden at this stage

- Writing tickets before the grill outcome exists, or coding before the ticket exists
  (S7's retroactive umbrella: 34 h of setup attributed, scope untrackable).
- A draft ticket at spec time "to be updated later" — rejected in ADR-0004.
- A ticket that requires the lane to ask a human anything not already carrying a default.
- A ticket whose acceptance criteria a machine cannot check.
- Links in place of folded content for landmines, forbidden zones, or decisions.
