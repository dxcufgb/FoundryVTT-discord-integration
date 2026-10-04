import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { MESSAGE_TYPES } from "../../state.js";

export const TYPE_DESCRIPTIONS = Object.freeze({
  default: "Fallback for any message type without its own channel",
  status: "Foundry went down / came back up",
  world: "A world was started or shut down",
  updates: "Foundry, system and module updates",
  restart: "Restart window opened / Foundry did not come back",
});

const typeChoices = MESSAGE_TYPES.map((t) => ({ name: `${t} – ${TYPE_DESCRIPTIONS[t]}`, value: t }));

export const data = new SlashCommandBuilder()
  .setName("channel")
  .setDescription("Choose which channel each kind of Foundry message is posted in (administrators only)")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Post one kind of message in a channel")
      .addStringOption((o) => o.setName("type").setDescription("Kind of message").setRequired(true).addChoices(...typeChoices))
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel to post in (defaults to this one)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Stop posting one kind of message")
      .addStringOption((o) => o.setName("type").setDescription("Kind of message").setRequired(true).addChoices(...typeChoices)),
  )
  .addSubcommand((sub) => sub.setName("list").setDescription("Show where each kind of message goes"))
  .addSubcommand((sub) =>
    sub
      .setName("mention")
      .setDescription("Role to ping when Foundry goes down unexpectedly (leave empty to stop pinging)")
      .addRoleOption((o) => o.setName("role").setDescription("Role to mention")),
  );

export const adminOnly = true;

export async function execute(interaction, { state }) {
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  if (sub === "set") {
    const type = interaction.options.getString("type", true);
    const channel = interaction.options.getChannel("channel") ?? interaction.channel;
    if (!channel) return interaction.reply({ content: "Pick a channel.", flags: MessageFlags.Ephemeral });
    state.setChannel(guildId, type, channel.id);
    return interaction.reply({ content: `**${type}** messages will be posted in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "clear") {
    const type = interaction.options.getString("type", true);
    const had = state.clearChannel(guildId, type);
    return interaction.reply({ content: had ? `**${type}** messages are no longer posted anywhere in this server.` : `No channel was set for **${type}** messages.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === "mention") {
    const role = interaction.options.getRole("role");
    state.setMentionRole(guildId, role?.id ?? null);
    return interaction.reply({ content: role ? `<@&${role.id}> will be pinged when Foundry goes down unexpectedly.` : "No role will be pinged.", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }

  return interaction.reply({ content: describeChannels(state, guildId), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

export function describeChannels(state, guildId) {
  const guild = state.guild(guildId);
  const lines = MESSAGE_TYPES.map((type) => {
    const own = guild.channels[type];
    const resolved = state.resolveChannel(guildId, type);
    let where = "not posted";
    if (own) where = `<#${own}>`;
    else if (resolved) where = `<#${resolved}> (via default)`;
    return `• **${type}** – ${TYPE_DESCRIPTIONS[type]}: ${where}`;
  });
  lines.push(guild.mentionRole ? `• Ping on unexpected downtime: <@&${guild.mentionRole}>` : "• Ping on unexpected downtime: nobody");
  return lines.join("\n");
}
