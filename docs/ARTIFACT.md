# The artifact pipeline: self-hosted Lavish on Cloudflare

This file is the operator guide for the grill review artifact (docs/GRILL.md
§3–§5). A grill outcome is published as a Lavish review page with a stable
public HTTPS URL served from Cloudflare, so the partner can annotate it from
anywhere — the owner's desktop and its tunnel can be off. Publishing and
collecting answers stay CLI steps run from the owner's machine.

## How it fits together

```
owner's machine                          Cloudflare
─────────────────                        ──────────────────────────────
bin/lavish-publish.mjs  ── publish ────▶ Worker "watchtower-lavish"
   (reads state/autopase-board.json)       one KV namespace
bin/lavish-publish.mjs  ◀─ poll ───────    serves /session/<key> with the
                                           real Lavish review chrome
board (bin/watchtower.mjs)               founders annotate in the browser
   links.artifact set on the card  ──▶   Telegram doorbell tags both founders
```

- The worker (`deploy/lavish-worker/worker.mjs`) reimplements the serving side
  of the owner's `lavish-axi` fork: the review page, element/text annotation,
  queued prompts, image attachments, agent replies, and a draining poll.
- The review chrome itself — page template, `chrome-client.js`, `chrome.css`,
  the annotation SDK, the design stylesheets — is **built from the fork at
  deploy time** (`deploy/lavish-worker/build-assets.mjs`) and bundled into the
  worker. Nothing fork-derived is committed to this repository.
- Queued annotations are stored under **append-only KV keys**: two founders
  annotating at the same moment can never overwrite each other. The poll
  drains by list → read → deliver → delete; Cloudflare KV's eventual
  consistency can at worst deliver a batch twice, never lose one.
- The session key is 16 random hex characters. Anyone with the URL can read
  the artifact and annotate — treat the link like the shared secret it is.
  Publishing, polling, replying and ending require the API token.

### What is intentionally different from the desktop Lavish

| Desktop | Public instance |
| --- | --- |
| One reviewer tab at a time (handoff/takeover) | Any number of tabs; both founders review at once |
| Layout gate + layout-warning audits | Off — the artifact shows immediately, the inbox is always empty |
| Live reload on file save | Republish instead (`--key` keeps the URL) |
| Whiteboards on mermaid diagrams | Not served; the chrome never offers them |
| Publish-to-ht-ml.app dialog | Refused — the page is already public |
| Sibling asset files next to the artifact | Single-file pages only — inline your assets |
| SSE push (replies appear instantly) | SSE snapshot on reconnect (~20 s cadence) |

Everything else — annotating elements and selected text, queueing prompts,
attaching screenshots, Send to Agent, End session, export — works as on the
desktop, because it is the same chrome code.

## Configuration

Everything lives in `state/autopase-board.json` (never in git — `state/` is
ignored), next to the existing `telegram` block:

```json
{
  "lavish": {
    "publicBaseUrl": "https://watchtower-lavish.<subdomain>.workers.dev",
    "apiToken": "long-random-string-the-CLI-uses-to-publish-and-poll"
  },
  "cloudflare": {
    "accountId": "the Cloudflare account id",
    "apiToken": "scoped token used only for deploying this worker"
  }
}
```

| field | meaning |
| --- | --- |
| `lavish.publicBaseUrl` | Origin of the deployed worker, no trailing slash. Set it after the first deploy prints the URL. |
| `lavish.apiToken` | Invent one (`openssl rand -hex 32`). The deploy stores it as the worker secret; the publish CLI sends it as `Authorization: Bearer …`. |
| `cloudflare.accountId` | Dashboard → Workers & Pages → right column, or `wrangler whoami`. |
| `cloudflare.apiToken` | Created once with the scopes below. Used only by `bin/lavish-deploy.mjs`. |
| `cloudflare.kvNamespaceId` | Written back automatically by the first deploy — do not fill by hand. |

Secrets never appear in the repository, in commits, or in card content. The
board itself does not read the `lavish` block; the CLIs do
(`bin/lavish-config.mjs` is the single reader).

### Cloudflare API token scopes

Create the token at dash.cloudflare.com → My Profile → API Tokens → Create
Token → Custom token. It needs exactly:

| scope | level | why |
| --- | --- | --- |
| Account → Workers Scripts | Edit | upload/deploy the worker |
| Account → Workers KV Storage | Edit | create the namespace, none of the session data is readable without it |
| Account → Account Settings | Read | wrangler resolves the account and workers.dev subdomain |

