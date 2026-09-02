# Watchtower

A live board for a coding-agent fleet, evolving into a delivery pipeline: persistent task cards
move through stages (spec → grilled → ticketed → development → local check → CI/PR → done)
while live data — herdr windows, build lanes, branches, PRs — attaches to them.

## Language

**Card**:
A persistent task born from a spec. It lives in the board's own state, moves through pipeline
stages, and accumulates attached live data. Not a herdr window.
_Avoid_: ticket, task (ambiguous), issue

**Unit card**:
A card for one unit ticket of a sprint card, spawned by the board when the sprint has left
`grilled` and its tickets exist. It carries `parent` (the sprint card), `ticket`, `unit` and
walks `ticketed → development → local_check → ci_pr → done` by facts alone — the lane that builds it,
the PR that carries it, the merge that finishes it. The sprint card is the roll-up people
move; the unit cards are the work in the columns.
_Avoid_: subtask, child ticket

**Window**:
A live herdr session working on some worktree. Windows attach to cards; they are evidence of
work, not the work item itself.
_Avoid_: card (the pre-pipeline Watchtower used card = window; that meaning is retired)

**Stage**:
A pipeline column a card is in: Spec, Grilled, Ticketed, Development, Local check, CI/PR,
Done — plus Stuck, where a card lands after its third consecutive failure and waits for a
founder. Ticketed is the CTO writing the GitHub tickets (one per work unit) after the grill;
the card leaves it for Development only with a ticket link attached.
_Avoid_: column (UI term)

**Slot**:
A dedicated CI server from the pool (three VPS today). The CTO assigns a free slot to a card
entering CI/PR; a card never queues for one — "no free slot" is an alarm, not a wait.
_Avoid_: runner (the GitHub Actions term for the same machine), queue

**Subscription**:
A coding-agent account (Codex or Claude home) that pays for a card's development run. The
owner assigns one per card by answering the Telegram bot; the card auto-advances to
Ticketed once assigned.

**Status**:
One sentence written by the board on every unit card of a served sprint — what the card is doing or waiting for.
Read-only; distinct from Stage.

**Lane**:
A remote build slot (lanes-01 / Hetzner / Mac) where code is written or checked. Assigned to a
card for Development and reused for Local check.

**Spec**:
The task description a founder writes into a card at the Spec stage. Founders discuss it in
flat card comments; the CTO refines it during the Grill.

**Grill**:
The CTO's interrogation of a spec. Its questions are published as an Artifact; founders answer
by annotating the Artifact, and the CTO folds the answers back into the spec.

**Artifact**:
A Lavish review page (public link) produced by the Grill. It is the answer surface: founder
annotations on it are the authoritative grill answers, collected by the CTO via lavish-axi poll.
_Avoid_: report, preview

**Probe**:
The retained board source mode that reads the last posted herdr snapshot. The executable that
pushed desktop data and delivered hooks was removed; local source mode reads herdr directly.

**Ticket**:
A GitHub issue the CTO creates in the product repo after the grill, under the CTO's own
GitHub App identity, during the Ticketed stage. The **umbrella ticket** is the durable,
public record of the finished spec — its link on the card (`links.ticket`) is what opens
the way to Development; a **unit ticket** is one grill unit's work order, bound to the
umbrella (docs/TICKETING.md).
_Avoid_: issue (when speaking of the pipeline artifact), card (the board entity)

**Founder**:
A human user of the board (the owner or the partner). Names their comments on the open loopback
board and gets tagged in Telegram.
_Avoid_: user (too generic), admin

## Working language

Watchtower is developed in the open. Everything that belongs to the repository — code,
commits, pull requests, specs, docs, ADRs, worker briefs and reports — is written in
English. User content passing through the board (pipeline cards, their specs and
comments) stays in whatever language the team writes it.
