# FoundryVTT Discord integration

Discord bot (Node >= 20, ESM, discord.js 14) that watches a Foundry VTT v13 server on the same machine: up/down, world starts, package updates, restart windows, campaigns and session planning. One runtime dependency; no build step, no linter.

## Commands

- `npm test` — runs `node --test` over `test/`. Keep it green.
- `npm run check-config` — validates `.env` and reports worlds and unused modules (needs a real Foundry data folder).
- `npm run register-commands` — pushes slash command definitions to Discord (needs a token; do not run casually).
- `npm start` — runs the bot (needs a token).

## Layout

- `src/index.js` — wiring and startup.
- `src/discord/commands/*.js` — one file per slash command; all registered in `src/discord/commands/index.js`.
- `src/discord/client.js` — interaction routing, admin check, autocomplete.
- `src/foundry/*` — talking to Foundry: status polling, monitor loop, packages, updates, releases, worlds, LevelDB reader.
- `src/state.js` — persistent JSON state (atomic writes); `MESSAGE_TYPES` lives here.
- `src/messages.js`, `src/notifier.js` — embeds and posting.
- `src/campaigns.js`, `src/sessions.js`, `src/restartWindow.js` — domain logic.
- `src/updateNotice.js` — after a bot update, DM the changelog to server admins once. `UPDATE_NOTIFY` = `admins` (default, needs the Server Members intent) / `owner` / `off`; `connectDiscord` in `src/discord/client.js` falls back to `owner` when Discord refuses the intent.
- `src/selfUpdate.js` + `scripts/self-update.js` — opt-in auto-update (release check, download, SHA-256); `deploy/linux/auto-update.sh` (root, `foundryvtt-discord-bot-update.timer`) and `deploy/windows/auto-update.ps1` (SYSTEM, daily task) install it and roll back on failure.
- `deploy/` — Linux (systemd) and Windows (Task Scheduler, Inno Setup) installers.
- `docs/` — `COMMANDS.md`, `INSTALL.md`, `RELEASING.md`.

## Conventions

- Match the surrounding style: terse code, dependency-injected context (`{ state, config, notifier, ... }`) so tests can fake everything; see `test/helpers.js`.
- Slash commands are guild-only. Bot-configuration commands set `adminOnly = true` (or `adminSubcommands`) and `setDefaultMemberPermissions(Administrator)`; `test/commands.test.js` enforces this for every command. `/session` is the exception: it is checked against the campaign's DM (or an administrator) inside the command.
- Replies to configuration commands are ephemeral.
- Foundry data (LevelDB, manifests) is read-only; never write to Foundry's folders.
- Never commit `.env`, `data/` or tokens.
- Auto-update stays opt-in and runs as root/SYSTEM: the install folder, its parents, the program files and the Node binary must not be changeable by a non-root account (`install.sh` makes them `root`-owned and `go-w`; the updater refuses otherwise). Upgrades keep `.env` and `data/`. A rollback that fails logs "ROLLBACK FAILED", keeps the backup and exits non-zero. The GitHub token goes only to `api.github.com`, never to logs.

## Docs and changelog

- Any new or changed command or option: update `docs/COMMANDS.md`.
- Any user-visible change: add an entry under `## [Unreleased]` in `CHANGELOG.md` (Keep a Changelog format).
- Releases follow `docs/RELEASING.md`; `main` is protected, so changes go through pull requests.
