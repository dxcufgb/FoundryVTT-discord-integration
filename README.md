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
| **session** | A **campaign**'s world comes up (🎲 *The world is ready to join*, tagging the campaign's players), and 15 minutes before a planned session when that world is *not* running (⏰ tagging the DM). |

On request (slash commands, nothing is posted automatically) the bot also looks **outward and inward**:

- `/updates available` asks foundryvtt.com which newer versions exist and shows only those that fit the **installed Foundry major version** (v13 today): current version → latest compatible version, per system and module. Packages that have nothing new for your Foundry are left out. For Foundry itself it shows both a newer build of the installed major version *and* a newer major version when one is out.
- `/updates compatibility` answers "could I upgrade to the next major Foundry?" by checking every installed system and module against that version: ready, needs an update first, untested, not ready, unknown.
- `/modules unused` lists the installed modules that **no world on the server has enabled**, read straight from each world's settings database; `/modules usage` shows the active-module count per world or where one module is used.

Each message type can go to its own channel, several types can share a channel, and a **default** channel catches anything without its own. The bot can sit in more than one Discord server; channels are configured per server.

**Campaigns** bind Discord users to worlds: each campaign belongs to one Discord server, is connected to exactly one Foundry world and has exactly one **DM**; any number of server members can be its players, and a member can be in any number of campaigns. The DM (or an administrator) plans the next session with a date and time, or by pasting a link to a Discord scheduled event, whose start time is taken over.

Everything is configured from Discord with slash commands. Configuration commands are only available to members with the **Administrator** permission; `/status`, `/updates list|available|compatibility`, `/modules`, `/campaign list|show|join|leave` and `/session show` can be used by everyone.

## How it works

- Every 30 seconds (configurable) the bot calls Foundry's status endpoint `GET /api/status` on `FOUNDRY_URL` (default `http://localhost:30000`). That endpoint needs no login and works while Foundry shows the setup screen, so it tells the bot whether Foundry is up, which version it runs and which world is active.
- Foundry counts as *down* after two failed checks in a row (configurable), so a single slow answer does not cause an alert.
- Every five minutes, and whenever Foundry comes back up, the bot reads the `system.json` / `module.json` manifests under Foundry's user data folder (`FOUNDRY_DATA_PATH`) and compares versions with what it saw last time. The first scan only records what is installed; nothing is announced until something changes.
- `/updates available` and `/updates compatibility` fetch each installed package's record from the foundryvtt.com package API (`/_api/packages/get?id=…`, which lists every published version with its compatibility declaration), falling back to the package's own `manifest` URL, and read the release list at `https://foundryvtt.com/releases/`. Answers are cached for 30 minutes. The compatibility verdicts are only as good as what package authors declare in their manifests.
- `/modules unused` reads the active-module list (`core.moduleConfiguration`) from every world's settings database (`Data/worlds/<id>/data/settings`, LevelDB in Foundry v11+; the older NeDB `settings.db` is understood too) with a small read-only reader of the on-disk files, so it works while Foundry is running and without any native dependency.
- After every poll the bot looks at the campaigns' planned sessions. 15 minutes before one, if Foundry is down, on the setup screen or running another world, it tags the campaign's DM once. When the monitor sees a world start, every campaign bound to that world (in every server) gets a message tagging its players.
- Settings, campaigns and the list of already announced updates live in `data/state.json` next to the bot. Writes are atomic, so a crash cannot corrupt it.

## Installation

Full guide: **[docs/INSTALL.md](docs/INSTALL.md)**. In short, after creating a Discord application and bot at <https://discord.com/developers/applications> (you need its **Application ID** and **bot token**, and must turn on **Server Members Intent** under *Bot → Privileged Gateway Intents*, or Discord refuses the bot's connection, unless you set `UPDATE_NOTIFY` to `owner` or `off`):

**Linux** (on the machine that runs Foundry):

```
curl -fsSL https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest/download/install.sh | sudo bash
```

The guided installer checks for Node.js, finds your running Foundry server to suggest its user, port and data folder, asks for the Discord token and IDs, and installs a systemd service. It also has a `--non-interactive` mode for scripted installs.

**Windows:** download `foundryvtt-discord-integration-<version>-setup.exe` from the [latest release](https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/latest) and run it. The wizard installs Node.js if needed, asks the same questions and registers a Scheduled Task that runs the bot at boot. Silent installs take the answers as `/DiscordToken=… /ClientId=…` parameters.

