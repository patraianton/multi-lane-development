# RULES — the one rulebook for every agent the board starts

The board writes the header of every task file (`Lane`, `Repository`, `Branch`, `Base`, `Role`, `Head`, `Round`,
`Check`, `Rules`, `Spec bundle`) and pastes `common` plus the section of the agent's role below it. Commands and
bans only. The ticket says what to build; these rules say how and what never.

<!-- role: common -->
## common — everyone
1. Work only in the folder named in `Lane:`. Never create another clone; never touch another lane's folder; never `git stash`.
2. Never run a production command; never touch a database; never change a deploy, env or workflow setting; never merge; never arm auto-merge; never push to `main`.
3. Never ask a human. Where the ticket is silent, take the safe reading, do it, and write the question and your choice in the report. If you truly cannot continue, post one comment on the ticket whose first line is `QUESTION #<ticket> <one line>` and stop.
4. Never change visible text or layout that the ticket does not name. "Seems more right" goes into the report, not into the code.
5. Never write `Closes #`, `Fixes #` or `Resolves #` anywhere — PR title, PR body, commit messages. Name the ticket as `Ticket: #<n>`.
6. On WHAT to build the ticket wins. On bans, the order of delivery and formats these rules win; a ticket or a brief that says otherwise is wrong.
7. Every `gh` call carries `--repo <Repository>`.
8. Your task ends when its proof exists (see your role) and `REPORT-<task file name>.md` is written next to this task file, last line `DONE #<ticket> <proof>`. Do not wait for CI, a review or a merge; do not start anything else.
9. Before `gh issue create --label qa`, list the umbrella's open `qa` tickets; for every open one that touches the same file or surface add the body line `depends on (merged): #n, #m - same file`. A finding filed during a review also lists the PR's own ticket there.

<!-- role: lane -->
## lane — writes one ticket; proof = an open PR on `Branch:`
1. `git fetch origin --prune`. If `origin/<Branch>` exists: `git checkout -B <Branch> origin/<Branch>`; otherwise `git checkout -B <Branch> <Base>`.
2. If `Base` is a sha: `git merge-base --is-ancestor <Base> HEAD || echo DRIFT`. On `DRIFT` post `QUESTION` (common 3) and stop.
3. Install dependencies from the lockfile only when the lockfile changed.
4. Build exactly what the ticket says, in the files it names. Too big → do it whole and say so in the report; never re-cut the ticket.
5. While iterating run only the tests your change touches. The full check in `Check:` runs at the end and again after each fix until it is green on the head you push; the third red full run in a row → `QUESTION` (common 3) and stop.
6. Every acceptance criterion with a negative case gets a test that is red on `Base` and green after. Never update snapshots to pass; every new wait has a timeout.
7. Push only after `Check:` is green on the exact head you push. One push per round; no empty commits.
8. Open the PR once, ready, not draft: `gh pr create --base main --head <Branch> --title "<title> #<ticket>" --body-file <file>`. Body line 1 `Ticket: #<ticket>`, then three lines "what changed".
9. Report: the `Check:` verdict line and log path; every acceptance criterion `met` / `not met` / `n/a` with the command output; what a reviewer would flag first; every existing test you rewrote or found red. Last line `DONE #<ticket> <PR url> <head sha>`.

<!-- role: reviewer -->
## reviewer — reads one PR head; proof = a verdict comment on `Head:`
1. `git fetch origin` and check out exactly `Head:`. Read the diff against `Base:` and the ticket.
2. Write your own findings before reading the lane's report or its self-check.
3. Run the ticket's acceptance commands yourself, plus one check of your own that is not on the lane's list. Do not run the full `Check:` — CI runs it on the PR.
4. Check the bans: visible text or layout outside the ticket, files outside the ticket's list, a second protected zone, `Closes #`, updated snapshots, waits without a timeout.
5. When the ticket names a mock, compare the rendered result with it and list the differences.
6. The verdict is one PR comment, plain text, no heading marks: line 1 `R<Round> — GO` or `R<Round> — NO-GO`; line 2 `head <Head>`; then findings as `file:line — what — which criterion`. NO-GO only for behaviour or an unmet criterion; wording goes under `notes:`.
7. A finding outside the ticket's scope → `gh issue create --label qa --title "QA <sprint>: <what>" --body "Part of #<umbrella>. <where, expected, seen>"`, never a NO-GO; same-file findings chain behind each other (common 9).
8. Never push, never edit the branch, never merge, never edit the ticket.
9. Report last line `DONE #<ticket> <PR url> R<Round> GO|NO-GO`.

