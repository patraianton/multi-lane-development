# Telegram bot

The board's own bot talks to the two founders in **one group**. It does not
broadcast into other chats. Every message tags the people who need to see it
and carries a link back to the pipeline card.

The owner assigns a card's subscription by pressing a button under the bot's
message. The bot then POSTs to the board; the board writes the subscription
on the card and advances it to Ticketed in the same write — the CTO writes
the GitHub tickets there before development starts.

This file is the contract. The bot is `bin/telegram-bot.mjs`. It has no
external packages: it calls `https://api.telegram.org` with the built-in
`fetch`. There is no bot token in the repository. Without `botToken` the
process refuses to send.

Two processes share the same bot:

- the **board** (`bin/watchtower.mjs`) imports the sender functions and
  posts the four notifications when a card moves;
- the **bot loop** (`node bin/telegram-bot.mjs run`) long-polls button
  presses and POSTs `assign-subscription` back to the board.

They do not share a process. Do not start two pollers on the same bot.

## Setup

### 1. Create the bot (BotFather)

In Telegram, talk to [@BotFather](https://t.me/BotFather):

1. `/newbot`
2. Pick a display name (for example `Watchtower board`) and a username.
3. BotFather replies with the token (`123456:ABC…`). That is `botToken`.
4. `/setjoingroups` → enable (the bot lives in a group).
5. `/setprivacy` → **Disable** (so the bot can see group messages if you ever
   need that; button presses work either way).

Keep the token out of git. It belongs in `state/telegram.json` (the poller)
and, for outbound notifications, in the `telegram` block of
`state/autopase-board.json`.

### 2. Create the group

1. New Telegram group. Add the two founders.
2. Add the bot. Make it an admin (it must be able to post and to edit its own
   messages after a button press).
3. Post any message in the group, then open
   `https://api.telegram.org/bot<botToken>/getUpdates` in a browser. Look for
   `"chat":{"id":-100…}`. That number is `chatId` (negative for a group).

If `getUpdates` is empty, send another message and refresh. Stop that browser
tab before you start `bin/telegram-bot.mjs`: Telegram allows only one
long-poll at a time.

### 3. Founder user ids

Each founder needs a numeric Telegram user id (`tgUserId`) and the @tag they
want in messages.

Ways to get the id:

- The founder talks to [@userinfobot](https://t.me/userinfobot) and copies the
  id it prints.
- Or look at `from.id` on any `getUpdates` payload they have produced in the
  group.

`tag` is the @username they are addressed with (`@anton`). If they have no
public username, pick a short label and still start it with `@` — the bot
prints it as written.

`owner: true` marks the founder who assigns subscriptions. Exactly one founder
should be the owner. The other is `owner: false`. Artifact-ready, Stuck and
Acceptance tag **both**; the subscription prompt tags **the owner**.

## Config

File: `state/telegram.json` (next to the board's other state files, not in
git).

```json
{
  "botToken": "123456:ABC…",
  "chatId": "-1001234567890",
  "boardUrl": "https://watchtower.example",
  "apiToken": "the-same-token-agents-use-on-the-board",
  "founders": [
    { "name": "Anton", "tgUserId": 1001, "tag": "@anton", "owner": true },
    { "name": "Partner", "tgUserId": 1002, "tag": "@partner", "owner": false }
  ]
}
```

| field | meaning |
| --- | --- |
| `botToken` | From BotFather. If this is missing or empty, the bot **never sends**. |
| `chatId` | The one group. String or number; a supergroup id is negative. |
| `boardUrl` | Public base of the board, no trailing slash. Used for card links and for `assign-subscription`. |
| `apiToken` | Sent as `Authorization: Bearer …` when the bot POSTs to the board. |
| `founders` | The two people in the group. `name`, numeric `tgUserId`, `tag`, `owner`. |

A missing file, invalid JSON, or an incomplete object is a clear English error
and exit code 1. Restart the process after you edit the file.

Card links are `{boardUrl}/#pipeline/{cardId}` — for example
`https://watchtower.example/#pipeline/c-selftest`. The pipeline page can adopt
that hash as the deep link to a card.

## Board config (outbound notifications)

The board does **not** read `state/telegram.json`. Outbound messages fire only
when a `telegram` object is present in `state/autopase-board.json` **and** a
`botToken` is set (or `dryRun` is `true`). Otherwise the board skips sending,
logs one English line at start-up, and the rest of the pipeline is unchanged
apart from the `assign-subscription` endpoint.

```json
{
  "apiToken": "the-same-token-agents-use-on-the-board",
  "subscriptions": ["cx1", "initech", "hz1"],
  "telegram": {
    "botToken": "123456:ABC…",
    "chatId": "-1001234567890",
    "boardUrl": "https://watchtower.example",
    "apiToken": "the-same-token-agents-use-on-the-board",
    "dryRun": false,
    "founders": [
      { "name": "Anton", "tgUserId": 1001, "tag": "@anton", "owner": true },
      { "name": "Partner", "tgUserId": 1002, "tag": "@partner", "owner": false }
    ]
  }
}
```

| field | meaning |
| --- | --- |
| `subscriptions` | Names the owner may assign. An array of strings. The assign-subscription keyboard lists these, and `POST /pipeline/assign-subscription` accepts only these names. |
| `telegram.botToken` | Same token as the poller. Empty (and `dryRun` not true) → no sends. |
| `telegram.dryRun` | Test hook. `true` prints the four messages to the board's stdout instead of calling Telegram. |
| `telegram.founders`, `chatId`, `boardUrl`, `apiToken` | Same shape as `state/telegram.json`. Needed so the senders can tag people and build card links. |

The board calls:

- `notifyArtifactReady` when a card in `grilled` first gets `links.artifact`;
- `notifyAssignSubscription` when a card in `grilled` first gets `lane` while `subscription` is still empty;
- `notifyStuck` when a card **enters** `stuck` (a later entry after a new failure may notify again);
- `notifyAcceptance` when a card **enters** `acceptance`.

A failed send is logged and never changes the HTTP answer. The card remembers
what was notified in `notified: { artifact, stuck, acceptance, assignSubscription }`
(ISO timestamps), so a restart or a repeated identical update does not send twice.

## Running

```
node bin/telegram-bot.mjs run          long-poll getUpdates (needs config + token)
node bin/telegram-bot.mjs              the same as `run`
node bin/telegram-bot.mjs --selftest   print the four notifications, no network, exit 0
node bin/telegram-bot.mjs --dry-run    with --selftest: print instead of sending
```

`--selftest` does not read `state/telegram.json` and does not send. Use it in
this checkout. The board's own dry-run is `telegram.dryRun` in the board
settings, not this flag — a flag on the board process must not swallow live
notifications.

### systemd

The poller is a second unit, next to the board. Copy
`deploy/watchtower-bot.service` to `/etc/systemd/system/`, then:

```
systemctl daemon-reload
systemctl enable --now watchtower-bot
```

It runs `node bin/telegram-bot.mjs run` from `/opt/watchtower` and reads
`state/telegram.json`. The board unit is unchanged. `setup.sh` does not
install this unit — enable it by hand when the bot token is in place.

The long-poll stores its Telegram offset in `state/telegram-offset.json`
(atomic write: unique temporary file, then rename). Do not start two pollers
on the same bot.

The board imports the sender API without starting the poller, then injects
its `telegram` block with `configureTelegram`:

```js
import {
  configureTelegram,
  notifyArtifactReady,
  notifyAssignSubscription,
  notifyStuck,
  notifyAcceptance,
} from './telegram-bot.mjs';
```

Each function takes a pipeline card (`id`, `title`, `links.artifact`, …).
`notifyAssignSubscription` also takes the list of available subscriptions
(strings, or `{id, name}` objects). `notifyStuck` also takes an error digest
(plain text).

## The four notifications

Texts below are what `--selftest` prints (fake card `c-selftest`, fake
founders `@anton` / `@partner`, fake board `https://watchtower.example`).

### 1. Artifact ready — `notifyArtifactReady(card)`

Tags **both** founders. The grill Artifact is ready to annotate.

```
@anton @partner

The grill artifact is ready for "Ship the pipeline Telegram bot".

Artifact: https://example.com/artifact/grill-1
Card: https://watchtower.example/#pipeline/c-selftest
```

No keyboard. If the card has no `links.artifact`, the Artifact line says so
instead of inventing a URL.

### 2. Assign a subscription — `notifyAssignSubscription(card, subscriptions)`

Tags **the owner**. One inline button per available subscription.

```
@anton

Assign a subscription for "Ship the pipeline Telegram bot" so the card can move on to Ticketed.

Card: https://watchtower.example/#pipeline/c-selftest
```

Keyboard JSON (one button per row; `callback_data` is `as|{cardId}|{subscription}`):

```json
{
  "inline_keyboard": [
    [{ "text": "cx1", "callback_data": "as|c-selftest|cx1" }],
    [{ "text": "initech", "callback_data": "as|c-selftest|initech" }],
    [{ "text": "hz1", "callback_data": "as|c-selftest|hz1" }]
  ]
}
```

Telegram limits `callback_data` to 64 bytes. A subscription name that would
overflow is an error, not a truncated button.

After a founder in the configured list presses a button, the bot:

1. POSTs the assignment to the board (contract below).
2. Answers the callback (a short confirmation toast).
3. Edits the message: appends
   `{name} ({@tag}) assigned subscription {id}.`
   and removes the keyboard.

If the presser is not a configured founder, the bot answers "Only a board
founder can assign a subscription" and does not POST. If the board rejects
the POST, the keyboard stays so they can try again.

### 3. Stuck — `notifyStuck(card, digest)`

Tags **both** founders. The card landed in Stuck after three consecutive
failures.

```
@anton @partner

Card "Ship the pipeline Telegram bot" is Stuck after 3 consecutive failures.

Digest:
local check failed: lane-2 exited 1 (test: pipeline cards)

Card: https://watchtower.example/#pipeline/c-selftest
```

No keyboard. `digest` is the short error the board already has; the bot does
not go looking for logs.

### 4. Acceptance — `notifyAcceptance(card)`

Tags **both** founders. The card reached Acceptance and waits for a human.

```
@anton @partner

Card "Ship the pipeline Telegram bot" reached Acceptance.

Card: https://watchtower.example/#pipeline/c-selftest
```

No keyboard.

## Assign-subscription contract

The bot POSTs this shape. The board implements it as
`POST /pipeline/assign-subscription`. Auth is the same as every other
pipeline mutation: a founder session, localhost-as-owner, or
`Authorization: Bearer {apiToken}`.

```
POST {boardUrl}/pipeline/assign-subscription
```

Headers:

```
Content-Type: application/json
Authorization: Bearer {apiToken}
```

Body:

```json
{
  "cardId": "c-selftest",
  "subscription": "cx1",
  "by": {
    "name": "Anton",
    "tgUserId": 1001,
    "tag": "@anton"
  }
}
```

| field | meaning |
| --- | --- |
| `cardId` | Pipeline card id (the same `id` the board already stores). |
| `subscription` | The button the founder pressed (id of a coding-agent account). |
| `by` | Who pressed it: `name`, numeric `tgUserId`, `tag` from `founders`. |

A 2xx response is success. The board records the subscription, writes a
comment `subscription <name> assigned by <by>`, and moves the card from
Grilled to Ticketed in that same write. The card must be in `grilled`
with an empty subscription, and the name must be one of config
`subscriptions`. Wrong stage, unknown name, or a second assign answers
`400`. Any other HTTP status is a failure: the bot shows the error to the
founder and leaves the buttons in place.

The bot does not call any other board path.