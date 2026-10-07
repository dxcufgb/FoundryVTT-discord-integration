// /gm-role: the server's game master role. Members with it may start and manage
// planning polls (/planning-poll) for any campaign, like the campaign's DM and
// administrators.

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("gm-role")
  .setDescription("Choose the role whose members may plan sessions with polls")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName("set").setDescription("Set the game master role").addRoleOption((o) => o.setName("role").setDescription("The game master role").setRequired(true)))
  .addSubcommand((sub) => sub.setName("clear").setDescription("Remove the game master role"))
  .addSubcommand((sub) => sub.setName("show").setDescription("Show the game master role"));

export const adminOnly = true;

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export async function execute(interaction, ctx) {
  const { state } = ctx;
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();
  if (sub === "set") {
    const role = interaction.options.getRole("role", true);
    state.setGmRole(guildId, role.id);
    return interaction.reply(ephemeral(`Members of <@&${role.id}> can now plan sessions with \`/planning-poll\` for every campaign.`));
  }
  if (sub === "clear") {
    const had = state.guild(guildId).gmRole;
    state.setGmRole(guildId, null);
    return interaction.reply(ephemeral(had ? "The game master role was removed." : "No game master role was set."));
  }
  const id = state.guild(guildId).gmRole;
  return interaction.reply(ephemeral(id ? `The game master role is <@&${id}>.` : "No game master role is set. Administrators and each campaign's DM can still use `/planning-poll`."));
}
