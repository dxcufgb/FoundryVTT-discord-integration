// Is the bot set up properly in each server? Permissions can be edited after the
// bot has joined (Server Settings -> Roles -> the bot's role, or a channel's
// permissions), so missing ones are announced in the server's status channel
// and the announcement is repeated only when the problem changes. A bot that
// was added without the `applications.commands` scope cannot be fixed by
// editing permissions: it has to be re-authorised with the invite link (no need
// to remove it first; the settings in state.json are kept either way).

import { Events, OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from "discord.js";

export const REQUIRED_PERMISSIONS = Object.freeze([
  ["ViewChannel", "View Channels"],
  ["SendMessages", "Send Messages"],
  ["SendMessagesInThreads", "Send Messages in Threads"],
  ["EmbedLinks", "Embed Links"],
  ["CreateEvents", "Create Events"],
]);

// What Discord wants in the channel itself before the bot can hold an event in a voice or stage channel.
export const VOICE_EVENT_PERMISSIONS = Object.freeze([
  ["ViewChannel", "View Channel"],
  ["Connect", "Connect"],
]);
export const STAGE_EVENT_PERMISSIONS = Object.freeze([
  ...VOICE_EVENT_PERMISSIONS,
  ["ManageChannels", "Manage Channels"],
  ["MuteMembers", "Mute Members"],
  ["MoveMembers", "Move Members"],
]);

/** Bot permissions the invite link asks for: the required ones, Connect (events in voice channels), Read Message History (showing a poll's result) and Mention @everyone/@here/All Roles (for the role ping). */
export const INVITE_PERMISSIONS = new PermissionsBitField([
  ...REQUIRED_PERMISSIONS.map(([flag]) => PermissionFlagsBits[flag]),
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.MentionEveryone,
]).bitfield;

export function inviteUrl(clientId) {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=${OAuth2Scopes.Bot}+${OAuth2Scopes.ApplicationsCommands}&permissions=${INVITE_PERMISSIONS}`;
}

/** Labels of the required permissions the bot lacks in the server (or, with a channel, in that channel). */
export function missingPermissions(guild, channel = null) {
  const me = guild.members?.me;
  if (!me) return [];
  const perms = channel?.permissionsFor ? channel.permissionsFor(me) : me.permissions;
  if (!perms) return [];
  const flags = channel ? REQUIRED_PERMISSIONS.filter(([flag]) => !["CreateEvents"].includes(flag)) : REQUIRED_PERMISSIONS;
  return flags.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

// --- telling the user exactly what is missing and where to add it -------------------------

// What the bot needs to post its messages in a channel, and in the channel of a planning poll (it fetches
// the poll message again to show the result).
export const POST_PERMISSIONS = Object.freeze([
  ["ViewChannel", "View Channel"],
  ["SendMessages", "Send Messages"],
  ["EmbedLinks", "Embed Links"],
]);
const THREAD_POST_PERMISSIONS = Object.freeze([...POST_PERMISSIONS, ["SendMessagesInThreads", "Send Messages in Threads"]]);
export const POLL_PERMISSIONS = Object.freeze([...POST_PERMISSIONS, ["ReadMessageHistory", "Read Message History"]]);
export const EVENT_PERMISSIONS = Object.freeze([["CreateEvents", "Create Events"]]);

/** Posting needs Send Messages in Threads as well when the channel is a thread. */
export const postPermissionsFor = (channel, base = POST_PERMISSIONS) => (channel?.isThread?.() ? [...base, ...THREAD_POST_PERMISSIONS.slice(POST_PERMISSIONS.length)] : base);

/** Labels of `wanted` ([flag, label] pairs) the bot lacks in `channel`, or in the server without one; [] when it cannot tell. */
function missingOf(guild, channel, wanted) {
  const me = guild?.members?.me;
  if (!me) return [];
  const perms = channel ? (channel.permissionsFor ? channel.permissionsFor(me) : null) : me.permissions;
  if (!perms) return [];
  return wanted.filter(([flag]) => !perms.has(PermissionFlagsBits[flag])).map(([, label]) => label);
}

const botRole = (guild) => {
  const role = guild?.members?.me?.roles?.botRole;
  return role?.name ? `**@${role.name}**` : "the bot's role";
};

/** Where an administrator adds `missing` for the bot: the server's roles, or (for a channel) also the channel's own permissions. */
export function whereToAdd(guild, channelId, missing) {
  const them = missing.length === 1 ? "it" : "them";
  const role = botRole(guild);
  if (!channelId) return `An administrator can add ${them} under *Server Settings → Roles →* ${role}.`;
  return (
    `An administrator can add ${them} in <#${channelId}> → *Edit Channel → Permissions* (add ${role} and allow ${them}), ` +
    `or under *Server Settings → Roles →* ${role}; a ❌ on the channel overrides the role.`
  );
}

/** "the bot lacks **X, Y** in <#c>. An administrator can add …", or null when nothing is known to be missing. */
export function permissionProblem(guild, channel, wanted) {
  const missing = missingOf(guild, channel, wanted);
  if (!missing.length) return null;
  return `the bot lacks **${missing.join(", ")}** ${channel ? `in <#${channel.id}>` : "in this server"}. ${whereToAdd(guild, channel?.id ?? null, missing)}`;
}

