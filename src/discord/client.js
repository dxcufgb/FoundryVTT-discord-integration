// Discord client wiring: logs in, dispatches slash commands and their
// autocomplete requests, enforces the administrator check on configuration
// commands.

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { commandMap, requiresAdmin } from "./commands/index.js";
import { GUILD_ONLY_MESSAGE, isGuildAdministrator, NOT_ADMIN_MESSAGE } from "./permissions.js";

/**
 * Handle one interaction. Exported so tests can drive it with a fake interaction.
 * @param {object} interaction
 * @param {object} ctx  shared services handed to every command
 */
export async function handleInteraction(interaction, ctx, { log = console } = {}) {
  if (interaction.isAutocomplete?.()) return handleAutocomplete(interaction, ctx, { log });
  if (!interaction.isChatInputCommand?.()) return;
  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  const subcommand = safeSubcommand(interaction);
  if (requiresAdmin(command, subcommand)) {
    if (!(typeof interaction.inGuild === "function" ? interaction.inGuild() : interaction.guildId)) {
      return interaction.reply({ content: GUILD_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
    }
    if (!isGuildAdministrator(interaction)) {
      return interaction.reply({ content: NOT_ADMIN_MESSAGE, flags: MessageFlags.Ephemeral });
    }
  }

  try {
    await command.execute(interaction, ctx);
  } catch (err) {
    log.error(`command /${interaction.commandName} ${subcommand ?? ""} failed:`, err);
    const payload = { content: "Something went wrong while running that command. Check the bot's log.", flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: payload.content });
      else await interaction.reply(payload);
    } catch {
      // nothing more we can do
    }
  }
}

async function handleAutocomplete(interaction, ctx, { log }) {
  const command = commandMap.get(interaction.commandName);
  if (!command?.autocomplete) return;
  try {
    await command.autocomplete(interaction, ctx);
  } catch (err) {
    log.debug(`autocomplete for /${interaction.commandName} failed:`, err?.message ?? err);
    try {
      if (!interaction.responded) await interaction.respond([]);
    } catch {
      // the interaction has probably expired
    }
  }
}

function safeSubcommand(interaction) {
  try {
    return interaction.options?.getSubcommand?.(false) ?? null;
  } catch {
    return null;
  }
}

// GuildMembers is a privileged intent, used only to find each server's administrators for the update
// notice DM (UPDATE_NOTIFY=admins). Discord refuses the connection (close code 4014) unless it is
// enabled in the Developer Portal, so it is not requested in the owner and off modes; in admins mode
// connectDiscord() then falls back to Guilds only and owner-only notices.
export const INTENTS = Object.freeze([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
export const intentsFor = (updateNotify) => (updateNotify === "admins" ? INTENTS : [GatewayIntentBits.Guilds]);
export const DISALLOWED_INTENTS_MESSAGE =
  'Discord refused the connection: the "Server Members Intent" is not enabled for this bot. Open https://discord.com/developers/applications, ' +
  'choose the application, go to Bot -> Privileged Gateway Intents, turn on "Server Members Intent", save, and start the bot again.';
export const INTENTS_FALLBACK_MESSAGE =
  'The "Server Members Intent" is not enabled for this bot, so update notices will go to server owners only (not to every Administrator). ' +
  "To include administrators: open https://discord.com/developers/applications, choose the application, go to Bot -> Privileged Gateway Intents, " +
  'turn on "Server Members Intent", save, and restart the bot. To keep owner-only notices and silence this warning, set UPDATE_NOTIFY=owner in .env.';

/** Is this a gateway close code / error saying the requested privileged intents are not allowed? */
export function isDisallowedIntents(x) {
  if (x === 4014 || x?.code === 4014 || x?.code === "DisallowedIntents") return true;
  return /disallowed intents|privileged intent/i.test(String(x?.message ?? ""));
}

export function createClient(ctx, { log = console, updateNotify = ctx.config?.updateNotify } = {}) {
  const client = new Client({ intents: intentsFor(updateNotify) });
  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, ctx, { log }));
  client.on(Events.Error, (err) => log.error("Discord client error:", err));
  client.on(Events.Warn, (msg) => log.warn("Discord:", msg));
  return client;
}

/**
 * Log in and wait until the client is ready. If Discord refuses the Server Members intent in admins
 * mode, warn once, log in again with a new Guilds-only client and continue in owner mode. Any other
 * failure (or a refusal of the fallback) rejects.
 * @param {{ token: string, updateNotify: string, makeClient: (updateNotify: string) => object, log?: object }} opts
 * @returns {Promise<{ client: object, readyClient: object, updateNotify: string }>}  the client that is connected and the effective notify mode
 */
export function connectDiscord({ token, updateNotify, makeClient, log = console }) {
  return new Promise((resolve, reject) => {
    const attempt = (mode) => {
      const client = makeClient(mode);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        void Promise.resolve()
          .then(() => client.destroy())
          .catch(() => {});
        if (isDisallowedIntents(err) && mode === "admins") {
          log.warn(INTENTS_FALLBACK_MESSAGE);
          attempt("owner");
        } else {
          reject(isDisallowedIntents(err) ? new Error(DISALLOWED_INTENTS_MESSAGE) : err);
        }
      };
      client.on(Events.ShardDisconnect, (event) => isDisallowedIntents(event?.code) && fail(event));
      client.on(Events.ShardError, (err) => isDisallowedIntents(err) && fail(err));
      client.once(Events.ClientReady, (readyClient) => {
        if (settled) return;
        settled = true;
        resolve({ client, readyClient, updateNotify: mode });
      });
      Promise.resolve()
        .then(() => client.login(token))
        .catch((err) => fail(err ?? new Error("Discord login failed")));
    };
    attempt(updateNotify);
  });
}