No zone scopes are needed while the worker runs on `workers.dev`. If you later
put it on a custom domain, add Zone → Workers Routes → Edit and Zone → Zone →
Read for that zone.

One dashboard prerequisite: the account must have a workers.dev subdomain
enabled (Workers & Pages → your first visit sets it). `wrangler deploy` will
say so if it is missing.

## Deploying

Prerequisites: Node 22+, the lavish-axi fork checkout with its node_modules
(default path `C:/Users/panto/projects/_conveyor/lavish-axi/work`, override
with `--fork` or `LAVISH_AXI_SRC`), and the config above.

```
node bin/lavish-deploy.mjs --check    # validates config + builds assets, touches nothing
node bin/lavish-deploy.mjs            # the actual deploy
```

The deploy, in order: builds the chrome assets from the fork; finds or creates
the KV namespace `watchtower-lavish-sessions` (caching its id back into the
config); writes `deploy/lavish-worker/wrangler.gen.jsonc` from the committed
template; runs `npx wrangler deploy`; stores `lavish.apiToken` as the worker
secret `LAVISH_API_TOKEN`. Re-running it is safe — every step is idempotent.

After the first deploy, put the printed URL into `lavish.publicBaseUrl`.
Redeploy whenever the fork's chrome changes (rebuilding assets is part of the
command).

## Publishing a grill artifact

```
node bin/lavish-publish.mjs publish grill-outcome.html --card c-abc123
```

- Prints the public URL (`…/session/<16-hex-key>`) and the session key.
- `--card <id>` also sets `links.artifact` on that pipeline card via
  `POST /pipeline/card/update`. On a card in `grilled` whose artifact link was
  empty, that first set makes the board post the artifact-ready notification
  tagging both founders (docs/TELEGRAM.md) — publishing and ringing the
  doorbell is one command.
- `--key <16hex>` republishes to the same URL (new version, same link); an
  agent-ended session reopens, a founder-ended one stays ended.
- `--title "…"` overrides the page title (default: the file's `<title>`).
- `--dry-run` prints every request it would make and sends nothing.
- `--base` / `--token` override the config (this is how tests and the local
  smoke below run); `--board` / `--board-token` override where `--card` goes.

## Collecting the answers

```
node bin/lavish-publish.mjs poll <key-or-url>            one shot
node bin/lavish-publish.mjs poll <key-or-url> --watch    wait for feedback
node bin/lavish-publish.mjs poll <key-or-url> --card <id>   …and mark the card answered
node bin/lavish-publish.mjs state <key-or-url>           answers so far, without draining
node bin/lavish-publish.mjs reply <key-or-url> --text "answer shown in the page chat"
node bin/lavish-publish.mjs end <key-or-url>
```

`state` answers `{ status: open|ended|missing, answers, lastAnswerAt, pending }` —
`answers` counts everything the founders ever queued and is never drained by a
poll; the board's artifact-answers sweep reads it (`GET /api/state?key=…`,
Bearer) to mark a card `artifact answered`. `poll --card <id>` posts the same
mark the moment a poll delivers prompts, so the card does not wait for the
sweep.

`poll` prints the same JSON shape the desktop `lavish-axi poll` delivers:
`status: feedback` with the queued prompts (each with `uid`, `prompt`,
`selector`, `tag`, `text`, optional `target` and `attachments`), the DOM
snapshot, and `session_ended` when a founder pressed Send & End. Delivery
drains the queue. Attachments arrive as public URLs under the session.
Founder annotations collected this way are the authoritative grill answers
(CONTEXT.md) — fold them into the spec.

## Local smoke path (no Cloudflare, no credentials)

The worker is a plain ES module; the whole surface runs locally:

```
npm test                                          # includes the worker + CLI suites
node deploy/lavish-worker/serve-local.mjs 8787    # the same code on node:http
node bin/lavish-publish.mjs publish page.html --base http://127.0.0.1:8787 --token local-dev-token
```

`serve-local.mjs` uses the fork-built assets when `assets.gen.mjs` exists
(run `node deploy/lavish-worker/build-assets.mjs`), the committed stubs
otherwise. `npx wrangler dev --config deploy/lavish-worker/wrangler.gen.jsonc`
also works once a config has been generated, but nothing in the test path
needs wrangler.

## Checking a deployed instance

```
curl https://<publicBaseUrl>/health
```

must answer `{"ok":true,"app":"lavish-axi","version":"<fork version>"}`. A
published page must load its chrome (the toolbar with Annotate) and show the
artifact; if the page shows "Check and reload", the assets were built from a
fork whose chrome expects endpoints this worker version does not serve —
redeploy so worker and assets move together.
