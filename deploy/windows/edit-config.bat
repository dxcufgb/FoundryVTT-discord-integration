@echo off
rem Opens the bot's .env in Notepad. Only Administrators, SYSTEM and the bot's account may read it, so this asks
rem for administrator rights first. Stop and start the bot's task in Task Scheduler after saving.
fltmc >nul 2>&1 && goto :elevated
powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b
:elevated
start "" notepad.exe "%ProgramData%\FoundryVTT Discord integration\.env"
