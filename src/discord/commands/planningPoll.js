// /planning-poll: let a campaign vote on when to play. The starter picks the
// candidate dates, the bot posts a poll tagging the DM and the players, and the
// starter (or any DM/game master/administrator) decides: pick one of the dates
// with the most votes, then a time. That creates a Discord scheduled event,
// announces it in the poll's channel and sets the campaign's next session (see
// sessions.js for the 15-minute check). Poll state lives in state.js so it
// survives restarts; the component handlers are routed from client.js.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, InteractionContextType, MessageFlags, ModalBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { createSession, eventUrl as discordEventUrl, mentionUser, NOT_DM_MESSAGE, zonedToUtc } from "../../campaigns.js";
import { buildDecidedEmbed, buildPollEmbed, campaignMembers, canManagePoll, canRunPoll, createPoll, dateLabel, MAX_POLL_DATES, NO_POLL_MESSAGE, NOT_POLL_MANAGER_MESSAGE, NOT_POLL_VOTER_MESSAGE, parseClock, pollComponents, SESSION_DURATION_MS, setVotes, timeSlots, topDates, upcomingDates } from "../../polls.js";
import { GUILD_ONLY_MESSAGE } from "../permissions.js";
import { autocomplete as campaignAutocomplete, findCampaign, NO_SUCH_CAMPAIGN } from "./campaign.js";

export const data = new SlashCommandBuilder()
  .setName("planning-poll")
  .setDescription("Let a campaign vote on the date of its next session")
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName("campaign").setDescription("Campaign (start typing for suggestions)").setRequired(true).setAutocomplete(true));

// Open in its definition: administrators, the campaign's DM and the server's
// game master role are checked inside the command (like /session).
export const adminOnly = false;
export const autocomplete = campaignAutocomplete;

const ephemeral = (content, extra = {}) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] }, ...extra });
const gmRoleOf = (ctx, guildId) => ctx.state.guild(guildId).gmRole;
const NO_PERMISSION = (gmRole) => `${NOT_DM_MESSAGE}${gmRole ? "" : " (Administrators can also set a game master role with `/gm-role set`.)"}`;

export async function execute(interaction, ctx) {
  const { state, config } = ctx;
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply(ephemeral(GUILD_ONLY_MESSAGE));
  const text = interaction.options.getString("campaign", true);
  const campaign = findCampaign(state, guildId, text);
  if (!campaign) return interaction.reply(ephemeral(NO_SUCH_CAMPAIGN(text)));
  const gmRole = gmRoleOf(ctx, guildId);
  if (!canRunPoll(interaction, campaign, gmRole)) return interaction.reply(ephemeral(NO_PERMISSION(gmRole)));

  const now = (ctx.now ?? (() => new Date()))();
  const dates = upcomingDates(now, config.timezone, MAX_POLL_DATES);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`poll:create:${campaign.id}`)
    .setPlaceholder("Pick the dates to vote on")
    .setMinValues(1)
    .setMaxValues(dates.length)
    .addOptions(dates.map((d) => ({ label: dateLabel(d), value: d })));
  return interaction.reply(ephemeral(`Which dates should **${campaign.name}** vote on? (Dates are in ${config.timezone}.)`, { components: [new ActionRowBuilder().addComponents(menu)] }));
}

// --- component routing ----------------------------------------------------------------

/** Handle a button, select menu or modal whose customId starts with "poll:". */
export async function handlePollComponent(interaction, ctx) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply(ephemeral(GUILD_ONLY_MESSAGE));
  const [, action, ...rest] = String(interaction.customId).split(":");
  switch (action) {
    case "create": return createFromSelection(interaction, ctx, rest[0]);
    case "vote": return vote(interaction, ctx);
    case "decide": return decide(interaction, ctx);
    case "delete": return deletePoll(interaction, ctx);
    case "date": return pickTime(interaction, ctx, rest[0]);
    case "time": return finalize(interaction, ctx, rest[0], rest[1], parseClock(interaction.values[0]));
    case "custom": return askCustomTime(interaction, ctx, rest[0], rest[1]);
    case "modal": return finalize(interaction, ctx, rest[0], rest[1], parseClock(interaction.fields.getTextInputValue("time")), { modal: true });
    default: return undefined;
  }
}

