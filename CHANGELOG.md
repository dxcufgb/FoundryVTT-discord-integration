# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org).

## [Unreleased]

### Security

- Configuration errors no longer print the rejected values (a `FOUNDRY_URL` with a password in it ended up in the log in clear text), and `npm run register-commands` prints only Discord's status, code and message instead of the whole error object. Fixes the three CodeQL "clear-text logging of sensitive information" alerts.

### Added

- One-line Linux install shared by the bots: `curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundryvtt-discord-integration` (see [docs/INSTALL.md](docs/INSTALL.md#2-install-on-linux-guided-installer)).
- **Voice channel for session events.** A campaign can have a default voice channel (`/campaign voice-channel`, or `voice-channel` on `/campaign create` and `/campaign edit`); the Discord event of a planned session is then held there. Without one, whoever plans the session is asked to pick one of the server's voice channels or skip, and after a pick whether to make it the campaign's default (declining shows how to set it later). `/campaign show` lists it.
- `/session set` now also creates the Discord scheduled event, like a decided planning poll. Planning again moves the event the bot created for the previous date instead of adding another one.
- Planning polls: every date is now a button with its vote count (tap to vote, tap again to take it back) instead of a drop-down list, plus a **Toggle all dates** button that votes for every date or withdraws all your votes. A poll now offers up to 20 dates (was 25) so the buttons fit one message; polls posted earlier keep their menu.
- `/session set` now also writes the date to the world's `world.json` (`nextSession`), like a decided planning poll; the reply says if that failed. `/session event` and `/session clear` leave `world.json` alone.
- **Automatic updates (opt-in, off by default).** A daily check of the latest GitHub release; when it is newer than the installed version (semantic versioning; drafts and pre-releases are ignored) the bundle for the platform is downloaded, its SHA-256 checked against the release's checksum file, and it is installed the same way as a manual upgrade, then the bot is restarted. `.env` is restored byte for byte and `data/` is never touched; if the installer fails or the bot does not come back up, the previous version is restored, and the rollback itself is verified (each restore step, and that the bot runs again if it was running): a failed rollback logs `ROLLBACK FAILED: …` with manual recovery steps, keeps the backup and exits with an error. Linux: a systemd timer and service (`foundryvtt-discord-bot-update`), turned on with the installer's new question, `--auto-update`, or `install.sh --enable-auto-update` (`--disable-auto-update` turns it off); `deploy/linux/auto-update.sh --check` reports without installing. Windows: a Scheduled Task running as SYSTEM, turned on with the setup wizard's new *Install new releases automatically* checkbox (unchecked by default), `/AutoUpdate=1`, `install-task.ps1 -AutoUpdate` or `deploy\windows\auto-update.ps1 -Enable` (`-Disable`, `-Check`); log in `C:\ProgramData\FoundryVTT Discord integration\auto-update.log`. Re-running an installer keeps the current choice; uninstalling removes the timer or task. An optional GitHub token file is supported for private forks. On Linux the installer now makes the program files root-owned, and the root updater refuses to run from a folder another account can change; on Windows it refuses to run setup.exe when the bot task runs as an account other than SYSTEM. See [docs/INSTALL.md](docs/INSTALL.md#automatic-updates).
- **Update notice by direct message.** When the bot starts on a newer version than it ran before, it sends one DM per person to the owner and every Administrator of each server it is in, listing their servers, with the changelog of the new version (the GitHub release notes when the auto-updater installed it, otherwise the section of the installed `CHANGELOG.md`) and a link to the release. Announced at most once per version; the first start only records the version. New setting `UPDATE_NOTIFY` = `admins` (default), `owner` or `off`.
- **Planning polls** (`/planning-poll campaign:<name>`; the Discord event is three hours long): pick candidate dates, the bot posts a poll tagging the DM and the players, and they vote. **Decide date** offers the dates with the most votes, then a time; the bot creates a Discord scheduled event, announces it in the poll's channel and sets the campaign's next session. **Delete poll** removes it. For administrators, the campaign's DM and the new game master role.
- Planning polls also set the world's `nextSession` in its `world.json` (the only write the bot makes to Foundry's folders; atomic, one key, layout kept).
- **Permission check**: at startup and when the bot's role or a channel changes, the bot checks the permissions it needs (View Channels, Send Messages, Send Messages in Threads, Embed Links, Create Events) and announces what is missing once in the status channel. A server where the bot was added without the `applications.commands` scope gets a reinstall notice with the invite link. The invite link and `docs/INSTALL.md` now include Create Events.
- `/gm-role set|clear|show` (admin): the per-server game master role that may use `/planning-poll` for every campaign.
- `/updates available changes:true`: one message per Foundry/system/module update, each with the cumulative changelogs of the versions between the installed and the latest one, kept within Discord's message size limit.

### Changed

- **Releases.** A release is made with *Actions → Release → Run workflow* and the version (`1.2.3`; `1.2.3-rc.1` makes a pre-release); the version comes from the tag and is stamped into the bundles, so nothing is bumped in the code. The workflow runs the full CI, builds every file and publishes the release only when all of it worked (a draft first, so the setup.exe no longer appears minutes after the rest). Publishing a release `vX.Y.Z` by hand on GitHub still works: the files are attached afterwards. Pushing a tag no longer starts a release. Notes come from the version's `CHANGELOG.md` section, else GitHub's generated notes. See [docs/RELEASING.md](docs/RELEASING.md).
- **Release files.** Besides `foundryvtt-discord-integration-X.Y.Z-linux.tar.gz`, `-windows.zip`, `-setup.exe` and `install.sh`, each release now has the same archives and setup under fixed names (`foundryvtt-discord-integration-linux.tar.gz`, `-windows.zip`, `-setup.exe`, for links that never change) and one `SHA256SUMS.txt` for every file. The Linux archive has `install.sh` at its top: `tar xzf foundryvtt-discord-integration-linux.tar.gz && cd foundryvtt-discord-integration-X.Y.Z && sudo ./install.sh`. The archives are reproducible. `SHA256SUMS-setup.txt` is still attached for installations up to v1.3.2.
- **Automatic updates** verify the Windows setup.exe with `SHA256SUMS.txt` (falling back to `SHA256SUMS-setup.txt` only for releases up to v1.3.2, which listed it only there).
- **Linux installer options** shared with the other bots: `--yes`/`-y` (same as `--non-interactive`), `--check-update` (exit 0 = up to date, 10 = newer release available, other = error), `--update-now` (installs the latest release with the auto-updater), and a `--help` listing the common options first. Every existing option keeps working. When `INSTALL_GITHUB_TOKEN` is set (the `dxcufgb/install` one-liner exports it for private repositories) and automatic updates are turned on, the token is stored as the updater's token file if there is none yet (asked first when interactive). `deploy/linux/auto-update.sh --check-update` is the check with that exit code; `--check` is unchanged.
- The `install.sh` one-liner (`…/releases/latest/download/install.sh | sudo bash`) now checks the downloaded archive against the release's `SHA256SUMS.txt`, and `--version` accepts `1.2.3` as well as `v1.2.3`.
- **Recommended: enable the *Server Members Intent*.** With the default `UPDATE_NOTIFY=admins` the bot now asks Discord for the privileged Server Members intent (to find each server's administrators for the update notice; `owner` and `off` do not request it). Turn it on in the Developer Portal (your application → **Bot** → *Privileged Gateway Intents* → *Server Members Intent*). Without it the bot still starts: it logs one warning (how to enable the intent, or set `UPDATE_NOTIFY=owner` to silence it), connects again without the intent and sends update notices to server owners only. If the intent is turned off while the bot is running, the bot exits so the service restarts it in that mode.
- The systemd unit no longer restarts the bot on exit code 2 (a configuration error such as a bad `.env`, where restarting does not help).
- Windows install scripts print with `Write-Output` instead of `Write-Host`, and CI now runs PSScriptAnalyzer on `deploy/windows` and shellcheck on `deploy/linux`.

## [1.2.1] - 2026-10-05

### Fixed

- `/campaign create` and `/campaign edit`: a world suggestion such as `DND-Online (dnd-online)` is now reduced to just its id (`dnd-online`) if the label is submitted instead of the suggestion's value.

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

[Unreleased]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.1.0
[1.0.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.0.0
