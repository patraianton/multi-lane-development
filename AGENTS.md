# Project agent memory

MLD: this file is the always-loaded memory for agents working in this repo.
It is kept short on purpose - every line here is paid on every session.

## Sprint start checklist (owner's order, 2026-09-05: run every time, in this order, before accepting a sprint)

Measure now; never trust yesterday's log or a handover. Each step is one command; a failed step is fixed before the next.

1. **Board alive.** `curl -s http://127.0.0.1:4878/api/pipeline | head -5` — `swept` age under 5 min; `tail -30 state/board.log`. Dead → `schtasks /Run /TN mld-board`, then re-check the port.
2. **Nothing in flight.** Summary line reads `stuck 0` and every card is `done`; finished sprints sit in History. A silent non-done card is the first thing to fix.
3. **GitHub token.** `GITHUB_TOKEN` in `.env.local` is usually dead. Use `export GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep -m1 '^password=' | cut -d= -f2-)`; `gh api user --jq .login` must answer.
4. **Product repo clean.** `gh pr list -R Baltic-OrangesLV/vincheck-latvia --state open` (no board PRs left), `gh run list -R … --branch main --limit 3` (main green), `gh issue list -R … --state open --limit 40` (read what is queued, incl. `qa` leftovers).
5. **CI capacity.** `gh api repos/Baltic-OrangesLV/vincheck-latvia/actions/runners --jq '.runners[]|"\(.name)\t\(.status)\t\(.busy)"'` — all online, none busy; `gh run list … --workflow pr-ci --limit 5` with durations. Two modes since Sep 2026: an ordinary PR push runs the SCOPED gate (~7–10 min, check `pr-ci`); the FULL pipeline (build + all tests + browser smoke, ~35–50 min, check `pr-ci-full`) runs only on a PR labelled `full-ci`. Judge the queue by the FULL rounds — a full round far past 50 min means the queue is the bottleneck; scoped rounds are too short to tell.
6. **Lanes free.** lanes-01: `ssh -i ~/.ssh/id_ed25519 root@2.29.10.164 'hzlane status'` (lane-1..3); hostinger: `ssh -i ~/.ssh/autopase_hostinger_codex_ed25519 root@187.77.109.226 'hzlane status'` (lane-4..5); Mac only from PowerShell: `ssh mac 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH; maclane status'` (lane-6..8; zsh has no `timeout`). Reserved lanes: `reservedReason` in `state/fleet-launch.json`.
7. **Codex answers.** Live probe per host with the model the launcher uses (`grep "codex exec -m" /usr/local/bin/hzlane`, gpt-6-astra since 2026-09-05), never a log line: lanes-01 `CODEX_HOME=/root/.codex-homes/hz3 codex exec -m gpt-6-astra --skip-git-repo-check "Reply with the single word OK"` (hostinger: `hz4`; Mac: no `CODEX_HOME`, PATH prefix as above). A quota error = that host is out for the sprint; "requires a newer version of Codex" = upgrade the CLI on that host (`npm i -g @openai/codex@latest`; on codex-dev add `--prefix /usr`).
8. **Product code for the grill.** Worktree `~/.herdr/worktrees/autopase.lv/autopase-cto`: `git fetch origin main`, read with `git show origin/main:<path>` and `git grep <pattern> origin/main -- <paths>`. Compare the spec's "verified base" SHA with `origin/main` and note the drift.
9. **Spec intake.** Copy the spec to `C:\Users\panto\projects\_conveyor\autopase.lv\specs\<SPRINT>\SPEC.md` + `MANIFEST.sha256`. Then the road in `docs/RULES.md` (cutter) and `docs/ARTIFACT.md`: card `POST /pipeline/card/create` → `grilled`; grill by Workflow against real code → `GRILL-OUTCOME.md` beside the spec; one Lavish page with every owner/partner question (multiple choice, first = default; money/production/outgoing = `owner`, no default) → `links.artifact` (the board rings the founders itself); after the answers → umbrella + **one** work ticket (the whole sprint, one lane, one PR — owner's rule of 2026-09-04, never units) + the QA ticket from `docs/QA-TICKET.md` (`qa-run`) → `links.ticket` → `ticketed`. The board does the rest.
10. **While it runs.** A round every 15 min (`/api/pipeline` + `board.log` tail): each card either moves or shouts. `hold-merge` PRs (migrations, schema, auth, deploy/env, payments, scraper) are merged by the session on green + GO — green means BOTH `pr-ci` and `pr-ci-full` green on the current head; if the PR has no `full-ci` label yet, add it first (`gh pr edit <n> -R Baltic-OrangesLV/vincheck-latvia --add-label full-ci`) and wait for the full run. The board adds that label itself only for the PRs it merges, never for `hold-merge` ones. The board closes the sprint itself; the owner gets one line with numbers.

## Learnings

- None recorded yet. backpass adds evidence-backed entries here from real sessions.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
