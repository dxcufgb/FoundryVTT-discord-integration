// The Discord scheduled event of a planned session, and where it takes place.
// A campaign may have a default voice channel (`campaign.voiceChannel`); the
// event is then held there. Without one, whoever plans the session (planning
// poll or /session set) is asked to pick one of the server's voice channels or
// to skip, and after a pick whether that channel should become the campaign's
// default. Those "vc:" buttons are routed here from client.js.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, MessageFlags } from "discord.js";
import { eventUrl } from "../campaigns.js";
import { canRunPoll, SESSION_DURATION_MS } from "../polls.js";
import { missingEventPermissions } from "./health.js";

export const VOICE_CHANNEL_TYPES = Object.freeze([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** The question asked when a campaign has no default voice channel; `prefix` routes the answer back ("poll:…:<key>" or "session:…:<key>"). */
export function voicePrompt(prefix, key, campaign) {
  const menu = new ChannelSelectMenuBuilder()
    .setCustomId(`${prefix}:voice:${key}`)
    .setPlaceholder("Pick a voice channel")
    .setChannelTypes(...VOICE_CHANNEL_TYPES)
    .setMinValues(1)
    .setMaxValues(1);
  const skip = new ButtonBuilder().setCustomId(`${prefix}:novoice:${key}`).setLabel("Skip (no voice channel)").setStyle(ButtonStyle.Secondary);
  return {
    content: `**${campaign.name}** has no default voice channel. Should the Discord event be held in one of the server's voice channels? Pick one, or skip.`,
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(skip)],
  };
}

/** Yes/No buttons: make the voice channel just picked the campaign's default. */
export function defaultVoiceQuestion(campaign, channelId) {
  return {
    text: `Make <#${channelId}> the default voice channel of **${campaign.name}**, so its next events use it without asking?`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vc:yes:${campaign.id}:${channelId}`).setLabel("Yes, make it the default").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`vc:no:${campaign.id}:${channelId}`).setLabel("No").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export const voiceChannelHelp = (campaign) =>
  `To give **${campaign.name}** a default voice channel later, use \`/campaign voice-channel campaign:${campaign.name} channel:<voice channel>\` ` +
  `(the campaign's DM, a game master or an administrator); \`/campaign voice-channel campaign:${campaign.name} clear:True\` removes it again. ` +
  "Until then you are asked each time a session is planned.";

/** Handle a "vc:yes:<campaign>:<channel>" or "vc:no:<campaign>:<channel>" button. */
export async function handleVoiceDefault(interaction, ctx) {
  const { state } = ctx;
  const [, answer, campaignId, channelId] = String(interaction.customId).split(":");
  const campaign = state.campaign(interaction.guildId, campaignId);
  if (!campaign) return interaction.update({ content: "That campaign no longer exists.", components: [] });
  if (answer !== "yes") return interaction.update({ content: `OK, <#${channelId}> is not saved as the default.\n${voiceChannelHelp(campaign)}`, components: [] });
  if (!canSetVoiceChannel(interaction, campaign, ctx)) return interaction.reply(ephemeral(NOT_VOICE_MANAGER_MESSAGE));
  state.updateCampaign(interaction.guildId, campaign.id, (c) => (c.voiceChannel = channelId));
  return interaction.update({ content: `🔊 <#${channelId}> is now the default voice channel of **${campaign.name}**. Change or remove it with \`/campaign voice-channel\`.`, components: [] });
}

export const NOT_VOICE_MANAGER_MESSAGE = "Only the campaign's DM, a game master or a server administrator can do that.";

/** Who may set a campaign's default voice channel: administrators, its DM and the server's game masters (the people who plan its sessions). */
export function canSetVoiceChannel(interaction, campaign, ctx) {
  return canRunPoll(interaction, campaign, ctx.state.guild(interaction.guildId).gmRole);
}

async function guildOf(interaction, ctx) {
  const guild = interaction.guild ?? (ctx.client?.guilds ? await ctx.client.guilds.fetch(interaction.guildId) : null);
  if (!guild?.scheduledEvents) throw new Error("the server is not available to the bot");
  return guild;
}

/**
 * Where a voice or stage event can be held: { entityType, channel } or, when the bot cannot hold it there,
 * { problem } (the channel is gone, or the bot lacks the permissions Discord asks for in it).
 */
async function voiceLocation(guild, channelId) {
  if (!guild.channels) return { entityType: GuildScheduledEventEntityType.Voice, channel: channelId };
  const channel = guild.channels.cache?.get(channelId) ?? (await Promise.resolve(guild.channels.fetch?.(channelId)).catch(() => null));
  if (!channel) return { problem: `the voice channel <#${channelId}> no longer exists or the bot cannot see it` };
  const stage = channel.type === ChannelType.GuildStageVoice;
  const missing = missingEventPermissions(guild, channel, stage);
  if (missing.length) return { problem: `the bot lacks **${missing.join(", ")}** in <#${channelId}>; give the bot's role ${missing.length > 1 ? "these permissions" : "that permission"} there (the channel's permission overrides) and plan the session again` };
  return { entityType: stage ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice, channel: channelId };
}

/**
 * Create the Discord event of a session: in `voiceChannel` when given, otherwise an external event "at" the
 * Foundry world. When the voice channel cannot be used (gone, missing permissions, refused by Discord) the
 * event is created as an external one instead and `warning` says why. When the campaign's planned session
 * still has an upcoming event the bot created, that event is moved instead, so planning again does not leave
 * a stale event behind.
 * Never throws: returns { event, url, error, warning, voiceChannel } (`voiceChannel`: where the event is held, or null).
 */
export async function scheduleSessionEvent(interaction, ctx, campaign, at, voiceChannel, how) {
  try {
    const guild = await guildOf(interaction, ctx);
    const world = ctx.worldTitle?.(campaign.world) ?? campaign.world;
    const base = {
      name: `${campaign.name} session`.slice(0, 100),
      scheduledStartTime: at,
      scheduledEndTime: new Date(at.getTime() + SESSION_DURATION_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      description: `Next session of ${campaign.name} (Foundry VTT: ${world}). ${how}`.slice(0, 1000),
    };
    // Moving an event out of a voice channel has to clear its channel.
    const external = { ...base, entityType: GuildScheduledEventEntityType.External, entityMetadata: { location: `Foundry VTT: ${world}`.slice(0, 100) }, channel: null };
    const previous = campaign.nextSession;
    const now = (ctx.now ?? (() => new Date()))();
    const movable = previous?.eventCreated && previous.eventId && new Date(previous.at) > now && guild.scheduledEvents.edit;
    const place = async (options) => {
      let event = null;
      if (movable) {
        event = await guild.scheduledEvents.edit(previous.eventId, options).catch((err) => {
          ctx.log?.debug?.("Could not move the previous session event; creating a new one:", err?.message ?? err);
          return null;
        });
      }
      if (!event) {
        const { channel, ...rest } = options;
        event = await guild.scheduledEvents.create(channel ? options : rest);
      }
      return event;
    };

    let event = null;
    let warning = null;
    if (voiceChannel) {
      const location = await voiceLocation(guild, voiceChannel);
      if (location.problem) warning = location.problem;
      else {
        event = await place({ ...base, entityType: location.entityType, channel: location.channel }).catch((err) => {
          warning = `Discord refused an event in <#${voiceChannel}>: ${err?.message ?? err}`;
          return null;
        });
      }
      if (warning) ctx.log?.warn?.(`The session event cannot be held in voice channel ${voiceChannel}; creating it without one:`, warning);
    }
    event ??= await place(external);
    const held = warning ? null : voiceChannel ?? null;
    return { event, url: event?.id ? eventUrl(interaction.guildId, event.id) : null, error: null, warning, voiceChannel: held };
  } catch (err) {
    const error = err?.message ?? String(err);
    ctx.log?.warn?.("Could not create the Discord event:", error);
    if (/permission/i.test(error)) ctx.checkHealth?.(interaction.guild)?.catch?.(() => {});
    return { event: null, url: null, error, warning: null, voiceChannel: null };
  }
}
