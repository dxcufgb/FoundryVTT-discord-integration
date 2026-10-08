<#
.SYNOPSIS
  Removes the scheduled task created by install-task.ps1 and the automatic-update task
  (auto-update.ps1 -Enable), if there is one. Files, .env and data\ are left in place.
#>
param(
  [string]$TaskName = "FoundryVTT Discord integration",
  [string]$UpdateTaskName = "FoundryVTT Discord integration update"
)
$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
  Write-Output "Removed scheduled task '$UpdateTaskName'."
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output "Removed scheduled task '$TaskName'."
} else {
  Write-Output "No scheduled task named '$TaskName' was found."
}
