# Watchtower becomes the pipeline

The delivery pipeline (spec → acceptance) is built into Watchtower itself rather than as a
separate app or on top of GitHub Issues. A card becomes a persistent task in the board's own
state; herdr windows, lanes, branches and PRs attach to it as live data. Chosen because the
board already owns the state layer, the agent API and every integration the pipeline needs
(herdr, lanes, PRs), so one tool carries both the monitoring view and the pipeline. GitHub
Issues were rejected: per-stage clocks, watchdog status lines and agent hooks would all have
to be bolted around GitHub's model.
