@echo off
rem Доска «Autopase в одном месте» коротким текстом: читает GET /api/board
rem живого сервера доски (bin\autopase-board.cmd).
rem Флаги: --json, --full, --card <имя>, --help, --version.
node "%~dp0autopase-board-read.mjs" %*
