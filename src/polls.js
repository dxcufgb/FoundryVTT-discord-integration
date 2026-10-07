// Planning polls: pure helpers (dates on offer, votes, labels, the poll embed
// and its components). Storage lives in state.js, the interactions in
// discord/commands/planningPoll.js.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from "discord.js";
import { localParts } from "./restartWindow.js";
import { mentionUser } from "./campaigns.js";

/** Discord allows at most 25 options in a select menu. */
export const MAX_POLL_DATES = 25;
export const SESSION_DURATION_MS = 3 * 3600_000;
export const NOT_POLL_MANAGER_MESSAGE = "Only the person who created the poll, the campaign's DM, a game master or a server administrator can do that.";
export const NOT_POLL_VOTER_MESSAGE = "Only the DM and the players of this campaign can vote.";
export const NO_POLL_MESSAGE = "This poll is no longer active.";

const pad = (n) => String(n).padStart(2, "0");

/** "2026-10-12" -> "Mon 12 Oct" (calendar date, no timezone involved). */
export function dateLabel(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** The next `count` calendar dates (YYYY-MM-DD), starting with today in `timezone`. */
export function upcomingDates(now, timezone, count = MAX_POLL_DATES) {
  const p = localParts(now, timezone);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  });
}

/** Half-hour time slots 10:00 to 22:00 (25, the select menu limit). */
export function timeSlots() {
  const out = [];
  for (let m = 10 * 60; m <= 22 * 60; m += 30) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
}

/** "19:00", "7:30", "1930" -> { hour, minute } or null. */
export function parseClock(text) {
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  return hour > 23 || minute > 59 ? null : { hour, minute };
}

export function createPoll({ id, channelId, campaign, dates, createdBy, timezone }, { now = () => new Date() } = {}) {
  const unique = [...new Set(dates)].sort();
  if (!unique.length) throw new Error("A poll needs at least one date");
  if (unique.length > MAX_POLL_DATES) throw new Error(`A poll can have at most ${MAX_POLL_DATES} dates`);
  return { id: String(id), channelId: String(channelId), campaignId: campaign.id, campaignName: campaign.name, dates: unique, votes: {}, createdBy: String(createdBy), createdAt: now().toISOString(), timezone };
}

/** Replace one user's votes (an empty list withdraws them). */
export function setVotes(poll, userId, dates) {
  const valid = poll.dates.filter((d) => dates.includes(d));
  if (valid.length) poll.votes[userId] = valid;
  else delete poll.votes[userId];
}

/** Votes per date, in date order. */
export function tally(poll) {
  return poll.dates.map((date) => ({ date, voters: Object.keys(poll.votes).filter((u) => poll.votes[u].includes(date)) }));
}

/** The dates sharing the highest vote count (none when nobody voted). */
export function topDates(poll) {
  const rows = tally(poll);
  const max = Math.max(0, ...rows.map((r) => r.voters.length));
  return max ? { votes: max, dates: rows.filter((r) => r.voters.length === max).map((r) => r.date) } : { votes: 0, dates: [] };
}

export const campaignMembers = (campaign) => [campaign.dm, ...campaign.players];

/** The interaction's member holds the server's game master role. */
export function hasGmRole(interaction, gmRole) {
  if (!gmRole) return false;
  const roles = interaction?.member?.roles;
  if (!roles) return false;
  if (Array.isArray(roles)) return roles.includes(gmRole);
  return Boolean(roles.cache?.has?.(gmRole));
}

/** Who may start a poll for a campaign: administrators, its DM and the server's game masters. */
export function canRunPoll(interaction, campaign, gmRole) {
  const perms = interaction?.memberPermissions;
  if (perms && typeof perms.has === "function" && perms.has(PermissionFlagsBits.Administrator)) return true;
  const userId = interaction?.user?.id ?? null;
  return Boolean(userId && (String(userId) === String(campaign?.dm) || hasGmRole(interaction, gmRole)));
}

/** Who may decide or delete a poll: its creator, or anyone who could have started it. */
export function canManagePoll(interaction, poll, campaign, gmRole) {
  const userId = interaction?.user?.id ?? null;
  return Boolean(userId && String(userId) === poll.createdBy) || canRunPoll(interaction, campaign, gmRole);
}

export function buildPollEmbed(poll, campaign) {
  const rows = tally(poll);
  const lines = rows.map(({ date, voters }) => `**${dateLabel(date)}** — ${voters.length} vote${voters.length === 1 ? "" : "s"}${voters.length ? `: ${voters.map(mentionUser).join(" ")}` : ""}`);
  const members = campaignMembers(campaign ?? { dm: poll.createdBy, players: [] });
  const waiting = members.filter((u) => !poll.votes[u]);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📅 When can we play ${poll.campaignName}?`)
    .setDescription(`Pick every date that works for you in the menu below.\n\n${lines.join("\n")}${waiting.length ? `\n\nNot voted yet: ${waiting.map(mentionUser).join(" ")}` : ""}`)
    .setFooter({ text: `Times are in ${poll.timezone}` });
}

export function buildDecidedEmbed(poll, at, eventUrl = null) {
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ ${poll.campaignName}: date decided`)
    .setDescription(`<t:${Math.floor(at.getTime() / 1000)}:F> (<t:${Math.floor(at.getTime() / 1000)}:R>)${eventUrl ? `\n${eventUrl}` : ""}`);
}

export function pollComponents(poll) {
  const vote = new StringSelectMenuBuilder()
    .setCustomId("poll:vote")
    .setPlaceholder("Pick every date that works for you")
    .setMinValues(0)
    .setMaxValues(poll.dates.length)
    .addOptions(poll.dates.map((d) => ({ label: dateLabel(d), value: d })));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("poll:decide").setLabel("Decide date").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("poll:delete").setLabel("Delete poll").setStyle(ButtonStyle.Danger),
  );
  return [new ActionRowBuilder().addComponents(vote), buttons];
}
