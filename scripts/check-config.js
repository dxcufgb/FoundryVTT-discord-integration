// Validate .env and probe Foundry without talking to Discord.
// Usage: npm run check-config
import { loadConfig } from "../src/config.js";
import { createStatusFetcher } from "../src/foundry/status.js";
import { readFoundryVersion, resolveDataFolder, scanPackages } from "../src/foundry/packages.js";
import { moduleUsage, scanWorldsWithModules } from "../src/foundry/worlds.js";

let config;
try {
  config = loadConfig({ requireDiscord: false });
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
console.log("Configuration OK:");
console.log(`  Foundry URL:        ${config.foundry.url}`);
console.log(`  Foundry data path:  ${config.foundry.dataPath ?? "(not set – update tracking off)"}`);
console.log(`  Foundry app path:   ${config.foundry.appPath ?? "(not set)"}`);
console.log(`  Foundry website:    ${config.foundry.websiteUrl}`);
console.log(`  Bot data dir:       ${config.botDataDir}`);
console.log(`  Poll every:         ${config.pollIntervalSeconds} s, down after ${config.downAfterFailures} failed checks`);
console.log(`  Timezone:           ${config.timezone}`);
console.log(`  Discord token:      ${config.discord.token ? "set" : "MISSING"}, client id: ${config.discord.clientId ? "set" : "MISSING"}`);

const result = await createStatusFetcher(config.foundry.url)();
if (result.ok) {
  const s = result.status;
  console.log(`\nFoundry answered: v${s.version ?? "?"}, world ${s.world ?? "none"}, system ${s.system ?? "none"}, ${s.users ?? "?"} users online`);
} else {
  console.log(`\nFoundry did not answer at ${config.foundry.url}: ${result.error}`);
}
if (config.foundry.dataPath) {
  const pkgs = scanPackages(config.foundry.dataPath);
  console.log(`Found ${pkgs.filter((p) => p.type === "system").length} systems and ${pkgs.filter((p) => p.type === "module").length} modules in ${resolveDataFolder(config.foundry.dataPath)}`);
  const worlds = scanWorldsWithModules(config.foundry.dataPath);
  const usage = moduleUsage(pkgs.filter((p) => p.type === "module"), worlds);
  console.log(`Found ${worlds.length} worlds; module settings readable for ${worlds.length - usage.unreadable.length} of them; ${usage.unused.length} modules are not active in any world`);
  for (const w of usage.unreadable) console.log(`  world ${w.id}: ${w.reason}`);
}
if (config.foundry.appPath) console.log(`Installed Foundry version from app folder: ${readFoundryVersion(config.foundry.appPath) ?? "not found"}`);
