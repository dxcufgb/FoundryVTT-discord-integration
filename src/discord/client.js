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

// GuildMembers is a privileged intent, used to find each server's administrators for the update
// notice DM. Discord refuses the connection (close code 4014) unless it is enabled in the Developer Portal.
export const INTENTS = Object.freeze([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
export const DISALLOWED_INTENTS_MESSAGE =
  'Discord refused the connection: the "Server Members Intent" is not enabled for this bot. Open https://discord.com/developers/applications, ' +
  'choose the application, go to Bot -> Privileged Gateway Intents, turn on "Server Members Intent", save, and start the bot again.';

/** Is this a gateway close code / error saying the requested privileged intents are not allowed? */
export function isDisallowedIntents(x) {
  if (x === 4014 || x?.code === 4014 || x?.code === "DisallowedIntents") return true;
  return /disallowed intents|privileged intent/i.test(String(x?.message ?? ""));
}

export function createClient(ctx, { log = console } = {}) {
  const client = new Client({ intents: INTENTS });
  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, ctx, { log }));
  client.on(Events.Error, (err) => log.error("Discord client error:", err));
  client.on(Events.Warn, (msg) => log.warn("Discord:", msg));
  return client;
}
