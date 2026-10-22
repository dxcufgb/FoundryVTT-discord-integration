@echo off
rem Validates the configuration and probes Foundry without touching Discord.
rem Uses .env next to the bot, or the one the installer wrote under %ProgramData%\FoundryVTT Discord integration.
cd /d "%~dp0..\.."
rem The installers let only Administrators, SYSTEM and the bot's account read .env and use the data folder:
rem when this account cannot read the .env the bot would use, run again as administrator.
set "ENVFILE=.env"
if not exist .env set "ENVFILE=%ProgramData%\FoundryVTT Discord integration\.env"
if not exist "%ENVFILE%" goto :run
type "%ENVFILE%" >nul 2>&1 && goto :run
powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b
:run
set NODE=node
where node >nul 2>nul || set "NODE=%ProgramFiles%\nodejs\node.exe"
"%NODE%" scripts\check-config.js
echo.
pause
