# SPEC-CHECK task template — the session fills `<…>`, copies it to the lane's kitchen, launches `hzlane <N> "Read <path> and carry it out in full."`

Role text: `docs/RULES.md` → `spec-check`. First run: AUTO-FEEDBACK-MODULE-SPEC-001 on lanes-01/lane-1, 2026-09-08.

```
# TASK — SPEC-CHECK <SPEC-ID> (independent spec-compliance audit)

You are the spec-compliance auditor. You did not write this code and you owe it nothing. Your job:
prove, clause by clause, whether what is on `origin/main` today does what the spec says — and find
what the reviewers missed. A clause you cannot prove from code is not "met"; it is
"not verifiable by code" and you say so.

## Where things are

- Working copy: `<lane dir>` (this directory). Start with
  `git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main && git rev-parse HEAD`.
  The head must be `<merged head sha>` or newer. Write the exact SHA into the report header.
- Spec: `<kitchen>/specs/<SPEC-ID>/SPEC.md` (the `assets/` folder next to it holds the approved images
  the spec refers to — describe what you can infer from the file names and the spec text; you cannot view images).
- The change set that claims to implement the spec: squash commit `<sha>` (PR #<n>, "<title>").
  `git show --stat <sha>` lists the files. But audit the code AS IT IS on `origin/main` now, not the diff:
  later commits may have changed it.
- Toolchain on this host: node 22, pnpm 10, `node_modules` already installed. There is NO database on
  this host: tests that need Postgres will fail to connect — mark them "not run here (needs DB)", do not
  try to install or start one.
- Memory cap on this lane is <6 GB | 2.5 GB on lane-3>. Run vitest on single files
  (`pnpm vitest run <file>`), never the whole suite, never `pnpm build`.

## What to do

1. Read `SPEC.md` completely. Build the list of every checkable requirement: every sentence in the
   requirement sections that states what must / must not happen, and every acceptance box. Number them
   by section (`§2.1-a`, `§2.1-b`, …) or by the spec's own numbering where it has one.
2. For each requirement, find the executable path in the code and give a verdict:
   - `MET` — the code does it; evidence `path:line`.
   - `PARTIAL` — done in part, or done differently; evidence + one line saying what differs.
   - `NOT MET` — absent or contradicts the spec; evidence of where it should have been.
   - `NOT VERIFIABLE BY CODE` — needs a browser, production data or a mailbox; say what would prove it.
   Read the code path, not comments and not test names. A test proves a requirement only if you ran it
   green here and its assertion actually pins that requirement.
3. Be exact where the spec is exact: strings and their order in every locale, character for character;
   counts; sizes; event names and their allowed fields; DB constraints against the validation schema;
   what the spec forbids to store or emit; the files the squash commit touched against the spec's
   allowed list and its out-of-scope list (name every file outside the allowed list).
   <paste here the spec's own exact lists the auditor must compare against: case lists, field lists, event names>
4. Run the module's own tests one file at a time (find them with
   `git show --stat <sha> | grep -E 'test\.(ts|tsx)$'`). Record pass/fail counts per file; DB-bound
   files: "not run here (needs DB)".
5. Look for what a spec-compliance reviewer usually misses: a locale string reused from another module
   that says something slightly different; a default that changes with the route; an error state that
   clears the user's input; a shared cron/route that now fails for an unrelated reason; a migration
   constraint weaker than the validation schema; analytics carrying a field the spec did not allow; a
   layout rule not holding on one breakpoint; a control missing on one authenticated route. Check each
   explicitly and say so.

## What you must not do

- Do not modify, format, or "fix" any file. Do not create branches, commits or PRs. Do not push.
- Do not run the full test suite, `pnpm build`, `next build`, or anything that needs a database.
- Do not open production or any external site; do not send e-mail; do not touch `.env*`.
- Do not soften a verdict because tests exist or because a comment claims something.

## Report

Write `<kitchen>/reports/SPEC-CHECK-<SPEC-ID>.md`, in English:

1. Header: spec id, audited head SHA, date, the squash commit audited, files in it (count), tests run
   (file → passed/failed/not run).
2. One table per spec section: `requirement | verdict | evidence path:line | note`.
3. `## Deviations` — every PARTIAL and NOT MET, ordered HIGH / MEDIUM / LOW:
   `SEVERITY — §ref — what the spec says — what the code does — path:line`.
   HIGH = user-visible behaviour or data/delivery contract broken; MEDIUM = spec letter not followed but
   behaviour acceptable; LOW = wording, sizes, cosmetics.
4. `## Not verifiable by code` — each item with what would prove it (browser walk, mailbox, DB query).
5. `## Verdict` — one of `COMPLIANT`, `COMPLIANT WITH DEVIATIONS`, `NOT COMPLIANT`, one sentence why.
6. Last line, exactly: `DONE SPEC-CHECK <head sha> MET=<n> PARTIAL=<n> NOT_MET=<n> NOT_VERIFIABLE=<n>`.

Print the same last line to stdout when finished.
```

## After the run (the session)

- `scp` the report into `C:\Users\panto\projects\_conveyor\MLD\reports\`; move the task file and the lane
  log into the kitchen's `reports/` (cleanup is part of the round).
- HIGH + MEDIUM → one fix ticket (RULES `cutter` 4). LOW → a count in the owner's one line.
- Owner's line: `<spec> — checked against the spec by an independent auditor: <n> requirements, <k> deviations (<h> serious), verdict <…>`.
