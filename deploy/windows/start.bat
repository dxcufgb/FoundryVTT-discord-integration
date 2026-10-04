@echo off
rem Starts the bot in this window (for trying it out). Use install-task.ps1 to run it in the background at boot.
cd /d "%~dp0..\.."
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example. Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and FOUNDRY_DATA_PATH, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm ci --omit=dev --no-audit --no-fund
)
node src\index.js
pause
