# Board server lives on Hetzner

The board moves off the owner's Windows machine to a Hetzner host and runs 24/7, so the
partner can always reach cards, comments and Telegram links. Local-only sources (herdr
windows on the owner's machine) are pushed to the board by a small probe running where
herdr lives; lanes, PRs and CI are already reachable from Hetzner directly. Rejected:
tunnel-from-desktop (board dies with the desktop) and a cloud/local hybrid (two state
stores to reconcile).