/** Resolve the poll and campaign behind a message (or a poll id), replying when it is gone. */
async function loadPoll(interaction, ctx, pollId = interaction.message?.id) {
  const poll = ctx.state.poll(interaction.guildId, pollId);
  if (!poll) {
    await interaction.reply(ephemeral(NO_POLL_MESSAGE));
    return {};
  }
  return { poll, campaign: ctx.state.campaign(interaction.guildId, poll.campaignId) };
}

async function requireManager(interaction, ctx, poll, campaign) {
  if (campaign && canManagePoll(interaction, poll, campaign, gmRoleOf(ctx, interaction.guildId))) return true;
  await interaction.reply(ephemeral(campaign ? NOT_POLL_MANAGER_MESSAGE : "The campaign of this poll no longer exists."));
  return false;
}

// --- creating ------------------------------------------------------------------------

async function createFromSelection(interaction, ctx, campaignId) {
  const { state, config } = ctx;
  const guildId = interaction.guildId;
  const campaign = state.campaign(guildId, campaignId);
  if (!campaign) return interaction.update({ content: NO_SUCH_CAMPAIGN(campaignId), components: [] });
  if (!canRunPoll(interaction, campaign, gmRoleOf(ctx, guildId))) return interaction.reply(ephemeral(NO_PERMISSION(gmRoleOf(ctx, guildId))));
  const channel = interaction.channel;
  if (!channel?.send) return interaction.update({ content: "The bot cannot post in this channel.", components: [] });

  const now = ctx.now ?? (() => new Date());
  const poll = createPoll({ id: "pending", channelId: channel.id, campaign, dates: interaction.values, createdBy: interaction.user.id, timezone: config.timezone }, { now });
  const message = await channel.send({
    content: `📅 ${campaignMembers(campaign).map(mentionUser).join(" ")} — ${mentionUser(interaction.user.id)} wants to plan the next session of **${campaign.name}**. Vote below!`,
    embeds: [buildPollEmbed(poll, campaign)],
    components: pollComponents(poll),
    allowedMentions: { users: campaignMembers(campaign) },
  });
  poll.id = message.id;
  state.savePoll(guildId, poll);
  return interaction.update({ content: `✅ Poll posted in <#${channel.id}>.`, components: [] });
}

// --- voting --------------------------------------------------------------------------

async function vote(interaction, ctx) {
  const { poll, campaign } = await loadPoll(interaction, ctx);
  if (!poll) return undefined;
  if (!campaign || !campaignMembers(campaign).includes(interaction.user.id)) return interaction.reply(ephemeral(NOT_POLL_VOTER_MESSAGE));
  const updated = ctx.state.updatePoll(interaction.guildId, poll.id, (p) => setVotes(p, interaction.user.id, interaction.values));
  return interaction.update({ embeds: [buildPollEmbed(updated, campaign)] });
}

// --- deleting ------------------------------------------------------------------------

async function deletePoll(interaction, ctx) {
  const { poll, campaign } = await loadPoll(interaction, ctx);
  if (!poll || !(await requireManager(interaction, ctx, poll, campaign))) return undefined;
  ctx.state.deletePoll(interaction.guildId, poll.id);
  await interaction.deferUpdate();
  try {
    await interaction.message.delete();
  } catch (err) {
    ctx.log?.warn?.("Could not delete the poll message:", err?.message ?? err);
    await interaction.message.edit({ content: "🗑️ Poll deleted.", embeds: [], components: [] }).catch(() => {});
  }
  return undefined;
}