**Automatic updates** (opt-in, off by default): both installers offer to check GitHub once a day and install a newer release the same way as a manual upgrade, keeping `.env` and the data folder and rolling back if the update fails. Turn it on or off later with `sudo …/deploy/linux/install.sh --enable-auto-update` / `--disable-auto-update` or `deploy\windows\auto-update.ps1 -Enable` / `-Disable`; see [Automatic updates](docs/INSTALL.md#automatic-updates).

Then, in Discord, run `/channel set type:default` in the channel where messages should go, and fine-tune with the commands below.

Running from source: `npm ci`, copy `.env.example` to `.env` and fill it in, `npm start`.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/status` | everyone | Is Foundry up, which version and world, users online, next restart window. |
| `/channel set type channel` | admins | Post one kind of message (`default`, `status`, `world`, `updates`, `restart`, `session`) in a channel. |
| `/channel clear type` · `/channel list` | admins | Stop posting a kind of message / show the current routing. |
| `/channel mention role` | admins | Role to ping when Foundry goes down unexpectedly. |
| `/monitor enable|disable what` | admins | Turn `status`, `world`, `updates` or `all` monitoring on or off. |
| `/monitor show` · `/monitor check` | admins | Show monitor settings / check Foundry right now. |
| `/restart-window set start duration [days] [timezone] [grace] [announce]` | admins | Expected restart, e.g. `start:04:00 duration:15 days:daily`. |
| `/restart-window show` · `/restart-window clear` | admins | Show the window and its next opening / remove it. |
| `/updates list [type]` | everyone | Installed systems and modules with versions. |
| `/updates available [type]` | everyone | Newer Foundry builds (same major version and the next major version) and the newest system/module versions compatible with the installed Foundry. Only packages with an update are shown. |
| `/updates compatibility [generation]` | everyone | Would the installed systems and modules work on the next major Foundry version (or the one given)? |
| `/updates check` · `/updates settings` · `/updates reset` | admins | Scan now / choose what counts as an update / take the current versions as a fresh starting point. |
| `/modules unused` | everyone | Installed modules that are not enabled in any world. |
| `/modules usage [module]` | everyone | Active modules per world, or the worlds that use one module. |
| `/campaign create name world dm [channel]` | admins | Create a campaign: one Foundry world, one DM. `world` and `campaign` options autocomplete. |
| `/campaign edit` · `/campaign delete` | admins | Change name, world, DM or channel / remove a campaign. |
| `/campaign add-player` · `/campaign remove-player` | DM or admins | Manage the players of a campaign. |
| `/campaign join` · `/campaign leave` · `/campaign list` · `/campaign show` | everyone | Join or leave a campaign; see campaigns, their DM, players and next session. |
| `/session set campaign when [timezone]` | DM or admins | Next session at a date and time, e.g. `when:2026-10-12 19:00` or `tomorrow 19:00`. |
| `/session event campaign link` | DM or admins | Take the next session's time from a Discord scheduled event. |
| `/session clear` · `/session show [campaign]` | DM or admins · everyone | Remove the planned session / show the next session(s). |
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
| `FOUNDRY_WEBSITE_URL` | `https://foundryvtt.com` | Where `/updates available` and `/updates compatibility` look up packages and releases. Only change it for a mirror. |
| `BOT_DATA_DIR` | `./data` | Where `state.json` is kept. |
| `POLL_INTERVAL_SECONDS` | `30` | How often Foundry is checked (minimum 5). |
| `DOWN_AFTER_FAILURES` | `2` | Failed checks in a row before Foundry counts as down. |
| `TIMEZONE` | `UTC` | Default timezone for restart windows (IANA name, e.g. `Europe/Stockholm`). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `UPDATE_NOTIFY` | `admins` | Who gets a direct message with the changelog after the bot was updated: `admins` (owner and every Administrator of each server), `owner` or `off`. |

`npm run check-config` validates `.env`, probes Foundry, counts the installed packages and worlds and tells how many modules no world uses, without touching Discord. The bot looks for `.env` next to `package.json`; `--env <file>` or `FOUNDRY_DISCORD_ENV_FILE` point it elsewhere (the Windows installer keeps it under `%ProgramData%\FoundryVTT Discord integration`).

## Development

```
npm ci
npm test            # unit tests (node:test, no extra tooling)
npm start           # run the bot with the .env in this folder
```

Tests cover the configuration loader, the state store, restart-window maths (including DST and windows that cross midnight), update detection and the announce-once guarantee, the up/down state machine, message routing, the administrator check on commands, the LevelDB reader (against databases written by Foundry's own LevelDB binding, see `scripts/make-leveldb-fixtures.js`), world/module usage, the compatibility and update logic (with a fake foundryvtt.com), campaigns and the session reminders (time parsing in a timezone, Discord event links, the 15-minute world check, world-ready pings), and the self-updater's release check (semantic version order, asset choice, checksum parsing and verification, the token staying on api.github.com, with a fake GitHub). CI runs them on Linux and Windows with Node 20 and 22, runs the Linux installer against a real systemd (including an automatic update to the latest release through the systemd timer's service), and compiles, silently installs, auto-updates and uninstalls the Windows setup.

Releases: see **[docs/RELEASING.md](docs/RELEASING.md)**.

## License

[MIT](LICENSE)
