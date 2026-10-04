<#
.SYNOPSIS
  Removes the scheduled task created by install-task.ps1. Files, .env and data\ are left in place.
#>
param([string]$TaskName = "FoundryVTT Discord integration")
$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task named '$TaskName' was found."
}
