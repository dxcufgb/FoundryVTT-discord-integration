# Installing the bot

The bot runs on the **same machine as Foundry VTT** so it can reach Foundry on its local address and read Foundry's data folder. It needs **Node.js 20 or newer**.

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it, for example, "Foundry".
2. **General Information** → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. **Bot** → click **Reset Token**, copy the token. This is `DISCORD_TOKEN`. Treat it like a password.
4. Still under **Bot**, no privileged intents are needed (leave *Presence*, *Server Members* and *Message Content* off).
5. **Installation** → under *Install Link* choose *Discord Provided Link*, and under *Default Install Settings → Guild Install* add the scopes `applications.commands` and `bot`, with these bot permissions: **View Channels**, **Send Messages**, **Send Messages in Threads**, **Embed Links**, **Create Events** (for `/planning-poll`) and, if you want the bot to ping a role, **Mention @everyone, @here and All Roles** (or make that role mentionable).
6. Open the install link in your browser and add the bot to your server.

If you prefer to build the invite link yourself:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION ID>&scope=bot+applications.commands&permissions=17867064101888
```

## 2. Install on Linux (guided installer)

On the machine that runs Foundry, run the installer. It downloads the latest release, checks for Node.js 20+ (and offers to install it), finds your running Foundry server to suggest its user, port and data folder, asks for the Discord token and IDs, writes the configuration, and installs and starts a systemd service:

```
curl -fsSL https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest/download/install.sh | sudo bash
```

Press Enter to accept a suggested value in `[brackets]`. If you downloaded the Linux bundle instead, extract it and run `sudo ./deploy/linux/install.sh` from the extracted folder; the questions are the same.

Unattended installs (scripts, Ansible, CI) pass everything on the command line:

```
sudo ./deploy/linux/install.sh --non-interactive --token <bot token> --client-id <application id> \
  --data-path /home/foundry/foundrydata --user foundry [--guild-id <server id>] \
  [--url http://localhost:30000] [--timezone Europe/Stockholm] [--interval 30] [--no-start]
```

Afterwards:

```
sudo systemctl status foundryvtt-discord-bot     # running?
sudo journalctl -u foundryvtt-discord-bot -f     # live log
sudo nano /opt/foundryvtt-discord-integration/.env && sudo systemctl restart foundryvtt-discord-bot
sudo /opt/foundryvtt-discord-integration/deploy/linux/install.sh --uninstall [--purge]
```

Running the installer again upgrades in place and keeps your `.env` and `data/` folder. If Foundry itself runs under systemd, you can make the bot wait for it by adding `After=foundry.service` (your unit's name) to `/etc/systemd/system/foundryvtt-discord-bot.service`.

## 3. Install on Windows (setup wizard)

Download `foundryvtt-discord-integration-<version>-setup.exe` from the [latest release](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest) and run it. The wizard:

1. Checks for Node.js 20 or newer and offers to download and install Node.js LTS if it is missing.
2. Asks for the Discord bot token, application ID and (optional) server ID.
3. Asks for the Foundry URL, Foundry's user data folder (pre-filled with `%LOCALAPPDATA%\FoundryVTT` when it exists), the timezone (`auto` uses the computer's) and how often to check Foundry.
4. Installs the bot under `C:\Program Files\FoundryVTT Discord integration`, writes the configuration to `C:\ProgramData\FoundryVTT Discord integration\.env` and registers a Scheduled Task *FoundryVTT Discord integration* that starts the bot at boot (as SYSTEM, without anyone logging in) and restarts it if it stops.

The Start menu folder has shortcuts to **Edit configuration** (stop and start the task afterwards in Task Scheduler), **Check configuration**, and **Run bot in a window (log)** for watching the log live. Running a newer setup upgrades in place and keeps the configuration; uninstalling asks whether to delete it.

Silent install, for scripts:

```
setup.exe /VERYSILENT /SUPPRESSMSGBOXES /DiscordToken=<token> /ClientId=<application id> [/GuildId=<server id>] ^
  [/FoundryUrl=http://localhost:30000] [/DataPath="C:\Users\me\AppData\Local\FoundryVTT"] [/Timezone=Europe/Stockholm] [/Interval=30]
```

and `unins000.exe /VERYSILENT [/PurgeConfig=1]` to remove it again.

If you prefer not to use the setup wizard, the `-windows.zip` bundle contains the same files plus `deploy\windows\install-task.ps1`, which registers the scheduled task from an elevated PowerShell (`-RunAsUser` runs it as a specific account instead of SYSTEM). [NSSM](https://nssm.cc) also works if you want a real Windows service.

## 4. Configuration reference

All settings live in `.env` (`/opt/foundryvtt-discord-integration/.env` on Linux, `C:\ProgramData\FoundryVTT Discord integration\.env` on Windows). The installers write it for you; this is what the values mean:

```
DISCORD_TOKEN=<bot token>
DISCORD_CLIENT_ID=<application id>
DISCORD_GUILD_ID=<server id, optional>
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

`DISCORD_GUILD_ID` makes slash commands appear immediately instead of after up to an hour. (Right-click your server → *Copy Server ID*; needs *Developer Mode* under Discord's *Advanced* settings.) The remaining variables are described in the [README](../README.md#configuration).

Check a configuration by hand: `node scripts/check-config.js [--env <file>]` validates it, probes Foundry and counts the installed systems and modules without touching Discord.

Running from source instead of an installer: `npm ci`, copy `.env.example` to `.env`, fill it in, `npm start`.

## 5. Set up channels in Discord

In your Discord server (as an administrator):

1. In the channel where you want everything by default: `/channel set type:default`
2. Optionally send specific kinds elsewhere, e.g. `/channel set type:updates channel:#foundry-updates`
3. `/channel mention role:@GM` to ping a role when Foundry goes down unexpectedly.
4. `/restart-window set start:04:00 duration:15` if Foundry restarts on a schedule.
5. `/test-message type:status` to confirm the bot can post there.

The bot must be able to **view** and **send messages** in each chosen channel (check the channel's permissions for the bot's role).

### Permissions, reinstalling and removing the bot

- Permissions can be changed after the bot has joined: *Server Settings → Roles →* the bot's role (or a channel's permission overrides). No reinstall is needed. The bot checks its permissions at startup and whenever its role or a channel changes, and if something is missing it says so **once** in the server's `status` channel (falling back to the `default` channel). Set one with `/channel set type:status`.
- The one thing editing permissions cannot fix is a bot added **without the `applications.commands` scope**. The bot detects that and posts the invite link in the status channel; an administrator opens it and authorises again (the bot does not have to be removed first).
- The settings of a server (channels, mention role, game master role, campaigns, planned sessions, open polls) are kept in `state.json`, keyed by the server. They are **not** deleted when the bot is removed, so inviting it back restores everything and there is nothing to set up again. Deleting `state.json` or the data folder does reset it.

## Upgrading

Run the installer for the new version (the Linux one-liner, or the new `setup.exe`). Both upgrade in place and keep `.env` and the data folder, whose `state.json` remembers your channels, windows and which updates were already announced.

## Troubleshooting

- **Slash commands do not appear**: global commands can take up to an hour. Set `DISCORD_GUILD_ID` for instant registration, or run `node scripts/register-commands.js`. The bot must have been invited with the `applications.commands` scope.
- **"Only server administrators can use this command"**: configuration commands require the *Administrator* permission in that server.
- **Foundry shows as down but is running**: check `FOUNDRY_URL`. Use the local address (`http://localhost:30000`), not a public hostname behind a proxy that might need authentication. `curl http://localhost:30000/api/status` should return JSON.
- **No update messages**: `FOUNDRY_DATA_PATH` must point at the user data folder and be readable by the user the bot runs as. `/updates list` shows what the bot sees. The first scan is silent on purpose.
- **Nothing is posted**: `/channel list` shows the routing; `/test-message` tests a channel. Look at the log (`journalctl -u foundryvtt-discord-bot` on Linux, *Run bot in a window* from the Start menu on Windows).
- **Windows: the task is there but the bot is not running**: open Task Scheduler and look at the task's *Last Run Result*; run *Check configuration* from the Start menu. If Node.js was installed during setup and the bot still does not start, reboot once so the new PATH is picked up by the task.
