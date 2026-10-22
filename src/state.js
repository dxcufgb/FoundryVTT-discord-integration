// Persistent state: guild channel settings, campaigns and their planned
// sessions, monitor settings, what the bot has already announced. Stored as
// one JSON file, written atomically (write to a temp file, then rename) so a
// crash mid-write never leaves a corrupt file.

import fs from "node:fs";
import path from "node:path";

export const MESSAGE_TYPES = Object.freeze(["default", "status", "world", "updates", "restart", "session"]);
export const MONITORS = Object.freeze(["status", "world", "updates"]);

/** Create fresh persistent state with default monitoring settings and no recorded bot version. */
export function defaultState() {
  return {
    version: 1,
    guilds: {},
    monitor: {
      enabled: { status: true, world: true, updates: true },
      restartWindow: null,
      updates: { trackFoundry: true, trackSystems: true, trackModules: true, announceNewPackages: true, announceRemovedPackages: true },
    },
    foundry: {
      // "up" | "down" | null (unknown, before the first check)
      status: null,
      since: null,
      world: null,
      worldSince: null,
      version: null,
      lastSeenUpAt: null,
      restartWindowAlerted: false,
    },
    // Posting the session summaries of the dxcufgbs-session-summary module when a world stops
    // (src/sessionSummaries.js); changed on the administration page.
    sessionSummaries: { enabled: true, maxAgeHours: 24 },
    packages: {},
    packagesSeeded: false,
    lastWindowAnnounced: null,
    notified: {},
    // Version of the bot that last ran, to DM server admins once after an update.
    botVersion: null,
    // Where the slash commands were last registered ({ guildId: id|null, hash, version, at }), so a
    // changed DISCORD_GUILD_ID can remove the old set and the log can say whether they changed.
    commands: null,
  };
}

// Ids used as keys (servers, campaigns, polls, notified keys) can come from what a user typed, so the
// maps in the state are plain objects that are only ever read through `own` and written through
// `put`: an id such as "constructor" or "toString" must not find what Object.prototype inherits, and
// "__proto__" must never reach the object's prototype.

/** The value stored under an id in a map, or undefined; inherited properties do not count. */
export function own(map, key) {
  return map !== null && typeof map === "object" && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Store a value under an id. "__proto__" is refused: it would replace the map's prototype, never be a key. */
export function put(map, key, value) {
  if (String(key) === "__proto__") throw new Error(`Invalid id "${key}"`);
  map[key] = value;
  return value;
}

/** Remove an id from a map. Returns whether it was there. */
export function remove(map, key) {
  if (map === null || typeof map !== "object" || !Object.hasOwn(map, key)) return false;
  delete map[key];
  return true;
}

/** A server's record in the state data, created when it is missing. */
export function ensureGuild(data, guildId) {
  return own(data.guilds, guildId) ?? put(data.guilds, guildId, emptyGuild());
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra) || typeof base !== "object" || base === null || typeof extra !== "object" || extra === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) if (key !== "__proto__") out[key] = deepMerge(own(base, key), value);
  return out;
}