/** The channel as the bot's server sees it (for its permissions), or null. */
export async function guildChannel(guild, channelId) {
  if (!guild?.channels || !channelId) return null;
  return guild.channels.cache?.get(channelId) ?? (await Promise.resolve(guild.channels.fetch?.(channelId)).catch(() => null)) ?? null;
}

/** A line warning that the bot cannot post in `channel` (and how to fix it), or "". */
export function postingWarning(guild, channel) {
  const problem = channel ? permissionProblem(guild, channel, postPermissionsFor(channel)) : null;
  return problem ? `\n⚠️ The bot cannot post in <#${channel.id}> yet: ${problem}` : "";
}

/** End a message with a full stop unless it already ends a sentence. */
export const asSentence = (text) => (/[.!?]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);

/** Is this Discord's "Missing Permissions" (50013) or "Missing Access" (50001)? */
export const isPermissionError = (err) => err?.code === 50013 || err?.code === 50001 || /missing (permissions|access)/i.test(err?.message ?? "");

/**
 * Explain a failed Discord call: for a permission error, which of `wanted` the bot lacks and where to add
 * them (or, when that cannot be told, which permissions it needs); otherwise Discord's message.
 */
export function explainError(err, guild, channel, wanted) {
  const message = err?.message ?? String(err);
  if (!isPermissionError(err)) return message;
  const problem = permissionProblem(guild, channel, wanted);
  if (problem) return problem;
  const labels = wanted.map(([, label]) => label);
  return `Discord refused (${message}): the bot needs **${labels.join(", ")}** ${channel ? `in <#${channel.id}>` : "in this server"}. ${whereToAdd(guild, channel?.id ?? null, labels)}`;
}

/** Does Discord refuse the bot access to this server's application commands, i.e. is the `applications.commands` scope missing? */
export async function lacksCommandsScope(client, guildId) {
  try {
    await client.application.commands.fetch({ guildId });
    return false;
  } catch (err) {
    return err?.code === 50001 || err?.status === 403;
  }
}

export function buildHealthMessage({ missing, reinstall, channelMissing, clientId }) {
  const lines = ["⚠️ **The bot needs your attention in this server.**"];
  if (reinstall) {
    lines.push(
      "• The bot was added without the `applications.commands` permission scope, so its slash commands cannot work here. **It has to be reinstalled**: an administrator opens the link below and authorises it again. You do not need to remove the bot first, and its settings are kept.",
      inviteUrl(clientId),
    );
  }
  if (missing.length) {
    lines.push(
      `• Missing permissions: **${missing.join(", ")}**. No reinstall is needed: an administrator can change this under *Server Settings → Roles →* the bot's role (or in the channel's permission overrides).`,
    );
  }
  if (channelMissing.length) lines.push(`• In this channel the bot lacks: **${channelMissing.join(", ")}** (check the channel's permission overrides).`);
  return lines.join("\n");
}

/**
 * Check one server and announce a problem in its status channel, once per
 * distinct problem. Returns the issues found.
 */
export async function checkGuildHealth(guild, ctx) {
  const { state, client, log = console } = ctx;
  try {
    const statusChannelId = state.resolveChannel(guild.id, "status");
    const channel = statusChannelId ? await client.channels.fetch(statusChannelId).catch(() => null) : null;
    const missing = missingPermissions(guild);
    const channelMissing = channel ? missingPermissions(guild, channel).filter((p) => !missing.includes(p)) : [];
    const reinstall = await lacksCommandsScope(client, guild.id);
    const key = JSON.stringify({ missing, channelMissing, reinstall });
    const none = !missing.length && !channelMissing.length && !reinstall;
    const previous = state.guild(guild.id).healthIssue ?? null;
    if (none) {
      if (previous) state.setHealthIssue(guild.id, null);
      return { missing, channelMissing, reinstall };
    }
    if (previous === key) return { missing, channelMissing, reinstall };
    if (!channel?.send) {
      log.warn(`${guild.name ?? guild.id}: the bot has problems (${[...missing, ...channelMissing, reinstall ? "applications.commands scope" : null].filter(Boolean).join(", ")}) but no usable status channel is set (/channel set type:status).`);
      return { missing, channelMissing, reinstall };
    }
    try {
      await channel.send({ content: buildHealthMessage({ missing, reinstall, channelMissing, clientId: ctx.config.discord.clientId }), allowedMentions: { parse: [] } });
      state.setHealthIssue(guild.id, key);
    } catch (err) {
      log.warn(`${guild.name ?? guild.id}: could not post the permission warning in the status channel: ${err?.message ?? err}`);
    }
    return { missing, channelMissing, reinstall };
  } catch (err) {
    log.warn(`health check for server ${guild?.id} failed:`, err?.message ?? err);
    return null;
  }
}

/** Check every server at startup, and again when one is joined or the bot's role or a channel changes. */
export function watchGuildHealth(client, ctx) {
  const check = (guild) => checkGuildHealth(guild, ctx);
  client.once(Events.ClientReady, async () => {
    for (const guild of client.guilds.cache.values()) await check(guild);
  });
  client.on(Events.GuildCreate, check);
  client.on(Events.GuildRoleUpdate, (_old, role) => {
    if (role.tags?.botId === client.user?.id) return check(role.guild);
    return undefined;
  });
  client.on(Events.GuildMemberUpdate, (_old, member) => (member.id === client.user?.id ? check(member.guild) : undefined));
  client.on(Events.ChannelUpdate, (_old, channel) => (channel.guild ? check(channel.guild) : undefined));
  ctx.checkHealth = check;
}
