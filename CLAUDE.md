# FoundryVTT Discord integration

Discord bot (Node >= 20, ESM, discord.js 14) that watches a Foundry VTT v13 server on the same machine: up/down, world starts, package updates, restart windows, campaigns and session planning. One runtime dependency; no build step, no linter.

## Commands

- `npm test` — runs `node --test` over `test/`. Keep it green.
- `npm run check-config` — validates `.env` and reports worlds and unused modules (needs a real Foundry data folder).
- `npm run register-commands` — pushes slash command definitions to Discord (needs a token; do not run casually).
- `npm start` — runs the bot (needs a token).
- `npm run admin-password` — sets the administration page's password (`data/admin.json`).
- Security (`.github/workflows/security.yml`, required checks `Secrets (gitleaks)`, `Code (Semgrep)`, `Dependencies`; push to main, PRs, weekly): locally `gitleaks git --redact --log-opts="--full-history --diff-filter=tuxdb --diff-merges=first-parent HEAD" .`, `semgrep scan --metrics=off --error --severity WARNING --severity ERROR --config p/python --config p/javascript --config p/security-audit --config p/secrets --config p/github-actions --config r/bash`, and `npm audit --omit=dev --audit-level=low`. Semgrep false positives: `// nosemgrep: <rule-id>` (JavaScript) or `# nosemgrep: <rule-id>` (shell, YAML, PowerShell) on the matched line or the line immediately before it, with a reason; gitleaks: `.gitleaks.toml` with `[extend]` `useDefault = true`. CodeQL (default setup) and GitHub secret scanning also run.

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
- `src/admin/` — the optional administration page (`ADMIN_PORT` + a password in `data/admin.json`, set with `npm run admin-password`): `server.js` (HTTPS listener, self-signed certificate kept in `data/`), `page.js` (the `/_admin` handler and JSON API; session cookie, CSRF token, host/origin checks, login lockout, strict CSP), `settings.js` (scrypt password), `guilds.js` (a server's channels and roles to pick from, and the commands' permission warnings as plain text), `selfsigned.js`, `ui/` (one page, plain DOM, `textContent` only). Modelled on the admin pages of FoundryVTT-world-backup-to-git and FoundryVTT-Private-Github-proxy. Never put the Discord token in a response or a log line.
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

## Review focus

- **Who may click what**: `requiresAdmin` in `src/discord/client.js` is the server-side check behind `setDefaultMemberPermissions`. Buttons, menus and modals (`poll:`, `session:`, `vc:`) can be used by anyone who sees the message, so every handler must re-check `canManageCampaign` / `canRunPoll` / `canManagePoll` itself (as `handleSessionComponent` and `handleVoiceDefault` do). Select values, modal fields and command options are user input.
- **Ids from users reach plain-object lookups**: `findCampaign` passes typed text to `state.campaign()` (`campaigns[id]`), and `state.poll()` works the same way, so keys like `constructor` or `__proto__` find inherited properties. New lookups by user-given ids should use `Object.hasOwn`; flag code that writes through such a lookup.
- **Pings and untrusted text**: every send passes `allowedMentions`. Only campaign members (`eventMentions`) and the mention role for `MENTION_EVENTS` may be pinged; everything else uses `{ parse: [] }`. Session-summary Markdown, world titles and package data from manifests and foundryvtt.com are untrusted: keep `allowedMentions: { parse: [] }`, `clip()` (2000 characters) and the embed limits (`truncate`, `EMBED_LIMITS`).
- **Paths built from outside input**: world ids go through `normaliseWorldId`/`resolveWorld`. `writeWorldNextSession` refuses separators, `.` and `..`, and session-summary file names from `index.json` must pass `safeName`; `readSummaries` reads at most `MAX_INDEX_ENTRIES` entries.
- **The poll loop must not die or stall**: `FoundryMonitor.tick` catches everything and never overlaps (`ticking`); `Notifier.deliver` throws only when no channel was reached; `postSessionSummaries` never throws and runs once per world at a time (`inFlight`). Every network call needs a timeout (status 8 s, `FoundryWebsite` 10 s with its cache and `concurrency`, self-update 30 s / 10 min). Flag new sync I/O beyond the small `StateStore.save()`.
- **`state.json` compatibility**: new fields get a default in `defaultState()` (old files are `deepMerge`d over it). `state.notified` keys are written only after a successful send, and `botVersion` is recorded before the update DMs go out, so a version is announced once.
- **Admin page API** (`src/admin/page.js`): new routes go inside `api()` after the session check, and changes after the CSRF check. Validate bodies against allow-lists (`MONITORS`, `UPDATE_SWITCHES`, `MESSAGE_TYPES`), and channel or role ids against the guild (`pickChannel`, `pickRole`). `state()` returns a hand-picked `config` subset; never add `config.discord` or `.env` values to it. `X-Forwarded-*` counts only through `fromProxy` (`ADMIN_TRUST_PROXY`). A failed login is counted before `verifyPassword` runs. 401 means "logged out" to the UI (`app.js`).
- **Self-update** (`src/selfUpdate.js`): `headersFor` adds the token only for `https://api.github.com`, and `fetchFollow` re-checks every redirect hop for HTTPS. Downloads are size-capped and must match `SHA256SUMS.txt` (the legacy `SHA256SUMS-setup.txt` only for old setup.exe releases). Only a strictly newer, non-draft, non-pre-release version installs. The `key=value` lines that `scripts/self-update.js` prints (`status`, `current`, `latest`, `file`, `notice`) are read by `auto-update.sh` / `auto-update.ps1`, so keep them stable.
- **Root/SYSTEM scripts**: `auto-update.sh` calls the new release's `deploy/linux/install.sh --non-interactive --no-start --dir`, and `install.sh --check-update` exits 10 for a newer release; keep both working. Root reads `.env` as text (`read_env`), never sources it. `data/` and `.env` belong to the bot's account, so root must not follow anything inside them (symlinks, junctions). Keep the `go-w`/owner checks on the install folder, its parents and Node, the Windows `Test-WritableByUser` checks, and the refusal to let `setup.exe` re-register a task that runs as another account.
- **Secrets**: the Discord token, the GitHub token and `admin.json`'s hash never go into a log line, a Discord message or an admin response. On Linux `.env` is mode 600 and owned by the bot's account, and `github-token` is root-only mode 600 (Administrators+SYSTEM on Windows); never widen these.
- CI runs `npm test` on Node 20 and 22 (Linux and Windows), shellcheck on `deploy/linux/*.sh` and `scripts/build-release.sh`, PSScriptAnalyzer on `deploy/windows`, and Windows PowerShell 5.1 for the auto-update. Avoid APIs newer than Node 20.
