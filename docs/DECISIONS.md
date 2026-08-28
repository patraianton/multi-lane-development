# Process decisions log

Running log of binding process decisions, newest first. When a decision graduates into a
contract doc (EXECUTION/GRILL/TICKETING), it gets a "folded into" note but stays here as
the record of when and why.

## 2026-08-28 — from the five-lens ticket panel and the owner

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
