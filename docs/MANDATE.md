# The stream mandate — one text for every stream

The stream window (the orchestrator of one sprint) runs on **this file, verbatim**. The CTO
does not write a mandate per sprint: the launch pastes this text and fills the parameter
block below from the card. Nothing else is added, softened or "clarified" per stream — a
rule that needs changing is changed here, in one commit, for every stream at once.

Why: a mandate improvised per sprint carries whatever the CTO had in mind that morning, and
the stream inherits it as law. One sprint got "ship by morning" and ran clean; the next got
"ultra mode" and spent its first hour inventing its own pre-dispatch checks.

## Launch

The stream window is started as a plain session at effort **xhigh — never in ultracode**
(the multi-agent workflow mode). Ultracode tells an agent to fan out a panel on every
substantive task; a stream given it invents its own pre-dispatch panels and holds the lanes.
The stream's only subagents are the reviewers the unit round prescribes (§6).

## Parameters (the only per-sprint content)

```
sprint:        <NAME>                       card: <board card id>
umbrella:      #<N>                         spec: <path to the spec dir; ships whole with every task file>
tickets:       U1 #… → {U2 #… ∥ U3 #…} → …  (dependency order, copied from the umbrella)
worktree:      <path>   branch: orchestrate/<stream>
lanes:         <lane list from FLEET.md — as many as the widest wave>
subscription:  <assigned on the card, once per sprint>
```

## Rules

1. **Ticket text is law.** Tickets passed the grill and the cut review; the stream does not
   re-cut, re-scope or re-verify them. A ticket that turns out wrong on a fact gets one
   comment on the umbrella with the `ВОПРОС CTO` label and the stream moves to another unit.
2. **Width = the number of lanes assigned.** Every assigned lane carries a unit whenever a
   brief is ready. A unit starts from the head of its dependency's OPEN PR once that PR's
   local gate is PASS, rebasing after the merge — it never waits for the dependency to land.
3. **Lanes are for writing code and nothing else holds them.** A unit leaves its lane the moment its PR is open; the PR then waits in the CI/PR queue for review and merge, and that queue never holds a lane. A fix round after NO-GO is just another brief for a lane, on equal footing with new units. **A free lane + a ready brief = dispatch, before anything else.** Work on someone else's
   PR (merging main into it, rewriting its body, re-arming its CI watcher) comes after every
   assigned lane is busy.
4. **No self-invented checks.** The stream runs the nine steps of the unit round
   (PROGRAM-ORCHESTRATION §1) and nothing more: no pre-dispatch panels, sweeps or
   re-verification of ticket facts. Verifying the cut against the code is the CTO's job at
   `ticketed` (RUNBOOK stage 3). Review and acceptance of a PR use the reviewers the
   round prescribes — not more.
5. **One unit = one lane for the unit's whole life.** Task file = `TASK-<UNIT>.md` with the
   full ticket text and the playbook §4 paragraphs verbatim; the spec bundle — text AND
   images — ships with it.
6. **Review verdict** is the first line of the comment, plain text: `R1 — GO` / `R1 — NO-GO`.
   The review starts when the PR opens, alongside CI — not after green. The window that
   starts a reader turns the card's badge on the same second
   (`POST /pipeline/card/update { id, review: { running: true, round: N, by: "<who>" } }`)
   and may turn it off with the verdict (`{ running: false }`); the board turns it off by
   itself when the verdict lands on the PR. A finding not taken into the round becomes its
   own ticket the moment it is found.
7. **Reports go to the umbrella only.** Not to the owner, not to the acceptor. Questions:
   one comment with the `ВОПРОС CTO` label, then continue on another unit.
8. **The board moves by fact.** The unit card advances the moment the step is done
   (`POST /pipeline/card/move`; a failure — `/pipeline/card/fail`); no confirmation is awaited.
9. **State survives a cold start.** `PROGRAM-STATE.md` in the spec dir is rewritten after
   every step 9 and every dispatch; a cold session re-arms its watchers from it.
10. **QA is not the stream's.** QA runs once per sprint, after the last unit is on production,
    organised by the CTO (RUNBOOK stage 7). The stream never announces "shipped".
11. **Forbidden:** the production database, production switches (env, flags, rebuilds),
    anything outbound (messages, live `workflow_dispatch`), money, builds on the
    orchestrator's own machine, schema migrations unless a ticket owns one, and touching
    shared infrastructure without a line in the umbrella first.

## First step

Reply in the umbrella: `мандат принят (фаза разработки), поток <stream>, полосы <list>,
подписка <name>` — then write the first briefs and charge every assigned lane.
