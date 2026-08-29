# Process decisions log

Running log of binding process decisions, newest first. When a decision graduates into a
contract doc (EXECUTION/GRILL/TICKETING), it gets a "folded into" note but stays here as
the record of when and why.

## 2026-08-29 (afternoon) — nothing is built off the board

14. **Everything being built is on the board; the board watches for what is not (owner,
    2026-08-29 ~13:00).** Three ways onto the board and no fourth (TICKETING.md §7): a unit
    ticket naming its umbrella, a QA ticket (`qa` label + umbrella number) for anything after
    the sprint, a card of its own for work of no sprint. The umbrella number counts in the
    body **or in a comment** — the board reads both from now on. The watch runs after every
    sprint sweep: open PRs no card carries, tickets in work naming no umbrella, busy lanes on
    unknown branches — flagged above the columns and in `/api/pipeline`, and every new case
    written into `state/edge-cases.md` as an edge case the regulation must absorb.
    Why: Zhenya's acceptance fixes #1572/#1573 were opened without an umbrella and worked by
    the orchestrator while the board showed nothing; the umbrella line, added on request,
    went into a comment the board did not read.

## 2026-08-29 (midday) — the page is the pipeline; QA before done; merged is not done

13. **Merged is delivered, not accepted (owner, 2026-08-29 ~12:40: "да, окей" to option 1).**
    A merged unit goes to `qa`, not `done`; it is done once its ticket is closed later than
    two minutes after the merge (a person, after the acceptance run — for a rollout unit the
    production probe) or closed with no merge at all. The PR's own `Closes #N` closes the
    ticket in the same second as the merge and is not an acceptance — PRs no longer say it;
    an auto-closed ticket is accepted by reopening and closing it. The sprint reaches `done`
    only when every unit is accepted, its QA tickets are closed and the umbrella is closed.
    Why: U16 (#1532, the rollout) was Done on the board at 10:04, the second PR #1557 merged,
    while the rollout itself — Vercel env, re-run deploys, the production probe — ran in the
    orchestrator until after 12:00; the sprint was Done at 10:26 with the umbrella open. The
    board reads lanes, PRs and tickets — never production — so the ticket's close after the
    merge is the only fact that can carry the acceptance.


12. **The windows view is cut; the pipeline is the page (owner, 2026-08-29 ~12:00).**
    The live-windows board (herdr windows in columns, the lane strip, hand-typed cards,
    hidden cards) is gone from the page — "it is simply not needed; the pipeline is the
    default story". The server keeps reading windows: they still feed the pipeline
    (window names on cards, the shadow verdict of ADR-0006, `/api/board` for agents).
    The gear keeps only the project choice, which is what those facts are filtered by.
    In the same round: lane names come from the fleet registry (FLEET.md → `lanes` in the
    settings), and the sprint band's summary shows the fleet as a table — lane, server,
    state, unit — with the ticket/artifact/subscription chips in one row under it.


11. **A QA stage before done (owner, 2026-08-29 ~11:30).** The road is `… → ci_pr → qa →
    done`. The findings a sprint's reviews leave behind are written as **QA tickets** —
    issues labelled `qa` that reference the umbrella — and land in the QA column the day
    they are written; the sprint goes to `qa` when its last unit merges and reaches `done`
    only when its QA tickets are closed (with none written, a human declares the pass).
    Why: the AUTO-SALON close-out put six leftover findings into one unlabelled "tails"
    issue after the sprint was already `done`; the board read it as a queued unit of a
    finished sprint. The owner's word: such tickets must fall onto QA before done, not
    after it. This is not the acceptance column of decision 10 coming back: acceptance
    waited for a GO on every unit; QA is the sprint's own leftovers, and the facts move it.

## 2026-08-29 — the road ends at done; local check is a fact

10. **No acceptance stage; `accepted` is `done` (owner, 2026-08-29 ~00:50).** The
    acceptance column was designed for the sprint card: the whole sprint handed to the
    partner for the final say. With unit cards (decision 9) the columns hold tickets, and
    a ticket has no owner acceptance — its review is the GO its merge required. The road
    is `spec → grilled → ticketed → development → local_check → ci_pr → done`; a merged
    PR is `done`; the sprint's derived stage is `done` when every unit is merged or
    closed. The failure kind `acceptance` is now `review` (counter `reviewFails`); the
    `accept` action is gone (`ci_pr → done` is a plain move). Stored cards in
    `acceptance` / `accepted` load as `done`. Where decision 9 and ADR-0006 say
    "acceptance" / "accepted", read "done".
    **Local check by fact (owner: "why did nothing land in Local check?").** The column
    stayed empty because the unit mover knew three facts only — busy lane, PR open, PR
    merged — and walked a card from `development` straight to `ci_pr`. The lane probes
    now also report the project's local check running on a lane (`scripts/ci-local.mjs`,
    usually through `ci-local-and-stamp.sh`, matched by the process's working directory),
    and that fact moves the unit card to `local_check`.
    **Sprint band (owner, 2026-08-29 ~01:00): variant 2 — the two-pane control panel.** Four
    standalone variants were drawn by Codex on live data (compact command bar / two-pane
    panel / kanban swimlane / summary pill + drawer) and put to the owner as one
    multiple-choice page; the owner picked the two-pane panel (also Codex's recommendation):
    a bounded summary pane (identity, derived stage, clock, ordered progress with a legend,
    status clamped to three lines, free lanes, CI slots, source health, small links) and a
    fixed-layout sortable table of the units in flight. One panel per split sprint, stacked.
    The full sprint card (spec, comments, actions) opens under the panel from its `card`
    control. Amber marks a unit in local check.

## 2026-08-28 (late) — unit cards

9. **After `ticketed`, every unit ticket is its own card (owner, 2026-08-28 22:40).** One
   sprint card cannot carry seventeen lanes, PRs and states. The board spawns a **unit
   card** per ticket referencing the umbrella, bound to the sprint card (`parent`, one
   colour stripe per family), and moves it by facts only: busy lane → `development`, PR
   open → `ci_pr`, PR merged → `accepted`. The sprint card stays the roll-up (counts,
   lanes table) and the thing people move; the units are the work in the columns.
   Nobody announces "U5 is on lane-b" — the lane's branch or `TASK-<ticket>` file says so.
   **Placement (owner, 23:50):** a split sprint does not sit in a column — it would never
   move and only take space. It lives in the sprint band above the columns; its stage is
   derived from the units (development while any is unfinished, acceptance when all are
   merged), and the columns hold the unit cards.

## 2026-08-28 — from the five-lens ticket panel and the owner

00. **Ultra production mode (owner, 2026-08-28 evening; corrected after research).** Codex
   has NATIVE multi-agent ultra: `-c model_reasoning_effort=ultra` on gpt-5.6-sol means
   "maximum reasoning with automatic task delegation" (built-in sub-agents, multi_agent v2),
   while our previous `xhigh` explicitly prohibited sub-agents in the model prompt. From
   wave 2 on every lane run launches with `model_reasoning_effort=ultra` and
   `agents.max_concurrent_threads_per_session=5`. Guards: never pass `--ephemeral` (breaks
   spawning); sub-agents share ONE working copy, so code-writing task files must partition
   files between sub-agents explicitly; token burn scales with agent count (accepted).
   Every unit is tagged mode=solo-codex (wave 1) or mode=ultra-codex (wave 2+) in the sprint
   log with wall-clock and review-round counts — the owner compares speed AND quality.

0. **One sprint in development at a time (owner insight, 2026-08-28).** A single sprint's
   independent tickets already saturate the lane and CI capacity. Parallelism lives INSIDE
   a sprint. The next sprint travels the paper stages (spec -> grill -> answers -> tickets)
   while the current one develops — paper burns no lanes; when the current sprint's tail
   leaves lanes free, they pick up the next sprint's first independent tickets. Sprints
   queue as cards, never as parallel developments.

1. **Ticket-check panel is a standing stage step.** After the ticket set is written and
   before dispatch, one pass of a five-lens agent panel (critical path · ticket quality ·
   process overhead · board automation · launch risk) reviews the set. One pass, not a
   continuous watcher. Evidence from its first run: two certain NO-GO rounds and one
   production incident caught for minutes of cost.
2. **Dispatch goes by each ticket's depends-on line, not by whole waves.** A unit starts
   the moment its named bases are merged. Waves in the umbrella are a reading aid.
3. **Auto-merge is armed at the GO verdict, not before.** Repo auto-merge is enabled
   (2026-08-28); the reviewer's GO is the arming event. A protected-area PR may
   auto-merge only with a pre-authorized CTO line in the umbrella (rule 13).
4. **Roles at dispatch: the CTO assigns lanes; the owner assigns the subscription.**
5. **Review artifact rules (owner):** every question is multiple choice (first option =
   the default), no free-text fields, no open annotations expected; written for a reader
   who has not read the spec or the code — full context in every item.
6. **The review artifact is answered at `grilled`; the card enters `ticketed` only after
   the answers are folded into the spec.** (Folded into GRILL.md/TICKETING.md.)
7. **Internal tooling (this board, process rigs) is built fast:** single pass, one test
   run, no review workflows — FAST-WORKER-RULES preamble in every hire brief. The product
   repo keeps its full regime.
8. **Backlog accepted from the panel, in order:** (a) watchdog arms auto-merge on a GO
   comment; (b) evening Telegram sweep of PRs stuck outside the three healthy states;
   (c) auto-dispatch of ready tickets to free lanes; (d) two-tier review depth (full
   reviewer only for protected areas and visible UI); (e) grill lens output capped to
   blocker/important, 12 findings per lens.
