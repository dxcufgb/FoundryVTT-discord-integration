<#
.SYNOPSIS
  Restricts the bot's configuration and data to Administrators, SYSTEM and the account the bot runs as.

.DESCRIPTION
  .env holds the Discord token and the data folder holds state.json and admin.json (the admin page's password
  hash), so no other account may read or change them. Run from an elevated PowerShell (or as SYSTEM):

    .\deploy\windows\protect-config.ps1 [-ConfigDir <folder>] [-EnvFile <file>] [-RunAs <account>]

  -ConfigDir  the settings folder (%ProgramData%\FoundryVTT Discord integration): Administrators and SYSTEM full
              control, the bot's account may only list it. What else is in it (the logs) gets just that, inherited.
  -EnvFile    .env: Administrators and SYSTEM full control, the bot's account read. The data folder next to it
              (BOT_DATA_DIR, by default "data"): Administrators and SYSTEM full control, the bot's account modify,
              inherited by everything in it. Any other BOT_DATA_DIR is left alone (and said so).
  -RunAs      the account the bot's scheduled task runs as (default SYSTEM, which needs no extra entry).

  Every ACL is explicit and not inherited, so Users, Everyone and Authenticated Users never get access. A file or
  folder inside that has an owner or an entry for any other account (versions up to 1.6.0 gave Users modify on
  data\) is taken over by Administrators and reset to inherit those permissions. Links are never followed: the
  settings folder, .env or the data folder being a link (junction, symbolic or hard link) stops the script; a link
  inside them is removed.
  Run by install-task.ps1 (and so by setup.exe), by setup.exe before it writes .env, and by auto-update.ps1 on every
  run, so upgrades fix older installations too.
#>
param(
  [string]$ConfigDir,
  [string]$EnvFile,
  [string]$RunAs = "S-1-5-18"
)
$ErrorActionPreference = "Stop"

$SystemSid = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-18"
$AdminsSid = New-Object System.Security.Principal.SecurityIdentifier "S-1-5-32-544"
# Everyone, Authenticated Users, Users, Guests, INTERACTIVE, NETWORK, ANONYMOUS LOGON: never the bot's account.
$Weak = "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-32-546", "S-1-5-4", "S-1-5-2", "S-1-5-7"

function Get-AccountSid([string]$Name) {
  if ($Name -match '^S-1-[0-9-]+$') { return New-Object System.Security.Principal.SecurityIdentifier $Name }
  if (@("SYSTEM", "NT AUTHORITY\SYSTEM", "LocalSystem") -contains $Name) { return $SystemSid }
  if ($Name.StartsWith(".\")) { $Name = "$env:COMPUTERNAME\$($Name.Substring(2))" }
  return (New-Object System.Security.Principal.NTAccount $Name).Translate([System.Security.Principal.SecurityIdentifier])
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

# Run a Windows tool and return its output lines and exit code. Windows PowerShell 5.1 turns a native command's
# stderr into errors that $ErrorActionPreference = "Stop" makes fatal, so that preference is relaxed meanwhile.
function Invoke-Tool([string]$Exe, [string[]]$Arguments) {
  $eap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $lines = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $eap }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Lines = $lines }
}

function Test-Link([string]$Path) {
  return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# True when a file has more than one name (a hard link). All its names share one ACL and owner, so changing them
# through this name would change a file somewhere else. (Creating one needs write access to that file already.)
function Test-HardLinked([string]$Path) {
  $r = Invoke-Tool -Exe "fsutil.exe" -Arguments @("hardlink", "list", $Path)
  return ($r.Code -eq 0) -and (@($r.Lines | Where-Object { $_.Trim() }).Count -gt 1)
}

# Give Administrators ownership even when the ACL shuts them out (takeown enables the privilege it needs).
function Grant-AdminOwnership([string]$Path) {
  $r = Invoke-Tool -Exe "takeown.exe" -Arguments @("/F", $Path, "/A")
  if ($r.Code -ne 0) { throw "takeown could not give $Path to Administrators (exit code $($r.Code): $($r.Lines -join ' '))." }
}

# Replace the ACL of a path with an explicit one that inherits nothing: SYSTEM and Administrators full control,
# the bot's account $BotRights (on the folder only with -BotThisFolderOnly). An owner other than SYSTEM or
# Administrators (an owner can always change the ACL, the bot's account too) is replaced by Administrators.
function Protect-Item([string]$Path, [switch]$Folder, [System.Security.AccessControl.FileSystemRights]$BotRights, [switch]$BotThisFolderOnly) {
  $owner = $null
  try { $owner = (Get-PathAcl $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value } catch { $owner = $null }
  if (@($SystemSid.Value, $AdminsSid.Value) -notcontains $owner) { Grant-AdminOwnership $Path }
  $acl = if ($Folder) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($Folder) { [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit" } else { [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in $SystemSid, $AdminsSid) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $sid, "FullControl", $inherit, "None", "Allow"))
  }
  if ($BotRights -and -not ($script:Bot.Equals($SystemSid) -or $script:Bot.Equals($AdminsSid))) {
    $botInherit = if ($BotThisFolderOnly) { [System.Security.AccessControl.InheritanceFlags]::None } else { $inherit }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule $script:Bot, $BotRights, $botInherit, "None", "Allow"))
  }
  try { Write-PathAcl -Path $Path -Acl $acl } catch {
    Grant-AdminOwnership $Path
    Write-PathAcl -Path $Path -Acl $acl
  }
}

# True when only the $Trusted accounts own the path or appear in its ACL.
function Test-AclClean([string]$Path, [string[]]$Trusted) {
  try { $acl = Get-PathAcl $Path } catch { return $false }
  if ($Trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { return $false }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($Trusted -notcontains $rule.IdentityReference.Value) { return $false }
  }
  return $true
}

# Everything below a protected folder: links are removed (never followed; a file with a second name, a hard link,
# loses this name: the bot never makes one, the file it points at stays as it is), anything with a foreign owner or
# ACL entry (any account but $Trusted) is given to Administrators and reset to inherit the folder's permissions.
# -Lenient (the settings folder: logs, the updater token) logs a file it cannot fix instead of stopping.
function Repair-FolderContent([string]$Folder, [string[]]$Trusted, [string[]]$Skip = @(), [switch]$Lenient) {
  foreach ($child in Get-ChildItem -LiteralPath $Folder -Force) {
    if ($Skip -contains $child.Name) { continue }
    try {
      if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        # Deleting a link removes the link only, never what it points at.
        if ($child.PSIsContainer) { [System.IO.Directory]::Delete($child.FullName) } else { [System.IO.File]::Delete($child.FullName) }
        Write-Output "Removed the link $($child.FullName) (links are not followed here)"
        continue
      }
      if (-not (Test-AclClean -Path $child.FullName -Trusted $Trusted)) {
        if (-not $child.PSIsContainer -and (Test-HardLinked $child.FullName)) {
          [System.IO.File]::Delete($child.FullName)
          Write-Output "Removed $($child.FullName): a second name (hard link) of another file"
          continue
        }
        Grant-AdminOwnership $child.FullName
        $r = Invoke-Tool -Exe "icacls.exe" -Arguments @($child.FullName, "/reset", "/L", "/Q")
        if ($r.Code -ne 0) { throw "icacls could not reset the permissions of $($child.FullName) (exit code $($r.Code): $($r.Lines -join ' '))." }
        Write-Output "Reset the permissions of $($child.FullName)"
      }
    } catch {
      # Gone in the meantime (the bot replaces state.json by renaming a temporary file): nothing to fix.
      if (-not (Test-Path -LiteralPath $child.FullName)) { continue }
      if (-not $Lenient) { throw }
      Write-Output "WARNING: could not fix the permissions of $($child.FullName): $($_.Exception.Message)"
      continue
    }
    if ($child.PSIsContainer) { Repair-FolderContent -Folder $child.FullName -Trusted $Trusted -Lenient:$Lenient }
  }
}

# The data folder: BOT_DATA_DIR from .env (relative to its folder), "data" by default.
function Get-DataDir([string]$File) {
  $value = ""
  if (Test-Path -LiteralPath $File -PathType Leaf) {
    foreach ($line in [System.IO.File]::ReadAllLines($File)) {
      if ($line -match '^\s*BOT_DATA_DIR\s*=(.*)$') { $value = $Matches[1].Trim().Trim('"').Trim("'") }
    }
  }
  if (-not $value) { $value = "data" }
  if ([System.IO.Path]::IsPathRooted($value)) { return [System.IO.Path]::GetFullPath($value) }
  return [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $File) $value))
}

