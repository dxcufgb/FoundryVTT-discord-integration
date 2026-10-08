<#
.SYNOPSIS
  Opt-in automatic updates for the Foundry VTT Discord integration on Windows.

.DESCRIPTION
  From an elevated (Administrator) PowerShell:

    .\deploy\windows\auto-update.ps1 -Enable    registers the daily task "FoundryVTT Discord integration update" (runs as SYSTEM)
    .\deploy\windows\auto-update.ps1 -Disable   removes that task again
    .\deploy\windows\auto-update.ps1 -Check     only reports whether a newer release exists
    .\deploy\windows\auto-update.ps1            installs a newer release now, if there is one (what the task runs)

  The update asks GitHub for the latest release and, only if it is newer than the installed
  version, downloads the matching asset (the setup.exe for an installation made with setup.exe,
  otherwise the -windows.zip), verifies its SHA-256 against the release's checksum file and
  installs it the same way as a manual upgrade: setup.exe /VERYSILENT, or for a zip installation
  copying the new files over the old ones (.env and data\ are never touched). The configuration
  file(s) are restored byte for byte afterwards and the bot's task is restarted. A failed zip
  update is rolled back; a failed setup.exe rolls back its own changes.

  Log: %ProgramData%\FoundryVTT Discord integration\auto-update.log
  Optional GitHub token (only needed for a private fork): %ProgramData%\FoundryVTT Discord integration\github-token
  (-Enable restricts it to Administrators and SYSTEM).
#>
[CmdletBinding(DefaultParameterSetName = "Update")]
param(
  [Parameter(ParameterSetName = "Enable", Mandatory = $true)][switch]$Enable,
  [Parameter(ParameterSetName = "Disable", Mandatory = $true)][switch]$Disable,
  [Parameter(ParameterSetName = "Check", Mandatory = $true)][switch]$Check,
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$TaskName = "FoundryVTT Discord integration",
  [string]$UpdateTaskName = "FoundryVTT Discord integration update"
)
$ErrorActionPreference = "Stop"
$InformationPreference = "Continue"
$InstallDir = $InstallDir.TrimEnd("\")
$ConfigDir = Join-Path $env:ProgramData "FoundryVTT Discord integration"
$LogFile = Join-Path $ConfigDir "auto-update.log"
$TokenFile = Join-Path $ConfigDir "github-token"
$Keep = @(".env", "data")

function Write-UpdateLog([string]$Message) {
  $line = "$(Get-Date -Format s) $Message"
  Write-Information $line
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { Write-Information "(could not write $LogFile)" }
}

# ACLs through .NET instead of Get-Acl/Set-Acl: Windows PowerShell started from PowerShell 7 (or by a
# setup started from it) inherits a PSModulePath on which Microsoft.PowerShell.Security fails to load.
function Get-PathAcl([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq "Core") { return [System.IO.FileSystemAclExtensions]::GetAccessControl($item) }
  return $item.GetAccessControl()
}

function Write-PathAcl([string]$Path, $Acl) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($PSVersionTable.PSEdition -eq "Core") { [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $Acl) } else { $item.SetAccessControl($Acl) }
}

# Only Administrators and SYSTEM, nothing inherited.
function Protect-Path([string]$Path, [switch]$Folder) {
  $acl = if ($Folder) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($Folder) { "ContainerInherit, ObjectInherit" } else { "None" }
  foreach ($sid in "S-1-5-18", "S-1-5-32-544") {
    $id = New-Object System.Security.Principal.SecurityIdentifier $sid
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $id, "FullControl", $inherit, "None", "Allow"))
  }
  Write-PathAcl -Path $Path -Acl $acl
}

# True when Everyone, Users, Authenticated Users, INTERACTIVE or NETWORK may change the path (a SYSTEM task must not run code from there).
function Test-WritableByUser([string]$Path) {
  $weak = "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-4", "S-1-5-2"
  $write = [System.Security.AccessControl.FileSystemRights]"WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership"
  foreach ($rule in (Get-PathAcl $Path).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne "Allow" -or ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($weak -contains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $write)) { return $true }
  }
  return $false
}

function Get-NodeExe {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.Actions[0].Execute -and (Test-Path $task.Actions[0].Execute)) { return $task.Actions[0].Execute }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if (Test-Path "$env:ProgramFiles\nodejs\node.exe") { return "$env:ProgramFiles\nodejs\node.exe" }
  throw "Node.js was not found."
}

