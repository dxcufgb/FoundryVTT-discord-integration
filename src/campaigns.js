// Campaigns: the link between a Discord server, a Foundry world, one DM and the
// players. Pure functions only (validation, parsing, formatting); storage lives
// in state.js, the reminders in sessions.js and the slash commands in
// discord/commands/campaign.js and session.js.

import { PermissionFlagsBits } from "discord.js";
import { localParts, tzOffsetMs } from "./restartWindow.js";
import { discordTime } from "./messages.js";

export const MAX_CAMPAIGN_NAME = 60;

/** Minutes before a session at which the bot checks that the world is up. */
export const DEFAULT_REMINDER_MINUTES = 15;

/** How long after its start a session still counts as "the current session" (for /session show and the world-ready message). */
export const SESSION_LINGER_MS = 4 * 3600_000;

/** "The Lost Mines!" -> "the-lost-mines". Throws when nothing usable is left. */
export function slugify(name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CAMPAIGN_NAME);
  if (!slug) throw new Error("A campaign name needs at least one letter or digit");
  return slug;
}

/**
 * Build a new, validated campaign record.
 * @param {{name:string, world:string, dm:string, players?:string[], channel?:string|null, createdBy?:string|null}} input
 * @param {{ now?: () => Date }} [ctx]
 */
export function createCampaign({ name, world, dm, players = [], channel = null, createdBy = null }, { now = () => new Date() } = {}) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("A campaign needs a name");
  if (cleanName.length > MAX_CAMPAIGN_NAME) throw new Error(`Campaign names can be at most ${MAX_CAMPAIGN_NAME} characters`);
  const worldId = normaliseWorldId(world);
  if (!dm) throw new Error("A campaign needs exactly one DM");
  return {
    id: slugify(cleanName),
    name: cleanName,
    world: worldId,
    dm: String(dm),
    players: uniqueUsers(players, dm),
    channel: channel ?? null,
    createdAt: now().toISOString(),
    createdBy: createdBy ?? null,
    nextSession: null,
    lastSession: null,
    reminderSentFor: null,
  };
}

/** Foundry world ids are folder names: lower-case letters, digits, dashes and underscores. */
export function normaliseWorldId(world) {
  const id = String(world ?? "").trim();
  if (!id) throw new Error("A campaign needs a Foundry world");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`"${id}" does not look like a Foundry world id (the folder name under Data/worlds)`);
  return id;
}