export class StateStore {
  /** @param {string} file path of the JSON file */
  constructor(file) {
    this.file = file;
    this.data = defaultState();
    this._saving = Promise.resolve();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return this;
      throw err;
    }
    let parsed;
    try {
      // The bot never writes a "__proto__" key; one in the file is dropped wherever it is.
      parsed = JSON.parse(raw, (key, value) => (key === "__proto__" ? undefined : value));
    } catch (err) {
      throw new Error(`State file ${this.file} is not valid JSON (${err.message}). Fix or delete it.`);
    }
    this.data = deepMerge(defaultState(), parsed);
    return this;
  }

  /** Write synchronously and atomically. */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.file);
    return this;
  }

  /** Apply a mutation and persist it. Returns whatever the mutator returns. */
  update(mutator) {
    const result = mutator(this.data);
    this.save();
    return result;
  }

  // --- guild channel settings -----------------------------------------------

  guild(guildId) {
    return own(this.data.guilds, guildId) ?? emptyGuild();
  }

  setChannel(guildId, type, channelId) {
    assertMessageType(type);
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.channels[type] = channelId;
      return g;
    });
  }

  clearChannel(guildId, type) {
    assertMessageType(type);
    return this.update((d) => {
      const g = own(d.guilds, guildId);
      if (!g) return false;
      return remove(g.channels, type);
    });
  }

  setMentionRole(guildId, roleId) {
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.mentionRole = roleId;
      return g;
    });
  }

  /**
   * Resolve which channel a message type goes to in a guild: the type's own
   * channel, else the "default" channel, else null.
   */
  resolveChannel(guildId, type) {
    const g = own(this.data.guilds, guildId);
    if (!g) return null;
    return own(g.channels, type) ?? own(g.channels, "default") ?? null;
  }

  // --- campaigns ------------------------------------------------------------------
  //
  // A campaign belongs to one Discord server, is bound to exactly one Foundry
  // world and has exactly one DM (a Discord user). Any number of players can be
  // part of it, and a user may be in any number of campaigns. Within a server a
  // world can only be bound to one campaign, so "the DM of that world" is
  // well defined.

  /** All campaigns of a server, sorted by name. */
  campaigns(guildId) {
    const g = own(this.data.guilds, guildId);
    return Object.values(own(g, "campaigns") ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One campaign by its id (the slug of its name), or null. */
  campaign(guildId, campaignId) {
    return own(own(own(this.data.guilds, guildId), "campaigns"), campaignId) ?? null;
  }

  /** The campaign a world is bound to in a server, or null. */
  campaignForWorld(guildId, worldId) {
    return this.campaigns(guildId).find((c) => c.world === worldId) ?? null;
  }

  /** Every (guildId, campaign) pair bound to a world, across all servers. */
  campaignsForWorld(worldId) {
    const out = [];
    for (const guildId of Object.keys(this.data.guilds)) {
      const c = this.campaignForWorld(guildId, worldId);
      if (c) out.push({ guildId, campaign: c });
    }
    return out;
  }

  /** Insert or replace a campaign. */
  saveCampaign(guildId, campaign) {
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.campaigns ??= {};
      put(g.campaigns, campaign.id, campaign);
      return campaign;
    });
  }

  /** Mutate one campaign in place and persist. Returns the campaign, or null when it does not exist. */
  updateCampaign(guildId, campaignId, mutator) {
    const existing = this.campaign(guildId, campaignId);
    if (!existing) return null;
    return this.update((d) => {
      const c = own(own(d.guilds, guildId).campaigns, campaignId);
      mutator(c);
      return c;
    });
  }

  deleteCampaign(guildId, campaignId) {
    return this.update((d) => {
      return remove(own(own(d.guilds, guildId), "campaigns"), campaignId);
    });
  }

  // --- planning polls ---------------------------------------------------------------
  //
  // An open planning poll, keyed by the id of the Discord message that shows it.

  poll(guildId, messageId) {
    return own(own(own(this.data.guilds, guildId), "polls"), messageId) ?? null;
  }

  savePoll(guildId, poll) {
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.polls ??= {};
      put(g.polls, poll.id, poll);
      return poll;
    });
  }

  /** Mutate one poll in place and persist. Returns the poll, or null when it does not exist. */
  updatePoll(guildId, messageId, mutator) {
    if (!this.poll(guildId, messageId)) return null;
    return this.update((d) => {
      const p = own(own(d.guilds, guildId).polls, messageId);
      mutator(p);
      return p;
    });
  }

  deletePoll(guildId, messageId) {
    return this.update((d) => {
      return remove(own(own(d.guilds, guildId), "polls"), messageId);
    });
  }

  // --- game master role ---------------------------------------------------------------

  setGmRole(guildId, roleId) {
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.gmRole = roleId;
      return g;
    });
  }

  /** What the bot last warned this server about (a key), so the same problem is announced once. */
  setHealthIssue(guildId, key) {
    return this.update((d) => {
      const g = ensureGuild(d, guildId);
      g.healthIssue = key;
      return g;
    });
  }

  // --- notified-once bookkeeping ----------------------------------------------

  wasNotified(key) {
    return Boolean(own(this.data.notified, key));
  }

  markNotified(key, when = new Date()) {
    return this.update((d) => {
      put(d.notified, key, when.toISOString());
    });
  }
}

export function emptyGuild() {
  return { channels: {}, mentionRole: null, gmRole: null, healthIssue: null, campaigns: {}, polls: {} };
}

export function assertMessageType(type) {
  if (!MESSAGE_TYPES.includes(type)) throw new Error(`Unknown message type "${type}" (expected one of ${MESSAGE_TYPES.join(", ")})`);
}
