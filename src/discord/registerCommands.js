// Pushes the slash command definitions to Discord. Global commands can take up
// to an hour to appear; guild commands appear immediately, so DISCORD_GUILD_ID
// is handy while setting things up.
//
// The bot calls syncCommands() every time it starts (so every update, automatic or
// by hand, re-registers the commands of the new version); the installers run
// scripts/register-commands.js as well. syncCommands remembers in state.json where
// the commands were last put, removes the set left behind when DISCORD_GUILD_ID was
// added, changed or removed (otherwise Discord keeps showing the old commands next
// to the new ones), and retries a failed registration instead of waiting for the
// next restart.

import crypto from "node:crypto";
import { REST, Routes } from "discord.js";

/** Delays before each retry of a failed registration (ms). */
export const RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 90_000]);

/** The route of the command set: a server's commands with a guild id, else the application's global commands. */
export function commandsRoute(clientId, guildId) {
  return guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
}

const where = (guildId) => (guildId ? `in server ${guildId}` : "globally");

/** Short fingerprint of the command definitions, to tell whether they changed since the last registration. */
export function commandsHash(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
}

export async function registerCommands(config, commands, { rest = new REST().setToken(config.discord.token), log = console } = {}) {
  const body = commands.map((c) => c.data.toJSON());
  const result = await rest.put(commandsRoute(config.discord.clientId, config.discord.guildId), { body });
  log.info(`Registered ${body.length} slash commands ${where(config.discord.guildId)}.`);
  return result;
}

/**
 * Register the commands at startup, remembering the result in state.json (`commands`). Never throws.
 * @param {{ config: object, commands: object[], state: object, version?: string|null, rest?: object, log?: object, delays?: number[], sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<{status: "registered"|"failed", count?: number, changed?: boolean, movedFrom?: string|null}>}
 */
export async function syncCommands(opts) {
  try {
    return await doSync(opts);
  } catch (err) {
    (opts.log ?? console).error("Registering the slash commands failed:", err?.message ?? err);
    return { status: "failed" };
  }
}

async function doSync({ config, commands, state, version = null, rest = new REST().setToken(config.discord.token), log = console, delays = RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const clientId = config.discord.clientId;
  const guildId = config.discord.guildId ?? null;
  const body = commands.map((c) => c.data.toJSON());
  const hash = commandsHash(body);
  const previous = state.data.commands ?? null;
  let movedFrom = null;

  // DISCORD_GUILD_ID was added, changed or removed: the set registered before stays in Discord
  // (and is shown next to the new one) until it is emptied.
  if (previous && (previous.guildId ?? null) !== guildId) {
    try {
      await rest.put(commandsRoute(clientId, previous.guildId), { body: [] });
      movedFrom = previous.guildId ?? "global";
      log.info(`Removed the slash commands registered ${where(previous.guildId)} earlier; they are registered ${where(guildId)} from now on.`);
    } catch (err) {
      log.warn(`Could not remove the slash commands registered ${where(previous.guildId)} earlier (${err?.message ?? err}); the old set may show up next to the new one until it is removed.`);
    }
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await rest.put(commandsRoute(clientId, guildId), { body });
      break;
    } catch (err) {
      if (attempt >= delays.length) {
        log.error(`Could not register the slash commands ${where(guildId)} after ${attempt + 1} attempts: ${err?.message ?? err}. Discord keeps the previous set; restart the bot or run: npm run register-commands`);
        return { status: "failed" };
      }
      log.warn(`Registering the slash commands failed (${err?.message ?? err}); trying again in ${delays[attempt] / 1000} s.`);
      await sleep(delays[attempt]);
    }
  }

  const changed = !previous || previous.hash !== hash || (previous.guildId ?? null) !== guildId;
  state.update((d) => {
    d.commands = { guildId, hash, version, at: new Date().toISOString() };
  });
  log.info(`Registered ${body.length} slash commands ${where(guildId)}${changed ? " (changed since the last registration)" : ""}.`);
  if (changed && previous && !guildId) {
    log.info("Discord can take up to an hour to show changed global commands, and Discord clients keep the old list until they are restarted (Ctrl+R on desktop).");
  }
  return { status: "registered", count: body.length, changed, movedFrom };
}
