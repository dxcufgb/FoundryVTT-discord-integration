// /session: plan a campaign's next session. The DM of the campaign (or an
// administrator) sets a date and time, or pastes a link to a Discord scheduled
// event whose start time is taken over. 15 minutes before the session the bot
// checks that the world is up and tags the DM if it is not (see sessions.js).

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { canManageCampaign, createSession, describeSession, eventUrl, isCurrentSession, mentionUser, NOT_DM_MESSAGE, parseEventLink, parseSessionTime } from "../../campaigns.js";
import { discordTime } from "../../messages.js";
import { GUILD_ONLY_MESSAGE } from "../permissions.js";
import { autocomplete as campaignAutocomplete, findCampaign, NO_SUCH_CAMPAIGN } from "./campaign.js";

const campaignOption = (o, required = true) => o.setName("campaign").setDescription("Campaign (start typing for suggestions)").setRequired(required).setAutocomplete(true);

export const data = new SlashCommandBuilder()
  .setName("session")
  .setDescription("Plan the next session of a campaign")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Set the date and time of the next session (DM or administrators)")
      .addStringOption((o) => campaignOption(o))
      .addStringOption((o) => o.setName("when").setDescription("YYYY-MM-DD HH:MM, today HH:MM, tomorrow HH:MM or a Discord timestamp").setRequired(true))
      .addStringOption((o) => o.setName("timezone").setDescription("IANA timezone the time is written in (default: the bot's TIMEZONE)")),
  )
  .addSubcommand((sub) =>
    sub
      .setName("event")
      .setDescription("Take the next session's date and time from a Discord event (DM or administrators)")
      .addStringOption((o) => campaignOption(o))
      .addStringOption((o) => o.setName("link").setDescription("Link to the Discord event (https://discord.com/events/…), or its id").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("clear").setDescription("Remove the planned session (DM or administrators)").addStringOption((o) => campaignOption(o)))
  .addSubcommand((sub) => sub.setName("show").setDescription("Show the next session of one campaign, or of all campaigns").addStringOption((o) => campaignOption(o, false)));

export const adminOnly = false;

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export async function execute(interaction, ctx) {
  const { state, config } = ctx;
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply(ephemeral(GUILD_ONLY_MESSAGE));
  const sub = interaction.options.getSubcommand();
  const now = ctx.now ?? (() => new Date());
  const me = interaction.user?.id ?? interaction.member?.user?.id ?? null;

  if (sub === "show") {
    const text = interaction.options.getString("campaign");
    if (text) {
      const campaign = findCampaign(state, guildId, text);
      if (!campaign) return interaction.reply(ephemeral(NO_SUCH_CAMPAIGN(text)));
      return interaction.reply({ content: `**${campaign.name}** (world \`${campaign.world}\`, DM ${mentionUser(campaign.dm)}): ${sessionLine(campaign, now())}`, allowedMentions: { parse: [] } });
    }
    return interaction.reply({ content: describeSessions(state, guildId, now()), allowedMentions: { parse: [] } });
  }

  const campaign = findCampaign(state, guildId, interaction.options.getString("campaign", true));
  if (!campaign) return interaction.reply(ephemeral(NO_SUCH_CAMPAIGN(interaction.options.getString("campaign"))));
  if (!canManageCampaign(interaction, campaign)) return interaction.reply(ephemeral(NOT_DM_MESSAGE));

  if (sub === "clear") {
    const had = Boolean(campaign.nextSession);
    state.updateCampaign(guildId, campaign.id, (c) => {
      c.nextSession = null;
      c.reminderSentFor = null;
    });
    return interaction.reply(had ? { content: `The planned session of **${campaign.name}** was removed.`, allowedMentions: { parse: [] } } : ephemeral(`**${campaign.name}** had no planned session.`));
  }

  let session;
  if (sub === "set") {
    const timezone = interaction.options.getString("timezone") ?? config.timezone;
    try {
      session = createSession({ at: parseSessionTime(interaction.options.getString("when", true), timezone, now()), source: "manual", setBy: me }, { now });
    } catch (err) {
      return interaction.reply(ephemeral(`That time is not valid: ${err.message}`));
    }
  } else if (sub === "event") {
    const link = interaction.options.getString("link", true);
    const ref = parseEventLink(link);
    if (!ref) return interaction.reply(ephemeral("That is not a link to a Discord event. Open the event, choose *Copy Event Link* and paste it (https://discord.com/events/<server>/<event>)."));
    if (ref.guildId && ref.guildId !== guildId) return interaction.reply(ephemeral("That event belongs to another server."));
    let event;
    try {
      event = await fetchScheduledEvent(interaction, ctx, ref.eventId);
    } catch (err) {
      return interaction.reply(ephemeral(`Could not read that event: ${err.message}. Does it still exist, and is the bot in this server?`));
    }
    const start = event?.scheduledStartAt ?? (event?.scheduledStartTimestamp ? new Date(event.scheduledStartTimestamp) : null);
    if (!start || Number.isNaN(start.getTime())) return interaction.reply(ephemeral("That event has no start time."));
    if (start.getTime() <= now().getTime()) return interaction.reply(ephemeral(`That event started ${discordTime(start, "R")}; pick an upcoming one.`));
    session = createSession({ at: start, source: "event", eventId: ref.eventId, eventUrl: eventUrl(guildId, ref.eventId), setBy: me }, { now });
    session.eventName = event.name ?? null;
  }

  state.updateCampaign(guildId, campaign.id, (c) => {
    c.nextSession = session;
    c.reminderSentFor = null;
  });
  const at = new Date(session.at);
  const from = session.source === "event" ? ` (from the Discord event${session.eventName ? ` **${session.eventName}**` : ""}: ${session.eventUrl})` : "";
  const players = campaign.players.length ? `\nPlayers: ${campaign.players.map(mentionUser).join(" ")}` : "";
  return interaction.reply({
    content: `📅 Next session of **${campaign.name}**: ${discordTime(at, "F")} (${discordTime(at, "R")})${from}.\nIf world \`${campaign.world}\` is not up 15 minutes before, ${mentionUser(campaign.dm)} will be reminded.${players}`,
    allowedMentions: { parse: [] },
  });
}

async function fetchScheduledEvent(interaction, ctx, eventId) {
  const guild = interaction.guild ?? (ctx.client?.guilds ? await ctx.client.guilds.fetch(interaction.guildId) : null);
  if (!guild?.scheduledEvents) throw new Error("the server is not available to the bot");
  return guild.scheduledEvents.fetch(eventId);
}

function sessionLine(campaign, now) {
  const current = isCurrentSession(campaign.nextSession, now) ? campaign.nextSession : null;
  if (current) return describeSession(current, now);
  return campaign.lastSession ? `No session planned (the last one was ${discordTime(campaign.lastSession.at, "D")}).` : "No session planned.";
}

export function describeSessions(state, guildId, now = new Date()) {
  const campaigns = state.campaigns(guildId);
  if (!campaigns.length) return "No campaigns yet. An administrator can create one with `/campaign create`.";
  return campaigns.map((c) => `• **${c.name}** (DM ${mentionUser(c.dm)}): ${sessionLine(c, now)}`).join("\n");
}

export const autocomplete = campaignAutocomplete;
