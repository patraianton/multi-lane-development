@echo off
rem Probe: pushes herdr snapshots to the board and delivers queued hooks.
rem Flags: --once, --dry-run. Config: state\probe.json
node "%~dp0probe.mjs" %*