<!-- role: fixer -->
## fixer — one round on an open PR; proof = a new head on the PR
1. `git fetch origin --prune`; `git checkout -B <Branch> origin/<Branch>` — never from `Base`.
2. The list is the `VERDICT`, `CI` or `CONFLICT` section of this task file, nothing beyond it. Before touching code read every earlier `R<k> — GO|NO-GO` comment on this PR (`gh pr view <Branch> --repo <Repository> --comments`); a change that reopens what an earlier round fixed is a defect.
3. `VERDICT`: every behaviour item gets a test that is red before the fix and green after; every item is answered in the report `fixed` / `not a defect — why`.
4. `CI`: read the failed check's log first; fix the cause; never retry blindly; never delete or skip a test to pass.
5. `CONFLICT`: `git merge origin/main`; resolve only in files the ticket names; a conflict in anyone else's file → `QUESTION` (common 3).
6. `Check:` until it is green on the exact head you push (the third red run in a row → `QUESTION`, common 3), then push at once: a run still queued or running on `Head:` is dead and your push cancels it (`pr-ci` cancel-in-progress, owner decision #1274); the repository's push-discipline note does not apply to a fix round (common 6). No `--force`, no empty commit; one PR comment `fix R<Round> pushed, head <sha>`.
7. Report last line `DONE #<ticket> <PR url> <new head sha>`.

<!-- role: qa -->
## qa — walks production; proof = your `qa-run` ticket closed
1. Change no code, push nothing, open no PR. Production only, in the real browser the ticket names.
2. Before walking, compare the deployed commit with `origin/main` as the ticket says; if it lags, wait up to 15 minutes, then walk what is deployed and say so in the report.
3. Walk every surface, locale and viewport the ticket lists; count content, not status codes; screenshot beside the mock where the ticket names one; the console clean of errors. Cabinet units are walked in the live cabinet signed in as the QA account (`node ~/kitchens/autopase.lv/qa/qa-login.mjs` prints a single-use sign-in link); the preview page never stands in for the cabinet. Delete what you created there before closing.
4. One finding = one ticket, at once: `gh issue create --label qa --title "QA <sprint>: <what the user sees>" --body "Part of #<umbrella> (QA R<n>).\nWhere: <URL, locale, viewport>\nExpected (ticket #<k>): …\nSeen: …\nEvidence: <screenshot path, numbers, console line>\nRepro: …"`. Unsure = still a ticket with `(unsure)` in the title. Nothing lives only in the report. Same-file findings chain behind each other (common 9).
5. Filed at least one finding and `n` < 3 → create the next round: `gh issue create --label qa-run --title "QA R<n+1> — <sprint>" --body "Part of #<umbrella>.\ndepends on: #<each finding you filed>\n<the walk section of your own ticket verbatim>"`. `n` = 3 with findings → post `QUESTION #<ticket> QA round 3 still finds defects` and stop.
6. One comment on the umbrella: line 1 `QA R<n> — <k> findings`, then the table surface × locale × viewport × result.
7. Report last line `DONE #<ticket> findings=<k>`; then `gh issue close <ticket>`. Checks skipped → write `STOPPED <reason>` as the last line and leave the ticket open.

<!-- role: cutter -->
## cutter — turns a spec into tickets (the MLD session, on the owner's word)
1. Read the spec and the code at `origin/main`; verify every factual claim of the spec against the code and cite `file:line`; a wrong fact is corrected in the ticket, never carried.
2. Grill: five lenses against the real code; business questions to the partner on one Lavish page — multiple choice, first option = default, no free text; money, strategy, outgoing messages and production env get no default and the mark `owner`. Tickets only after the page is answered.
3. Umbrella issue: the unit table, `grill passed:`, the spec bundle path, `Rules: docs/RULES.md @ <sha>`.
4. One issue per unit, first line `Part of #<umbrella>`; ≤ 600 lines; ≤ 1 protected zone; `depends on: none | #N — why`; never a train; a `Branch:` line only when `feat/<ticket>` will not do; never `Closes #` in instructions.
5. Acceptance = commands with expected output, at least one red on `main` today. A visible result → the mock path and the verbatim spec line, or a production screenshot with "change only X".
6. Landmines and defaults from the grill are pasted into the ticket as `question · default · deadline · addressee`.
7. A ticket touching migrations, schema, auth, deploy/env, payments or the scraper gets the label `hold-merge`.
   A ticket cut to repair a red `main` gets the label `main-fix` — the board holds every other task based on `main`
   while `main` is red, and dispatches this one.
   A ticket that changes styles, texts or documentation only — no logic, none of the protected zones above — may
   get the label `no-review`: the board plans no reviewer and merges it on one green check. Never together with
   `hold-merge`; the QA walk still covers these units.
8. The QA round-1 ticket is cut with the sprint from `docs/QA-TICKET.md`: label `qa-run`, `depends on:` every unit.
9. Finish with `POST /pipeline/card/update { links.ticket }`; the board takes over at `ticketed`.
