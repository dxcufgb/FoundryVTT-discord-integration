# FoundryVTT Discord integration

Discord bot (Node >= 20, ESM, discord.js 14) that watches a Foundry VTT v13 server on the same machine: up/down, world starts, package updates, restart windows, campaigns and session planning. One runtime dependency; no build step, no linter.

## Commands

- `npm test` — runs `node --test` over `test/`. Keep it green.
- `npm run check-config` — validates `.env` and reports worlds and unused modules (needs a real Foundry data folder).
- `npm run register-commands` — pushes slash command definitions to Discord (needs a token; do not run casually).
- `npm start` — runs the bot (needs a token).
- `npm run admin-password` — sets the administration page's password (`data/admin.json`).

## Layout

- `src/index.js` — wiring and startup.
- `src/discord/commands/*.js` — one file per slash command; all registered in `src/discord/commands/index.js`.
- `src/discord/client.js` — interaction routing (component customIds by prefix: `poll:`, `session:`, `vc:`), admin check, autocomplete.
- `src/discord/sessionEvents.js` — the Discord event of a planned session: campaign's default voice channel, the "pick a voice channel or skip" prompt and the "make it the default?" buttons.
- `src/foundry/*` — talking to Foundry: status polling, monitor loop, packages, updates, releases, worlds, LevelDB reader.
- `src/state.js` — persistent JSON state (atomic writes); `MESSAGE_TYPES` lives here.
- `src/messages.js`, `src/notifier.js` — embeds and posting.
- `src/campaigns.js`, `src/sessions.js`, `src/restartWindow.js` — domain logic.
- `src/sessionSummaries.js` — posts the session summaries of the Foundry module dxcufgbs-session-summary (read-only, `Data/session-summaries` or `SESSION_SUMMARY_DIR`) to the channels of the campaigns bound to a world when it goes back to setup (`FoundryMonitor`'s `onWorldStopped`, which runs also with world announcements off). Never throws; posted (session, channel) pairs are recorded in `state.notified` after a successful send. Settings in `state.sessionSummaries`.
- `src/admin/` — the optional administration page (`ADMIN_PORT` + a password in `data/admin.json`, set with `npm run admin-password`): `server.js` (HTTPS listener, self-signed certificate kept in `data/`), `page.js` (the `/_admin` handler and JSON API; session cookie, CSRF token, host/origin checks, login lockout, strict CSP), `settings.js` (scrypt password), `selfsigned.js`, `ui/` (one page, plain DOM, `textContent` only). Modelled on the admin pages of FoundryVTT-world-backup-to-git and FoundryVTT-Private-Github-proxy. Never put the Discord token in a response or a log line.
- `src/updateNotice.js` — after a bot update, DM the changelog to server admins once. `UPDATE_NOTIFY` = `admins` (default, needs the Server Members intent) / `owner` / `off`; `connectDiscord` in `src/discord/client.js` falls back to `owner` when Discord refuses the intent.
- `src/selfUpdate.js` + `scripts/self-update.js` — opt-in auto-update (release check, download, SHA-256); `deploy/linux/auto-update.sh` (root, `foundryvtt-discord-bot-update.timer`) and `deploy/windows/auto-update.ps1` (SYSTEM, daily task) install it and roll back on failure.
- `deploy/` — Linux (systemd) and Windows (Task Scheduler, Inno Setup) installers. `deploy/linux/archive-install.sh` becomes `install.sh` at the top of the Linux archive and runs `deploy/linux/install.sh`.
- `scripts/build-release.sh` — builds the release files (`build`, then `finalize` once the setup.exe exists) with the version stamped from the tag; its `LEGACY_ASSETS` block keeps the old file names that running updaters look for.
- `docs/` — `COMMANDS.md`, `INSTALL.md`, `RELEASING.md`.

## Conventions

- Match the surrounding style: terse code, dependency-injected context (`{ state, config, notifier, ... }`) so tests can fake everything; see `test/helpers.js`.
- Slash commands are guild-only. Bot-configuration commands set `adminOnly = true` (or `adminSubcommands`) and `setDefaultMemberPermissions(Administrator)`; `test/commands.test.js` enforces this for every command. `/session` is the exception: it is checked against the campaign's DM (or an administrator) inside the command.
- Replies to configuration commands are ephemeral.
- Foundry data (LevelDB, manifests) is read-only; never write to Foundry's folders. The one exception: `writeWorldNextSession` (`src/foundry/packages.js`) sets the `nextSession` key of a world's `world.json` when a planning poll decides a date or `/session set` is used. Do not widen it.
- Never commit `.env`, `data/` or tokens.
- Auto-update stays opt-in and runs as root/SYSTEM: the install folder, its parents, the program files and the Node binary must not be changeable by a non-root account (`install.sh` makes them `root`-owned and `go-w`; the updater refuses otherwise). Upgrades keep `.env` and `data/`. A rollback that fails logs "ROLLBACK FAILED", keeps the backup and exits non-zero. The GitHub token goes only to `api.github.com`, never to logs.

## Docs and changelog

- Any new or changed command or option: update `docs/COMMANDS.md`.
- Any user-visible change: add an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format).
- Releasing: Actions → Release → Run workflow → type the version. Fallback: publish a release `vX.Y.Z` on GitHub, files are attached afterwards. No version bump in the code (the repository's `package.json` version is not the release version). Details in `docs/RELEASING.md`; `main` is protected, so changes go through pull requests.
- Install on Linux: `curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundryvtt-discord-integration`, or download `foundryvtt-discord-integration-linux.tar.gz`, `tar xzf`, `cd foundryvtt-discord-integration-X.Y.Z`, `sudo ./install.sh`. The installer's common options (`--yes`, `--auto-update`/`--no-auto-update`, `--enable-auto-update`/`--disable-auto-update`, `--check-update`, `--update-now`, `--uninstall [--purge]`, `--help`) are shared with the other bots; keep them and every existing option working.
- Release file names are fixed (see `docs/RELEASING.md`); installations look for them, so never rename a release file without keeping the old name in `LEGACY_ASSETS`.
