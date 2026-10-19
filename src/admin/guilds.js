// What the administration page needs from a Discord server to edit its channels and
// roles: the channels and roles to choose from, and the same permission checks (as
// plain text) that /channel, /campaign and /gm-role give.

import { ChannelType } from "discord.js";
import { permissionProblem, postPermissionsFor, STAGE_EVENT_PERMISSIONS, VOICE_EVENT_PERMISSIONS } from "../discord/health.js";

// The channel types the slash commands accept.
export const TEXT_CHANNEL_TYPES = Object.freeze([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread]);
export const VOICE_CHANNEL_TYPES = Object.freeze([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const byPosition = (a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0) || String(a.name).localeCompare(String(b.name));

function channelsOf(guild, types) {
  const all = [...(guild?.channels?.cache?.values?.() ?? [])];
  return all
    .filter((c) => types.includes(c.type) && !c.archived)
    .sort(byPosition)
    .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name ?? null, thread: c.isThread?.() ?? false, stage: c.type === ChannelType.GuildStageVoice }));
}

/** The channels and roles of a server the page offers ({ textChannels, voiceChannels, roles }). */
export function guildOptions(guild) {
  const roles = [...(guild?.roles?.cache?.values?.() ?? [])]
    .filter((r) => r.id !== guild.id) // @everyone
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map((r) => ({ id: r.id, name: r.name, managed: Boolean(r.managed) }));
  return { textChannels: channelsOf(guild, TEXT_CHANNEL_TYPES), voiceChannels: channelsOf(guild, VOICE_CHANNEL_TYPES), roles };
}

/** A channel of the server, when it exists and is one of `types`; else null. */
export function findChannel(guild, id, types) {
  const channel = guild?.channels?.cache?.get?.(id);
  return channel && types.includes(channel.type) ? channel : null;
}

export const findRole = (guild, id) => (id !== guild?.id && guild?.roles?.cache?.get?.(id)) || null;

/** Discord markdown (bold, <#channel>, <@&role>) as plain text with names. */
export function plain(text, guild) {
  return String(text)
    .replace(/\*\*|\*/g, "")
    .replace(/<#([^>\s]+)>/g, (_, id) => `#${guild?.channels?.cache?.get?.(id)?.name ?? id}`)
    .replace(/<@&([^>\s]+)>/g, (_, id) => `@${guild?.roles?.cache?.get?.(id)?.name ?? id}`)
    .trim();
}

/** Why the bot cannot post in a channel yet (plain text), or null. */
export function postingProblem(guild, channel) {
  const problem = permissionProblem(guild, channel, postPermissionsFor(channel));
  return problem ? plain(`The bot cannot post in <#${channel.id}> yet: ${problem}`, guild) : null;
}

/** Why session events cannot be held in a voice channel yet (plain text), or null. */
export function voiceProblem(guild, channel) {
  const problem = permissionProblem(guild, channel, channel.type === ChannelType.GuildStageVoice ? STAGE_EVENT_PERMISSIONS : VOICE_EVENT_PERMISSIONS);
  return problem ? plain(`Session events cannot be held in <#${channel.id}> yet: ${problem}`, guild) : null;
}
