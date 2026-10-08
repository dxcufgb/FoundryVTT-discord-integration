; Inno Setup script for the Foundry VTT Discord integration (Windows installer).
;
; Build (Inno Setup 6.2+):
;   ISCC.exe /DMyAppVersion=1.2.3 /DSourceDir=..\..\dist\windows\payload deploy\windows\installer.iss
; SourceDir must contain the bot with its node_modules (what the release workflow
; builds); it defaults to the repository root for local experiments.
;
; What the installer does:
;   - checks for Node.js 20+ and offers to download and install Node.js LTS if missing
;   - asks for the Discord token / application id / server id and the Foundry URL,
;     data folder, timezone and poll interval (pre-filled from an existing install)
;   - installs the bot under Program Files, writes the configuration to
;     %ProgramData%\FoundryVTT Discord integration\.env (kept on upgrades)
;   - registers a Scheduled Task that starts the bot at boot and restarts it on failure
;   - optionally (unchecked by default) registers a daily task that installs new releases
;     (deploy\windows\auto-update.ps1); an upgrade keeps whatever was chosen before
;
; Silent install (all pages skipped, values from the command line):
;   setup.exe /VERYSILENT /SUPPRESSMSGBOXES /DiscordToken=... /ClientId=... [/GuildId=...]
;             [/FoundryUrl=http://localhost:30000] [/DataPath="C:\Users\me\AppData\Local\FoundryVTT"]
;             [/Timezone=Europe/Stockholm] [/Interval=30] [/AutoUpdate=1|0]
; /AutoUpdate=1 turns automatic updates on, /AutoUpdate=0 off; without it the current choice is kept.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\.."
#endif
#define MyAppName "FoundryVTT Discord integration"
#define MyAppPublisher "Dxcufgb"
#define MyAppURL "https://github.com/dxcufgb/FoundryVTT-discord-integration"
#define TaskName "FoundryVTT Discord integration"
#define UpdateTaskName "FoundryVTT Discord integration update"
#define NodeVersion "22.22.0"

[Setup]
AppId={{7D3F2B61-5C7A-4E0B-9B5E-2A4F6D8C1E90}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/blob/main/docs/INSTALL.md
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile={#SourceDir}\LICENSE
OutputDir=..\..\dist
OutputBaseFilename=foundryvtt-discord-integration-{#MyAppVersion}-setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
UninstallDisplayName={#MyAppName}
CloseApplications=no
; The auto-update choice is read from the scheduled task itself, not from the last setup's task list.
UsePreviousTasks=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autoupdate"; Description: "Install new releases automatically (checks GitHub once a day; keeps the configuration)"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "\.env,\data,\.git,\.github,\dist,*.tar.gz,*.zip"

[Dirs]
; The scheduled task runs as SYSTEM; start.bat is run by a logged-in user, so both need to write the state file.
Name: "{commonappdata}\{#MyAppName}"
Name: "{commonappdata}\{#MyAppName}\data"; Permissions: users-modify

[Icons]
Name: "{group}\Edit configuration"; Filename: "notepad.exe"; Parameters: """{commonappdata}\{#MyAppName}\.env"""; Comment: "Open the bot's .env in Notepad (restart the task afterwards)"
Name: "{group}\Check configuration"; Filename: "{app}\deploy\windows\check-config.bat"; Comment: "Validate .env and probe Foundry"
Name: "{group}\Run bot in a window (log)"; Filename: "{app}\deploy\windows\start.bat"; Comment: "Run the bot in a console to watch its log"
Name: "{group}\Open Task Scheduler"; Filename: "taskschd.msc"
Name: "{group}\Install guide"; Filename: "{#MyAppURL}/blob/main/docs/INSTALL.md"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\deploy\windows\check-config.bat"; Description: "Check the configuration and the connection to Foundry now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\deploy\windows\uninstall-task.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveScheduledTask"

[Code]
var
  DiscordPage: TInputQueryWizardPage;
  FoundryPage: TInputQueryWizardPage;
  DownloadPage: TDownloadWizardPage;
  NodeExe: String;
  NodeNeeded: Boolean;
  AutoUpdateWasOn: Boolean;
  TasksPrefilled: Boolean;

function GetNodeExe(Param: String): String;
begin
  Result := NodeExe;
end;

function ConfigDir: String;
begin
  Result := ExpandConstant('{commonappdata}\{#MyAppName}');
end;

function EnvFile: String;
begin
  Result := ConfigDir + '\.env';
end;

{ Run a command through cmd.exe and return the first line it prints. }
function RunCapture(const Command: String; var Output: String): Boolean;
var
  ResultCode: Integer;
  TmpFile: String;
  Lines: TArrayOfString;
begin
  Output := '';
  TmpFile := ExpandConstant('{tmp}\capture.txt');
  DeleteFile(TmpFile);
  { /S keeps every quote inside the command intact; without it cmd strips the first and last quote of a quoted command. }
  Result := Exec(ExpandConstant('{cmd}'), '/S /C "' + Command + ' > "' + TmpFile + '" 2>&1"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if LoadStringsFromFile(TmpFile, Lines) and (GetArrayLength(Lines) > 0) then
    Output := Trim(Lines[0]);
end;

{ Find node.exe (registry, then PATH) and check it is version 20 or newer. }
function FindNode(var Exe: String): Boolean;
var
  Dir, Major: String;
begin
  Result := False;
  Exe := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', Dir) and FileExists(AddBackslash(Dir) + 'node.exe') then
    Exe := AddBackslash(Dir) + 'node.exe'
  else if FileExists(ExpandConstant('{pf}\nodejs\node.exe')) then
    Exe := ExpandConstant('{pf}\nodejs\node.exe')
  else if RunCapture('where node.exe', Dir) and FileExists(Dir) then
    Exe := Dir;
  if Exe = '' then
    Exit;
  if RunCapture('"' + Exe + '" -p "process.versions.node.split(''.'')[0]"', Major) then
    Result := StrToIntDef(Major, 0) >= 20;
  Log('Node.js at ' + Exe + ', major version "' + Major + '", acceptable: ' + IntToStr(Integer(Result)));
end;

{ Read KEY=value from an existing .env (upgrade); empty string if absent. }
function ReadEnvValue(const Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(EnvFile, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos(Key + '=', Line) = 1 then
    begin
      Result := Copy(Line, Length(Key) + 2, MaxInt);
      if (Length(Result) >= 2) and (Result[1] = '"') and (Result[Length(Result)] = '"') then
        Result := Copy(Result, 2, Length(Result) - 2);
      Exit;
    end;
  end;
end;

{ Command-line parameter, then existing .env, then default. }
function Setting(const Param, Key, Default: String): String;
begin
  Result := ExpandConstant('{param:' + Param + '|}');
  if Result = '' then
    Result := ReadEnvValue(Key);
  if Result = '' then
    Result := Default;
end;

function IsDigits(const S: String): Boolean;
var
  I: Integer;
begin
  Result := Length(S) > 0;
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
      Result := False;
end;

function InitializeSetup: Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  AutoUpdateWasOn := Exec('schtasks.exe', '/Query /TN "{#UpdateTaskName}"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  Log('Automatic updates currently on: ' + IntToStr(Integer(AutoUpdateWasOn)));
  NodeNeeded := not FindNode(NodeExe);
  if NodeNeeded and not WizardSilent then
  begin
    if MsgBox('The bot needs Node.js 20 or newer, which was not found on this computer.' + #13#10#13#10 +
              'Download and install Node.js {#NodeVersion} (LTS) from nodejs.org as part of this setup?' + #13#10#13#10 +
              'Choose No to stop and install Node.js yourself first.', mbConfirmation, MB_YESNO) <> IDYES then
      Result := False;
  end;
end;

procedure InitializeWizard;
var
  DefaultData: String;
begin
  DiscordPage := CreateInputQueryPage(wpSelectDir, 'Discord bot',
    'How the bot connects to your Discord server',
    'Create an application at https://discord.com/developers/applications. Copy the Application ID from "General Information" ' +
    'and the token from "Bot" (Reset Token); on that page also turn on "Server Members Intent" under Privileged Gateway Intents, or Discord refuses the bot. Invite the bot to your server with the "bot" and "applications.commands" scopes. ' +
    'The server ID is optional: with it, the slash commands appear immediately instead of within an hour.');
  DiscordPage.Add('Bot token:', True);
  DiscordPage.Add('Application (client) ID:', False);
  DiscordPage.Add('Server ID (optional):', False);
  DiscordPage.Values[0] := Setting('DiscordToken', 'DISCORD_TOKEN', '');
  DiscordPage.Values[1] := Setting('ClientId', 'DISCORD_CLIENT_ID', '');
  DiscordPage.Values[2] := Setting('GuildId', 'DISCORD_GUILD_ID', '');

  DefaultData := ExpandConstant('{localappdata}\FoundryVTT');
  if not DirExists(DefaultData) then
    DefaultData := '';
  FoundryPage := CreateInputQueryPage(DiscordPage.ID, 'Foundry VTT',
    'Where Foundry runs on this computer',
    'The URL is how the bot reaches Foundry locally. The user data folder is the one that contains Config, Data and Logs; ' +
    'it is needed for system/module update tracking. The timezone is an IANA name such as Europe/Stockholm; "auto" uses this computer''s.');
  FoundryPage.Add('Foundry URL:', False);
  FoundryPage.Add('Foundry user data folder:', False);
  FoundryPage.Add('Timezone:', False);
  FoundryPage.Add('Check Foundry every N seconds:', False);
  FoundryPage.Values[0] := Setting('FoundryUrl', 'FOUNDRY_URL', 'http://localhost:30000');
  FoundryPage.Values[1] := Setting('DataPath', 'FOUNDRY_DATA_PATH', DefaultData);
  FoundryPage.Values[2] := Setting('Timezone', 'TIMEZONE', 'auto');
  FoundryPage.Values[3] := Setting('Interval', 'POLL_INTERVAL_SECONDS', '30');

  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
end;

function InstallNode: Boolean;
var
  Msi: String;
  ResultCode: Integer;
begin
  Result := False;
  DownloadPage.Clear;
  DownloadPage.Add('https://nodejs.org/dist/v{#NodeVersion}/node-v{#NodeVersion}-x64.msi', 'node.msi', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if DownloadPage.AbortedByUser then
        Log('Node.js download aborted by user')
      else
        SuppressibleMsgBox('Could not download Node.js: ' + AddPeriod(GetExceptionMessage), mbCriticalError, MB_OK, IDOK);
      Exit;
    end;
  finally
    DownloadPage.Hide;
  end;
  Msi := ExpandConstant('{tmp}\node.msi');
  if not Exec('msiexec.exe', '/i "' + Msi + '" /passive /norestart', '', SW_SHOW, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    SuppressibleMsgBox('Node.js installation failed (exit code ' + IntToStr(ResultCode) + ').', mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  Result := FindNode(NodeExe);
  if not Result then
    SuppressibleMsgBox('Node.js was installed but could not be found afterwards. Install Node.js 20+ from https://nodejs.org and run this setup again.', mbCriticalError, MB_OK, IDOK);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  V: String;
begin
  Result := True;
  if CurPageID = DiscordPage.ID then
  begin
    if Trim(DiscordPage.Values[0]) = '' then
    begin
      MsgBox('Please enter the bot token.', mbError, MB_OK);
      Result := False;
    end
    else if not IsDigits(Trim(DiscordPage.Values[1])) or (Length(Trim(DiscordPage.Values[1])) < 15) then
    begin
      MsgBox('The application ID is a number with 17–20 digits (from General Information in the developer portal).', mbError, MB_OK);
      Result := False;
    end
    else if (Trim(DiscordPage.Values[2]) <> '') and not IsDigits(Trim(DiscordPage.Values[2])) then
    begin
      MsgBox('The server ID must be a number (or left empty).', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = FoundryPage.ID then
  begin
    V := Trim(FoundryPage.Values[0]);
    if (Pos('http://', V) <> 1) and (Pos('https://', V) <> 1) then
    begin
      MsgBox('The Foundry URL must start with http:// or https://', mbError, MB_OK);
      Result := False;
    end
    else if (Trim(FoundryPage.Values[1]) <> '') and not DirExists(Trim(FoundryPage.Values[1])) then
    begin
      Result := MsgBox('The folder "' + Trim(FoundryPage.Values[1]) + '" does not exist. Use it anyway?', mbConfirmation, MB_YESNO) = IDYES;
    end
    else if (Trim(FoundryPage.Values[1]) = '') then
    begin
      Result := MsgBox('Without a data folder, system/module update tracking and world titles are off. Continue?', mbConfirmation, MB_YESNO) = IDYES;
    end
    else if StrToIntDef(Trim(FoundryPage.Values[3]), 0) < 5 then
    begin
      MsgBox('The interval must be a whole number of at least 5 seconds.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if (CurPageID = wpReady) and NodeNeeded then
  begin
    Result := InstallNode;
    if Result then
      NodeNeeded := False;
  end;
end;

{ Pre-tick the auto-update box when the update task already exists, once, so the user can still untick it. }
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and not TasksPrefilled then
  begin
    TasksPrefilled := True;
    if AutoUpdateWasOn then
      WizardSelectTasks('autoupdate');
  end;
end;

{ /AutoUpdate=1|0 wins; a silent upgrade keeps the current choice; otherwise the checkbox decides. }
function WantAutoUpdate: Boolean;
var
  P: String;
begin
  P := ExpandConstant('{param:AutoUpdate|}');
  if P = '1' then
    Result := True
  else if P = '0' then
    Result := False
  else if WizardSilent then
    Result := AutoUpdateWasOn or WizardIsTaskSelected('autoupdate')
  else
    Result := WizardIsTaskSelected('autoupdate');
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine +
    'Configuration file:' + NewLine + Space + EnvFile + NewLine + NewLine +
    'Foundry:' + NewLine + Space + Trim(FoundryPage.Values[0]) + NewLine + Space + 'Data folder: ' + Trim(FoundryPage.Values[1]) + NewLine + NewLine +
    'Startup:' + NewLine + Space + 'Scheduled task "{#TaskName}" runs the bot at boot as SYSTEM.';
  if WantAutoUpdate then
    Result := Result + NewLine + NewLine + 'Automatic updates:' + NewLine + Space + 'Scheduled task "{#UpdateTaskName}" installs new releases daily.';
  if NodeNeeded then
    Result := Result + NewLine + NewLine + 'Node.js {#NodeVersion} will be downloaded and installed first.';
end;

procedure WriteEnvFile;
var
  Lines: TArrayOfString;
  Tz: String;
begin
  Tz := Trim(FoundryPage.Values[2]);
  if (Tz = '') or (CompareText(Tz, 'auto') = 0) then
  begin
    if (NodeExe = '') or not RunCapture('"' + NodeExe + '" -p "Intl.DateTimeFormat().resolvedOptions().timeZone"', Tz) or (Tz = '') then
      Tz := 'UTC';
  end;
  ForceDirectories(ConfigDir + '\data');
  SetArrayLength(Lines, 12);
  Lines[0] := '# Written by the installer. Edit, then stop and start the "{#TaskName}" task in Task Scheduler.';
  Lines[1] := 'DISCORD_TOKEN=' + Trim(DiscordPage.Values[0]);
  Lines[2] := 'DISCORD_CLIENT_ID=' + Trim(DiscordPage.Values[1]);
  Lines[3] := 'DISCORD_GUILD_ID=' + Trim(DiscordPage.Values[2]);
  Lines[4] := 'FOUNDRY_URL=' + Trim(FoundryPage.Values[0]);
  Lines[5] := 'FOUNDRY_DATA_PATH=' + Trim(FoundryPage.Values[1]);
  Lines[6] := 'FOUNDRY_APP_PATH=' + ReadEnvValue('FOUNDRY_APP_PATH');
  Lines[7] := 'BOT_DATA_DIR=' + ConfigDir + '\data';
  Lines[8] := 'POLL_INTERVAL_SECONDS=' + Trim(FoundryPage.Values[3]);
  Lines[9] := 'DOWN_AFTER_FAILURES=2';
  Lines[10] := 'TIMEZONE=' + Tz;
  Lines[11] := 'LOG_LEVEL=info';
  if not SaveStringsToFile(EnvFile, Lines, False) then
    SuppressibleMsgBox('Could not write ' + EnvFile, mbError, MB_OK, IDOK);
end;

{ Register the scheduled task through install-task.ps1; its output goes to install-task.log next to .env. }
procedure RegisterTask;
var
  Params, LogFile: String;
  ResultCode: Integer;
begin
  LogFile := ConfigDir + '\install-task.log';
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\deploy\windows\install-task.ps1') + '"' +
    ' -InstallDir "' + ExpandConstant('{app}') + '" -EnvFile "' + EnvFile + '" -LogFile "' + LogFile + '" -SkipConfigCheck';
  if NodeExe <> '' then
    Params := Params + ' -NodeExe "' + NodeExe + '"';
  WizardForm.StatusLabel.Caption := 'Registering the scheduled task that runs the bot at startup...';
  if not Exec('powershell.exe', Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
  begin
    Log('install-task.ps1 failed with exit code ' + IntToStr(ResultCode) + '; see ' + LogFile);
    SuppressibleMsgBox('The bot was installed, but the scheduled task that starts it could not be registered (exit code ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
      'Details: ' + LogFile + #13#10#13#10 +
      'You can retry from an elevated PowerShell:' + #13#10 + ExpandConstant('{app}\deploy\windows\install-task.ps1') + ' -EnvFile "' + EnvFile + '"', mbError, MB_OK, IDOK);
  end
  else
    Log('install-task.ps1 succeeded');
end;

{ Register or remove the daily update task with auto-update.ps1 (it logs to auto-update.log next to .env). }
procedure ConfigureAutoUpdate;
var
  Want: Boolean;
  Mode: String;
  ResultCode: Integer;
begin
  Want := WantAutoUpdate;
  if Want = AutoUpdateWasOn then
    Exit;
  if Want then Mode := '-Enable' else Mode := '-Disable';
  WizardForm.StatusLabel.Caption := 'Configuring automatic updates...';
  if not Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\deploy\windows\auto-update.ps1') + '" ' + Mode +
      ' -InstallDir "' + ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    SuppressibleMsgBox('Automatic updates could not be configured (exit code ' + IntToStr(ResultCode) + '). Details: ' + ConfigDir + '\auto-update.log', mbError, MB_OK, IDOK)
  else
    Log('auto-update.ps1 ' + Mode + ' succeeded');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if NodeNeeded and WizardSilent then
      Log('Node.js is missing and cannot be installed silently; the scheduled task will fail until Node.js 20+ is installed.');
    WriteEnvFile;
    RegisterTask;
    ConfigureAutoUpdate;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and DirExists(ConfigDir) then
  begin
    { Silent uninstalls keep the configuration unless /PurgeConfig=1 is passed. }
    if UninstallSilent then
    begin
      if ExpandConstant('{param:PurgeConfig|0}') = '1' then
        DelTree(ConfigDir, True, True, True);
    end
    else if MsgBox('Also delete the configuration and data in' + #13#10 + ConfigDir + '?' + #13#10#13#10 +
        'Choose No to keep the bot token, channel settings and the list of announced updates for a later reinstall.', mbConfirmation, MB_YESNO) = IDYES then
      DelTree(ConfigDir, True, True, True);
  end;
end;
