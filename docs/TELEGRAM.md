# Telegram sender

The board sends Telegram notifications. It does not poll Telegram, receive
button presses, or call back into the board. The sender is
`bin/telegram-bot.mjs` and uses the built-in `fetch`; there are no external
packages and no second bot process.

The bot sends owner alarms to the owner's private chat and partner-facing
doorbells to the founders' group. Each message is one line. Group messages do
not contain a board card link.

## Config

Telegram is configured only in `state/autopase-board.json`:

```json
{
  "autoDispatch": true,
  "telegram": {
    "botToken": "123456:ABC…",
    "chatId": "-1001234567890",
    "ownerChatId": "1001",
    "founders": [
      { "name": "Anton", "tgUserId": 1001, "tag": "@anton", "owner": true },
      { "name": "Partner", "tgUserId": 1002, "tag": "@partner", "owner": false }
    ]
  }
}
```

| field | meaning |
| --- | --- |
| `telegram.botToken` | Token from BotFather. If it is missing or empty, the bot never sends. |
| `telegram.chatId` | The founders' group. A supergroup id is normally negative. |
| `telegram.ownerChatId` | The owner's private chat with the bot. The owner must start the bot before it can send there. |
| `telegram.founders` | People tagged in messages. Each entry has `name`, numeric `tgUserId`, `tag`, and `owner`; one entry has `owner: true`. |

`boardUrl` and `apiToken` are not Telegram settings. The sender does not need
either one. `telegram.dryRun: true` is a test hook: it prints notifications
instead of calling Telegram and permits an empty `botToken`.

When `autoDispatch` is true, `ownerChatId` is required because dispatch alarms
need an addressee. If it is absent, the board logs
`auto-dispatch: off — telegram.ownerChatId missing` once and dispatches
nothing. Group-only sending can still be configured without `ownerChatId`;
an owner notification then fails with a clear error.

Keep the token out of git. The board re-reads this file every 30 seconds.

## Sender API

The board imports these functions and injects the config block once:

```js
import {
  configureTelegram,
  notifyArtifactReady,
  notifyStuck,
  notifyIdleLanes,
  notifyReady,
  notifyDone,
} from './telegram-bot.mjs';

configureTelegram(settings.telegram);
```

| function | destination | purpose |
| --- | --- | --- |
| `notifyArtifactReady(card)` | `chatId` | A questions or acceptance page is ready. Includes its artifact URL, but no board URL. |
| `notifyDone(card)` | `chatId` | The sprint or standalone card is done. No board URL. |
| `notifyStuck(card, digest)` | `ownerChatId` | A card is stuck after three failures. |
| `notifyIdleLanes(card, finding)` | `ownerChatId` | A lane has been free with startable work waiting for five minutes. |
| `notifyReady(card)` | `ownerChatId` | A sprint is ready for the owner to prepare acceptance. |

A failed send is logged by the board and never changes an HTTP response.
Notification stamps on pipeline cards prevent repeated sends.

For a local, network-free sender check:

```text
node bin/telegram-bot.mjs --selftest
```

The file has no `run` command. It is not a service; the board is the only
process that uses it.
