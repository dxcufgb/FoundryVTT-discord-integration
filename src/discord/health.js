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

/** Bot permissions the invite link asks for: the required ones plus Mention @everyone/@here/All Roles (for the role ping). */
export const INVITE_PERMISSIONS = new PermissionsBitField([...REQUIRED_PERMISSIONS.map(([flag]) => PermissionFlagsBits[flag]), PermissionFlagsBits.MentionEveryone]).bitfield;

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
