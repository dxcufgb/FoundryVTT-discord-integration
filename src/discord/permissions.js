// Who may run the configuration commands: only members with the Administrator
// permission in the server the command is used in. The commands are also
// registered with a default permission of Administrator, so Discord hides them
// from everyone else; this check is the server-side guarantee behind that.

import { PermissionFlagsBits } from "discord.js";

/**
 * @param {{ inGuild?: () => boolean, guildId?: string|null, memberPermissions?: { has(flag: bigint): boolean }|null }} interaction
 */
export function isGuildAdministrator(interaction) {
  if (!interaction) return false;
  const inGuild = typeof interaction.inGuild === "function" ? interaction.inGuild() : Boolean(interaction.guildId);
  if (!inGuild) return false;
  const perms = interaction.memberPermissions;
  return Boolean(perms && typeof perms.has === "function" && perms.has(PermissionFlagsBits.Administrator));
}

export const NOT_ADMIN_MESSAGE = "Only server administrators can use this command.";
export const GUILD_ONLY_MESSAGE = "This command can only be used inside a server.";
