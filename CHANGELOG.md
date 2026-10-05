# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org).

## [Unreleased]

## [1.2.0] - 2026-10-05

### Added

- `/updates available [type]`: asks foundryvtt.com what is new and shows only what fits the installed Foundry major version — for every system and module the installed version and the newest compatible version (packages with nothing new are left out; releases that need a different Foundry are counted separately), and for Foundry itself both a newer build of the installed major version and a newer major version when one is out, with links to the release notes.
- `/updates compatibility [generation]`: would the installed systems and modules work on the next major Foundry version (or the one given)? Sorts them into ready / update first / untested / not ready / unknown, based on what the packages declare in their installed manifests and on foundryvtt.com.
- `/modules unused` and `/modules usage [module]`: modules that no world on the server has enabled, the active-module count per world, and where one module is used. The world settings databases (LevelDB in Foundry v11+, NeDB before) are read directly and read-only, so this works while Foundry is running and needs no native dependency.
- `FOUNDRY_WEBSITE_URL` (default `https://foundryvtt.com`) for the lookups above; `npm run check-config` now also reports the worlds and unused modules.
- **Campaigns** (`/campaign`): bind Discord users to campaigns. Each campaign belongs to one Discord server, is connected to exactly one Foundry world and has exactly one DM; any number of players can join (`/campaign join`, or the DM/an administrator adds them) and a member can be in any number of campaigns. Options autocomplete with the server's campaigns and the worlds found in Foundry's data folder. Each campaign may have its own channel for session messages.
- **Session planning** (`/session`): the campaign's DM or an administrator sets the next session with a date and time (`2026-10-12 19:00`, `tomorrow 19:00`, a Discord timestamp; timezone aware) or by pasting a link to a Discord scheduled event, whose start time is taken over. `/session show` lists upcoming sessions.
- **15-minute check**: 15 minutes before a planned session the bot checks that the campaign's world is running. If Foundry is down, on the setup screen or running another world, it tags the DM once per planned time, in the campaign's channel; retried if Discord was unreachable.
- **World ready to join**: when a world starts, every campaign bound to it (in every server) gets a message tagging its players, with the planned session time if there is one.
- New message type `session` for `/channel set`, `/channel list` and `/test-message`.

### Fixed

- Linux installer: pressing Enter at the bot token prompt to keep the token from an existing `.env` ended the script silently (the prompt helper's last command was a failing test under `set -e`). It now keeps the token and continues; CI drives the interactive path on a pseudo-terminal to keep it that way.

## [1.1.0] - 2026-10-04

### Added

- Guided Linux installer (`deploy/linux/install.sh`, also attached to releases as `install.sh` for `curl | sudo bash`): downloads the latest release, checks for Node.js 20+ and offers to install it, detects the running Foundry server's user, port and data folder, asks for the Discord settings, writes `.env`, installs and starts the systemd service. `--non-interactive` for scripted installs, `--uninstall [--purge]` to remove.
- Windows installer (`setup.exe`, built with Inno Setup): wizard pages for the Discord and Foundry settings, downloads and installs Node.js LTS when missing, keeps the configuration under `%ProgramData%\FoundryVTT Discord integration`, registers the Scheduled Task, Start-menu shortcuts, silent install parameters and an uninstaller.
- `--env <file>` / `FOUNDRY_DISCORD_ENV_FILE` to point the bot at a configuration file outside its folder; on Windows the ProgramData file is found automatically.
- CI now runs the Linux installer against systemd and compiles, silently installs and uninstalls the Windows setup.

### Changed

- The release workflow attaches `install.sh` and the Windows `setup.exe` in addition to the bundles.
- `deploy/linux/uninstall.sh` was folded into `install.sh --uninstall`.

## [1.0.0] - 2026-10-04

First release, built for Foundry VTT v13.

### Added

- Up/down monitoring of a Foundry instance through its `/api/status` endpoint, with a configurable number of failed checks before Foundry counts as down, and downtime reported when it is back.
- Restart windows (`/restart-window`): expected downtime is reported as a restart, downtime that outlasts the window plus a grace period raises an alert; optional announcement when a window opens; timezone and daylight-saving aware; windows may cross midnight and be limited to certain weekdays.
- World notifications: world started, switched and returned to setup, with world title and game system.
- Update tracking for Foundry itself and for installed systems and modules (version changes, new installs, removals), each announced exactly once, surviving bot restarts and retried if Discord was unreachable.
- Per-server channel routing for five message types (`default`, `status`, `world`, `updates`, `restart`) and an optional role to ping on unexpected downtime.
- Slash commands: `/status`, `/channel`, `/monitor`, `/restart-window`, `/updates`, `/test-message`. Configuration commands are restricted to Discord administrators.
- Linux systemd installer and Windows Task Scheduler installer; release bundles for both platforms with dependencies included.
- Test suite (Node's built-in test runner) and CI on Linux and Windows.

[Unreleased]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.1.0
[1.0.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.0.0
