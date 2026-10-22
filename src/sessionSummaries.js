// Session summaries: when a Foundry world goes back to setup, post the summaries the
// Foundry module dxcufgbs-session-summary wrote for it to the channel of every
// campaign bound to that world.
//
// The module writes into Foundry's Data folder (by default Data/session-summaries/):
//   index.json                  { schema, world, updatedAt, sessions: [{ id, number, title, endedAt, json, md, ... }] }, newest first
//   session-NNN_DATE.json / .md  one session: the full summary and its Discord-ready Markdown
//   latest.json / latest.md     copies of the newest export (used when index.json is missing)
// The bot only reads those files. Without the module, the folder or a usable file
// nothing is posted and nothing breaks: every problem is logged and skipped.

import fs from "node:fs";
import path from "node:path";
import { resolveDataFolder } from "./foundry/packages.js";
import { own } from "./state.js";

export const SUMMARY_SCHEMA = 1;
export const DEFAULT_FOLDER = "session-summaries";
export const DISCORD_LIMIT = 2000;
export const MAX_AGE_HOURS = Object.freeze({ min: 1, max: 720 });
// Only the newest entries of index.json are looked at (each one means a file to read).
const MAX_INDEX_ENTRIES = 50;

const defaultReadFile = (file) => fs.promises.readFile(file, "utf8");

/** The folder the module writes to: SESSION_SUMMARY_DIR (absolute, or inside the Data folder), else Data/session-summaries. null without a Data folder. */
export function summaryFolder(config) {
  const dir = config.sessionSummaryDir;
  if (dir && path.isAbsolute(dir)) return dir;
  const data = resolveDataFolder(config.foundry?.dataPath);
  return data ? path.join(data, dir || DEFAULT_FOLDER) : null;
}

/** The feature's settings from the state, with defaults for anything missing or out of range. */
export function summarySettings(state) {
  const s = state.data.sessionSummaries ?? {};
  const hours = Number(s.maxAgeHours);
  return {
    enabled: s.enabled !== false,
    maxAgeHours: Number.isFinite(hours) && hours >= MAX_AGE_HOURS.min && hours <= MAX_AGE_HOURS.max ? hours : 24,
  };
}

/** The key that records a summary posted to a channel (state.notified). */
export const postedKey = (sessionId, channelId) => `sessionSummary:${sessionId}:${channelId}`;

/** Text cut to Discord's limit without splitting a surrogate pair. */
export function clip(text, limit = DISCORD_LIMIT) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

// A file name from index.json must name a file in the folder itself.
const safeName = (name) => typeof name === "string" && name !== "" && name === path.basename(name) && !name.startsWith(".") ? name : null;

