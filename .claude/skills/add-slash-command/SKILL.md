---
name: add-slash-command
description: Add a new Discord slash command (or subcommand) to this bot, including registration, tests, docs and changelog. Use when asked to add or extend a /command.
---

# Add a slash command

1. Read `src/discord/commands/testMessage.js` (small) and, for subcommands, `src/discord/commands/channel.js` or `monitor.js`. Copy their shape: `export const data` (SlashCommandBuilder), `export async function execute(interaction, ctx)`, optional `autocomplete`, `adminOnly`, `adminSubcommands`.
2. Create `src/discord/commands/<name>.js`:
   - `.setContexts(InteractionContextType.Guild)` — all commands are guild-only.
   - Anything that changes configuration: `export const adminOnly = true` and `.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)`. Mixed commands use `adminSubcommands = new Set([...])` instead.
   - Reply with `flags: MessageFlags.Ephemeral` for configuration output.
   - Take collaborators from `ctx` (`state`, `config`, `notifier`, `fetchStatus`, `now`, `log`) rather than importing singletons.
   - New persistent data goes through `src/state.js`; new message kinds extend `MESSAGE_TYPES` (and `/channel`, `/test-message`, docs).
3. Register it in `src/discord/commands/index.js` (import + `commands` array).
4. Tests in `test/`: call `handleInteraction` with `fakeInteraction`, `tmpState`, `quietLog` from `test/helpers.js` (see `test/commands.test.js`). Cover the admin check, the happy path and one error path. The existing "all configuration commands are admin-only and guild-only" test covers the definition automatically.
5. Docs: add a section to `docs/COMMANDS.md` (mark **admin** where relevant) and an entry under `## [Unreleased]` → `### Added` in `CHANGELOG.md`.
6. Run `npm test`. Do not run `npm run register-commands` unless the user asks; mention that it must be run (or the bot restarted with registration) for Discord to show the command.
