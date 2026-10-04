import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { handleInteraction } from "../src/discord/client.js";
import { commands, requiresAdmin } from "../src/discord/commands/index.js";
import { isGuildAdministrator, NOT_ADMIN_MESSAGE } from "../src/discord/permissions.js";
import { buildStatusEmbed } from "../src/discord/commands/status.js";
import { quietLog, tmpState, upStatus } from "./helpers.js";

/** Minimal stand-in for a discord.js ChatInputCommandInteraction. */
function fakeInteraction({ command, subcommand = null, options = {}, admin = false, guildId = "g1", channelId = "chan" }) {
  const replies = [];
  const perms = { has: (flag) => admin && flag === PermissionFlagsBits.Administrator };
  return {
    replies,
    commandName: command,
    guildId,
    channel: { id: channelId },
    memberPermissions: guildId ? perms : null,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
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
    },
    async reply(p) { this.replied = true; replies.push(p); },
    async deferReply(p) { this.deferred = true; replies.push({ deferred: true, ...p }); },
    async editReply(p) { replies.push(p); },
  };
}

function ctx(extra = {}) {
  const state = tmpState();
  return {
    state,
    config: { timezone: "Europe/Stockholm", foundry: { url: "http://localhost:30000" } },
    fetchStatus: async () => ({ ok: true, status: upStatus() }),
    worldTitle: () => null,
    now: () => new Date("2026-03-01T12:00:00Z"),
    monitor: { tick: async () => {}, maybeScanPackages: async () => {} },
    notifier: { sendTo: async () => {} },
    log: quietLog,
    ...extra,
  };
}

test("all configuration commands are admin-only and guild-only in their definitions", () => {
  const adminDefault = String(PermissionFlagsBits.Administrator);
  for (const c of commands) {
    const json = c.data.toJSON();
    assert.deepEqual(json.contexts, [0], `${c.data.name} is guild-only`);
    if (c.adminOnly) assert.equal(json.default_member_permissions, adminDefault, `${c.data.name} hidden from non-admins`);
  }
  const updates = commands.find((c) => c.data.name === "updates");
  assert.equal(requiresAdmin(updates, "list"), false);
  assert.equal(requiresAdmin(updates, "check"), true);
  assert.equal(requiresAdmin(updates, "settings"), true);
  assert.equal(requiresAdmin(updates, "reset"), true);
  assert.equal(requiresAdmin(commands.find((c) => c.data.name === "status"), null), false);
  for (const name of ["channel", "monitor", "restart-window", "test-message"]) assert.equal(requiresAdmin(commands.find((c) => c.data.name === name), "anything"), true, name);
});

test("isGuildAdministrator", () => {
  assert.equal(isGuildAdministrator(null), false);
  assert.equal(isGuildAdministrator({ inGuild: () => false, memberPermissions: { has: () => true } }), false);
  assert.equal(isGuildAdministrator({ inGuild: () => true, memberPermissions: null }), false);
  assert.equal(isGuildAdministrator({ inGuild: () => true, memberPermissions: { has: (f) => f === PermissionFlagsBits.Administrator } }), true);
  assert.equal(isGuildAdministrator({ inGuild: () => true, memberPermissions: { has: (f) => f === PermissionFlagsBits.ManageGuild } }), false);
});

test("non-admins are refused configuration commands and nothing changes", async () => {
  const c = ctx();
  const i = fakeInteraction({ command: "channel", subcommand: "set", options: { type: "status" }, admin: false });
  await handleInteraction(i, c, { log: quietLog });
  assert.equal(i.replies[0].content, NOT_ADMIN_MESSAGE);
  assert.equal(c.state.resolveChannel("g1", "status"), null);

  const u = fakeInteraction({ command: "updates", subcommand: "reset", admin: false });
  await handleInteraction(u, c, { log: quietLog });
  assert.equal(u.replies[0].content, NOT_ADMIN_MESSAGE);

  const dm = fakeInteraction({ command: "monitor", subcommand: "show", admin: true, guildId: null });
  await handleInteraction(dm, c, { log: quietLog });
  assert.match(dm.replies[0].content, /inside a server/);
});

