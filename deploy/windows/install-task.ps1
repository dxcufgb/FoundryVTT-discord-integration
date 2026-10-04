<#
.SYNOPSIS
  Installs the Foundry VTT Discord integration as a Windows Scheduled Task that
  starts at boot and restarts if it stops.

.DESCRIPTION
  Run from an elevated (Administrator) PowerShell:

    Set-ExecutionPolicy -Scope Process Bypass
    .\deploy\windows\install-task.ps1 [-RunAsUser <DOMAIN\user>] [-InstallDir <path>]

  By default the task runs as SYSTEM so it starts without anyone logging in.
  Pass -RunAsUser to run as the account that runs Foundry instead (you will be
  asked for its password), which is needed if Foundry's data folder is not
  readable by SYSTEM.

  -EnvFile points the bot at a .env outside the install folder (the Inno Setup
  installer keeps it under %ProgramData%\FoundryVTT Discord integration).

  Needs Node.js 20 or newer (https://nodejs.org) and a filled-in .env.
#>
param(
  [string]$RunAsUser,
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$EnvFile,
  [string]$NodeExe,
  [switch]$SkipConfigCheck,
  [string]$TaskName = "FoundryVTT Discord integration"
)
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated (Administrator) PowerShell."
}

$node = if ($NodeExe -and (Test-Path $NodeExe)) { $NodeExe } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node -and (Test-Path "$env:ProgramFiles\nodejs\node.exe")) { $node = "$env:ProgramFiles\nodejs\node.exe" }
if (-not $node) { throw "Node.js was not found on the PATH. Install Node.js 20 or newer from https://nodejs.org and reopen PowerShell." }
$major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 20) { throw "Node.js 20 or newer is required (found $(& $node --version))." }

$envFile = if ($EnvFile) { $EnvFile } else { Join-Path $InstallDir ".env" }
$envArgs = if ($EnvFile) { " --env `"$EnvFile`"" } else { "" }
if (-not (Test-Path $envFile)) {
  if ($EnvFile) { throw "Configuration file $EnvFile does not exist." }
  Copy-Item (Join-Path $InstallDir ".env.example") $envFile
  Write-Host ""
  Write-Host "Created $envFile from the example. Fill in DISCORD_TOKEN, DISCORD_CLIENT_ID and FOUNDRY_DATA_PATH, then run this script again."
  exit 0
}

if (-not (Test-Path (Join-Path $InstallDir "node_modules"))) {
  Write-Host "Installing dependencies"
  Push-Location $InstallDir
  try { & npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm ci failed" } } finally { Pop-Location }
}
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "data") | Out-Null

if (-not $SkipConfigCheck) {
  Write-Host "Checking configuration"
  Push-Location $InstallDir
  try {
    if ($EnvFile) { & $node scripts\check-config.js --env $EnvFile } else { & $node scripts\check-config.js }
    if ($LASTEXITCODE -ne 0) { throw "Configuration check failed; fix $envFile and run again." }
  } finally { Pop-Location }
}

$action = New-ScheduledTaskAction -Execute $node -Argument "src\index.js$envArgs" -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if ($RunAsUser) {
  $cred = Get-Credential -UserName $RunAsUser -Message "Password for the account the bot runs as"
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password | Out-Null
} else {
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
}

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ""
Write-Host "Installed scheduled task '$TaskName' (state: $state)."
Write-Host "The bot starts with Windows. Manage it in Task Scheduler, or:"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop-ScheduledTask  -TaskName '$TaskName'   # then Start again after editing .env"
Write-Host "Output is not shown anywhere by the task; run deploy\windows\start.bat in a terminal to watch the log."
