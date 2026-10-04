// Persistent state: guild channel settings, monitor settings, what the bot has
// already announced. Stored as one JSON file, written atomically (write to a
// temp file, then rename) so a crash mid-write never leaves a corrupt file.

import fs from "node:fs";
import path from "node:path";

export const MESSAGE_TYPES = Object.freeze(["default", "status", "world", "updates", "restart"]);
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
    return this.data.guilds[guildId] ?? { channels: {}, mentionRole: null };
  }

  setChannel(guildId, type, channelId) {
    assertMessageType(type);
    return this.update((d) => {
      const g = (d.guilds[guildId] ??= { channels: {}, mentionRole: null });
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
      const g = (d.guilds[guildId] ??= { channels: {}, mentionRole: null });
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

export function assertMessageType(type) {
  if (!MESSAGE_TYPES.includes(type)) throw new Error(`Unknown message type "${type}" (expected one of ${MESSAGE_TYPES.join(", ")})`);
}