/** De-duplicate player ids; the DM is never also listed as a player. */
export function uniqueUsers(ids, dm = null) {
  const out = [];
  for (const id of ids ?? []) {
    const s = String(id);
    if (s === String(dm) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * Who may manage a campaign's sessions and players: the server's administrators
 * and the campaign's DM.
 */
export function canManageCampaign(interaction, campaign) {
  if (!interaction || !campaign) return false;
  const perms = interaction.memberPermissions;
  if (perms && typeof perms.has === "function" && perms.has(PermissionFlagsBits.Administrator)) return true;
  const userId = interaction.user?.id ?? interaction.member?.user?.id ?? null;
  return Boolean(userId && String(userId) === String(campaign.dm));
}

export const NOT_DM_MESSAGE = "Only the campaign's DM or a server administrator can do that.";

// --- Discord event links --------------------------------------------------------

const EVENT_URL = /^(?:<)?(?:https?:\/\/)?(?:(?:ptb|canary|www)\.)?discord(?:app)?\.com\/events\/(\d+)\/(\d+)\/?(?:\?[^>\s]*)?(?:>)?$/i;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Parse a link to a Discord scheduled event (https://discord.com/events/<server>/<event>)
 * or a bare event id. Returns { guildId, eventId } (guildId null for bare ids) or null.
 */
export function parseEventLink(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (SNOWFLAKE.test(t)) return { guildId: null, eventId: t };
  const m = EVENT_URL.exec(t);
  if (!m) return null;
  return { guildId: m[1], eventId: m[2] };
}

export function eventUrl(guildId, eventId) {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

// --- session times ---------------------------------------------------------------

/** Wall-clock components in `timezone` -> UTC Date. Handles DST like restartWindow does. */
export function zonedToUtc({ year, month, day, hour, minute }, timezone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const once = new Date(guess.getTime() - tzOffsetMs(guess, timezone));
  return new Date(guess.getTime() - tzOffsetMs(once, timezone));
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`"${timezone}" is not a known IANA timezone (example: Europe/Stockholm)`);
  }
}

function checkClock(hour, minute) {
  if (hour > 23 || minute > 59) throw new Error(`Time ${hour}:${String(minute).padStart(2, "0")} is out of range (00:00 to 23:59)`);
}

function checkCalendar(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) throw new Error(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} is not a real date`);
}

export const SESSION_TIME_HELP = "Write the time as YYYY-MM-DD HH:MM (for example 2026-10-12 19:00), today HH:MM, tomorrow HH:MM, or paste a Discord timestamp like <t:1760295600:F>.";

/**
 * Parse what a DM typed as the next session time.
 * Accepts "YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM", "today HH:MM", "tomorrow HH:MM"
 * (all local time in `timezone`) and Discord timestamps "<t:1234567890:F>".
 * The result must be in the future and at most a year away.
 * @returns {Date}
 */
export function parseSessionTime(text, timezone, now = new Date()) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error(`No time given. ${SESSION_TIME_HELP}`);
  assertTimezone(timezone);
  let when;

  let m = /^<t:(\d{1,12})(?::[tTdDfFR])?>$/.exec(t) ?? /^(\d{9,12})$/.exec(t);
  if (m) when = new Date(Number(m[1]) * 1000);
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]|\s+at\s+)(\d{1,2}):(\d{2})(?::\d{2})?$/i.exec(t))) {
    const [year, month, day, hour, minute] = m.slice(1).map(Number);
    checkCalendar(year, month, day);
    checkClock(hour, minute);
    when = zonedToUtc({ year, month, day, hour, minute }, timezone);
  } else if ((m = /^(today|tomorrow)(?:\s+at)?\s+(\d{1,2}):(\d{2})$/i.exec(t))) {
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    checkClock(hour, minute);
    const p = localParts(now, timezone);
    const dayOffset = m[1].toLowerCase() === "tomorrow" ? 1 : 0;
    // Date.UTC normalises day overflow (e.g. the 32nd) into the next month.
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
    when = zonedToUtc({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), hour, minute }, timezone);
  } else {
    throw new Error(`Could not understand "${t}". ${SESSION_TIME_HELP}`);
  }

  if (Number.isNaN(when.getTime())) throw new Error(`Could not understand "${t}". ${SESSION_TIME_HELP}`);
  if (when.getTime() <= now.getTime()) throw new Error(`${discordTime(when, "F")} is in the past`);
  if (when.getTime() - now.getTime() > 366 * 86_400_000) throw new Error(`${discordTime(when, "F")} is more than a year away`);
  return when;
}

/** Build the nextSession record stored on a campaign. */
export function createSession({ at, source = "manual", eventId = null, eventUrl: url = null, setBy = null }, { now = () => new Date() } = {}) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid session time");
  return { at: date.toISOString(), source, eventId, eventUrl: url, setBy: setBy ?? null, setAt: now().toISOString() };
}

/** Is a stored session still "current": upcoming, or started less than SESSION_LINGER_MS ago. */
export function isCurrentSession(session, now = new Date()) {
  if (!session?.at) return false;
  const at = new Date(session.at).getTime();
  return now.getTime() < at + SESSION_LINGER_MS;
}

// --- formatting ------------------------------------------------------------------------

export function mentionUser(id) {
  return `<@${id}>`;
}

export function describeSession(session, now = new Date()) {
  if (!session) return "No session planned.";
  const at = new Date(session.at);
  const when = `${discordTime(at, "F")} (${discordTime(at, "R")})`;
  const started = at.getTime() <= now.getTime();
  const from = session.source === "event" && session.eventUrl ? ` · [Discord event](${session.eventUrl})` : "";
  return `${started ? "Started" : "Next session"} ${when}${from}`;
}

export function describeCampaign(campaign, { worldTitle = () => null, now = new Date() } = {}) {
  const title = worldTitle(campaign.world);
  const world = title && title !== campaign.world ? `**${title}** (\`${campaign.world}\`)` : `\`${campaign.world}\``;
  const lines = [
    `**${campaign.name}** (\`${campaign.id}\`)`,
    `• World: ${world}`,
    `• DM: ${mentionUser(campaign.dm)}`,
    `• Players (${campaign.players.length}): ${campaign.players.length ? campaign.players.map(mentionUser).join(" ") : "none yet"}`,
    `• ${describeSession(isCurrentSession(campaign.nextSession, now) ? campaign.nextSession : null, now)}`,
  ];
  if (campaign.channel) lines.push(`• Session messages: <#${campaign.channel}>`);
  return lines.join("\n");
}
