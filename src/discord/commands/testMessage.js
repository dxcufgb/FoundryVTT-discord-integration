import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { MESSAGE_TYPES } from "../../state.js";
import { COLORS } from "../../messages.js";

export const data = new SlashCommandBuilder()
  .setName("test-message")
  .setDescription("Post a test message to check where a kind of message ends up (administrators only)")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) => o.setName("type").setDescription("Kind of message").setRequired(true).addChoices(...MESSAGE_TYPES.filter((t) => t !== "default").map((t) => ({ name: t, value: t }))));

export const adminOnly = true;

export async function execute(interaction, { state, notifier }) {
  const type = interaction.options.getString("type", true);
  const channelId = state.resolveChannel(interaction.guildId, type);
  if (!channelId) return interaction.reply({ content: `No channel is set for **${type}** messages (and no default). Use \`/channel set\` first.`, flags: MessageFlags.Ephemeral });
  try {
    await notifier.sendTo(channelId, { embeds: [{ title: "🧪 Test message", description: `This is where **${type}** messages will be posted.`, color: COLORS.grey, timestamp: new Date().toISOString() }] });
  } catch (err) {
    return interaction.reply({ content: `Could not post in <#${channelId}>: ${err.message}. Does the bot have permission to view and send messages there?`, flags: MessageFlags.Ephemeral });
  }
  return interaction.reply({ content: `Posted a test **${type}** message in <#${channelId}>.`, flags: MessageFlags.Ephemeral });
}
