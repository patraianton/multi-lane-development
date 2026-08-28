# Process decisions log

Running log of binding process decisions, newest first. When a decision graduates into a
contract doc (EXECUTION/GRILL/TICKETING), it gets a "folded into" note but stays here as
the record of when and why.

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
