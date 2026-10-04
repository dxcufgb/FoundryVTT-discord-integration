@echo off
rem Starts the bot in this window so you can watch the log. The installer runs it in the background at boot;
rem stop that task first (Task Scheduler) so two copies are not running.
cd /d "%~dp0..\.."
set NODE=node
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist .env if not exist "%ProgramData%\FoundryVTT Discord integration\.env" (
  copy .env.example .env >nul
  echo Created .env from .env.example. Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and FOUNDRY_DATA_PATH, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm ci --omit=dev --no-audit --no-fund
)
"%NODE%" src\index.js
pause
