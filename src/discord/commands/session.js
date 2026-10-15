// /session: plan a campaign's next session. The DM of the campaign (or an
// administrator) sets a date and time, or pastes a link to a Discord scheduled
// event whose start time is taken over. `set` also creates a Discord event, in
// the campaign's default voice channel or (when it has none) one the DM picks
// or none. 15 minutes before the session the bot checks that the world is up
// and tags the DM if it is not (see sessions.js).

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { canManageCampaign, createSession, describeSession, eventUrl, isCurrentSession, mentionUser, NOT_DM_MESSAGE, parseEventLink, parseSessionTime } from "../../campaigns.js";
import { discordTime } from "../../messages.js";
import { GUILD_ONLY_MESSAGE } from "../permissions.js";
import { defaultVoiceQuestion, scheduleSessionEvent, voicePrompt } from "../sessionEvents.js";
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

  if (sub === "set") {
    const timezone = interaction.options.getString("timezone") ?? config.timezone;
    let at;
    try {
      at = parseSessionTime(interaction.options.getString("when", true), timezone, now());
    } catch (err) {
      return interaction.reply(ephemeral(`That time is not valid: ${err.message}`));
    }
    if (!campaign.voiceChannel) {
      const prompt = voicePrompt("session", `${campaign.id}:${Math.floor(at.getTime() / 1000)}`, campaign);
      return interaction.reply({ ...ephemeral(prompt.content), components: prompt.components });
    }
    await interaction.deferReply();
    return interaction.editReply({ content: await planSession(interaction, ctx, campaign, at, campaign.voiceChannel), allowedMentions: { parse: [] } });
  }

  let session;
  if (sub === "event") {
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
  const from = ` (from the Discord event${session.eventName ? ` **${session.eventName}**` : ""}: ${session.eventUrl})`;
  return interaction.reply({ content: announcement(campaign, at, from), allowedMentions: { parse: [] } });
}

function announcement(campaign, at, extra = "", after = "") {
  const players = campaign.players.length ? `\nPlayers: ${campaign.players.map(mentionUser).join(" ")}` : "";
  return `📅 Next session of **${campaign.name}**: ${discordTime(at, "F")} (${discordTime(at, "R")})${extra}.\nIf world \`${campaign.world}\` is not up 15 minutes before, ${mentionUser(campaign.dm)} will be reminded.${after}${players}`;
}

/**
 * /session set, once the place is known: create the Discord event, set the next session and write it to
 * the world's world.json (the one write to Foundry's folders). Returns the announcement.
 */
async function planSession(interaction, ctx, campaign, at, voiceChannel) {
  const now = ctx.now ?? (() => new Date());
  const { event, url, error, warning, voiceChannel: heldIn } = await scheduleSessionEvent(interaction, ctx, campaign, at, voiceChannel, "Planned with /session set.");
  const session = createSession({ at, source: event ? "event" : "manual", eventId: event?.id ?? null, eventUrl: url, setBy: interaction.user?.id ?? null }, { now });
  if (event) Object.assign(session, { eventName: event.name ?? null, eventCreated: true });
  ctx.state.updateCampaign(interaction.guildId, campaign.id, (c) => {
    c.nextSession = session;
    c.reminderSentFor = null;
  });
  let world;
  try {
    world = ctx.setWorldNextSession ? await ctx.setWorldNextSession(campaign.world, at) : { ok: false, reason: "not available" };
  } catch (err) {
    world = { ok: false, reason: err?.message ?? String(err) };
  }
  if (!world.ok) ctx.log?.warn?.(`Could not set the next session on world ${campaign.world}: ${world.reason}`);
  const lines = [
    url ? `\n📅 Event: ${url}` : `\n⚠️ The Discord event could not be created (${error}), but the session is planned.`,
    url && heldIn ? `\n🔊 Voice channel: <#${heldIn}>` : "",
    url && warning ? `\n⚠️ The event is not held in the voice channel: ${warning}.` : "",
    world.ok ? `\nWorld \`${campaign.world}\` has the date as its next session in Foundry.` : `\n⚠️ Could not set it on world \`${campaign.world}\` in Foundry (${world.reason}).`,
  ];
  return announcement(campaign, at, "", lines.join(""));
}

/** The answer to the voice channel question of /session set: "session:voice:<campaign>:<unix>" or "session:novoice:…". */
export async function handleSessionComponent(interaction, ctx) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply(ephemeral(GUILD_ONLY_MESSAGE));
  const [, action, campaignId, unix] = String(interaction.customId).split(":");
  if (action !== "voice" && action !== "novoice") return undefined;
  const campaign = ctx.state.campaign(guildId, campaignId);
  if (!campaign) return interaction.update({ content: "That campaign no longer exists.", components: [] });
  if (!canManageCampaign(interaction, campaign)) return interaction.reply(ephemeral(NOT_DM_MESSAGE));
  const at = new Date(Number(unix) * 1000);
  if (!(at.getTime() > (ctx.now ?? (() => new Date()))().getTime())) return interaction.update({ content: `${discordTime(at, "F")} is in the past now. Run \`/session set\` again.`, components: [] });
  const voiceChannel = action === "voice" ? (interaction.values?.[0] ?? null) : null;

  await interaction.deferUpdate();
  const content = await planSession(interaction, ctx, campaign, at, voiceChannel);
  await interaction.followUp({ content, allowedMentions: { parse: [] } });
  const done = `✅ Session planned${voiceChannel ? ` with <#${voiceChannel}> as the event's voice channel` : " without a voice channel"}.`;
  if (voiceChannel && !ctx.state.campaign(guildId, campaign.id)?.voiceChannel) {
    const question = defaultVoiceQuestion(campaign, voiceChannel);
    return interaction.editReply({ content: `${done}\n\n${question.text}`, components: question.components, allowedMentions: { parse: [] } });
  }
  return interaction.editReply({ content: done, components: [], allowedMentions: { parse: [] } });
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