if (-not $ConfigDir -and -not $EnvFile) { throw "Nothing to do: pass -ConfigDir and/or -EnvFile." }
$script:Bot = Get-AccountSid $RunAs
if ($Weak -contains $script:Bot.Value) { throw "The bot must run as a single account, not as '$RunAs'." }
$adminsOnly = @($SystemSid.Value, $AdminsSid.Value)
$withBot = @($SystemSid.Value, $AdminsSid.Value, $script:Bot.Value)
$who = if ($script:Bot.Equals($SystemSid)) { "Administrators and SYSTEM" } else { "Administrators, SYSTEM and $RunAs" }

if ($ConfigDir) {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  if (Test-Link $ConfigDir) { throw "$ConfigDir is a link (junction or symbolic link); remove it and run the installer again." }
  Protect-Item -Path $ConfigDir -Folder -BotRights ReadAndExecute -BotThisFolderOnly
  # .env and data get their own ACLs below; the lock file is held open by a running update.
  Repair-FolderContent -Folder $ConfigDir -Trusted $adminsOnly -Skip ".env", "data", "auto-update.lock" -Lenient
  Write-Output "Restricted $ConfigDir to Administrators and SYSTEM"
}

if ($EnvFile) {
  if (Test-Path -LiteralPath $EnvFile) {
    if (Test-Link $EnvFile) { throw "$EnvFile is a link; replace it with the real file and run the installer again." }
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "$EnvFile is a folder, not a file." }
    if (Test-HardLinked $EnvFile) { throw "$EnvFile has more than one name (a hard link); replace it with a copy and run the installer again." }
    Protect-Item -Path $EnvFile -BotRights Read
    Write-Output "Restricted $EnvFile to $who (read)"
  }
  $dataDir = Get-DataDir $EnvFile
  $envDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $EnvFile)).TrimEnd("\")
  if (((Split-Path -Parent $dataDir).TrimEnd("\") -ne $envDir) -or ((Split-Path -Leaf $dataDir) -ne "data")) {
    # Only the folder "data" next to .env is changed here: any other folder could be something else entirely (in a zip
    # installation even program files, which the bot's account must never be able to change).
    Write-Output "BOT_DATA_DIR ($dataDir) is not the folder data next to $EnvFile; its permissions are left as they are."
  } else {
    if ((Test-Path -LiteralPath $dataDir) -and (Test-Link $dataDir)) { throw "$dataDir is a link (junction or symbolic link); replace it with the real folder and run the installer again." }
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    Protect-Item -Path $dataDir -Folder -BotRights Modify
    Repair-FolderContent -Folder $dataDir -Trusted $withBot
    Write-Output "Restricted $dataDir to $who (modify)"
  }
}
