# Roadmap: from a monitoring board to a delivery pipeline

The agreed model lives in [`CONTEXT.md`](../CONTEXT.md) and [`docs/adr/`](./adr/). Build order:

## Wave A — Pipeline cards (in code)
Persistent card store (atomic JSON journal): spec text, flat comments, stage, per-stage clocks
(ticking; stopped at Acceptance), failure counters (local / CI / acceptance), Stuck after the
third consecutive failure, links (ticket, branch, PR, artifact, lane, subscription, slot).
A Pipeline view next to the existing windows view: stage columns, card creation form, card
page. Stage transitions over validated endpoints. No auth, no Telegram yet.

## Wave B — Board moves to Hetzner
systemd service on the lanes host, HTTPS, the probe on the owner's Windows machine pushing
herdr snapshots up and pulling queued hooks down. The local single-user mode keeps working.

## Wave C — Founders sign in
Two allow-listed accounts, magic-link sign-in, sessions. Everything mutating requires a
signed-in founder (agents authenticate with tokens).

## Wave D — Telegram bot
The board's own bot, one group, addressed tags, links into cards; subscription assignment by
answering the bot; Stuck and Acceptance pings.

## Wave E — CTO loop
Hook queue on the board, probe delivery into the CTO window, grill flow (Lavish artifact,
answer polling), the GitHub ticket set via the CTO's GitHub App (ADR-0004 as amended:
umbrella + one ticket per grill unit, [TICKETING.md](./TICKETING.md)), lane assignment.

## Wave F — Execution stages
Development launch (branch + Opus orchestrator on the assigned lane), Local check (Codex on
the same lane), CI slot assignment (pinned runner labels, no queues), merge, Acceptance,
failure loops back to Development.

## Wave G — Watchdog
Every ~15 minutes per active card: gather evidence (lane log tail, window movement, CI
state), have a cheap LLM write the Status line and a moving / stalled / looping verdict.
