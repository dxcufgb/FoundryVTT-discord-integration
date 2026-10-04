// Pushes the slash command definitions to Discord. Global commands can take up
// to an hour to appear; guild commands appear immediately, so DISCORD_GUILD_ID
// is handy while setting things up.

import { REST, Routes } from "discord.js";

export async function registerCommands(config, commands, { rest = new REST().setToken(config.discord.token), log = console } = {}) {
  const body = commands.map((c) => c.data.toJSON());
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.clientId);
  const result = await rest.put(route, { body });
  log.info(`Registered ${body.length} slash commands ${config.discord.guildId ? `in server ${config.discord.guildId}` : "globally"}.`);
  return result;
}
