// /campaign: bind Discord users to campaigns. Each campaign is one Foundry
// world with exactly one DM and any number of players; a user can be in any
// number of campaigns. Creating, deleting and editing campaigns is for
// administrators; the DM (or an administrator) manages the players; anyone can
// join, leave, list and show.

import { ChannelType, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { canManageCampaign, createCampaign, describeCampaign, isCurrentSession, MAX_CAMPAIGN_NAME, mentionUser, normaliseWorldId, NOT_DM_MESSAGE, slugify, uniqueUsers } from "../../campaigns.js";
import { discordTime } from "../../messages.js";
import { GUILD_ONLY_MESSAGE } from "../permissions.js";

const campaignOption = (o, description = "Campaign (start typing for suggestions)") => o.setName("campaign").setDescription(description).setRequired(true).setAutocomplete(true);
const worldOption = (o, required) => o.setName("world").setDescription("Foundry world id, the folder name under Data/worlds (start typing for suggestions)").setRequired(required).setAutocomplete(true);

export const data = new SlashCommandBuilder()
  .setName("campaign")
  .setDescription("Campaigns: which Foundry world, who is the DM and who plays")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Create a campaign bound to one Foundry world with one DM (administrators only)")
      .addStringOption((o) => o.setName("name").setDescription("Campaign name").setRequired(true).setMaxLength(MAX_CAMPAIGN_NAME))
      .addStringOption((o) => worldOption(o, true))
      .addUserOption((o) => o.setName("dm").setDescription("The campaign's DM").setRequired(true))
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for this campaign's session messages (default: the server's session channel)").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
      ),
  )
  .addSubcommand((sub) => sub.setName("delete").setDescription("Delete a campaign (administrators only)").addStringOption((o) => campaignOption(o)))
  .addSubcommand((sub) =>
    sub
      .setName("edit")
      .setDescription("Change a campaign's name, world, DM or channel (administrators only)")
      .addStringOption((o) => campaignOption(o))
      .addStringOption((o) => o.setName("name").setDescription("New name").setMaxLength(MAX_CAMPAIGN_NAME))
      .addStringOption((o) => worldOption(o, false))
      .addUserOption((o) => o.setName("dm").setDescription("New DM"))
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel for this campaign's session messages").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread),
      )
      .addBooleanOption((o) => o.setName("clear-channel").setDescription("Go back to the server's session channel")),
  )
  .addSubcommand((sub) =>
    sub.setName("add-player").setDescription("Add a player to a campaign (DM or administrators)").addStringOption((o) => campaignOption(o)).addUserOption((o) => o.setName("user").setDescription("Player to add").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub.setName("remove-player").setDescription("Remove a player from a campaign (DM or administrators)").addStringOption((o) => campaignOption(o)).addUserOption((o) => o.setName("user").setDescription("Player to remove").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("join").setDescription("Join a campaign as a player").addStringOption((o) => campaignOption(o)))
  .addSubcommand((sub) => sub.setName("leave").setDescription("Leave a campaign").addStringOption((o) => campaignOption(o)))
  .addSubcommand((sub) => sub.setName("list").setDescription("List the campaigns in this server"))
  .addSubcommand((sub) => sub.setName("show").setDescription("Show a campaign: world, DM, players and next session").addStringOption((o) => campaignOption(o)));

export const adminOnly = false;
export const adminSubcommands = new Set(["create", "delete", "edit"]);

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** Find a campaign by what the user typed: its id, or its name. */
export function findCampaign(state, guildId, text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const direct = state.campaign(guildId, raw);
  if (direct) return direct;
  let slug;
  try {
    slug = slugify(raw);
  } catch {
    return null;
  }
  return state.campaign(guildId, slug) ?? state.campaigns(guildId).find((c) => c.name.toLowerCase() === raw.toLowerCase()) ?? null;
}

export const NO_SUCH_CAMPAIGN = (text) => `There is no campaign called **${text}** in this server. Use \`/campaign list\` to see them.`;

/**
 * Check a world id against the worlds on disk, when the bot can see them. With
 * no FOUNDRY_DATA_PATH every well-formed id is accepted.
 * @returns {string} the world id
 */
export function resolveWorld(text, listWorlds) {
  const typed = String(text ?? "").trim();
  const known = safeList(listWorlds);
  if (!known.length) return normaliseWorldId(typed);
  const exact = known.find((w) => w.id === typed);
  if (exact) return exact.id;
  const byTitle = known.filter((w) => w.title.toLowerCase() === typed.toLowerCase());
  if (byTitle.length === 1) return byTitle[0].id;
  const names = known.slice(0, 15).map((w) => `\`${w.id}\``).join(", ");
  throw new Error(`There is no world "${typed}" on the Foundry server. Worlds found: ${names}${known.length > 15 ? ", …" : ""}`);
}

function safeList(listWorlds) {
  try {
    return listWorlds?.() ?? [];
  } catch {
    return [];
  }
}

export async function execute(interaction, ctx) {
  const { state } = ctx;
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply(ephemeral(GUILD_ONLY_MESSAGE));
  const sub = interaction.options.getSubcommand();
  const now = ctx.now ?? (() => new Date());
  const worldTitle = ctx.worldTitle ?? (() => null);
  const me = interaction.user?.id ?? interaction.member?.user?.id;

  if (sub === "create") {
    const name = interaction.options.getString("name", true);
    const dm = interaction.options.getUser("dm", true);
    if (dm.bot) return interaction.reply(ephemeral("A bot cannot be the DM."));
    let campaign;
    try {
      const world = resolveWorld(interaction.options.getString("world", true), ctx.listWorlds);
      campaign = createCampaign({ name, world, dm: dm.id, channel: interaction.options.getChannel("channel")?.id ?? null, createdBy: me }, { now });
    } catch (err) {
      return interaction.reply(ephemeral(`Could not create the campaign: ${err.message}`));
    }
    if (state.campaign(guildId, campaign.id)) return interaction.reply(ephemeral(`A campaign called **${state.campaign(guildId, campaign.id).name}** already exists. Pick another name or use \`/campaign edit\`.`));
    const clash = state.campaignForWorld(guildId, campaign.world);
    if (clash) return interaction.reply(ephemeral(`World \`${campaign.world}\` is already bound to **${clash.name}**. Each world can only belong to one campaign in a server.`));
    state.saveCampaign(guildId, campaign);
    return interaction.reply({ content: `Campaign created.\n${describeCampaign(campaign, { worldTitle, now: now() })}\n\nPlayers can join with \`/campaign join campaign:${campaign.name}\`; the DM plans sessions with \`/session set\` or \`/session event\`.`, allowedMentions: { parse: [] } });
  }

  const campaign = findCampaign(state, guildId, interaction.options.getString("campaign", sub !== "list"));
  if (sub !== "list" && !campaign) return interaction.reply(ephemeral(NO_SUCH_CAMPAIGN(interaction.options.getString("campaign"))));

  if (sub === "delete") {
    state.deleteCampaign(guildId, campaign.id);
    return interaction.reply(ephemeral(`Campaign **${campaign.name}** (world \`${campaign.world}\`) was deleted.`));
  }

  if (sub === "edit") {
    const name = interaction.options.getString("name");
    const worldText = interaction.options.getString("world");
    const dm = interaction.options.getUser("dm");
    const channel = interaction.options.getChannel("channel");
    const clearChannel = interaction.options.getBoolean("clear-channel") ?? false;
    if (name === null && worldText === null && !dm && !channel && !clearChannel) return interaction.reply(ephemeral("Nothing to change: give a new name, world, dm or channel."));
    if (dm?.bot) return interaction.reply(ephemeral("A bot cannot be the DM."));
    let world = campaign.world;
    let newId = campaign.id;
    try {
      if (worldText !== null) world = resolveWorld(worldText, ctx.listWorlds);
      if (name !== null) {
        if (!name.trim()) throw new Error("the name cannot be empty");
        newId = slugify(name);
      }
    } catch (err) {
      return interaction.reply(ephemeral(`Could not change the campaign: ${err.message}`));
    }
    if (newId !== campaign.id && state.campaign(guildId, newId)) return interaction.reply(ephemeral(`A campaign called **${state.campaign(guildId, newId).name}** already exists.`));
    const clash = world !== campaign.world ? state.campaignForWorld(guildId, world) : null;
    if (clash) return interaction.reply(ephemeral(`World \`${world}\` is already bound to **${clash.name}**.`));

    const updated = { ...campaign, id: newId, name: name !== null ? name.trim() : campaign.name, world };
    if (dm) {
      updated.dm = dm.id;
      updated.players = uniqueUsers(campaign.players, dm.id);
    }
    if (clearChannel) updated.channel = null;
    else if (channel) updated.channel = channel.id;
    if (newId !== campaign.id) state.deleteCampaign(guildId, campaign.id);
    state.saveCampaign(guildId, updated);
    return interaction.reply(ephemeral(`Campaign updated.\n${describeCampaign(updated, { worldTitle, now: now() })}`));
  }

  if (sub === "add-player" || sub === "remove-player") {
    if (!canManageCampaign(interaction, campaign)) return interaction.reply(ephemeral(NOT_DM_MESSAGE));
    const user = interaction.options.getUser("user", true);
    if (user.bot) return interaction.reply(ephemeral("Bots cannot be players."));
    if (sub === "add-player") {
      if (user.id === campaign.dm) return interaction.reply(ephemeral(`${mentionUser(user.id)} is the DM of **${campaign.name}** and is already part of it.`));
      if (campaign.players.includes(user.id)) return interaction.reply(ephemeral(`${mentionUser(user.id)} is already a player in **${campaign.name}**.`));
      const updated = state.updateCampaign(guildId, campaign.id, (c) => c.players.push(user.id));
      return interaction.reply({ content: `${mentionUser(user.id)} was added to **${campaign.name}** (${updated.players.length} player${updated.players.length === 1 ? "" : "s"}).`, allowedMentions: { parse: [] } });
    }
    if (!campaign.players.includes(user.id)) return interaction.reply(ephemeral(`${mentionUser(user.id)} is not a player in **${campaign.name}**.`));
    state.updateCampaign(guildId, campaign.id, (c) => (c.players = c.players.filter((id) => id !== user.id)));
    return interaction.reply({ content: `${mentionUser(user.id)} was removed from **${campaign.name}**.`, allowedMentions: { parse: [] } });
  }

  if (sub === "join") {
    if (me === campaign.dm) return interaction.reply(ephemeral(`You are the DM of **${campaign.name}**, so you are already part of it.`));
    if (campaign.players.includes(me)) return interaction.reply(ephemeral(`You are already a player in **${campaign.name}**.`));
    state.updateCampaign(guildId, campaign.id, (c) => c.players.push(me));
    return interaction.reply({ content: `${mentionUser(me)} joined **${campaign.name}** (DM ${mentionUser(campaign.dm)}, world \`${campaign.world}\`). You will be tagged when the world is ready to join.`, allowedMentions: { parse: [] } });
  }

  if (sub === "leave") {
    if (!campaign.players.includes(me)) return interaction.reply(ephemeral(me === campaign.dm ? `You are the DM of **${campaign.name}**; an administrator can hand the campaign to someone else with \`/campaign edit\`.` : `You are not a player in **${campaign.name}**.`));
    state.updateCampaign(guildId, campaign.id, (c) => (c.players = c.players.filter((id) => id !== me)));
    return interaction.reply(ephemeral(`You left **${campaign.name}**.`));
  }

  if (sub === "show") return interaction.reply({ content: describeCampaign(campaign, { worldTitle, now: now() }), allowedMentions: { parse: [] } });

  return interaction.reply({ content: describeCampaigns(state, guildId, { worldTitle, now: now(), me }), allowedMentions: { parse: [] } });
}

export function describeCampaigns(state, guildId, { worldTitle = () => null, now = new Date(), me = null } = {}) {
  const campaigns = state.campaigns(guildId);
  if (!campaigns.length) return "No campaigns yet. An administrator can create one with `/campaign create`.";
  const lines = campaigns.map((c) => {
    const title = worldTitle(c.world);
    const world = title && title !== c.world ? `${title} (\`${c.world}\`)` : `\`${c.world}\``;
    const mine = me && (c.dm === me || c.players.includes(me)) ? " · you are in it" : "";
    const next = isCurrentSession(c.nextSession, now) ? ` · ${new Date(c.nextSession.at) <= now ? "session started" : "next session"} ${discordTime(c.nextSession.at, "f")}` : "";
    return `• **${c.name}** – world ${world}, DM ${mentionUser(c.dm)}, ${c.players.length} player${c.players.length === 1 ? "" : "s"}${next}${mine}`;
  });
  return lines.join("\n");
}

/** Autocomplete for the `campaign` and `world` options. */
export async function autocomplete(interaction, ctx) {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value ?? "").toLowerCase();
  if (focused.name === "campaign") return interaction.respond(campaignChoices(ctx.state, interaction.guildId, typed));
  if (focused.name === "world") return interaction.respond(worldChoices(safeList(ctx.listWorlds), typed));
  return interaction.respond([]);
}

export function campaignChoices(state, guildId, typed = "") {
  return state
    .campaigns(guildId)
    .filter((c) => !typed || c.name.toLowerCase().includes(typed) || c.id.includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: c.name.slice(0, 100), value: c.id }));
}

export function worldChoices(worlds, typed = "") {
  return worlds
    .filter((w) => !typed || w.id.toLowerCase().includes(typed) || w.title.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((w) => ({ name: (w.title && w.title !== w.id ? `${w.title} (${w.id})` : w.id).slice(0, 100), value: w.id }));
}
