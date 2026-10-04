# Foundry VTT Discord integration

A small Discord bot that watches a [Foundry VTT](https://foundryvtt.com) **v13** server running on the same machine and tells your Discord server what is going on.

**Foundry VTT:** v13 · **Node.js:** 20 or newer · **Discord:** slash commands, no message content access needed

## What it does

| Message type | Posted when |
| --- | --- |
| **status** | Foundry stops answering (🔴 *Foundry is down*) and when it answers again (🟢 *Foundry is back up*, with the downtime). Optionally pings a role on unexpected downtime. |
| **restart** | A **restart window** is set (for example 04:00–04:15 every day). Downtime inside the window is reported calmly as a restart. If Foundry is still down when the window (plus a grace period) has passed, the bot raises ⚠️ *Foundry did not come back*. Optionally announces when the window opens. |
| **world** | A world is launched (🌍 *World started*, with the world's title and game system), switched, or returned to the setup screen. |
| **updates** | Foundry itself, an installed **system** or an installed **module** changes version (also newly installed and removed packages, if wanted). **Every update is announced exactly once**, even across bot restarts. |

Each message type can go to its own channel, several types can share a channel, and a **default** channel catches anything without its own. The bot can sit in more than one Discord server; channels are configured per server.

Everything is configured from Discord with slash commands. Configuration commands are only available to members with the **Administrator** permission; `/status` and `/updates list` can be used by everyone.

## How it works

- Every 30 seconds (configurable) the bot calls Foundry's status endpoint `GET /api/status` on `FOUNDRY_URL` (default `http://localhost:30000`). That endpoint needs no login and works while Foundry shows the setup screen, so it tells the bot whether Foundry is up, which version it runs and which world is active.
- Foundry counts as *down* after two failed checks in a row (configurable), so a single slow answer does not cause an alert.
- Every five minutes, and whenever Foundry comes back up, the bot reads the `system.json` / `module.json` manifests under Foundry's user data folder (`FOUNDRY_DATA_PATH`) and compares versions with what it saw last time. The first scan only records what is installed; nothing is announced until something changes.
- Settings and the list of already announced updates live in `data/state.json` next to the bot. Writes are atomic, so a crash cannot corrupt it.

## Installation

Short version (full instructions with screenshots-level detail in **[docs/INSTALL.md](docs/INSTALL.md)**):

1. Create a Discord application and bot at <https://discord.com/developers/applications>, copy the **bot token** and the **application ID**, and invite the bot to your server with the `bot` and `applications.commands` scopes.
2. Download the latest release bundle for your platform from the [Releases page](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest) and extract it on the machine that runs Foundry.
3. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `FOUNDRY_DATA_PATH`.
4. Install it as a service:
   - **Linux:** `sudo ./deploy/linux/install.sh --user <user that runs Foundry>`
   - **Windows:** in an elevated PowerShell, `.\deploy\windows\install-task.ps1`
5. In Discord, run `/channel set type:default` in the channel where messages should go, then fine-tune with the commands below.

Running from source instead of a release bundle: `npm ci`, fill in `.env`, `npm start`.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/status` | everyone | Is Foundry up, which version and world, users online, next restart window. |
| `/channel set type channel` | admins | Post one kind of message (`default`, `status`, `world`, `updates`, `restart`) in a channel. |
| `/channel clear type` · `/channel list` | admins | Stop posting a kind of message / show the current routing. |
| `/channel mention role` | admins | Role to ping when Foundry goes down unexpectedly. |
| `/monitor enable|disable what` | admins | Turn `status`, `world`, `updates` or `all` monitoring on or off. |
| `/monitor show` · `/monitor check` | admins | Show monitor settings / check Foundry right now. |
| `/restart-window set start duration [days] [timezone] [grace] [announce]` | admins | Expected restart, e.g. `start:04:00 duration:15 days:daily`. |
| `/restart-window show` · `/restart-window clear` | admins | Show the window and its next opening / remove it. |
| `/updates list [type]` | everyone | Installed systems and modules with versions. |
| `/updates check` · `/updates settings` · `/updates reset` | admins | Scan now / choose what counts as an update / take the current versions as a fresh starting point. |
| `/test-message type` | admins | Post a test message to see where a type ends up. |

Details for every command and option: **[docs/COMMANDS.md](docs/COMMANDS.md)**.

## Configuration

All settings are environment variables, read from `.env` (see [`.env.example`](.env.example)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | – | Bot token. **Required.** |
| `DISCORD_CLIENT_ID` | – | Application ID, used to register the slash commands. **Required.** |
| `DISCORD_GUILD_ID` | – | Register commands only in this server (instant). Empty = global (up to an hour). |
| `FOUNDRY_URL` | `http://localhost:30000` | Where the bot reaches Foundry. |
| `FOUNDRY_DATA_PATH` | – | Foundry's user data folder (contains `Config/`, `Data/`, `Logs/`). Needed for system/module update tracking and world titles. |
| `FOUNDRY_APP_PATH` | – | Foundry's install folder; lets the bot read the Foundry version while Foundry is down. |
| `BOT_DATA_DIR` | `./data` | Where `state.json` is kept. |
| `POLL_INTERVAL_SECONDS` | `30` | How often Foundry is checked (minimum 5). |
| `DOWN_AFTER_FAILURES` | `2` | Failed checks in a row before Foundry counts as down. |
| `TIMEZONE` | `UTC` | Default timezone for restart windows (IANA name, e.g. `Europe/Stockholm`). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

`npm run check-config` validates `.env`, probes Foundry and counts the installed packages without touching Discord.

## Development

```
npm ci
npm test            # unit tests (node:test, no extra tooling)
npm start           # run the bot with the .env in this folder
```

Tests cover the configuration loader, the state store, restart-window maths (including DST and windows that cross midnight), update detection and the announce-once guarantee, the up/down state machine, message routing and the administrator check on commands. CI runs them on Linux and Windows with Node 20 and 22.

Releases: see **[docs/RELEASING.md](docs/RELEASING.md)**.

## License

[MIT](LICENSE)