/** Read and parse a JSON file: { value } or { missing } or { problem }. */
async function readJson(readFile, file) {
  let text;
  try {
    text = await readFile(file);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { missing: true };
    return { problem: `cannot read ${file} (${err?.code ?? err?.message ?? err})` };
  }
  if (!String(text).trim()) return { problem: `${file} is empty (still being written?)` };
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { problem: `${file} is not valid JSON (${err.message})` };
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What the module exported, newest first: [{ file, mdFile, summary }] for every summary
 * file that could be read, plus the problems met on the way. Never throws.
 */
export async function readSummaries({ folder, readFile = defaultReadFile, log = console, limit = MAX_INDEX_ENTRIES }) {
  const problems = [];
  const out = [];
  const index = await readJson(readFile, path.join(folder, "index.json"));
  let entries = null;
  if (index.value !== undefined) {
    if (isObject(index.value) && Array.isArray(index.value.sessions)) entries = index.value.sessions.filter(isObject).slice(0, limit);
    else problems.push("index.json has no session list");
  } else if (index.problem) {
    problems.push(index.problem);
  }

  if (entries) {
    for (const entry of entries) {
      const json = safeName(entry.json);
      if (!json) continue;
      const read = await readJson(readFile, path.join(folder, json));
      if (read.missing) {
        log.debug(`session summary ${json} listed in index.json is missing`);
        continue;
      }
      if (read.problem) {
        problems.push(read.problem);
        continue;
      }
      out.push({ file: json, mdFile: safeName(entry.md) ?? json.replace(/\.json$/i, ".md"), summary: read.value });
    }
    return { summaries: out, problems, source: "index.json" };
  }

  // No usable index.json: the newest export only.
  const latest = await readJson(readFile, path.join(folder, "latest.json"));
  if (latest.problem) problems.push(latest.problem);
  if (latest.value !== undefined) out.push({ file: "latest.json", mdFile: "latest.md", summary: latest.value });
  return { summaries: out, problems, source: latest.missing && index.missing ? null : "latest.json" };
}

/**
 * The fields the bot uses from one summary, or { skip: reason }. An unknown or newer
 * schema is tried through its `markdown` field only.
 */
export function describeSummary(summary) {
  if (!isObject(summary)) return { skip: "not a JSON object" };
  const session = isObject(summary.session) ? summary.session : {};
  const known = summary.schema === SUMMARY_SCHEMA;
  const id = typeof session.id === "string" && session.id ? session.id : typeof session.id === "number" ? String(session.id) : null;
  if (!id) return { skip: "no session id" };
  const endedAt = typeof session.endedAt === "string" ? new Date(session.endedAt) : null;
  return {
    id,
    known,
    schema: summary.schema ?? null,
    number: Number.isFinite(session.number) ? session.number : null,
    title: typeof session.title === "string" ? session.title : null,
    worldId: isObject(session.world) && typeof session.world.id === "string" ? session.world.id : null,
    inProgress: session.inProgress === true,
    endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt : null,
    markdown: typeof summary.markdown === "string" && summary.markdown.trim() ? summary.markdown : null,
  };
}

/** Why a summary is not for this world stop (a debug reason), or null when it should be posted. */
function notPostable(info, worldId, now, maxAgeHours) {
  if (info.skip) return info.skip;
  if (info.worldId !== worldId) return `belongs to world ${info.worldId ?? "?"}`;
  if (info.inProgress) return "is an in-progress export";
  if (!info.endedAt) return "has no end time";
  const age = now.getTime() - info.endedAt.getTime();
  if (age > maxAgeHours * 3_600_000) return `ended more than ${maxAgeHours} h ago`;
  return null;
}

/** The campaigns bound to a world that have a channel: [{ guildId, campaign, channelId }]. */
function targetsFor(state, worldId) {
  return state.campaignsForWorld(worldId).filter(({ campaign }) => campaign.channel).map(({ guildId, campaign }) => ({ guildId, campaign, channelId: campaign.channel }));
}

/**
 * Post the summaries of a world that just went back to setup. Resolves to the number
 * of messages sent. Never throws.
 * @param {{ state, config, client, log?, now?: () => Date, readFile?: (file:string) => Promise<string> }} ctx
 */
const inFlight = new Map(); // worldId -> the running post

export function postSessionSummaries(ctx, worldId) {
  // One run per world at a time (a world stop and "Post now" could otherwise post the same summary twice).
  if (inFlight.has(worldId)) return inFlight.get(worldId);
  const { state, config, client, log = console, now = () => new Date(), readFile = defaultReadFile } = ctx;
  const run = (async () => {
    try {
      return await postSummaries({ state, config, client, log, now, readFile }, worldId);
    } catch (err) {
      log.warn(`session summaries for world ${worldId}: ${err?.message ?? err}`);
      return 0;
    } finally {
      inFlight.delete(worldId);
    }
  })();
  inFlight.set(worldId, run);
  return run;
}

async function postSummaries({ state, config, client, log, now, readFile }, worldId) {
  const settings = summarySettings(state);
  if (!settings.enabled) {
    log.debug(`session summaries are turned off; nothing posted for world ${worldId}`);
    return 0;
  }
  const bound = state.campaignsForWorld(worldId);
  const targets = targetsFor(state, worldId);
  if (!targets.length) {
    log.debug(bound.length
      ? `no session summary posted for world ${worldId}: its campaign(s) ${bound.map((b) => b.campaign.name).join(", ")} have no channel`
      : `no session summary posted for world ${worldId}: no campaign is bound to it`);
    return 0;
  }
  const folder = summaryFolder(config);
  if (!folder) {
    log.debug("no session summary posted: FOUNDRY_DATA_PATH and SESSION_SUMMARY_DIR are not set");
    return 0;
  }

  const { summaries, problems, source } = await readSummaries({ folder, readFile, log });
  for (const p of problems) log.warn(`session summaries: ${p}`);
  if (!source) {
    log.debug(`no session summary posted for world ${worldId}: nothing in ${folder}`);
    return 0;
  }

  const at = now();
  const due = [];
  const seen = new Set();
  for (const item of summaries) {
    const info = describeSummary(item.summary);
    const why = notPostable(info, worldId, at, settings.maxAgeHours);
    if (why) {
      log.debug(`session summary ${item.file} skipped: ${why}`);
      continue;
    }
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    due.push({ ...item, info });
  }
  due.sort((a, b) => a.info.endedAt - b.info.endedAt);

  let sent = 0;
  for (const item of due) {
    const open = targets.filter((t) => !state.wasNotified(postedKey(item.info.id, t.channelId)));
    if (!open.length) {
      log.debug(`session summary ${item.file} was already posted`);
      continue;
    }
    const text = await summaryText(item, { folder, readFile, log });
    if (!text) {
      log.warn(`session summary ${item.file} has no text to post${item.info.known ? "" : ` (unknown schema ${item.info.schema})`}`);
      continue;
    }
    for (const target of open) {
      try {
        const channel = await client?.channels?.fetch(target.channelId);
        if (!channel || typeof channel.send !== "function") throw new Error("channel not found or not a text channel");
        await channel.send({ content: clip(text), allowedMentions: { parse: [] } });
      } catch (err) {
        log.warn(`could not post session summary ${item.file} to channel ${target.channelId} of campaign "${target.campaign.name}" (server ${target.guildId}): ${err?.message ?? err}`);
        continue;
      }
      state.markNotified(postedKey(item.info.id, target.channelId), now());
      sent += 1;
      log.info(`Posted session summary ${item.file} of world ${worldId} to campaign "${target.campaign.name}" (server ${target.guildId}).`);
    }
  }
  if (!due.length) log.debug(`no new session summary for world ${worldId} in ${folder}`);
  return sent;
}

/** The summary's markdown, else (known schema only) its .md file. */
async function summaryText(item, { folder, readFile, log }) {
  if (item.info.markdown) return item.info.markdown;
  if (!item.info.known || !item.mdFile) return null;
  try {
    const text = String(await readFile(path.join(folder, item.mdFile)));
    return text.trim() ? text : null;
  } catch (err) {
    log.debug(`cannot read ${item.mdFile}: ${err?.code ?? err?.message ?? err}`);
    return null;
  }
}

/**
 * For the administration page: the folder, whether it exists, and the newest summaries
 * with the campaign channels they were posted to. Never throws.
 */
export async function summaryOverview({ state, config, readFile = defaultReadFile, log = console, limit = 10 }) {
  const folder = summaryFolder(config);
  if (!folder) return { folder: null, exists: false, sessions: [], problems: [] };
  let exists = false;
  try {
    exists = fs.statSync(folder).isDirectory();
  } catch {
    // missing: the module is not installed or has not exported yet
  }
  if (!exists) return { folder, exists, sessions: [], problems: [] };
  const { summaries, problems } = await readSummaries({ folder, readFile, log, limit });
  const sessions = [];
  for (const item of summaries) {
    const info = describeSummary(item.summary);
    if (info.skip) continue;
    const channels = targetsFor(state, info.worldId);
    sessions.push({
      file: item.file,
      id: info.id,
      number: info.number,
      title: info.title,
      worldId: info.worldId,
      endedAt: info.endedAt?.toISOString() ?? null,
      inProgress: info.inProgress,
      hasText: Boolean(info.markdown),
      posted: channels.map((t) => ({ guildId: t.guildId, campaign: t.campaign.name, channelId: t.channelId, at: own(state.data.notified, postedKey(info.id, t.channelId)) ?? null })),
    });
  }
  return { folder, exists, sessions, problems };
}
