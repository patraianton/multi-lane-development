# The CTO agent is a herdr window; hooks are delivered by the probe

The CTO stays a live herdr window on the owner's machine — visible, steerable, close to the
other windows — rather than a headless run on the board host. The board therefore never calls
the CTO directly: it queues hook events per card, and the probe delivers them into the CTO
window (herdr pane run) when it connects.

Consequences: hooks survive the desktop being off (they wait on the board, delivery lag is
shown on the card); protecting the CTO means protecting the probe and the window, so the
board must flag "hook queued, not delivered for N minutes" instead of failing silently.
