// Discord client wiring: logs in, dispatches slash commands, enforces the
// administrator check on configuration commands.

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { commandMap, requiresAdmin } from "./commands/index.js";
import { GUILD_ONLY_MESSAGE, isGuildAdministrator, NOT_ADMIN_MESSAGE } from "./permissions.js";

/**
 * Handle one interaction. Exported so tests can drive it with a fake interaction.
 * @param {object} interaction
 * @param {object} ctx  shared services handed to every command
 */
export async function handleInteraction(interaction, ctx, { log = console } = {}) {
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

function safeSubcommand(interaction) {
  try {
    return interaction.options?.getSubcommand?.(false) ?? null;
  } catch {
    return null;
  }
}

export function createClient(ctx, { log = console } = {}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, ctx, { log }));
  client.on(Events.Error, (err) => log.error("Discord client error:", err));
  client.on(Events.Warn, (msg) => log.warn("Discord:", msg));
  return client;
}
