# Lessons — what a check missed, and why

Running log of cases where the process ran every check it prescribes and a defect still
reached the next stage. Each entry names the defect, which checks ran, why each of them
could not have caught it, and the rule that closes the gap. When the rule graduates into
a contract doc (RUNBOOK/TICKETING/GRILL), it gets a "folded into" note but stays here as
the record. Newest first.

## 2026-08-29 — two review panels passed a ticket whose facts were wrong

**Sprint:** AUTO-DETAIL-FINANCE-CARDS-R1 (umbrella #1569), unit U1 (#1575).

**What happened.** The spec went through the grill (five independent lenses, ~50 findings,
twelve mandatory amendments) and the ticket set went through the cut-review panel (three
independent lenses, ~30 findings, all applied). Then the stream window, before writing the
lane brief, ran its own check — ten agents reading the real files at the pinned base and
testing every claim the ticket makes, with a refutation pass — and found that four of the
ticket's six factual claims were wrong:

1. The ticket says to project `contactPerson` from the published-fields JSON. That key is
   never stored: the publish path rewrites it to `contactName` before saving. A lane coding
   the ticket verbatim would return NULL on every row, every contact row would render a
   dash, and no test would fail — a silent zero that would have cost the whole round.
2. Two existing gates go red when the SELECT changes (a per-file query-hash pin and the
   prod-schema probe). The ticket names neither, so the lane would have met them as
   surprises.
3. The line range the ticket cites for the contact rows is off by three lines, and the
   ticket's "remove sellerKind" reads as removing a function that another surviving row
   still calls.
4. The ticket's list of superseded tests names a file that has no assertion to change, and
   the only file that does is named without its line.

**The fact in item 1 was already known — four hours earlier.** Before the grill, the stream
window had read the code and filed a digest (179 verified facts, twelve places where the spec
disagrees with the code). Item one of that digest, posted to the umbrella, was exactly the
`contactName` finding. It reached neither the grill outcome nor the tickets.

**Why each check missed it.**

- *The grill* reads the spec through product, risk and QA lenses: does the spec make sense,
  what breaks, what must the founders decide. It is not a reader of code. It took some of
  the digest's items (the cache-key bump, the surface register) into its amendments and
  dropped others, and nothing checked that every digest item had landed somewhere.
- *The cut-review panel* reads the ticket set against the spec and against itself: sizes,
  protected areas, dependency order, collisions, provable acceptance, embedded defaults. A
  wrong key name, a wrong line number and a missing gate are not visible at that altitude —
  the panel takes a ticket's `file:line` claims as given. Its contract says "against the
  real code", but nothing in it makes an agent open the file a claim names.
- *The ticket writer* cut the tickets from the spec and the grill outcome. The digest lived
  next to them in `digest/` and in a thread comment — not in the document the cut was made
  from. A fact that is not in the document being read forward is lost, however loudly it was
  posted upstream.

**The general shape.** Both panels check *reasoning* (is this cut sound, is this spec
sound). Neither checks *facts* (does this key, this line, this file exist as claimed). A
ticket that cites paths and lines is making claims, and claims are cheap to verify — ten
agents and fifteen minutes — against a lost round.

**Rule.** Between `ticketed` and `development` every factual claim in a unit ticket — key
names, file paths, line numbers, function names, the list of tests that must change, the
gates that will go red — is verified by agents reading the pinned base, with a refutation
pass, and the corrections ship with the lane brief as a "verified corrections" section that
outranks the ticket on facts (the ticket still outranks it on decisions). Upstream, the
seam digest is an input to the grill and to the cut, and the cut review checks that every
digest item either landed in a ticket or was struck with a reason.

**Folded into:** (pending — RUNBOOK stage 3 step 4 and stage 4 step 1, TICKETING §4).
