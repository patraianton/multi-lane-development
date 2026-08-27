# 6. The board decides the stage itself

Date: 2026-08-27. Status: accepted (step 1 shipped; steps 2–3 pending).

## Context

The owner's rule: a stream card moves to Acceptance when *the whole sprint
scope* of that stream is finished — every unit merged, nothing open. Nobody
announces this; the board must see it itself. Two earlier readings were wrong
and are rejected for good: "merged today ⇒ acceptance" (streams keep working —
units merged mid-sprint are progress, not completion) and "a human says closed
⇒ acceptance" (then the board is a secretary, not an instrument).

An Opus design panel (three lenses + judge, 2026-08-27) examined the real data
and settled where the truth lives:

- **The umbrella issue body is NOT the scope.** It freezes on the day it is
  written: #1300 still lists four units while the stream reached fifteen.
- **The count line in PROGRAM-STATE.md is NOT the scope.** It is the same
  human announcement the owner rejected, written by the reporting window
  itself, observed 6 minutes to 24 hours behind reality.
- **The scope is the set of live tickets.** A unit exists for the board only
  as an open issue that references the umbrella number in its title or body
  (plus native sub-issues, plus the ticket column of a table like #1204's).
  A unit with no ticket does not exist for the board — so each stream must
  promise "every unit gets a ticket" once, as `units: "issues"` in its
  stream-watch entry. No promise → that stream can never reach acceptance
  automatically, and the card says why.

## Decision

The card of a window is moved by facts, with doubt always working *against*
movement:

- **Acceptance** only when ALL hold: scope is machine-readable (units promise,
  branch prefixes, umbrella known); zero open unit tickets; zero open PRs
  bound to the window by any binding, weak ones included; lanes free; at
  least one merged PR since the card began; every source alive and younger
  than ten minutes; the same verdict twice in a row. Entry time = mergedAt of
  the last merged PR (clamped).
- **Weak bindings hold, never push.** A PR bound only by a number the window
  mentioned can keep a card out of acceptance but can never advance it.
- **Unknown ≠ empty.** A dead gh, a missing window, a stale source void the
  sweep; nothing moves.
- **Return is not failure.** A new open PR or unit ticket after the card
  entered acceptance sends it back to development through a dedicated
  `reopen` path that does not touch failure counters (the salon B1/B4 case).
  The waited hours then COUNT toward delivery time — the board pays for its
  own early lift.
- **Accepted is terminal.** The owner's word is not undone; new work after
  acceptance gets a new continuation card (`continues: <id>`), one live card
  per window.
- The board never walks spec/grilled (human stages) and never sets accepted.

## Rollout

1. **Shadow (shipped):** the board computes the would-be stage and prints it
   on the card (`auto would set … / auto holds …`) and in the JSON — writing
   no transition. Verify against the hand count for a day.
2. Enable forward transitions (development → local_check → ci_pr →
   acceptance).
3. Enable reopen and continuation cards.

Full transition table and criterion: the panel's design record in the session
log of 2026-08-27; condensed rules live in `bin/pipeline.mjs` next to the
shadow code.
