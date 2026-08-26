@echo off
rem Watchtower as short text: reads GET /api/board from the running server
rem (bin\watchtower.cmd).
rem Flags: --json, --full, --card <name>, --help, --version.
node "%~dp0wt.mjs" %*
