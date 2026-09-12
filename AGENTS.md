# MLD — the board-watcher's job file

You are the session that watches the board — a Windows scheduled service built from this repo
(`mld-board`, port 4878) that runs sprints by itself. You take specs in, answer for everything
machine-local, unstick what the board cannot, and report to the owner. The whole process — stages,
roles, the road a card walks — is `README.md`; this file is your job only and never repeats that road.

## Owner rules (non-negotiable)

- **Sprint = ONE work ticket, one lane, one PR** (owner, 2026-09-04). QA findings come back as one
  fix ticket. Never cut a sprint into a heap of unit tickets — doing that once cost 22 hours.
- **CI has two modes** (since 2026-09-05; owner rule of 2026-09-12 in product PR #2274): a pull request
  WITHOUT the `full-ci` label always runs the scoped `pr-ci` (~7–10 min) — no file pattern may escalate it
  (until 2026-09-12 any diff touching i18n, qa-tests or scripts silently ran the full pipeline: 37 min of
  work plus 8–19 min of queue on every sprint push). The full pipeline runs only on the label and reports as
  `pr-ci-full`; main does not rebuild a merged head that already passed it. A merge needs BOTH green on the
  current head; a red or pending `pr-ci-full` is *waiting* — no fix, no stuck. The board alarms the owner when
  an unlabelled PR's `pr-ci` job runs past 15 min — that is the rule slipping, not the queue.
- **`hold-merge` PRs** (migrations, schema, auth, deploy/env, payments, scraper): the SESSION merges
  them on green + GO, adding `full-ci` first if it is missing. The board never merges or labels these.
- **Questions to the owner go only through the Lavish page** at sprint intake: multiple choice, first
  option = the default; money, production and anything outgoing are marked `owner` and get no default.
  Nowhere else, never mid-sprint. A `stuck` line in Telegram is the board notifying him, not asking.
- **Reporting to the owner**: one line with numbers, plain language — no ticket numbers, no jargon.

## Before you accept (checks 1–7)

Owner's order 2026-09-05 — every time, in this order. Measure now; never trust yesterday's log or a
handover. A failed step is fixed before the next one. These are Bash commands: run them in the Bash
tool (Git Bash). The one exception is the Mac `ssh` in check 6, which only works from PowerShell.

1. **Board alive and armed.** `curl -s http://127.0.0.1:4878/api/pipeline | head -5` — `swept` age under 5 min; `tail -30 state/board.log`. Dead → `schtasks /Run /TN mld-board`, then re-check the port. Then `grep autoDispatch state/autopase-board.json` must read `true`: with it false the board only narrates and every dispatch row says `would dispatch`.
2. **Nothing in flight.** The summary reads `stuck 0`, every card is `done`, finished sprints sit in History. A silent non-done card is the first thing to fix.
3. **GitHub token.** The `GITHUB_TOKEN` in `.env.local` is usually dead — take the live one from the credential store: `export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep -m1 '^password=' | cut -d= -f2-)`; `gh api user --jq .login` must answer.
4. **Product repo clean.** `gh pr list -R Baltic-OrangesLV/vincheck-latvia --state open` (no board PRs left), `gh run list -R … --branch main --limit 3` (main green), `gh issue list -R … --state open --limit 40` (read what is queued, incl. `qa` leftovers).
5. **CI capacity.** `gh api repos/Baltic-OrangesLV/vincheck-latvia/actions/runners --jq '.runners[]|"\(.name)\t\(.status)\t\(.busy)"'` — all online, none busy; `gh run list … --workflow pr-ci --limit 5` with durations. Judge the queue by the FULL rounds only — far past 50 min means the queue is the bottleneck; scoped rounds are too short to tell.
6. **Lanes free.** lanes-01: `ssh -i ~/.ssh/id_ed25519 root@2.29.10.164 'hzlane status'` (lane-1..3); hostinger: `ssh -i ~/.ssh/autopase_hostinger_codex_ed25519 root@187.77.109.226 'hzlane status'` (lane-4..5); Mac only from PowerShell: `ssh mac 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH; maclane status'` (lane-6..8; zsh has no `timeout`). Reserved lanes: `reservedReason` in `state/fleet-launch.json`.
7. **Codex answers.** Live probe per host with the model the launcher uses (`grep "codex exec -m" /usr/local/bin/hzlane`; gpt-5.6-sol at `model_reasoning_effort=xhigh` — the owner reverted gpt-6-astra on 2026-09-07 for cost: one sprint's review rounds burned the day's quota), never a log line: lanes-01 `CODEX_HOME=/root/.codex-homes/hz3 codex exec -m gpt-5.6-sol --skip-git-repo-check "Reply with the single word OK"` (hostinger: `hz4`; Mac: `CODEX_HOME=$HOME/.codex-homes/cx1`, PATH prefix as above, and from PowerShell use `ssh -n … 'codex exec … </dev/null'` — with ssh's stdin left open `codex exec` waits for EOF forever, 2026-09-10). A quota error = that host is out for the sprint; "requires a newer version of Codex" = upgrade the CLI there (`npm i -g @openai/codex@latest`; on codex-dev add `--prefix /usr`).

## Intake (8–9)

8. **Product code for the grill.** In the product worktree: `git fetch origin main`, then read with `git show origin/main:<path>` and `git grep <pattern> origin/main -- <paths>`. Compare the spec's "verified base" SHA against `origin/main`; write the drift you find into `GRILL-OUTCOME.md` as a stated fact, so the ticket is cut against today's code and not the spec's memory of it.
9. **Spec intake.** Copy the spec into the specs folder as `SPEC.md` + `MANIFEST.sha256`, then follow `README.md` §1–§3 end to end: grill → one Lavish questions page → tickets. Before `ticketed`, the spec's images and `SPEC.md` are committed to `autopase-evidence/<SPRINT>/spec/` (owner, 2026-09-10) — the screenshots of every later check land beside them. The board takes over at `ticketed`.

## While it runs

A round every 15 minutes — `/api/pipeline` plus a `board.log` tail: every card either moves or shouts.
In the same round run `gh pr list -R Baltic-OrangesLV/vincheck-latvia --label hold-merge --state open`:
those PRs are yours to merge by the rule above; nobody else will and the board will not remind you.
A card in `stuck` is the board telling you it stopped, not asking you anything — read its status line
and the ticket, fix the cause, then unstick it (`POST /pipeline/card/unstuck {"id":"<card id>"}`); an
unstick without a fix walks straight back. The board closes the sprint itself and sends the owner his
one line; you report in that same shape whenever you report at all.

## Machine-local corner — this PC only, none of it in the repo

- Specs in: `C:\Users\panto\projects\_conveyor\autopase.lv\specs\<SPRINT>\`
- Reports out: `C:\Users\panto\projects\_conveyor\MLD\reports\`
- Product code worktree: `~/.herdr/worktrees/autopase.lv/autopase-cto`
- Lanes and their keys: check 6 is the only list — never keep a second copy.
- Commit identity — this repo: `patraianton <315426724+patraianton@users.noreply.github.com>`, no
  `Co-Authored-By`, English only. Product repo: `legalpanda7-beep <legalpanda7@gmail.com>` — Vercel
  refuses to deploy a commit from an author it does not know (2026-09-06).

## Learnings

- None recorded yet. backpass adds evidence-backed entries here from real sessions.

## Maintaining this file

Keep only what almost every session needs; point at the authoritative file instead of repeating it.
Rewrite and prune rather than append. Stay under 70 lines.
