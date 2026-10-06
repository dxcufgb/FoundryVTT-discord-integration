// Register (or re-register) the slash commands without starting the bot.
// Usage: npm run register-commands
import { loadConfig } from "../src/config.js";
import { commands } from "../src/discord/commands/index.js";
import { registerCommands } from "../src/discord/registerCommands.js";

try {
  const config = loadConfig();
  await registerCommands(config, commands);
} catch (err) {
  // Only Discord's own answer (status, code, message) is printed, never the request or the configuration.
  const reply = err?.rawError;
  console.error(reply?.message ?? err?.message ?? "Registering the commands failed.");
  if (err?.status) console.error(`HTTP status: ${err.status}`);
  if (reply?.code) console.error(`Discord error code: ${reply.code}`);
  process.exit(1);
}