// --- deciding: date, then time ---------------------------------------------------------

async function decide(interaction, ctx) {
  const { poll, campaign } = await loadPoll(interaction, ctx);
  if (!poll || !(await requireManager(interaction, ctx, poll, campaign))) return undefined;
  const top = topDates(poll);
  if (!top.dates.length) return interaction.reply(ephemeral("Nobody has voted yet, so there is nothing to decide."));
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`poll:date:${poll.id}`)
    .setPlaceholder("Pick the date")
    .addOptions(top.dates.map((d) => ({ label: dateLabel(d), value: d, description: `${top.votes} vote${top.votes === 1 ? "" : "s"}` })));
  const what = top.dates.length === 1 ? "The date with the most votes" : "These dates are tied for the most votes";
  return interaction.reply(ephemeral(`${what} (${top.votes} each). Which date do you want?`, { components: [new ActionRowBuilder().addComponents(menu)] }));
}

async function pickTime(interaction, ctx, pollId) {
  const { poll, campaign } = await loadPoll(interaction, ctx, pollId);
  if (!poll || !(await requireManager(interaction, ctx, poll, campaign))) return undefined;
  const date = interaction.values[0];
  if (!poll.dates.includes(date)) return interaction.update({ content: "That date is not part of the poll.", components: [] });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`poll:time:${poll.id}:${date}`)
    .setPlaceholder("Pick the start time")
    .addOptions(timeSlots().map((t) => ({ label: t, value: t })));
  const custom = new ButtonBuilder().setCustomId(`poll:custom:${poll.id}:${date}`).setLabel("Other time…").setStyle(ButtonStyle.Secondary);
  return interaction.update({ content: `At what time on **${dateLabel(date)}**? (${poll.timezone})`, components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(custom)] });
}

async function askCustomTime(interaction, ctx, pollId, date) {
  const { poll, campaign } = await loadPoll(interaction, ctx, pollId);
  if (!poll || !(await requireManager(interaction, ctx, poll, campaign))) return undefined;
  const input = new TextInputBuilder().setCustomId("time").setLabel(`Start time on ${dateLabel(date)} (${poll.timezone})`).setPlaceholder("19:30").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(5);
  return interaction.showModal(new ModalBuilder().setCustomId(`poll:modal:${poll.id}:${date}`).setTitle("Session start time").addComponents(new ActionRowBuilder().addComponents(input)));
}

