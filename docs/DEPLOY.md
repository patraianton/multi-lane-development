# Deploying Watchtower

The board is meant to run as a systemd service on a Linux host (Wave B: a
Hetzner VPS). This file is the operator guide for that install.

## Layout

```
/opt/watchtower/          application tree (bin/, deploy/, docs/, …)
                          overwrite on every update
/opt/watchtower/state/    persistent board state (cards, clocks, settings,
                          login sessions). Must survive updates — never
                          rsync --delete without excluding state/
/etc/watchtower.env       environment overrides (port, ssh, gh). Created once
/etc/systemd/system/watchtower.service
```

Node.js 22 or newer must already be on `PATH`. This kit does not install Node,
a reverse proxy, or TLS certificates.

## First copy

From the machine that holds the repository:

```
rsync -a --exclude state/ --exclude .git/ ./ root@HOST:/opt/watchtower/
```

Then on the host:

```
bash /opt/watchtower/deploy/setup.sh
```

`setup.sh` is idempotent. It creates `/opt/watchtower/state`, writes
`/etc/watchtower.env` only if that file does not exist, installs the systemd
unit, enables it and restarts it.

The board listens on `127.0.0.1:4878` by default (`WATCHTOWER_PORT` in the env
file to change the port). Put a reverse proxy with TLS in front if anyone
outside this host should open the page.

## Sign-in before exposing the port

Set `auth.founders` in `/opt/watchtower/state/autopase-board.json` **before**
the reverse proxy is reachable from the internet. With no `auth` block the
board is an open page on localhost, which is the owner's desktop mode and is
fine. The moment the port is reachable from elsewhere, an empty founders list
means anyone who can hit the proxy can read and mutate cards.

```json
{
  "auth": {
    "founders": [
      { "email": "owner@example.com", "name": "Ada", "owner": true },
      { "email": "partner@example.com", "name": "Bob", "owner": false }
    ],
    "sessionDays": 30,
    "allowLocalhost": false,
    "trustProxy": true,
    "publicUrl": "https://board.example.com",
    "cookieSecure": true
  },
  "apiToken": "a long random secret for agents",
  "probeToken": "the probe's shared secret"
}
```

### `allowLocalhost` — off unless nothing forwards to the port

`allowLocalhost: true` lets any request that reaches the port from `127.0.0.1`
act as the first `owner: true` founder, with no login link. It is **off by
default**, and on a proxied host it must stay off.

The board drops the localhost rule when it sees `X-Forwarded-For`,
`X-Forwarded-Proto`, `X-Real-IP` or `Forwarded`. That only helps when the thing
in front actually sets one of them. It does not:

- `proxy_pass` in nginx without `proxy_set_header X-Forwarded-For …`
- `ssh -L 4878:127.0.0.1:4878`
- `socat`, `iptables` port forwarding, a Cloudflare or ngrok tunnel client

All of those hand the board a plain loopback connection with no extra headers,
and every visitor on the far end silently becomes the owner — full read and
write on the board. If you enable it, make sure nothing on the host forwards to
the port. The service prints an `auth warning:` line at start-up while it is on.

If you do put a proxy in front, set `trustProxy: true` **and** make the proxy
overwrite `X-Forwarded-For` (`proxy_set_header X-Forwarded-For $remote_addr;` —
not `$proxy_add_x_forwarded_for`, which keeps whatever the client sent). Without
`trustProxy`, forwarding headers are ignored and rate limiting counts the proxy
as one client.

### `publicUrl` and `cookieSecure`

Set `publicUrl` to the public HTTPS base. Login links are built from it; without
it the board falls back to `http://127.0.0.1:<port>` for any non-loopback `Host`
header, precisely so a request carrying `Host: evil.example.net` cannot make the
board mint a link pointing at someone else's server.

`cookieSecure` defaults to `true`, so the session cookie is only sent over
HTTPS. Browsers accept `Secure` cookies on `http://localhost`, so the desktop
still works. Set it to `false` only for a deployment that is deliberately plain
HTTP.

This wave prints the login link on the service's stdout
(`journalctl -u watchtower -f`). Email and Telegram delivery come later.

`apiToken` is what agents (watchdog, Telegram bot, lane launchers) send as
`Authorization: Bearer` on `/pipeline/*` and `/hooks/enqueue`. `probeToken` is
only for `/probe/*`.

Restart after editing the settings file, or wait for the 30-second config
reload.

## Updating

```
rsync -a --exclude state/ --exclude .git/ ./ root@HOST:/opt/watchtower/
bash /opt/watchtower/deploy/setup.sh
```

`state/` is left alone. `setup.sh` will not overwrite `/etc/watchtower.env`.

## Checking

```
systemctl status watchtower
journalctl -u watchtower -n 50 --no-pager
curl -sS http://127.0.0.1:4878/auth/me
```

With sign-in off, `GET /` is the board. With sign-in on and no cookie, `GET /`
is the English sign-in page and `/data` answers `401`.
