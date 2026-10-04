# Installing the bot

The bot runs on the **same machine as Foundry VTT** so it can reach Foundry on its local address and read Foundry's data folder. It needs **Node.js 20 or newer**.

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it, for example, "Foundry".
2. **General Information** → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. **Bot** → click **Reset Token**, copy the token. This is `DISCORD_TOKEN`. Treat it like a password.
4. Still under **Bot**, no privileged intents are needed (leave *Presence*, *Server Members* and *Message Content* off).
5. **Installation** → under *Install Link* choose *Discord Provided Link*, and under *Default Install Settings → Guild Install* add the scopes `applications.commands` and `bot`, with these bot permissions: **View Channels**, **Send Messages**, **Send Messages in Threads**, **Embed Links** and, if you want the bot to ping a role, **Mention @everyone, @here and All Roles** (or make that role mentionable).
6. Open the install link in your browser and add the bot to your server.

If you prefer to build the invite link yourself:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION ID>&scope=bot+applications.commands&permissions=274878057472
```

## 2. Get the bot files

Download the bundle for your platform from the [latest release](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest):

- `foundryvtt-discord-integration-<version>-linux.tar.gz`
- `foundryvtt-discord-integration-<version>-windows.zip`

They contain the bot with all dependencies, so no `npm install` is needed. Extract to a permanent location, for example `/opt/foundryvtt-discord-integration` or `C:\FoundryBot`.

Alternatively clone the repository and run `npm ci --omit=dev`.

## 3. Configure

Copy `.env.example` to `.env` and fill it in. The important ones:

```
DISCORD_TOKEN=<bot token>
DISCORD_CLIENT_ID=<application id>
FOUNDRY_URL=http://localhost:30000
FOUNDRY_DATA_PATH=<Foundry user data folder>
TIMEZONE=Europe/Stockholm
```

`FOUNDRY_DATA_PATH` is the folder Foundry calls *User Data* (it contains `Config`, `Data` and `Logs`). Typical locations:

| Platform | Default user data folder |
| --- | --- |
| Linux (Node install) | `~/.local/share/FoundryVTT` or whatever `--dataPath` points at (often `/home/<user>/foundrydata`) |
| Windows | `C:\Users\<user>\AppData\Local\FoundryVTT` |
| Docker (felddy image) | the folder mounted at `/data` |

Optionally set `DISCORD_GUILD_ID` to your server's ID while setting things up: slash commands then appear immediately instead of after up to an hour. (Right-click your server → *Copy Server ID*; needs *Developer Mode* under Discord's *Advanced* settings.)

Check it: `node scripts/check-config.js` (or `npm run check-config`) prints the configuration, probes Foundry and counts installed systems and modules.

## 4a. Linux: run as a systemd service

```
cd /opt/foundryvtt-discord-integration
sudo ./deploy/linux/install.sh --user foundry
```

Replace `foundry` with the Linux user that runs Foundry so the bot can read Foundry's data folder. The script checks Node.js, creates `.env` from the example if missing, verifies the configuration, installs `/etc/systemd/system/foundryvtt-discord-bot.service` and starts it.

```
sudo systemctl status foundryvtt-discord-bot     # running?
sudo journalctl -u foundryvtt-discord-bot -f     # live log
sudo systemctl restart foundryvtt-discord-bot    # after editing .env
sudo ./deploy/linux/uninstall.sh                 # remove the service (keeps files)
```

If Foundry itself runs under systemd, the bot's unit can wait for it: add `After=foundry.service` (your Foundry unit's name) under `[Unit]` in the installed unit file.

## 4b. Windows: run as a scheduled task

Open **PowerShell as Administrator** in the bot folder:

```
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\install-task.ps1
```

This registers a Task Scheduler task *FoundryVTT Discord integration* that starts the bot at boot (as SYSTEM, without anyone logged in) and restarts it if it stops. Pass `-RunAsUser "COMPUTER\name"` to run it as the account that runs Foundry if Foundry's data folder is not readable by SYSTEM.

- See it in **Task Scheduler** (taskschd.msc), or `Get-ScheduledTask -TaskName "FoundryVTT Discord integration"`.
- After editing `.env`: `Stop-ScheduledTask` then `Start-ScheduledTask` with that task name.
- To watch the log, run `deploy\windows\start.bat` in a terminal instead (stop the task first so two copies are not running).
- `.\deploy\windows\uninstall-task.ps1` removes the task and keeps the files.

If you would rather have a real Windows service, [NSSM](https://nssm.cc) works well: `nssm install FoundryDiscordBot "C:\Program Files\nodejs\node.exe" "src\index.js"` with the bot folder as the startup directory.

## 5. Set up channels in Discord

In your Discord server (as an administrator):

1. In the channel where you want everything by default: `/channel set type:default`
2. Optionally send specific kinds elsewhere, e.g. `/channel set type:updates channel:#foundry-updates`
3. `/channel mention role:@GM` to ping a role when Foundry goes down unexpectedly.
4. `/restart-window set start:04:00 duration:15` if Foundry restarts on a schedule.
5. `/test-message type:status` to confirm the bot can post there.

The bot must be able to **view** and **send messages** in each chosen channel (check the channel's permissions for the bot's role).

## Upgrading

Extract the new bundle over the old folder (or `git pull && npm ci --omit=dev`), keep your `.env` and `data/` folder, and restart the service or task. `data/state.json` remembers your channels, windows and which updates were already announced.

## Troubleshooting

- **Slash commands do not appear**: global commands can take up to an hour. Set `DISCORD_GUILD_ID` for instant registration, or run `npm run register-commands`. The bot must have been invited with the `applications.commands` scope.
- **"Only server administrators can use this command"**: configuration commands require the *Administrator* permission in that server.
- **Foundry shows as down but is running**: check `FOUNDRY_URL`. Use the local address (`http://localhost:30000`), not a public hostname behind a proxy that might need authentication. `curl http://localhost:30000/api/status` should return JSON.
- **No update messages**: `FOUNDRY_DATA_PATH` must point at the user data folder and be readable by the user the bot runs as. `/updates list` shows what the bot sees. The first scan is silent on purpose.
- **Nothing is posted**: `/channel list` shows the routing; `/test-message` tests a channel. Look at the log (`journalctl` or `start.bat`).
