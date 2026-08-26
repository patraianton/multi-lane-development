# Watchtower

A live kanban of your coding-agent fleet.

One page that shows every [herdr](https://github.com/patraianton/herdr) window
working on a project: what each agent is doing right now and for how long, which
build lane is compiling what, which pull requests are open and what their CI
says, and — first column, always — who is stuck waiting for a human.

Nothing on the board is typed in by hand. Every card is assembled from live
sources on each refresh, and the board only ever reads: it never writes into your
windows, never starts or stops anything. Its single action is switching herdr to
the window you clicked.

---

## Features

- **One card per window.** Agent state (`working` / `idle` / `blocked` / `done`)
  plus how long it has been in that state, the rule herdr used to decide, the
  model, account, effort and context fill read off the window's own footer line,
  and the checkout branch.
- **The "needs you" column first.** A window goes there when it is blocked, when
  its last words contain one of your ask markers, or when a question in its
  umbrella issue is still unanswered.
- **Build lanes.** Remote hosts where the actual compiling happens (`hzlane` boxes
  and Mac kitchens) with the branch on each lane and which window owns it. A busy
  lane nobody claims is flagged.
- **Pull requests with CI colour**, bound to a window by branch, branch prefix,
  lane branch, or simply because the window named the number.
- **Last words.** What the window actually said last, taken from the Claude
  session log and falling back to the screen.
- **Hand edits.** Hide a card you do not want to see (restore it behind the gear),
  or add a card of your own with the `+`.
- **An agent API.** `/api/board` and `bin\wt.cmd` — the same board as short text
  or JSON, so a watchdog agent can read it without a browser.

---

## Quick start

Requirements: Windows, Node.js 18+, herdr. Optional: `gh` (logged in) for pull
requests and issues, and an ssh key for the hosts that run your build lanes.

```
node bin\watchtower.mjs
```

or `bin\watchtower.cmd`, which also opens the page. The board serves
`http://127.0.0.1:4878` and refreshes itself every three seconds. To run it
without a console window (autostart on logon), use `bin\watchtower-hidden.vbs`.

Another port: `set WATCHTOWER_PORT=4900` before starting.

If `ssh` or `gh` are not on the default path, point at them with
`WATCHTOWER_SSH` and `WATCHTOWER_GH`.

---

## Onboarding

On the first run the board asks which project to watch. It groups the windows
herdr currently has by project — the worktree root
(`~/.herdr/worktrees/<project>/…`) or the repository the window sits in — and
shows each one with how many windows it has. Pick a project and the board shows
every window and every worktree of it. There is also **All windows**, which
applies no filter at all.

The choice is saved to `state/autopase-board.json` and the gear in the header
opens the same screen again — to change the project and to restore cards you have
hidden.

---

## The board

**Header:** Watchtower, the project being watched, one line of counters, the `+`
and the gear. That is all it carries.

**Columns:**

| column | what is in it |
|---|---|
| **Needs you** | window `blocked`, an ask marker in its last words, or an unanswered question in its umbrella issue. Always first — this is what stands still without a human |
| **Working** | the agent is working right now |
| **Lane is building** | the window is silent but its lane is busy — work is happening on the server, not in the window |
| **Idle** | live agent, no work and no lanes |
| **No agent** | a window with no agent in it |

Clicking a card makes herdr switch to that window.

---

## Where the data comes from

| what | source | how often |
|---|---|---|
| windows, tabs, agent state | `herdr api snapshot`, `herdr workspace list`, `herdr agent list` | every 3 s |
| the rule behind a state | `herdr agent explain <pane>` | every 12 s |
| model, account, effort, context, PR numbers on screen | `herdr pane read <pane> --source visible` | every 12 s |
| lanes on an hzlane host | `ssh … hzlane status` | every 45 s |
| lanes in a Mac kitchen | `ssh mac` — the branch of each `<kitchen>/lane-*` folder plus the working directory of live `codex exec` processes | every 45 s |
| open PRs and CI colour | `gh pr list --repo <repo>` | every 60 s |
| umbrella issues and questions in them | `gh issue list --label umbrella` + `gh issue view` | every 120 s |
| which window owns which lanes and branch prefixes | the `streamWatch` JSON file | every 30 s |
| umbrella issue number of a program | `<specsDir>/<PROGRAM>/PROGRAM-STATE.md`, the line `umbrella: #NNNN` | every 30 s |
| the window's last words | the Claude session log (`*.jsonl`); if the current session has not spoken yet, the previous session of the same window; if that is empty too, the last meaningful line on screen | every 3 s (by file mtime) |

Every source refreshes on its own timer in the background, so the page answers in
milliseconds and one dead source does not take the board down — it shows up next
to the lanes as "sources not answering".

The board stores three files of its own under `state/` (not in git): the chosen
project and settings, when each pane was first seen in its current state (herdr
does not keep that, and without it "stuck for 4 hours" cannot be computed), and
the hand edits — hidden and manually added cards.

---

## Configuration

Everything has a neutral default in `bin/watchtower.mjs` (the `DEFAULTS` block).
Your own values go into `state/autopase-board.json`, which is not in git:

```json
{
  "project": "my-project",
  "allWindows": false,
  "hide": ["marketing"],
  "repo": "acme/web",
  "streamWatch": "C:\\path\\to\\STREAM-WATCH.json",
  "specsDir": "C:\\path\\to\\specs",
  "askWords": ["QUESTION FOR THE CTO", "QUESTION FOR THE OWNER"],
  "answerWords": ["CTO ANSWER", "OWNER SAYS"],
  "hosts": {
    "builder": { "target": "root@203.0.113.10", "key": "id_ed25519", "kind": "hzlane" },
    "mac":     { "target": "mac", "kind": "mac", "kitchen": "~/kitchens/my-project" }
  }
}
```

- `project` — which project the board watches (set by the onboarding screen).
- `allWindows` — `true` shows every herdr window, with no project filter.
- `hide` — windows never to show, by folder name or window label.
- `repo` — `owner/name` for `gh`. Empty means GitHub is skipped entirely.
- `streamWatch`, `specsDir` — optional; without them the board simply has no lane
  bindings and no umbrella numbers.
- `askWords` — the exact words your windows and issues use to flag a question for
  a human. These are protocol markers, not interface text: write them in whatever
  language your team actually types.
- `answerWords` — the words that close such a question. Until one of them appears
  after the question in the umbrella issue, the question counts as open (the same
  account writes both, so the author tells you nothing).
- `hosts` — where code is built. `kind: "hzlane"` asks `hzlane status` over ssh;
  `kind: "mac"` reads `<kitchen>/lane-*` folders and live `codex exec` processes.
  With no hosts configured the lane strip is simply empty.

---

## Agent API

`bin\wt.cmd` prints the whole board as short text (or JSON with `--json`), and
`GET /api/board` serves the same thing over HTTP. Full contract, field by field:
[docs/API.md](docs/API.md).

---

## What the board cannot do

- Bind a PR to a window when the PR branch looks like neither the window branch
  nor any configured prefix, and the window never named its number.
- Show a lane that is neither in `hosts` nor a `lane-*` folder of a Mac kitchen.
- Tell "a human answered the question" from "the stream posted another report",
  unless the answer carries one of the `answerWords`.
- Say much about a window without a Claude agent: for those, only the last line
  of the screen is available.

---

## License

MIT — see `LICENSE`. Watchtower started as a fork of
[sheepdog](https://github.com/patraianton/sheepdog).
