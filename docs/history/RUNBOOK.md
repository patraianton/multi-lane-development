# Runbook — the one step-by-step file

One card = one work package. This file gives the exact steps for every stage, in order.
Per-stage contracts live in the linked docs; **the sequence here is authoritative** — a
stage may not be skipped, however polished the input looks.

The road is one-way:

`spec → grilled → ticketed → development → local_check → ci_pr → merged → done` (+ `stuck`)

The page draws the two paper stages as one column, Grill (decision 19); QA is not a stage — it is
one run per sprint before `done` (§7).

---

## 1. `spec` — a spec arrives

**Who:** the CTO window.

1. Put the source (file/archive/voice/text) under the program's spec directory.
2. An Opus subagent — never the CTO window itself — unpacks it into `HANDOFF.md` and
   returns a 15-line digest: goal, units, done-criteria, protected zones, risks.
3. Create the pipeline card at `spec` with `links.spec` set.

**Exit:** the card exists and the digest is on it. Nothing is decided yet.

## 2. Grill — `spec → grilled`

**Who:** the CTO window, via a panel of independent lens agents. Contract: [GRILL.md](./GRILL.md).

1. Run the five Fable lens agents in parallel (complexity/slicing, acceptance subjects, external
   dependencies and money, landmines from the lessons memory, user path and proof).
   Every finding cites real code (`file:line` on main) and carries a proposed resolution.
2. Merge findings: fold blockers into the spec as amendments; take `default-decision`
   items alone; group remaining questions into two packets (owner = money/access only,
   partner = business data/copy).
3. Produce BOTH grill outcomes: the outcome markdown next to the spec, and the **Lavish
   review artifact for the founders** — every question a multiple choice whose FIRST
   option is the default decision. Questions for the business owner are business-language
   only — what the buyer sees, what the business promises, who does what. A technical
   point never reaches the artifact: the CTO defaults it, and the post-ticketing cut
   review (stage 3) re-checks it. Link the artifact on the card (`links.artifact`).
4. **Ping the reviewers — always, immediately.** The moment `links.artifact` lands on the
   card, post the artifact-ready ping into the configured Telegram channel: the artifact
   URL plus the card link, tagging the configured reviewers ([TELEGRAM.md](./TELEGRAM.md)).
   Answers are given on the artifact page; the ping is only the doorbell. An artifact
   published without the ping does not count as delivered.
5. Move the card to `grilled`. The board tracks answers itself and marks the card
   `artifact answered`; answers arriving another way are recorded via
   `POST /pipeline/card/artifact-answered`.
6. Fold the founders' answers back into the spec.

**Exit:** answers folded in. The board refuses `grilled → ticketed` while a linked
artifact is unanswered.

## 3. Ticketing — `grilled → ticketed`

**Who:** the CTO window. Contract: [TICKETING.md](./TICKETING.md).

1. Create the umbrella issue (goal, numbered units, criteria, protected zone yes/no).
2. Write one GitHub ticket per unit: ≤600 added lines and one protected area each; base
   branch + exact SHA pinned; branch name pinned; dependencies explicit; acceptance
   machine-provable with negative cases; red probe named; landmines folded in verbatim;
   default decisions embedded so a lane never asks a human.
3. **Code and prod actions never share a ticket.** Anything touching production (DB
   migration, env var, rebuild/redeploy) is its own CTO-owned ticket: its PRs never carry
   `Closes #`, and it is closed only by hand after the result is visible on production —
   content, not status 200.
4. **The cut is reviewed before it runs.** A panel of independent Opus reviewers reads
   the whole ticket set against the spec and the real code: sizes within budget, one
   protected area each, dependencies explicit and acyclic, acceptance provable, defaults
   embedded — and specifically that no ticket will force the lane to split it, re-cut it,
   or ask a human mid-work. Findings are fixed here, at `ticketed`; a lane never re-cuts
   a ticket.
