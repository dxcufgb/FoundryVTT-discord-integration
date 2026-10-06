import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { StateStore } from "../src/state.js";

export function tmpDir(prefix = "fvtt-bot-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tmpState() {
  const dir = tmpDir();
  return new StateStore(path.join(dir, "state.json")).load();
}

/** A controllable clock. */
export function fakeClock(start = "2026-03-01T12:00:00Z") {
  let t = new Date(start).getTime();
  const clock = {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(iso) {
      t = new Date(iso).getTime();
    },
  };
  return clock;
}

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

export function upStatus(overrides = {}) {
  return { active: true, version: "13.346", world: "my-world", system: "dnd5e", systemVersion: "5.1.0", users: 2, uptime: 100, ...overrides };
}

/** Write a fake Foundry user-data folder with the given packages. */
export function fakeDataFolder(packages) {
  const root = tmpDir("fvtt-data-");
  for (const pkg of packages) {
    const dir = path.join(root, "Data", `${pkg.type}s`, pkg.folder ?? pkg.id);
    fs.mkdirSync(dir, { recursive: true });
    const { type, folder, ...manifest } = pkg;
    fs.writeFileSync(path.join(dir, `${type}.json`), JSON.stringify(manifest));
  }
  return root;
}

/** Minimal stand-in for a discord.js ChatInputCommandInteraction. */
export function fakeInteraction({ command, subcommand = null, options = {}, admin = false, guildId = "g1", channelId = "chan", userId = "u1", focused = null, events = {} }) {
  const replies = [];
  const perms = { has: (flag) => admin && flag === PermissionFlagsBits.Administrator };
  return {
    replies,
    commandName: command,
    guildId,
    user: { id: userId, bot: false },
    channel: { id: channelId },
    // Discord scheduled events of the server, by id (a missing id rejects like Discord does).
    guild: guildId ? { id: guildId, scheduledEvents: { fetch: async (id) => { if (!events[id]) throw new Error("Unknown Guild Scheduled Event"); return events[id]; } } } : null,
    memberPermissions: guildId ? perms : null,
    deferred: false,
    replied: false,
    responded: false,
    // With `focused` the interaction is an autocomplete request for that option.
    isChatInputCommand: () => !focused,
    isAutocomplete: () => Boolean(focused),
    inGuild: () => Boolean(guildId),
    options: {
      getSubcommand: (required = true) => {
        if (!subcommand && required) throw new Error("no subcommand");
        return subcommand;
      },
      getString: (n) => options[n] ?? null,
      getInteger: (n) => options[n] ?? null,
      getBoolean: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
      getRole: (n) => options[n] ?? null,
      getUser: (n) => (typeof options[n] === "string" ? { id: options[n], bot: false } : options[n] ?? null),
      getFocused: () => focused,
    },
    async reply(p) { this.replied = true; replies.push(p); },
    async deferReply(p) { this.deferred = true; replies.push({ deferred: true, ...p }); },
    async editReply(p) { replies.push(p); },
    async followUp(p) { replies.push(p); },
    async respond(choices) { this.responded = true; replies.push({ choices }); },
  };
}