/** Time chosen: create the event, announce it, set the campaign's next session, close the poll. */
async function finalize(interaction, ctx, pollId, date, clock, { modal = false } = {}) {
  const { state } = ctx;
  const guildId = interaction.guildId;
  const { poll, campaign } = await loadPoll(interaction, ctx, pollId);
  if (!poll || !(await requireManager(interaction, ctx, poll, campaign))) return undefined;
  if (!clock) return interaction.reply(ephemeral("That is not a time. Write it as HH:MM, for example 19:30."));
  if (!poll.dates.includes(date)) return interaction.reply(ephemeral("That date is not part of the poll."));
  if (!topDates(poll).dates.includes(date)) return interaction.reply(ephemeral("That date no longer has the most votes. Press **Decide date** again."));
  const now = ctx.now ?? (() => new Date());
  const [year, month, day] = date.split("-").map(Number);
  const at = zonedToUtc({ year, month, day, hour: clock.hour, minute: clock.minute }, poll.timezone);
  if (at.getTime() <= now().getTime()) return interaction.reply(ephemeral(`That moment (<t:${Math.floor(at.getTime() / 1000)}:F>) is in the past. Pick a later time.`));

  // From here the poll is settled: closing it first keeps a second click from deciding it twice.
  // Acknowledge first: a failed acknowledgement must not leave the poll deleted. Closing the poll is the claim; the loser only follows up.
  if (modal) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  if (!state.deletePoll(guildId, poll.id)) return interaction.followUp(ephemeral(NO_POLL_MESSAGE));
  const reply = (content) => (modal ? interaction.editReply({ content, allowedMentions: { parse: [] } }) : interaction.editReply({ content, components: [], allowedMentions: { parse: [] } }));

  let event = null;
  let eventError = null;
  try {
    event = await createEvent(interaction, ctx, campaign, at);
  } catch (err) {
    eventError = err?.message ?? String(err);
    ctx.log?.warn?.("Could not create the Discord event:", eventError);
  }
  const url = event?.id ? discordEventUrl(guildId, event.id) : null;

  const session = createSession({ at, source: event ? "event" : "poll", eventId: event?.id ?? null, eventUrl: url, setBy: interaction.user.id }, { now });
  if (event) session.eventName = event.name ?? null;
  state.updateCampaign(guildId, campaign.id, (c) => {
    c.nextSession = session;
    c.reminderSentFor = null;
  });
  // The one write to Foundry's folders: the world's own "next session" date.
  let world;
  try {
    world = ctx.setWorldNextSession ? await ctx.setWorldNextSession(campaign.world, at) : { ok: false, reason: "not available" };
  } catch (err) {
    world = { ok: false, reason: err?.message ?? String(err) };
  }
  if (!world.ok) ctx.log?.warn?.(`Could not set the next session on world ${campaign.world}: ${world.reason}`);
  if (eventError && /permission/i.test(eventError)) ctx.checkHealth?.(interaction.guild).catch?.(() => {});

  const unix = Math.floor(at.getTime() / 1000);
  const announcement =
    `🎲 ${campaignMembers(campaign).map(mentionUser).join(" ")} — the next session of **${campaign.name}** is on <t:${unix}:F> (<t:${unix}:R>)!` +
    (url ? `\n📅 Event: ${url}` : "") +
    (eventError ? `\n⚠️ The Discord event could not be created (${eventError}), but the session is planned.` : "");
  const channel = interaction.channel ?? (await ctx.client?.channels?.fetch(poll.channelId).catch(() => null));
  let announcementError = null;
  if (channel?.send) {
    try {
      await channel.send({ content: announcement, allowedMentions: { users: campaignMembers(campaign) } });
    } catch (err) {
      announcementError = err?.message ?? String(err);
      ctx.log?.warn?.("Could not announce the planned session:", announcementError);
    }
  } else {
    announcementError = "the announcement channel is unavailable";
  }

  try {
    const pollMessage = await channel?.messages?.fetch(poll.id);
    await pollMessage?.edit({ content: "", embeds: [buildDecidedEmbed(poll, at, url)], components: [] });
  } catch (err) {
    ctx.log?.debug?.("Could not update the poll message:", err?.message ?? err);
  }
  const foundry = world.ok ? `world \`${campaign.world}\` has the date as its next session` : `⚠️ the next session could not be set on world \`${campaign.world}\` (${world.reason})`;
  const announced = announcementError ? `⚠️ the announcement failed (${announcementError})` : `The session is announced${eventError ? "; the event could not be created" : " and the event is created"}`;
  return reply(`✅ Decided: <t:${unix}:F>. ${announced}, and ${foundry}.`);
}

async function createEvent(interaction, ctx, campaign, at) {
  const guild = interaction.guild ?? (ctx.client?.guilds ? await ctx.client.guilds.fetch(interaction.guildId) : null);
  if (!guild?.scheduledEvents) throw new Error("the server is not available to the bot");
  const world = ctx.worldTitle?.(campaign.world) ?? campaign.world;
  return guild.scheduledEvents.create({
    name: `${campaign.name} session`.slice(0, 100),
    scheduledStartTime: at,
    scheduledEndTime: new Date(at.getTime() + SESSION_DURATION_MS),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location: `Foundry VTT: ${world}`.slice(0, 100) },
    description: `Next session of ${campaign.name}. Planned with a poll.`,
  });
}
