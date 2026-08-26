# CI runs on assigned slots; queues must not exist

A pool of dedicated CI servers (three VPS today) is sized so that a card entering CI/PR never
waits. The CTO assigns the card a specific free slot — each runner carries a unique label and
the PR's CI run is pinned to it — so the run starts immediately and the card shows where it
runs. "All slots busy" is not a queue but an alarm state on the board: the fix is adding
capacity, not waiting. Rejected: a shared runner queue with a concurrency cap (queues hide
delay; the owner explicitly wants none).
