@echo off
rem Validates the configuration and probes Foundry without touching Discord.
rem Uses .env next to the bot, or the one the installer wrote under %ProgramData%\FoundryVTT Discord integration.
cd /d "%~dp0..\.."
set NODE=node
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" scripts\check-config.js
echo.
pause
