// Register (or re-register) the slash commands without starting the bot.
// Usage: npm run register-commands
import { loadConfig } from "../src/config.js";
import { commands } from "../src/discord/commands/index.js";
import { registerCommands } from "../src/discord/registerCommands.js";

try {
  const config = loadConfig();
  await registerCommands(config, commands);
} catch (err) {
  console.error(err?.rawError ?? err?.message ?? err);
  process.exit(1);
}
