# Installing the bot

The bot runs on the **same machine as Foundry VTT** so it can reach Foundry on its local address and read Foundry's data folder. It needs **Node.js 20 or newer**.

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it, for example, "Foundry".
2. **General Information** → copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. **Bot** → click **Reset Token**, copy the token. This is `DISCORD_TOKEN`. Treat it like a password.
4. Still under **Bot** → *Privileged Gateway Intents*, **turn on *Server Members Intent*** and save (leave *Presence* and *Message Content* off). The bot uses it to find each server's administrators for the [update notice](#update-notices). It is only requested when `UPDATE_NOTIFY` is `admins` (the default). **Without it Discord refuses the connection**: the bot logs `Discord refused the connection: the "Server Members Intent" is not enabled for this bot …` and stops (exit code 2) until you enable it.
5. **Installation** → under *Install Link* choose *Discord Provided Link*, and under *Default Install Settings → Guild Install* add the scopes `applications.commands` and `bot`, with these bot permissions: **View Channels**, **Send Messages**, **Send Messages in Threads**, **Embed Links** and, if you want the bot to ping a role, **Mention @everyone, @here and All Roles** (or make that role mentionable).
6. Open the install link in your browser and add the bot to your server.

If you prefer to build the invite link yourself:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION ID>&scope=bot+applications.commands&permissions=274878057472
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
  [--url http://localhost:30000] [--timezone Europe/Stockholm] [--interval 30] [--no-start] [--auto-update]
```

Afterwards:

```
sudo systemctl status foundryvtt-discord-bot     # running?
sudo journalctl -u foundryvtt-discord-bot -f     # live log
sudo nano /opt/foundryvtt-discord-integration/.env && sudo systemctl restart foundryvtt-discord-bot
sudo /opt/foundryvtt-discord-integration/deploy/linux/install.sh --uninstall [--purge]
```

Running the installer again upgrades in place and keeps your `.env` and `data/` folder. The installer also asks whether to install new releases automatically (off unless you say yes; see [Automatic updates](#automatic-updates)). If Foundry itself runs under systemd, you can make the bot wait for it by adding `After=foundry.service` (your unit's name) to `/etc/systemd/system/foundryvtt-discord-bot.service`.

## 3. Install on Windows (setup wizard)

Download `foundryvtt-discord-integration-<version>-setup.exe` from the [latest release](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest) and run it. The wizard:

1. Checks for Node.js 20 or newer and offers to download and install Node.js LTS if it is missing.
2. Asks for the Discord bot token, application ID and (optional) server ID.
3. Asks for the Foundry URL, Foundry's user data folder (pre-filled with `%LOCALAPPDATA%\FoundryVTT` when it exists), the timezone (`auto` uses the computer's) and how often to check Foundry.
4. Offers *Install new releases automatically* (unchecked by default; see [Automatic updates](#automatic-updates)).
5. Installs the bot under `C:\Program Files\FoundryVTT Discord integration`, writes the configuration to `C:\ProgramData\FoundryVTT Discord integration\.env` and registers a Scheduled Task *FoundryVTT Discord integration* that starts the bot at boot (as SYSTEM, without anyone logging in) and restarts it if it stops.

The Start menu folder has shortcuts to **Edit configuration** (stop and start the task afterwards in Task Scheduler), **Check configuration**, and **Run bot in a window (log)** for watching the log live. Running a newer setup upgrades in place and keeps the configuration; uninstalling asks whether to delete it.

Silent install, for scripts:

```
setup.exe /VERYSILENT /SUPPRESSMSGBOXES /DiscordToken=<token> /ClientId=<application id> [/GuildId=<server id>] ^
  [/FoundryUrl=http://localhost:30000] [/DataPath="C:\Users\me\AppData\Local\FoundryVTT"] [/Timezone=Europe/Stockholm] [/Interval=30] [/AutoUpdate=1]
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

## Upgrading

Run the installer for the new version (the Linux one-liner, or the new `setup.exe`). Both upgrade in place and keep the data folder, whose `state.json` remembers your channels, windows and which updates were already announced, and the settings in `.env` (they rewrite the file from the settings they know, so comments and settings the installer does not ask about are reset; [automatic updates](#automatic-updates) keep the file exactly). Or let the bot update itself: see [Automatic updates](#automatic-updates).

## Automatic updates

Off by default. When turned on, the machine checks GitHub once a day for a newer release of the bot and installs it the same way as a manual upgrade, then restarts the bot. Nothing happens when the installed version is current; only a strictly newer full release is installed (drafts and pre-releases are ignored).

Each run:

1. asks `https://api.github.com/repos/dxcufgb/FoundryVTT-discord-integration/releases/latest` for the latest release and compares its version with the installed one (semantic versioning);
2. downloads the bundle for this platform (`-linux.tar.gz`, `-setup.exe`, or `-windows.zip` for an installation made from the zip) and checks its SHA-256 against the release's `SHA256SUMS.txt` / `SHA256SUMS-setup.txt` (no checksum, no update);
3. installs it with the release's own installer (`install.sh --non-interactive --no-start` on Linux, `setup.exe /VERYSILENT` on Windows; a zip installation gets the new files copied over the old ones);
4. puts `.env` back exactly as it was (the installers rewrite it from the settings they know, so comments and extra settings would otherwise be lost); `data/` is never touched;
5. restarts the bot. If the installer fails, or the bot was running before and does not stay up afterwards, the previous version is restored (Linux and zip installations; a failed `setup.exe` undoes its own changes).

Only one update runs at a time, every request uses HTTPS with a timeout, and nothing is written into Foundry's folders.

**Linux** (a systemd timer, `foundryvtt-discord-bot-update.timer`, daily with up to an hour of random delay; the update runs as root because it runs the installer):

```
sudo /opt/foundryvtt-discord-integration/deploy/linux/install.sh --enable-auto-update     # turn on
sudo /opt/foundryvtt-discord-integration/deploy/linux/install.sh --disable-auto-update    # turn off
sudo /opt/foundryvtt-discord-integration/deploy/linux/auto-update.sh --check              # is there a newer release?
sudo /opt/foundryvtt-discord-integration/deploy/linux/auto-update.sh                      # update now
sudo systemctl start foundryvtt-discord-bot-update                                        # update now, as the timer does
sudo journalctl -u foundryvtt-discord-bot-update                                          # what it did
systemctl list-timers foundryvtt-discord-bot-update.timer                                 # when it runs next
```

Or answer *yes* to the installer's question, or pass `--auto-update` (`--no-auto-update` turns it off) to an unattended install. Re-running the installer keeps the current choice. The updater runs as root, so the installer makes the program files root-owned (only `data/` and `.env` belong to the bot's account), and both turning it on and every run refuse an install folder, file or parent folder that another account can change, such as an in-place install from a checkout in your home folder. The same goes for the Node.js the bot runs with: install it system-wide (distribution packages or NodeSource), not with nvm in a home folder, or turning on automatic updates is refused.

**Windows** (a Scheduled Task, *FoundryVTT Discord integration update*, daily around 04:00 with up to an hour of random delay, running as SYSTEM):

- tick *Install new releases automatically* in the setup wizard, or pass `/AutoUpdate=1` (`/AutoUpdate=0` turns it off) to a silent install. A newer setup keeps the current choice;
- or, from an elevated PowerShell in `C:\Program Files\FoundryVTT Discord integration`:

  ```
  .\deploy\windows\auto-update.ps1 -Enable     # turn on
  .\deploy\windows\auto-update.ps1 -Disable    # turn off
  .\deploy\windows\auto-update.ps1 -Check      # is there a newer release?
  .\deploy\windows\auto-update.ps1             # update now
  ```

  For a zip installation, `install-task.ps1 -AutoUpdate` turns it on as well. Because the task runs as SYSTEM, `-Enable` refuses a folder that non-administrators can change; install under Program Files. If the bot task of a setup.exe installation was re-registered to run as another account (`install-task.ps1 -RunAsUser`), the updater refuses to run setup.exe, which would register it as SYSTEM again; update that installation by hand.

The log is `C:\ProgramData\FoundryVTT Discord integration\auto-update.log`. Uninstalling removes the task (Windows) or the timer (Linux).

**GitHub token (optional).** The repository is public, so no token is needed. GitHub allows 60 anonymous API requests an hour per IP address, which a daily check never gets near. For a private fork, or behind a shared address that runs out, put a token that can read the repository's releases in `/etc/foundryvtt-discord-integration/github-token` (owned by root, `chmod 600`) or `C:\ProgramData\FoundryVTT Discord integration\github-token` (the updater restricts it to Administrators and SYSTEM). It is only ever sent to `api.github.com`, never to the download servers, and never logged.

## Update notices

When the bot starts on a newer version than it ran before (after an automatic or a manual upgrade), it sends one direct message to each server administrator: the owner and every member with the *Administrator* permission of each server the bot is in, one message per person listing their servers. It contains the changelog of the new version (the GitHub release notes when the auto-updater installed it, otherwise the version's section of the installed `CHANGELOG.md`) and a link to the release. Each version is announced at most once; the very first start only records the version. Members who do not accept direct messages from server members are skipped (logged).

`UPDATE_NOTIFY` in `.env` chooses who gets it: `admins` (default), `owner` (only server owners) or `off`. Finding the administrators needs the *Server Members Intent* (see step 1.4); with `admins` the bot cannot log in without it. `owner` and `off` do not request the intent.

## Troubleshooting

- **Slash commands do not appear**: global commands can take up to an hour. Set `DISCORD_GUILD_ID` for instant registration, or run `node scripts/register-commands.js`. The bot must have been invited with the `applications.commands` scope.
- **"Only server administrators can use this command"**: configuration commands require the *Administrator* permission in that server.
- **Foundry shows as down but is running**: check `FOUNDRY_URL`. Use the local address (`http://localhost:30000`), not a public hostname behind a proxy that might need authentication. `curl http://localhost:30000/api/status` should return JSON.
- **No update messages**: `FOUNDRY_DATA_PATH` must point at the user data folder and be readable by the user the bot runs as. `/updates list` shows what the bot sees. The first scan is silent on purpose.
- **"Discord refused the connection: the "Server Members Intent" is not enabled"**: enable it in the Developer Portal (your application → **Bot** → *Privileged Gateway Intents* → *Server Members Intent* → Save) and start the bot again (`sudo systemctl restart foundryvtt-discord-bot`, or start the task in Task Scheduler).
- **Nothing is posted**: `/channel list` shows the routing; `/test-message` tests a channel. Look at the log (`journalctl -u foundryvtt-discord-bot` on Linux, *Run bot in a window* from the Start menu on Windows).
- **Windows: the task is there but the bot is not running**: open Task Scheduler and look at the task's *Last Run Result*; run *Check configuration* from the Start menu. If Node.js was installed during setup and the bot still does not start, reboot once so the new PATH is picked up by the task.
