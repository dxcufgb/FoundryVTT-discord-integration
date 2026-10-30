# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org).

## [Unreleased]

### Changed

- **Opening a world only pings the players when a session is about to start.** The "world is ready to join" message, which tags every player of the campaigns bound to the world, is now sent only when the campaign's next session starts within 30 minutes or is already under way. Opening the world at any other time (preparation, testing) no longer pings anyone; the plain "World started" announcement is unchanged.

## [1.6.3] - 2026-10-27

### Security

- **A flood of failed logins can no longer lock the administrator out of the administration page.** After 50 failed logins from any addresses within 15 minutes the page refused every login, including the right password, so anyone who could reach the port could keep the real administrator out. Wrong passwords are still refused during such a flood and an address is still locked out for five minutes after five wrong passwords, but the right password now always gets in.
- **Manifest lookups stay off the local network.** When foundryvtt.com does not know an installed package, the bot fetches the `manifest` URL from the package's `module.json`. A package could point that at a local, private or cloud-metadata address (`localhost`, `10.x`, `192.168.x`, `169.254.169.254`, …); such URLs are now skipped.
- **World ids are checked before they become a path.** Looking up a world's title refuses an id that is `.`, `..` or contains anything but letters, digits, `.`, `-` and `_`, so an id can never point outside `Data/worlds`.
- **The LevelDB reader refuses absurd block sizes.** A damaged or crafted world database that declares a compressed block of more than 128 MB is reported as unreadable instead of the bot trying to allocate that memory.

### Added

- **The administration page has a logo and a favicon.** The d20 icon is shown at the top left on every view, the login screen included, on the login card and as the browser tab's icon. The same icon is in `assets/icon.png`; the README explains how to use it as the bot's avatar.

## [1.6.2] - 2026-10-26

### Security

- **undici updated to 6.29.1.** undici is the HTTP client discord.js uses to talk to Discord. 6.29.0, which 1.6.1 and older install, has two high-severity denial-of-service bugs: unbounded memory use in its EventSource parser ([GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685)) and an unhandled error on a response with too many content encodings ([GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)). Nothing else changes.

## [1.6.1] - 2026-10-23

### Security

