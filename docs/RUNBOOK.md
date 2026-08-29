# Runbook — the one step-by-step file

One card = one work package. This file gives the exact steps for every stage, in order.
Per-stage contracts live in the linked docs; **the sequence here is authoritative** — a
stage may not be skipped, however polished the input looks. (Owner's decision 2026-08-29,
after a ready-made spec was cut into tickets with no grill.)

The road is one-way:

`spec → grilled → ticketed → development → local_check → ci_pr → qa → done` (+ `stuck`)

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

1. Run the five lenses in parallel (complexity/slicing, acceptance subjects, external
   dependencies and money, landmines from the lessons memory, user path and proof).
   Every finding cites real code (`file:line` on main) and carries a proposed resolution.
2. Merge findings: fold blockers into the spec as amendments; take `default-decision`
   items alone; group remaining questions into two packets (owner = money/access only,
   partner = business data/copy).
3. Produce BOTH grill outcomes: the outcome markdown next to the spec, and the **Lavish
   review artifact for the founders** — every question a multiple choice whose FIRST
   option is the default decision. Link it on the card (`links.artifact`); the Telegram
   doorbell tags both founders.
4. Move the card to `grilled`. The board tracks answers itself and marks the card
   `artifact answered`; answers arriving another way are recorded via
   `POST /pipeline/card/artifact-answered`.
5. Fold the founders' answers back into the spec.

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
4. Set `links.ticket` on the card. The board refuses `ticketed → development` without it.

**Exit:** every unit has a ticket; the dependency order is written down.

## 4. Development — `ticketed → development`

**Who:** development-launch + a lane from the fleet. Contracts: [DEVLAUNCH.md](./DEVLAUNCH.md),
[FLEET.md](./FLEET.md).

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
3. Review: verdict comment's FIRST line is plain text `R1 — GO` / `R1 — NO-GO` (bold
   markup breaks the watchers). NO-GO → back to the same lane.
4. Merge on green + GO. Deploy follows the ordinary train; the probe
   ([PROBE.md](./PROBE.md)) confirms the deployed surface by CONTENT.

**Exit:** merged, deployed, probe green on the exact revision.

## 7. QA — `ci_pr → qa → done`

**Who:** the CTO window + QA agents.

1. Every review finding not taken into the unit's round becomes its own backlog ticket
   THE MOMENT it is found. Tail bundles filed after handover are a violation.
2. After the sprint's LAST card reaches this stage: the QA stage opens — two agents on
   two free Mac lanes, in parallel and independently, walk PRODUCTION in a real browser
   along the sprint's briefs (the user's path, all locales, console clean). Their
   findings become tickets.
3. Only after both QA agents report and findings are triaged is the sprint handed to
   acceptance (Zhenya) — the notification is sent by the CTO/owner, tagging the acceptor.

**Exit to `done`:** merged + deployed + probed + QA reported. A card with a prod-action
ticket is `done` only when that ticket was closed by hand on visible production content.

## `stuck`

Three consecutive failures anywhere put the card in `stuck`. No automatic retries past
that point — a human decides. Leaving `stuck` requires naming what changed.

---

## Cross-references

- The CTO intake reglament (`autopase-ops/CTO-REGLAMENT.md` §1) defers to this file and
  to GRILL.md — a spec never goes to `ticketed` without the grill.
- The owner zone (what only the owner decides) is defined once, in GRILL.md §2a.
- Artifact publishing for founder review: [ARTIFACT.md](./ARTIFACT.md); Telegram
  doorbells: [TELEGRAM.md](./TELEGRAM.md).
