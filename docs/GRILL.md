# The Grill — contract and method

The grill is the CTO's interrogation of a spec **before** any development starts. Its purpose:
every question that would later stop a lane mid-work, and every finding an acceptance review
would raise as a NO-GO, must be named and settled while the card is still at `spec`.
A card moves to `grilled` only when the grill outcome has been folded back into the spec.

Status of this document: the **method** (§1–§2) is in live use, run by the CTO window.
The **artifact publishing pipeline** (§3–§5) is implemented — the worker under
`deploy/lavish-worker/`, the `bin/lavish-publish.mjs` and `bin/lavish-deploy.mjs` CLIs,
and the operator guide in docs/ARTIFACT.md. Deploying awaits the owner's Cloudflare
credentials (docs/ARTIFACT.md lists the exact token scopes).

## 1. Method: a panel of independent lenses

The spec is interrogated by a panel of independent agents (one per lens, strong model,
run in parallel). Two hard rules for every lens:

- **Check the spec against the real code, not against imagination.** Every blocker must have
  the shape "the spec says X, but `file:line` on the main branch says Y". A finding without a
  code citation is an opinion.
- **Return only typed findings with a proposed resolution** — never a summary of the spec.

Finding types: `spec-gap` · `default-decision` (the CTO can decide alone; the proposed
decision must be included) · `owner-question` (money / external access only) ·
`partner-question` (business data / product copy) · `landmine` (a recorded past lesson that
will detonate in this spec) · `slicing` (unit breakdown). Each finding carries severity:
`blocker` / `important` / `minor`.

The five lenses:

1. **Complexity and slicing** — does the work cut into units of ≤600 added lines
   (generated files excluded) touching one protected area each? Where is hidden coupling? What looks like one unit on paper but
   is three in the code? Produce a concrete unit breakdown with order and dependencies.
2. **Acceptance subjects** — for every acceptance criterion: is it proven by machine or by
   reading production? Where is the wording ambiguous enough for a disputable NO-GO? Which
   negative cases are missing (what must NOT happen)?
3. **External dependencies and money** — what depends on credentials, payments, third
   parties, or another person's decision. For each: the addressee (owner = money/access,
   partner = business data/copy) and a default resolution so work never blocks on the answer.
4. **Landmines from the lessons memory** — walk the project's recorded past failures and
   state where exactly each one detonates in THIS spec, and which added spec line disarms it.
5. **User path and proof** — on which real screen does a human see the result, and how is it
   proven on production (not by tests alone)? Include "how do we verify tomorrow without
   waiting a day" for anything time-based.

### Lens prompt template

> You are the grill lens "{LENS NAME}" for the spec {SPEC PATH} (read it in full).
> Project context: {repo, read-only working copy, facts the spec does not know}.
> {LENS QUESTION as above.}
> Read-only: change nothing, push nothing, comment nowhere.
> Return only genuine findings (no spec retelling). Every finding: type, severity,
> spec section, the finding itself plus the proposed resolution, plain language.

The CTO merges the lens results: deduplicates, takes the `default-decision` items alone,
groups questions by addressee into two short packets (owner, partner), and writes the
outcome document.

## 2. Grill outcome

Two artifacts, produced together:

1. **The outcome document** — a markdown file: blockers folded into the spec as mandatory
   amendments, the unit breakdown, both question packets. Stored next to the spec and
   linked from the card (`links.ticket` once the GitHub ticket exists).
2. **The review artifact** (§3) — the same content published as a Lavish page where the
   founders answer the questions by annotating.

The card gets a flat comment naming both and moves to `grilled` with the outcome folded
in. Answering happens **at `grilled`**: the artifact link sits on the card (the board
rings a bell while it awaits answers), the founders answer by annotating — every question
a multiple choice whose first option is the default decision. Only after the answers are
folded into the spec does the card move to `ticketed`, where the CTO writes the GitHub
tickets (one per work unit); the board
refuses `ticketed → development` until `links.ticket` is set.

The board tracks the answers itself. Every 30 s it reads where the artifact's answers
live — the desktop Lavish state file (`~/.lavish-axi/state.json`; any link naming that
session key counts, tunnels included) or the Cloudflare instance (`GET /api/state`) — and
the moment founder answers exist it marks the card `artifact answered` (time, count, who
saw it, one comment), without draining the CTO's poll. The bell on the card turns into
that mark. `grilled → ticketed` (and the subscription auto-advance) is refused while a
linked artifact is unmarked; answers that arrived another way (Telegram, a call) are
recorded with `POST /pipeline/card/artifact-answered`, and a different artifact link
starts a new round with the mark cleared.

## 2a. The owner zone — the single definition

This is the one place the owner zone is defined; every other doc references it
([TICKETING.md](./TICKETING.md) §2.8 for the no-default rule at ticketing time).

**The owner decides, never the pipeline:** money; strategy; anything outgoing
to external parties; the live bot and production environment variables /
external access. These are the only legitimate `owner-question` findings, and
they carry **no default decision** — a deadline produces a reminder, not an
assumed answer.

**Not an owner checkpoint:** production DB writes (owner decision 2026-08-25:
"take the live database off me — back it up properly and restore"). They run
under the backup regime documented in the product repo
(`docs/ops/DB-BACKUP-RESTORE.md`): a verified restore net, a restore point
taken right before every write, and the owner *informed* after a restore,
never *asked* before a write.

Every other reversible product question the pipeline decides itself, in favor
of the end user.

## 3. Requirement: self-hosted Lavish on Cloudflare

The grill questions must reach the partner, who does not sit at the owner's desktop —
a `127.0.0.1` Lavish page is useless to them. Requirement:

- Take the Lavish code from the owner's existing `lavish-axi` repository and deploy an
  instance of the artifact-serving side on **Cloudflare** (Workers/Pages — implementer's
  choice), so a published grill page has a stable public HTTPS URL that does not depend on
  the owner's machine being on.
- Publishing stays a CLI/API step the CTO window runs (`lavish-axi <file>` or equivalent);
  the published page supports the existing Lavish review surface: element/text annotation,
  queued prompts, `lavish-axi poll` to collect answers.
- Founder annotations on the artifact are the **authoritative grill answers** (CONTEXT.md);
  the CTO collects them via poll and folds them into the spec.

## 4. Requirement: the card links the artifact, Telegram tags the founders

- The pipeline card must carry the published page under `links.artifact`
  (`POST /pipeline/card/update` — already exists).
- When `links.artifact` first lands on a card, the board's Telegram bot posts the
  "artifact ready" notification (TELEGRAM.md) into the founders' group **tagging both
  founders** (`telegram.founders[].tag`), with the public artifact URL and the card link.
- Answering happens on the artifact page, not in Telegram; the Telegram post is the doorbell.

## 5. Requirement: configuration

All of this is configured in `state/autopase-board.json` (never in git), alongside the
existing `telegram` block:

```json
{
  "lavish": {
    "publicBaseUrl": "https://<the Cloudflare-hosted Lavish instance>",
    "apiToken": "token the CLI uses to publish and poll"
  },
  "cloudflare": {
    "accountId": "…",
    "apiToken": "scoped token used only for deploying the Lavish instance"
  }
}
```

The owner supplies the Cloudflare credentials and the bot API key once; every other step
must work without a human at the desktop. Secrets never appear in the repository, in
commits, or in card content.