5. **Ask the owner for the subscription — once per sprint.** Before any card leaves
   `ticketed`, the owner assigns the subscription the sprint's development runs on
   (the board's subscription mechanism). One answer covers the whole sprint — the
   question is never repeated per ticket.
6. Set `links.ticket` on the card. The board refuses `ticketed → development` without it.

**Exit:** every unit has a ticket, the cut-review panel found nothing left to fix, the
subscription is assigned, and the dependency order is written down.

## 4. Development — `ticketed → development`

**Who:** development-launch + a lane from the fleet. Contracts: [DEVLAUNCH.md](./DEVLAUNCH.md),
[FLEET.md](./FLEET.md). The stream window runs on [MANDATE.md](./MANDATE.md) **verbatim** —
one text for every stream, only the parameter block is filled per sprint; the CTO never
writes a mandate of their own.

1. Dispatch the unit's task file to a free lane (lane registry and busy-check per FLEET.md).
2. The lane codes on the pinned branch from the pinned base SHA. One unit = one lane for
   the unit's whole life.
3. The watchdog ([WATCHDOG.md](./WATCHDOG.md)) sweeps for dead writers, silent logs and
   stalled cards; three failures in a row → `stuck`, a human looks.

**Exit:** the writer reports done with the unit's tests written and green locally.

## 5. Local check — `development → local_check`

**Who:** the same lane. Contract: [EXECUTION.md](./EXECUTION.md).

1. Run the full local gate (`scripts/ci-local.mjs`) on the lane, on the exact commit.
2. Red gate → back to development on the same lane; the card does not advance.

**Exit:** green local gate on the exact SHA that will be pushed. Push only after green.

## 6. CI / PR — `local_check → ci_pr`

**Who:** the lane pushes; CI slots run; review agents judge. Contract: [EXECUTION.md](./EXECUTION.md).

1. Open the PR; CI runs on an assigned slot (no-queue alarm if slots are saturated).
2. Green CI must be on the exact head SHA — a green branch is not a green main.
3. Review runs **alongside CI, on the pushed head — not after green** (decision 20): the
   reviewer starts the moment the PR is open; if the head changes, only the difference
   is re-read. The window that starts a reader turns the card's review badge on
   (`POST /pipeline/card/update { id, review: { running: true, round: N, by } }`); the
   board turns it off when the verdict lands on the PR. Verdict comment's FIRST line is
   plain text `R1 — GO` / `R1 — NO-GO` (bold markup breaks the watchers). NO-GO → back
   to the same lane.
4. Merge on green + GO. Deploy follows the ordinary train; the probe
   ([PROBE.md](./PROBE.md)) confirms the deployed surface by CONTENT.

**Exit:** merged, deployed, probe green on the exact revision.

## 6a. Review — inside `ci_pr`

**Who:** the stream window runs the reviewers; the board reads the verdict.

Review is not a column (decision 20 folded decision 17's column back): a review that
waits for green CI adds the CI time to every PR for nothing. The reviewer reads the pushed
head while CI runs; the card stays in `ci_pr` from the PR opening to the merge, and the
column's header shows the average review round next to the average stay. While a reader
is on the head the card carries a live badge — `review running · R1 · 12m` — set by the
window that started the reader and cleared by the board when a verdict newer than the
badge lands on the PR. The verdict is the first line of a PR comment, plain text:
`R1 — GO` / `R1 — NO-GO`. A NO-GO is a review failure: the board sends the card back to
`development` for the fix round (the third in a row → `stuck`); the fix is just another
brief for a lane. Green CI on the exact head + GO = merge; the merged card moves on to
`merged` — on main, waiting for the rest of the sprint, the sprint's QA run and its own
acceptance — and to `done` when its ticket is closed by a person after the merge
(decisions 13, 19).

## 7. QA — two runs per sprint (walk, fix, final walk), before `done`; not a stage

**Who:** the CTO window + QA agents.

1. Every review finding not taken into the unit's round becomes its own backlog ticket
   THE MOMENT it is found. Tail bundles filed after handover are a violation.
2. **QA runs per sprint, never per unit — and it runs TWICE.** Round 1 opens only after
   the sprint's LAST unit is on production — until then a merged unit waits in `merged`. QA is not a column
   on the board (decision 19): its findings are `qa`-labelled tickets of the sprint, born
   in `ticketed` and travelling the road like units. Then two Codex computer-use agents on two free Mac lanes,
   in parallel and independently, walk PRODUCTION in a real browser along the sprint's
   briefs (the user's path, all locales, console clean). Their findings become tickets.
   A lane's own browser proof on Preview is part of its unit, not QA.
3. **Round 2 — the final QA (owner, 2026-08-30: "after the first QA, after the fixes are
   done, we run a second, final QA").** Once every round-1 fix is merged AND live on
   production, a fresh QA agent walks production again: every surface a fix touched, every
   surface round 1 marked pending or did not reach, plus the open `(unsure)` findings — same
   method (real browser, all locales, all viewports, counted content, console clean).
   Round 1 proves the sprint; round 2 proves the fixes — a fix seen only by its tests and
   its reviewer has not been seen by anyone. Findings are tickets as in round 1. If round 2
   files a fix, that fix gets its own re-walk of the surfaces it touched; the loop ends when
   a round comes back with zero product findings. Only then is the sprint handed to
   acceptance — the notification is sent by the CTO/owner, tagging the acceptor.

**Exit to `done`:** merged + deployed + probed + QA round 1 reported + fixes merged + QA round 2
(final) clean. A card with a prod-action
ticket is `done` only when that ticket was closed by hand on visible production content.

## `stuck`

Three consecutive failures anywhere put the card in `stuck`. No automatic retries past
that point — a human decides. Leaving `stuck` requires naming what changed.

---

## Cross-references

- The owner zone (what only the owner decides) is defined once, in GRILL.md §2a.
- Artifact publishing for founder review: [ARTIFACT.md](./ARTIFACT.md); Telegram
  doorbells: [TELEGRAM.md](./TELEGRAM.md).