# Run scripts\self-update.js; its progress (stderr) goes to the log, its key=value result (stdout) is returned.
function Invoke-SelfUpdate([string[]]$Arguments) {
  $node = Get-NodeExe
  $eap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $lines = & $node (Join-Path $InstallDir "scripts\self-update.js") @Arguments 2>&1 } finally { $ErrorActionPreference = $eap }
  $code = $LASTEXITCODE
  $result = @{}
  foreach ($l in $lines) {
    if ($l -isnot [System.Management.Automation.ErrorRecord] -and "$l" -match "^([a-z]+)=(.*)$") { $result[$Matches[1]] = $Matches[2] } else { Write-UpdateLog "  $l" }
  }
  if ($code -ne 0) { throw "The update check or download failed; nothing was changed." }
  return $result
}

function Register-UpdateTask {
  $script = Join-Path $InstallDir "deploy\windows\auto-update.ps1"
  if (-not (Test-Path (Join-Path $InstallDir "scripts\self-update.js")) -or -not (Test-Path $script)) { throw "$InstallDir has no auto-updater (install a newer version first)." }
  foreach ($p in $InstallDir, (Join-Path $InstallDir "deploy\windows"), (Join-Path $InstallDir "scripts"), (Join-Path $InstallDir "src"), $script, (Join-Path $InstallDir "scripts\self-update.js"), (Join-Path $InstallDir "src\selfUpdate.js")) {
    if (Test-WritableByUser $p) { throw "$p can be changed by non-administrators, so a task running as SYSTEM must not run from it. Install to a folder only Administrators can write (for example with setup.exe under Program Files)." }
  }
  if (Test-Path $TokenFile) { Protect-Path $TokenFile; Write-UpdateLog "Restricted $TokenFile to Administrators and SYSTEM" }
  $esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -InstallDir `"$InstallDir`" -TaskName `"$TaskName`""
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs new releases of the Foundry VTT Discord integration (opt-in). Log: $(& $esc $LogFile)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>2026-01-01T04:00:00</StartBoundary><Enabled>true</Enabled><RandomDelay>PT1H</RandomDelay><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc $ps)</Command>
      <Arguments>$(& $esc $arguments)</Arguments>
      <WorkingDirectory>$(& $esc $InstallDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
  Register-ScheduledTask -TaskName $UpdateTaskName -Xml $xml -Force | Out-Null
  Write-UpdateLog "Automatic updates on: task '$UpdateTaskName' checks for a new release daily (log: $LogFile)"
}

function Copy-Payload([string]$From, [string]$To) {
  Get-ChildItem -Path $From -Force | Where-Object { $Keep -notcontains $_.Name } | Copy-Item -Destination $To -Recurse -Force
}

function Restore-Payload([string]$Backup) {
  Write-UpdateLog "Restoring the previous version"
  Get-ChildItem -Path $InstallDir -Force | Where-Object { $Keep -notcontains $_.Name } | Remove-Item -Recurse -Force
  Copy-Payload -From $Backup -To $InstallDir
}

function Restore-EnvFile([hashtable]$Saved) {
  foreach ($f in $Saved.Keys) {
    if (-not (Test-Path $f) -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($f)) -ne [Convert]::ToBase64String($Saved[$f])) {
      [IO.File]::WriteAllBytes($f, $Saved[$f])
      Write-UpdateLog "Restored $f as it was before the update"
    }
  }
}

function Test-BotRunning {
  Start-Sleep -Seconds 15
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  return [bool]($t -and $t.State -eq "Running")
}

function Invoke-Update {
  $isSetup = Test-Path (Join-Path $InstallDir "unins000.exe")
  $platform = if ($isSetup) { "windows-setup" } else { "windows-zip" }
  $work = Join-Path ([IO.Path]::GetTempPath()) ("fvtt-discord-update-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Protect-Path $work -Folder
    $nodeArgs = @($(if ($Check) { "check" } else { "download" }), "--platform", $platform, "--dir", $InstallDir)
    if (-not $Check) { $nodeArgs += @("--out", $work) }
    if (Test-Path $TokenFile) { Protect-Path $TokenFile; $nodeArgs += @("--token-file", $TokenFile) }
    $r = Invoke-SelfUpdate $nodeArgs
    if ($r.status -ne "update") { return }
    if ($Check) { Write-UpdateLog "Version $($r.latest) is available. Install it now with: $PSCommandPath"; return }
    if (-not $r.file -or -not (Test-Path $r.file)) { throw "The downloaded file is missing." }

    $saved = @{}
    foreach ($f in (Join-Path $ConfigDir ".env"), (Join-Path $InstallDir ".env")) { if (Test-Path $f) { $saved[$f] = [IO.File]::ReadAllBytes($f) } }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $wasRunning = [bool]($task -and $task.State -eq "Running")
    # setup.exe re-registers the bot task as SYSTEM; never let an unattended update widen a task set up to run as another account.
    if ($isSetup -and $task -and $task.Principal.UserId -notin @("SYSTEM", "S-1-5-18", "NT AUTHORITY\SYSTEM")) {
      throw "The bot task runs as '$($task.Principal.UserId)', and setup.exe would re-register it as SYSTEM. Update by hand: run the new setup.exe, then install-task.ps1 -RunAsUser $($task.Principal.UserId)."
    }

    if ($isSetup) {
      Write-UpdateLog "Running $(Split-Path $r.file -Leaf) silently"
      $setupLog = Join-Path $work "setup.log"
      $p = Start-Process -FilePath $r.file -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$setupLog`"" -Wait -PassThru
      Restore-EnvFile $saved
      if ($p.ExitCode -ne 0) {
        if (Test-Path $setupLog) { Get-Content $setupLog -Tail 30 | ForEach-Object { Write-UpdateLog "  setup: $_" } }
        if ($wasRunning) { Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
        throw "Setup failed with exit code $($p.ExitCode); it undid its own changes, the previous version stays installed."
      }
    } else {
      Write-UpdateLog "Extracting $(Split-Path $r.file -Leaf)"
      $new = Join-Path $work "new"
      Expand-Archive -Path $r.file -DestinationPath $new
      $src = Get-ChildItem -Path $new -Directory | Select-Object -First 1
      if (-not $src -or -not (Test-Path (Join-Path $src.FullName "package.json")) -or -not (Test-Path (Join-Path $src.FullName "src\index.js"))) { throw "The bundle does not look like a bot release; nothing was changed." }
      $backup = Join-Path $work "backup"
      New-Item -ItemType Directory -Path $backup | Out-Null
      Write-UpdateLog "Backing up the current version"
      Copy-Payload -From $InstallDir -To $backup
      if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
      try {
        Write-UpdateLog "Installing version $($r.latest)"
        Copy-Payload -From $src.FullName -To $InstallDir
        Restore-EnvFile $saved
      } catch {
        Write-UpdateLog "Copying failed: $($_.Exception.Message)"
        Restore-Payload $backup
        if ($wasRunning) { Start-ScheduledTask -TaskName $TaskName }
        throw "The update failed; the previous version was restored."
      }
    }

    # Release notes for the bot's "updated" DM to server admins (read and deleted by the bot).
    $dataDir = if ($isSetup) { Join-Path $ConfigDir "data" } else { Join-Path $InstallDir "data" }
    if ($r.notice -and (Test-Path $r.notice) -and (Test-Path $dataDir)) { Copy-Item -Path $r.notice -Destination (Join-Path $dataDir "update-notice.json") -Force }

    if ($task -and -not $wasRunning) {
      # The bot was stopped on purpose: keep it stopped (setup.exe starts the task it registers).
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } elseif ($task) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Start-ScheduledTask -TaskName $TaskName
      if (-not (Test-BotRunning)) {
        if ($isSetup) { throw "Version $($r.latest) is installed but the bot did not stay running; see Task Scheduler and run 'Check configuration'." }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Restore-Payload $backup
        Start-ScheduledTask -TaskName $TaskName
        throw "Version $($r.latest) did not stay running; the previous version was restored."
      }
    }
    Write-UpdateLog "Updated to version $($r.latest)."
  } finally {
    Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated (Administrator) PowerShell."
  }
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -Path $LogFile -Destination "$LogFile.old" -Force }

  if ($Enable) { Register-UpdateTask; exit 0 }
  if ($Disable) {
    if (Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    }
    Write-UpdateLog "Automatic updates off"
    exit 0
  }

  $lock = $null
  try { $lock = [IO.File]::Open((Join-Path $ConfigDir "auto-update.lock"), "OpenOrCreate", "ReadWrite", "None") } catch { Write-UpdateLog "Another update is already running; nothing to do."; exit 0 }
  try {
    Write-UpdateLog "$(if ($Check) { 'Checking' } else { 'Looking' }) for a new release of $InstallDir (bot task '$TaskName')"
    Invoke-Update
  } finally { $lock.Dispose() }
} catch {
  Write-UpdateLog "ERROR: $($_.Exception.Message)"
  exit 1
}
exit 0