test("admins can set, list and clear channels and the mention role", async () => {
  const c = ctx();
  await handleInteraction(fakeInteraction({ command: "channel", subcommand: "set", options: { type: "status", channel: { id: "c-status" } }, admin: true }), c, { log: quietLog });
  await handleInteraction(fakeInteraction({ command: "channel", subcommand: "set", options: { type: "default" }, admin: true, channelId: "here" }), c, { log: quietLog });
  assert.equal(c.state.resolveChannel("g1", "status"), "c-status");
  assert.equal(c.state.resolveChannel("g1", "updates"), "here", "defaults to the channel the command was used in");

  const list = fakeInteraction({ command: "channel", subcommand: "list", admin: true });
  await handleInteraction(list, c, { log: quietLog });
  assert.match(list.replies[0].content, /\*\*status\*\*.*<#c-status>/);
  assert.match(list.replies[0].content, /\*\*updates\*\*.*<#here> \(via default\)/);

  await handleInteraction(fakeInteraction({ command: "channel", subcommand: "mention", options: { role: { id: "r" } }, admin: true }), c, { log: quietLog });
  assert.equal(c.state.guild("g1").mentionRole, "r");
  await handleInteraction(fakeInteraction({ command: "channel", subcommand: "clear", options: { type: "status" }, admin: true }), c, { log: quietLog });
  assert.equal(c.state.resolveChannel("g1", "status"), "here");
});

test("monitor enable/disable/check and restart-window set/show/clear", async () => {
  const c = ctx();
  await handleInteraction(fakeInteraction({ command: "monitor", subcommand: "disable", options: { what: "world" }, admin: true }), c, { log: quietLog });
  assert.equal(c.state.data.monitor.enabled.world, false);
  await handleInteraction(fakeInteraction({ command: "monitor", subcommand: "enable", options: { what: "all" }, admin: true }), c, { log: quietLog });
  assert.deepEqual(c.state.data.monitor.enabled, { status: true, world: true, updates: true });

  let ticked = 0;
  c.monitor.tick = async () => { ticked++; };
  const check = fakeInteraction({ command: "monitor", subcommand: "check", admin: true });
  await handleInteraction(check, c, { log: quietLog });
  assert.equal(ticked, 1);
  assert.ok(check.replies[0].deferred);

  const set = fakeInteraction({ command: "restart-window", subcommand: "set", options: { start: "04:00", duration: 15, days: "weekdays" }, admin: true });
  await handleInteraction(set, c, { log: quietLog });
  const w = c.state.data.monitor.restartWindow;
  assert.equal(w.start, 240);
  assert.deepEqual(w.days, [1, 2, 3, 4, 5]);
  assert.equal(w.timezone, "Europe/Stockholm", "falls back to the bot's timezone");
  assert.match(set.replies[0].content, /Next opening: <t:\d+:F>/);

  const bad = fakeInteraction({ command: "restart-window", subcommand: "set", options: { start: "25:00", duration: 15 }, admin: true });
  await handleInteraction(bad, c, { log: quietLog });
  assert.match(bad.replies[0].content, /not valid/);
  assert.equal(c.state.data.monitor.restartWindow.start, 240, "unchanged");

  await handleInteraction(fakeInteraction({ command: "restart-window", subcommand: "clear", admin: true }), c, { log: quietLog });
  assert.equal(c.state.data.monitor.restartWindow, null);
});

test("updates list is open to everyone, settings and reset to admins", async () => {
  const c = ctx();
  c.state.update((d) => {
    d.packages = { "module:a": { type: "module", id: "a", title: "Alpha", version: "1.0" }, "system:s": { type: "system", id: "s", title: "Sys", version: "2.0" } };
    d.foundry.version = "13.346";
  });
  const list = fakeInteraction({ command: "updates", subcommand: "list", admin: false });
  await handleInteraction(list, c, { log: quietLog });
  assert.match(list.replies[0].content, /v13\.346/);
  assert.match(list.replies[0].content, /Alpha.*1\.0/);
  assert.match(list.replies[0].content, /Sys.*2\.0/);

  await handleInteraction(fakeInteraction({ command: "updates", subcommand: "settings", options: { setting: "removed", enabled: false }, admin: true }), c, { log: quietLog });
  assert.equal(c.state.data.monitor.updates.announceRemovedPackages, false);

  c.state.markNotified("module:a@1.0");
  await handleInteraction(fakeInteraction({ command: "updates", subcommand: "reset", admin: true }), c, { log: quietLog });
  assert.deepEqual(c.state.data.notified, {});
});

test("status command and embed; test-message reports missing channel; command errors are caught", async () => {
  const c = ctx();
  const s = fakeInteraction({ command: "status" });
  await handleInteraction(s, c, { log: quietLog });
  const embed = s.replies[1].embeds[0];
  assert.match(embed.title, /up/);
  assert.ok(embed.fields.some((f) => f.name === "World" && f.value.includes("my-world")));

  const downEmbed = buildStatusEmbed({ ok: false, error: "ECONNREFUSED" }, c);
  assert.match(downEmbed.title, /down/);

  const tm = fakeInteraction({ command: "test-message", options: { type: "status" }, admin: true });
  await handleInteraction(tm, c, { log: quietLog });
  assert.match(tm.replies[0].content, /No channel is set/);

  c.state.setChannel("g1", "status", "x");
  c.notifier.sendTo = async () => { throw new Error("Missing Access"); };
  const tm2 = fakeInteraction({ command: "test-message", options: { type: "status" }, admin: true });
  await handleInteraction(tm2, c, { log: quietLog });
  assert.match(tm2.replies[0].content, /Missing Access/);

  c.fetchStatus = async () => { throw new Error("kaboom"); };
  const broken = fakeInteraction({ command: "status" });
  await handleInteraction(broken, c, { log: quietLog });
  assert.match(broken.replies.at(-1).content, /Something went wrong/);

  const unknown = fakeInteraction({ command: "nope" });
  await handleInteraction(unknown, c, { log: quietLog });
  assert.equal(unknown.replies.length, 0);
});
