// Persistent state: guild channel settings, campaigns and their planned
// sessions, monitor settings, what the bot has already announced. Stored as
// one JSON file, written atomically (write to a temp file, then rename) so a
// crash mid-write never leaves a corrupt file.

import fs from "node:fs";
import path from "node:path";

export const MESSAGE_TYPES = Object.freeze(["default", "status", "world", "updates", "restart", "session"]);
export const MONITORS = Object.freeze(["status", "world", "updates"]);

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
    packages: {},
    packagesSeeded: false,
    lastWindowAnnounced: null,
    notified: {},
  };
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra) || typeof base !== "object" || base === null || typeof extra !== "object" || extra === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = deepMerge(base[key], value);
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
      parsed = JSON.parse(raw);
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
    return this.data.guilds[guildId] ?? emptyGuild();
  }

  setChannel(guildId, type, channelId) {
    assertMessageType(type);
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.channels[type] = channelId;
      return g;
    });
  }

  clearChannel(guildId, type) {
    assertMessageType(type);
    return this.update((d) => {
      const g = d.guilds[guildId];
      if (!g) return false;
      const had = type in g.channels;
      delete g.channels[type];
      return had;
    });
  }

  setMentionRole(guildId, roleId) {
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.mentionRole = roleId;
      return g;
    });
  }

  /**
   * Resolve which channel a message type goes to in a guild: the type's own
   * channel, else the "default" channel, else null.
   */
  resolveChannel(guildId, type) {
    const g = this.data.guilds[guildId];
    if (!g) return null;
    return g.channels[type] ?? g.channels.default ?? null;
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
    const g = this.data.guilds[guildId];
    return Object.values(g?.campaigns ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One campaign by its id (the slug of its name), or null. */
  campaign(guildId, campaignId) {
    return this.data.guilds[guildId]?.campaigns?.[campaignId] ?? null;
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
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.campaigns ??= {};
      g.campaigns[campaign.id] = campaign;
      return campaign;
    });
  }

  /** Mutate one campaign in place and persist. Returns the campaign, or null when it does not exist. */
  updateCampaign(guildId, campaignId, mutator) {
    const existing = this.campaign(guildId, campaignId);
    if (!existing) return null;
    return this.update((d) => {
      const c = d.guilds[guildId].campaigns[campaignId];
      mutator(c);
      return c;
    });
  }

  deleteCampaign(guildId, campaignId) {
    return this.update((d) => {
      const g = d.guilds[guildId];
      if (!g?.campaigns?.[campaignId]) return false;
      delete g.campaigns[campaignId];
      return true;
    });
  }

  // --- planning polls ---------------------------------------------------------------
  //
  // An open planning poll, keyed by the id of the Discord message that shows it.

  poll(guildId, messageId) {
    return this.data.guilds[guildId]?.polls?.[messageId] ?? null;
  }

  savePoll(guildId, poll) {
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.polls ??= {};
      g.polls[poll.id] = poll;
      return poll;
    });
  }

  /** Mutate one poll in place and persist. Returns the poll, or null when it does not exist. */
  updatePoll(guildId, messageId, mutator) {
    if (!this.poll(guildId, messageId)) return null;
    return this.update((d) => {
      const p = d.guilds[guildId].polls[messageId];
      mutator(p);
      return p;
    });
  }

  deletePoll(guildId, messageId) {
    return this.update((d) => {
      const g = d.guilds[guildId];
      if (!g?.polls?.[messageId]) return false;
      delete g.polls[messageId];
      return true;
    });
  }

  // --- game master role ---------------------------------------------------------------

  setGmRole(guildId, roleId) {
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.gmRole = roleId;
      return g;
    });
  }

  /** What the bot last warned this server about (a key), so the same problem is announced once. */
  setHealthIssue(guildId, key) {
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= emptyGuild());
      g.healthIssue = key;
      return g;
    });
  }

  // --- notified-once bookkeeping ----------------------------------------------

  wasNotified(key) {
    return Boolean(this.data.notified[key]);
  }

  markNotified(key, when = new Date()) {
    return this.update((d) => {
      d.notified[key] = when.toISOString();
    });
  }
}

export function emptyGuild() {
  return { channels: {}, mentionRole: null, gmRole: null, healthIssue: null, campaigns: {}, polls: {} };
}

export function assertMessageType(type) {
  if (!MESSAGE_TYPES.includes(type)) throw new Error(`Unknown message type "${type}" (expected one of ${MESSAGE_TYPES.join(", ")})`);
}
