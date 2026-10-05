// Entry point: load config, open the state file, log in to Discord, register the
// slash commands and start polling Foundry.

import path from "node:path";
import { Events } from "discord.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./logger.js";
import { StateStore } from "./state.js";
import { createStatusFetcher } from "./foundry/status.js";
import { readFoundryVersion, readWorld, scanPackages } from "./foundry/packages.js";
import { scanWorldsWithModules } from "./foundry/worlds.js";
import { FoundryWebsite } from "./foundry/releases.js";
import { FoundryMonitor } from "./foundry/monitor.js";
import { Notifier } from "./notifier.js";
import { createClient } from "./discord/client.js";
import { commands } from "./discord/commands/index.js";
import { registerCommands } from "./discord/registerCommands.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    console.error("\nCopy .env.example to .env and fill it in, or set the variables in the environment.");
    process.exit(2);
  }
  setLogLevel(config.logLevel);
  log.info(`Foundry VTT Discord integration starting (Foundry at ${config.foundry.url}, data ${config.foundry.dataPath ?? "not set"})`);

  const state = new StateStore(path.join(config.botDataDir, "state.json")).load();
  state.save();

  const fetchStatus = createStatusFetcher(config.foundry.url);
  const worldTitle = (id) => readWorld(config.foundry.dataPath, id)?.title ?? null;

  const scanInstalled = () => (config.foundry.dataPath ? scanPackages(config.foundry.dataPath) : []);
  const readInstalledFoundryVersion = () => readFoundryVersion(config.foundry.appPath);

  const ctx = {
    config,
    state,
    fetchStatus,
    worldTitle,
    scanPackages: scanInstalled,
    readFoundryVersion: readInstalledFoundryVersion,
    worldsWithModules: () => (config.foundry.dataPath ? scanWorldsWithModules(config.foundry.dataPath, { log }) : []),
    website: new FoundryWebsite({ baseUrl: config.foundry.websiteUrl, log }),
    log,
    now: () => new Date(),
  };
  const client = createClient(ctx, { log });
  ctx.notifier = new Notifier({ client, state, worldTitle, log });
  ctx.monitor = new FoundryMonitor({
    fetchStatus,
    scanPackages: scanInstalled,
    readFoundryVersion: readInstalledFoundryVersion,
    state,
    emit: (event) => ctx.notifier.deliver(event),
    options: { downAfterFailures: config.downAfterFailures },
    log,
  });

  let timer = null;
  client.once(Events.ClientReady, async (c) => {
    log.info(`Logged in to Discord as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
    try {
      await registerCommands(config, commands, { log });
    } catch (err) {
      log.error("Could not register slash commands:", err?.message ?? err);
    }
    if (!config.foundry.dataPath) log.warn("FOUNDRY_DATA_PATH is not set: system/module update tracking and world titles are off.");
    await ctx.monitor.tick();
    timer = setInterval(() => ctx.monitor.tick(), config.pollIntervalSeconds * 1000);
    log.info(`Checking Foundry every ${config.pollIntervalSeconds} s.`);
  });

  const shutdown = (signal) => {
    log.info(`Received ${signal}, shutting down.`);
    if (timer) clearInterval(timer);
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error("Unhandled promise rejection:", err));

  await client.login(config.discord.token);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
