# Watchtower

A live board for a coding-agent fleet, evolving into a delivery pipeline: persistent task cards
move through stages (spec → grilled → ticketed → development → local check → CI/PR → acceptance)
while live data — herdr windows, build lanes, branches, PRs — attaches to them.

## Language

**Card**:
A persistent task born from a spec. It lives in the board's own state, moves through pipeline
stages, and accumulates attached live data. Not a herdr window.
_Avoid_: ticket, task (ambiguous), issue

**Window**:
A live herdr session working on some worktree. Windows attach to cards; they are evidence of
work, not the work item itself.
_Avoid_: card (the pre-pipeline Watchtower used card = window; that meaning is retired)

**Stage**:
A pipeline column a card is in: Spec, Grilled, Ticketed, Development, Local check, CI/PR,
Acceptance — plus Stuck, where a card lands after its third consecutive failure and waits for a
founder. Ticketed is the CTO writing the GitHub tickets (one per work unit) after the grill;
the card leaves it for Development only with a ticket link attached.
_Avoid_: status (reserved for the watchdog's "what is happening right now" line), column (UI term)

**Slot**:
A dedicated CI server from the pool (three VPS today). The CTO assigns a free slot to a card
entering CI/PR; a card never queues for one — "no free slot" is an alarm, not a wait.
_Avoid_: runner (the GitHub Actions term for the same machine), queue

**Subscription**:
A coding-agent account (Codex or Claude home) that pays for a card's development run. The
owner assigns one per card by answering the Telegram bot; the card auto-advances to
Ticketed once assigned.

**Watchdog**:
The board's built-in checker: every ~15 minutes it gathers evidence for each active card
(lane log tail, window movement, CI state) and has a cheap LLM write the card's Status and a
verdict — moving, stalled, or looping.

**Status**:
The one-line "what is happening right now" on a card, refreshed by the Watchdog. Distinct
from Stage.

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
The small process on the owner's machine that pushes herdr window data to the board and
delivers queued hooks into agent windows.

**Ticket**:
The GitHub issue the CTO creates in the product repo after the grill — the durable, public
record of the finished spec. Written under the CTO's own GitHub App identity, during the
Ticketed stage; its link on the card (`links.ticket`) is what opens the way to Development.
_Avoid_: issue (when speaking of the pipeline artifact), card (the board entity)

**Founder**:
A human user of the board (the owner or the partner). Signs in by email; gets tagged in
Telegram.
_Avoid_: user (too generic), admin

## Working language

Watchtower is developed in the open. Everything that belongs to the repository — code,
commits, pull requests, specs, docs, ADRs, worker briefs and reports — is written in
English. User content passing through the board (pipeline cards, their specs and
comments) stays in whatever language the team writes it.