- **Ids that are names of `Object.prototype` no longer reach it.** Campaign, poll, server and other ids are looked up only among the stored ones (`Object.hasOwn`), so `/campaign join campaign:__proto__` no longer crashes the command, `/campaign edit campaign:constructor …` no longer saves a broken campaign, and no id can change `Object.prototype`. A `__proto__` id is refused when saving, and a `__proto__` key in `state.json` (which the bot never writes) is ignored on loading. Existing `state.json` files load and save exactly as before.
- **The auto-updaters no longer write through links in the bot's data folder.** The data folder belongs to the bot's account, which could replace `update-notice.json` with a link to any file or folder, and the root (Linux) or SYSTEM (Windows) updater copied the release notes through it. The notes now go into a new file under a random name that is then renamed over `update-notice.json` (a rename replaces a link, not what it points at); a data folder that is itself a link, or (Linux) not owned by the bot's user, gets no notes. The Linux installer no longer follows links in `data/` when it gives the folder to the bot's user, and refuses an `.env` or `data` that is a symlink.
- **Windows: `.env` and the data folder are private.** Up to now setup.exe let every local user change `data\` (`state.json`, and `admin.json` with the administration page's password hash) and `.env` (the Discord token) inherited read access for Users from `C:\ProgramData`. The new `deploy\windows\protect-config.ps1`, run by setup.exe before it writes `.env`, by `install-task.ps1` and by every auto-update run (so existing installations are fixed by the upgrade), gives them explicit, non-inherited permissions: `.env` Administrators and SYSTEM full control and the bot task's account read; `data\` Administrators and SYSTEM full control and the bot task's account modify; the settings folder itself (logs, updater token) Administrators and SYSTEM only. Users, Everyone and Authenticated Users get nothing. *Edit configuration*, *Check configuration* and *Run bot in a window* now ask for administrator rights.

### Changed

- **Linux installer: Node.js is installed only on a real yes.** When Node.js is missing or too old and there is no terminal to ask (and no `--yes`), the installer now stops and says to install Node.js 20+ or run it again with `--yes`, instead of taking the default answer and running NodeSource's setup script as root. With a terminal it still asks; `--yes` still installs Node.js 22. It also no longer mistakes a `/dev/tty` that cannot be opened (no controlling terminal, as under cron or `setsid`) for a terminal, where a failed read counted as the default answer to every question.

## [1.6.0] - 2026-10-19

### Added

- **Administration page: edit channels and roles.** The *Servers and campaigns* page now changes each server's channel for every message type, the role pinged on unexpected downtime and the game master role, and each campaign's channel and voice channel, picked from the server's channels and roles. These are the same settings as `/channel`, `/gm-role` and `/campaign edit`. Saving warns, like those commands, when the bot lacks a permission in the chosen channel. A channel that was deleted in Discord stays selected until it is changed.

## [1.5.0] - 2026-10-19

### Added

- **Session summaries.** When a Foundry world goes back to setup, the bot posts that world's session summary, written by the Foundry module [dxcufgbs-session-summary](https://github.com/dxcufgb/FoundryVTT-session-summary), to the channel of every campaign bound to the world. Only sessions that ended within the last 24 hours, never a mid-session export, each one once per channel (a failed post is retried the next time the world stops), oldest first. A campaign without a channel gets nothing. Works with world announcements turned off. The new optional `SESSION_SUMMARY_DIR` points at the module's folder if it is not `session-summaries` in Foundry's Data folder; `npm run check-config` reports whether it exists. Without the module the bot works exactly as before.
- **Administration page** (optional, off by default), like the ones of the Foundry world backup and the release proxy: a password-protected HTTPS page on its own port (`ADMIN_PORT`) with an overview of Foundry, Discord and the configuration, the monitoring switches, every server's channels and campaigns, the session summary settings (on/off, age limit, recent summaries, *Post now*) and the admin password. Set the password with `npm run admin-password`. See [Administration page](README.md#administration-page).

## [1.4.2] - 2026-10-15

### Fixed

- Session events could not be created in a campaign's default voice channel: Discord also wants *View Channel* and *Connect* in that channel (a stage channel also *Manage Channels*, *Mute Members* and *Move Members*), and the invite link did not ask for *Connect*. The bot now checks those permissions first and, when they are missing or Discord refuses the voice channel, still creates the event (as an external event at the Foundry world) and says which permission is missing. The invite links (`docs/INSTALL.md`, the bot's own, and the one the Linux installer prints, which also lacked *Create Events*) now include *Connect* and *Read Message History* (needed to show a decided poll's result).
- **Missing permissions are now explained where they bite.** When the bot lacks a Discord permission for what it was asked, the reply names exactly which permission is missing, in which channel or in the server, the bot's role, and where an administrator adds it (*the channel → Edit Channel → Permissions*, or *Server Settings → Roles →* the bot's role). This covers posting a planning poll, the poll announcement and its result, creating or moving the session event, `/test-message`, and any other command Discord refuses with "Missing Permissions" (instead of "Something went wrong"). `/channel set`, `/campaign create`, `/campaign edit` and `/campaign voice-channel` still save the channel but warn when the bot cannot post or hold events there yet.

## [1.4.1] - 2026-10-12

### Fixed

- Slash commands are now updated whenever the bot is updated, by the auto-updater or by running an installer: the Linux installer, the Windows task installer (also from `setup.exe`) and the Windows zip updater register the commands of the installed version, and the bot registers them again every time it starts. A registration that fails (Discord unreachable, rate limit) is retried for a few minutes instead of waiting for the next restart, and the log says whether the commands changed. When `DISCORD_GUILD_ID` is added, changed or removed, the bot empties the set it registered before (remembered in `data/state.json` as `commands`), so the old commands no longer stay next to the new ones.

## [1.4.0] - 2026-10-12

### Added

- One-line Linux install shared by the bots: `curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundryvtt-discord-integration` (see [docs/INSTALL.md](docs/INSTALL.md#2-install-on-linux-guided-installer)).

### Changed

- **Releases.** A release is made with *Actions → Release → Run workflow* and the version (`1.2.3`; `1.2.3-rc.1` makes a pre-release); the version comes from the tag and is stamped into the bundles, so nothing is bumped in the code. The workflow runs the full CI, builds every file and publishes the release only when all of it worked (a draft first, so the setup.exe no longer appears minutes after the rest). Publishing a release `vX.Y.Z` by hand on GitHub still works: the files are attached afterwards. Pushing a tag no longer starts a release. Notes come from the version's `CHANGELOG.md` section, else GitHub's generated notes. See [docs/RELEASING.md](docs/RELEASING.md).
- **Release files.** Besides `foundryvtt-discord-integration-X.Y.Z-linux.tar.gz`, `-windows.zip`, `-setup.exe` and `install.sh`, each release now has the same archives and setup under fixed names (`foundryvtt-discord-integration-linux.tar.gz`, `-windows.zip`, `-setup.exe`, for links that never change) and one `SHA256SUMS.txt` for every file. The Linux archive has `install.sh` at its top: `tar xzf foundryvtt-discord-integration-linux.tar.gz && cd foundryvtt-discord-integration-X.Y.Z && sudo ./install.sh`. The archives are reproducible. `SHA256SUMS-setup.txt` is still attached for installations up to v1.3.2.
- **Automatic updates** verify the Windows setup.exe with `SHA256SUMS.txt` (falling back to `SHA256SUMS-setup.txt` only for releases up to v1.3.2, which listed it only there).
- **Linux installer options** shared with the other bots: `--yes`/`-y` (same as `--non-interactive`), `--check-update` (exit 0 = up to date, 10 = newer release available, other = error), `--update-now` (installs the latest release with the auto-updater), and a `--help` listing the common options first. Every existing option keeps working. When `INSTALL_GITHUB_TOKEN` is set (the `dxcufgb/install` one-liner exports it for private repositories) and automatic updates are turned on, the token is stored as the updater's token file if there is none yet (asked first when interactive). `deploy/linux/auto-update.sh --check-update` is the check with that exit code; `--check` is unchanged.
- The `install.sh` one-liner (`…/releases/latest/download/install.sh | sudo bash`) now checks the downloaded archive against the release's `SHA256SUMS.txt`, and `--version` accepts `1.2.3` as well as `v1.2.3`.

## [1.3.2] - 2026-10-11

### Added

- **Voice channel for session events.** A campaign can have a default voice channel (`/campaign voice-channel`, or `voice-channel` on `/campaign create` and `/campaign edit`); the Discord event of a planned session is then held there. Without one, whoever plans the session is asked to pick one of the server's voice channels or skip, and after a pick whether to make it the campaign's default (declining shows how to set it later). `/campaign show` lists it.
- `/session set` now also creates the Discord scheduled event, like a decided planning poll. Planning again moves the event the bot created for the previous date instead of adding another one.
- Planning polls: every date is now a button with its vote count (tap to vote, tap again to take it back) instead of a drop-down list, plus a **Toggle all dates** button that votes for every date or withdraws all your votes. A poll now offers up to 20 dates (was 25) so the buttons fit one message; polls posted earlier keep their menu.

## [1.3.1] - 2026-10-10

### Added

- `/session set` now also writes the date to the world's `world.json` (`nextSession`), like a decided planning poll; the reply says if that failed. `/session event` and `/session clear` leave `world.json` alone.

## [1.3.0] - 2026-10-10

### Added

- **Automatic updates (opt-in, off by default).** A daily check of the latest GitHub release; when it is newer than the installed version (semantic versioning; drafts and pre-releases are ignored) the bundle for the platform is downloaded, its SHA-256 checked against the release's checksum file, and it is installed the same way as a manual upgrade, then the bot is restarted. `.env` is restored byte for byte and `data/` is never touched; if the installer fails or the bot does not come back up, the previous version is restored, and the rollback itself is verified (each restore step, and that the bot runs again if it was running): a failed rollback logs `ROLLBACK FAILED: …` with manual recovery steps, keeps the backup and exits with an error. Linux: a systemd timer and service (`foundryvtt-discord-bot-update`), turned on with the installer's new question, `--auto-update`, or `install.sh --enable-auto-update` (`--disable-auto-update` turns it off); `deploy/linux/auto-update.sh --check` reports without installing. Windows: a Scheduled Task running as SYSTEM, turned on with the setup wizard's new *Install new releases automatically* checkbox (unchecked by default), `/AutoUpdate=1`, `install-task.ps1 -AutoUpdate` or `deploy\windows\auto-update.ps1 -Enable` (`-Disable`, `-Check`); log in `C:\ProgramData\FoundryVTT Discord integration\auto-update.log`. Re-running an installer keeps the current choice; uninstalling removes the timer or task. An optional GitHub token file is supported for private forks. On Linux the installer now makes the program files root-owned, and the root updater refuses to run from a folder another account can change; on Windows it refuses to run setup.exe when the bot task runs as an account other than SYSTEM. See [docs/INSTALL.md](docs/INSTALL.md#automatic-updates).
- **Update notice by direct message.** When the bot starts on a newer version than it ran before, it sends one DM per person to the owner and every Administrator of each server it is in, listing their servers, with the changelog of the new version (the GitHub release notes when the auto-updater installed it, otherwise the section of the installed `CHANGELOG.md`) and a link to the release. Announced at most once per version; the first start only records the version. New setting `UPDATE_NOTIFY` = `admins` (default), `owner` or `off`.
- **Planning polls** (`/planning-poll campaign:<name>`; the Discord event is three hours long): pick candidate dates, the bot posts a poll tagging the DM and the players, and they vote. **Decide date** offers the dates with the most votes, then a time; the bot creates a Discord scheduled event, announces it in the poll's channel and sets the campaign's next session. **Delete poll** removes it. For administrators, the campaign's DM and the new game master role.
- Planning polls also set the world's `nextSession` in its `world.json` (the only write the bot makes to Foundry's folders; atomic, one key, layout kept).
- **Permission check**: at startup and when the bot's role or a channel changes, the bot checks the permissions it needs (View Channels, Send Messages, Send Messages in Threads, Embed Links, Create Events) and announces what is missing once in the status channel. A server where the bot was added without the `applications.commands` scope gets a reinstall notice with the invite link. The invite link and `docs/INSTALL.md` now include Create Events.
- `/gm-role set|clear|show` (admin): the per-server game master role that may use `/planning-poll` for every campaign.

### Changed

- **Recommended: enable the *Server Members Intent*.** With the default `UPDATE_NOTIFY=admins` the bot now asks Discord for the privileged Server Members intent (to find each server's administrators for the update notice; `owner` and `off` do not request it). Turn it on in the Developer Portal (your application → **Bot** → *Privileged Gateway Intents* → *Server Members Intent*). Without it the bot still starts: it logs one warning (how to enable the intent, or set `UPDATE_NOTIFY=owner` to silence it), connects again without the intent and sends update notices to server owners only. If the intent is turned off while the bot is running, the bot exits so the service restarts it in that mode.
- The systemd unit no longer restarts the bot on exit code 2 (a configuration error such as a bad `.env`, where restarting does not help).
- Windows install scripts print with `Write-Output` instead of `Write-Host`, and CI now runs PSScriptAnalyzer on `deploy/windows` and shellcheck on `deploy/linux`.

## [1.2.2] - 2026-10-07

### Security

- Configuration errors no longer print the rejected values (a `FOUNDRY_URL` with a password in it ended up in the log in clear text), and `npm run register-commands` prints only Discord's status, code and message instead of the whole error object. Fixes the three CodeQL "clear-text logging of sensitive information" alerts.

### Added

- `/updates available changes:true`: one message per Foundry/system/module update, each with the cumulative changelogs of the versions between the installed and the latest one, kept within Discord's message size limit.

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

[Unreleased]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.6.3...HEAD
[1.6.3]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.1.0
[1.0.0]: https://github.com/dxcufgb/FoundryVTT-discord-integration/releases/tag/v1.0.0
