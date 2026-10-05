import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { handleInteraction } from "../src/discord/client.js";
import { commands, requiresAdmin } from "../src/discord/commands/index.js";
import { isGuildAdministrator, NOT_ADMIN_MESSAGE } from "../src/discord/permissions.js";
import { buildStatusEmbed } from "../src/discord/commands/status.js";
import { NOT_DM_MESSAGE } from "../src/campaigns.js";
import { fakeInteraction, quietLog, tmpState, upStatus } from "./helpers.js";
import { resolveWorld } from "../src/discord/commands/campaign.js";

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
  assert.equal(requiresAdmin(updates, "available"), false);
  assert.equal(requiresAdmin(updates, "compatibility"), false);
  assert.equal(requiresAdmin(commands.find((c) => c.data.name === "modules"), "unused"), false);
  for (const name of ["channel", "monitor", "restart-window", "test-message"]) assert.equal(requiresAdmin(commands.find((c) => c.data.name === name), "anything"), true, name);
  const campaign = commands.find((c) => c.data.name === "campaign");
  for (const sub of ["create", "delete", "edit"]) assert.equal(requiresAdmin(campaign, sub), true, sub);
  for (const sub of ["add-player", "remove-player", "join", "leave", "list", "show"]) assert.equal(requiresAdmin(campaign, sub), false, sub);
  const session = commands.find((c) => c.data.name === "session");
  for (const sub of ["set", "event", "clear", "show"]) assert.equal(requiresAdmin(session, sub), false, `${sub} is checked against the DM inside the command`);
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

const run = async (c, spec) => {
  const i = fakeInteraction(spec);
  await handleInteraction(i, c, { log: quietLog });
  return i;
};
const runIn = run;

test("campaigns: admins create, edit and delete; one world per campaign and per server", async () => {
  const worlds = [{ id: "lost-mines", title: "Lost Mines of Phandelver" }, { id: "strahd", title: "Curse of Strahd" }];
  const c = ctx({ listWorlds: () => worlds, worldTitle: (id) => worlds.find((w) => w.id === id)?.title ?? null });

  const denied = await run(c, { command: "campaign", subcommand: "create", options: { name: "Lost Mines", world: "lost-mines", dm: "dm1" } });
  assert.equal(denied.replies[0].content, NOT_ADMIN_MESSAGE);

  const created = await run(c, { command: "campaign", subcommand: "create", options: { name: "Lost Mines", world: "lost-mines", dm: "dm1", channel: { id: "camp-chan" } }, admin: true });
  assert.match(created.replies[0].content, /Campaign created/);
  assert.match(created.replies[0].content, /Lost Mines of Phandelver/);
  const saved = c.state.campaign("g1", "lost-mines");
  assert.equal(saved.world, "lost-mines");
  assert.equal(saved.dm, "dm1");
  assert.equal(saved.channel, "camp-chan");
  assert.deepEqual(saved.players, []);

  const dup = await run(c, { command: "campaign", subcommand: "create", options: { name: "lost mines", world: "strahd", dm: "dm1" }, admin: true });
  assert.match(dup.replies[0].content, /already exists/);
  const sameWorld = await run(c, { command: "campaign", subcommand: "create", options: { name: "Second", world: "lost-mines", dm: "dm2" }, admin: true });
  assert.match(sameWorld.replies[0].content, /already bound to \*\*Lost Mines\*\*/);
  const unknownWorld = await run(c, { command: "campaign", subcommand: "create", options: { name: "Second", world: "typo", dm: "dm2" }, admin: true });
  assert.match(unknownWorld.replies[0].content, /no world "typo".*`lost-mines`/);
  const byTitle = await run(c, { command: "campaign", subcommand: "create", options: { name: "Strahd", world: "Curse of Strahd", dm: "dm2" }, admin: true });
  assert.match(byTitle.replies[0].content, /Campaign created/);
  assert.equal(c.state.campaign("g1", "strahd").world, "strahd", "a world title is accepted too");
  const bot = await run(c, { command: "campaign", subcommand: "create", options: { name: "Botty", world: "strahd", dm: { id: "b", bot: true } }, admin: true });
  assert.match(bot.replies[0].content, /bot cannot be the DM/);
  assert.equal(c.state.campaigns("g1").length, 2);
  assert.equal(c.state.campaigns("g2").length, 0, "campaigns are per server");

  const noPath = ctx();
  const anyWorld = await run(noPath, { command: "campaign", subcommand: "create", options: { name: "X", world: "whatever-id", dm: "dm1" }, admin: true });
  assert.match(anyWorld.replies[0].content, /Campaign created/, "without FOUNDRY_DATA_PATH any well-formed id is accepted");

  c.state.updateCampaign("g1", "lost-mines", (x) => x.players.push("p1", "dm2"));
  const edited = await run(c, { command: "campaign", subcommand: "edit", options: { campaign: "lost-mines", name: "Lost Mines II", dm: "dm2", "clear-channel": true }, admin: true });
  assert.match(edited.replies[0].content, /Campaign updated/);
  assert.equal(c.state.campaign("g1", "lost-mines"), null, "renamed: old id gone");
  const renamed = c.state.campaign("g1", "lost-mines-ii");
  assert.equal(renamed.name, "Lost Mines II");
  assert.equal(renamed.dm, "dm2");
  assert.deepEqual(renamed.players, ["p1"], "the new DM is no longer a player");
  assert.equal(renamed.channel, null);
  const nothing = await run(c, { command: "campaign", subcommand: "edit", options: { campaign: "Lost Mines II" }, admin: true });
  assert.match(nothing.replies[0].content, /Nothing to change/);
  const clash = await run(c, { command: "campaign", subcommand: "edit", options: { campaign: "strahd", world: "lost-mines" }, admin: true });
  assert.match(clash.replies[0].content, /already bound/);

  const missing = await run(c, { command: "campaign", subcommand: "show", options: { campaign: "nope" } });
  assert.match(missing.replies[0].content, /no campaign called \*\*nope\*\*/);
  const list = await run(c, { command: "campaign", subcommand: "list", userId: "p1" });
  assert.match(list.replies[0].content, /\*\*Lost Mines II\*\* – world Lost Mines of Phandelver \(`lost-mines`\), DM <@dm2>, 1 player · you are in it/);
  assert.match(list.replies[0].content, /\*\*Strahd\*\*.*0 players/);
  assert.deepEqual(list.replies[0].allowedMentions, { parse: [] }, "lists never ping");

  const deleted = await run(c, { command: "campaign", subcommand: "delete", options: { campaign: "strahd" }, admin: true });
  assert.match(deleted.replies[0].content, /was deleted/);
  assert.equal(c.state.campaign("g1", "strahd"), null);
});

test("players: the DM or an admin adds and removes, anyone joins and leaves", async () => {
  const c = ctx();
  await run(c, { command: "campaign", subcommand: "create", options: { name: "Lost Mines", world: "lost-mines", dm: "dm1" }, admin: true });

  const notDm = await run(c, { command: "campaign", subcommand: "add-player", options: { campaign: "lost-mines", user: "p1" }, userId: "random" });
  assert.equal(notDm.replies[0].content, NOT_DM_MESSAGE);
  const byDm = await run(c, { command: "campaign", subcommand: "add-player", options: { campaign: "lost-mines", user: "p1" }, userId: "dm1" });
  assert.match(byDm.replies[0].content, /<@p1> was added/);
  const byAdmin = await run(c, { command: "campaign", subcommand: "add-player", options: { campaign: "lost-mines", user: "p2" }, admin: true });
  assert.match(byAdmin.replies[0].content, /2 players/);
  const twice = await run(c, { command: "campaign", subcommand: "add-player", options: { campaign: "lost-mines", user: "p2" }, userId: "dm1" });
  assert.match(twice.replies[0].content, /already a player/);
  const dmAsPlayer = await run(c, { command: "campaign", subcommand: "add-player", options: { campaign: "lost-mines", user: "dm1" }, userId: "dm1" });
  assert.match(dmAsPlayer.replies[0].content, /is the DM/);
  assert.deepEqual(c.state.campaign("g1", "lost-mines").players, ["p1", "p2"]);

  const joined = await run(c, { command: "campaign", subcommand: "join", options: { campaign: "Lost Mines" }, userId: "p3" });
  assert.match(joined.replies[0].content, /<@p3> joined/);
  const again = await run(c, { command: "campaign", subcommand: "join", options: { campaign: "lost-mines" }, userId: "p3" });
  assert.match(again.replies[0].content, /already a player/);
  const dmJoin = await run(c, { command: "campaign", subcommand: "join", options: { campaign: "lost-mines" }, userId: "dm1" });
  assert.match(dmJoin.replies[0].content, /You are the DM/);
  assert.deepEqual(c.state.campaign("g1", "lost-mines").players, ["p1", "p2", "p3"]);

  await run(c, { command: "campaign", subcommand: "create", options: { name: "Other", world: "other", dm: "dm9" }, admin: true });
  await run(c, { command: "campaign", subcommand: "join", options: { campaign: "other" }, userId: "p3" });
  assert.deepEqual(c.state.campaign("g1", "other").players, ["p3"], "a user can be in several campaigns");

  const left = await run(c, { command: "campaign", subcommand: "leave", options: { campaign: "lost-mines" }, userId: "p3" });
  assert.match(left.replies[0].content, /You left/);
  const notIn = await run(c, { command: "campaign", subcommand: "leave", options: { campaign: "lost-mines" }, userId: "p3" });
  assert.match(notIn.replies[0].content, /not a player/);
  const removed = await run(c, { command: "campaign", subcommand: "remove-player", options: { campaign: "lost-mines", user: "p1" }, userId: "dm1" });
  assert.match(removed.replies[0].content, /<@p1> was removed/);
  const notThere = await run(c, { command: "campaign", subcommand: "remove-player", options: { campaign: "lost-mines", user: "p1" }, userId: "dm1" });
  assert.match(notThere.replies[0].content, /not a player/);
  assert.deepEqual(c.state.campaign("g1", "lost-mines").players, ["p2"]);

  const show = await run(c, { command: "campaign", subcommand: "show", options: { campaign: "lost-mines" } });
  assert.match(show.replies[0].content, /Players \(1\): <@p2>/);
  assert.match(show.replies[0].content, /No session planned/);
});

test("sessions: set by date, by Discord event, shown and cleared; only the DM or an admin", async () => {
  const G = "123456789012345678"; // a real-looking server id, so event links can name it
  const run = (c, spec) => runIn(c, { guildId: G, ...spec });
  const c = ctx();
  await run(c, { command: "campaign", subcommand: "create", options: { name: "Lost Mines", world: "lost-mines", dm: "dm1" }, admin: true });
  await run(c, { command: "campaign", subcommand: "join", options: { campaign: "lost-mines" }, userId: "p1" });

  const denied = await run(c, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-07 19:00" }, userId: "p1" });
  assert.equal(denied.replies[0].content, NOT_DM_MESSAGE);
  assert.equal(c.state.campaign(G, "lost-mines").nextSession, null);

  const set = await run(c, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-07 19:00" }, userId: "dm1" });
  assert.match(set.replies[0].content, /Next session of \*\*Lost Mines\*\*: <t:1772906400:F>/, "19:00 Stockholm = 18:00 UTC via the bot's TIMEZONE");
  assert.match(set.replies[0].content, /<@dm1> will be reminded/);
  assert.match(set.replies[0].content, /Players: <@p1>/);
  assert.deepEqual(set.replies[0].allowedMentions, { parse: [] });
  let session = c.state.campaign(G, "lost-mines").nextSession;
  assert.equal(session.at, "2026-03-07T18:00:00.000Z");
  assert.equal(session.source, "manual");
  assert.equal(session.setBy, "dm1");

  const utc = await run(c, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-07 19:00", timezone: "UTC" }, admin: true });
  assert.match(utc.replies[0].content, /<t:1772910000:F>/);
  const bad = await run(c, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "friday" }, userId: "dm1" });
  assert.match(bad.replies[0].content, /not valid: Could not understand/);
  const past = await run(c, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-02-01 19:00" }, userId: "dm1" });
  assert.match(past.replies[0].content, /in the past/);
  assert.equal(c.state.campaign(G, "lost-mines").nextSession.at, "2026-03-07T19:00:00.000Z", "invalid input changes nothing");

  c.state.updateCampaign(G, "lost-mines", (x) => (x.reminderSentFor = x.nextSession.at));
  const events = { "876543210987654321": { name: "Session 12", scheduledStartAt: new Date("2026-03-14T18:30:00Z") }, "111111111111111111": { name: "Old", scheduledStartAt: new Date("2026-01-01T18:30:00Z") } };
  const ev = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "https://discord.com/events/123456789012345678/876543210987654321" }, userId: "dm1", events });
  assert.match(ev.replies[0].content, /<t:1773513000:F>.*from the Discord event \*\*Session 12\*\*: https:\/\/discord\.com\/events\/123456789012345678\/876543210987654321/);
  session = c.state.campaign(G, "lost-mines").nextSession;
  assert.equal(session.at, "2026-03-14T18:30:00.000Z");
  assert.equal(session.source, "event");
  assert.equal(session.eventId, "876543210987654321");
  assert.equal(c.state.campaign(G, "lost-mines").reminderSentFor, null, "a new time arms the reminder again");

  const notLink = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "https://discord.com/channels/1/2" }, userId: "dm1", events });
  assert.match(notLink.replies[0].content, /not a link to a Discord event/);
  const otherGuild = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "https://discord.com/events/999/876543210987654321" }, userId: "dm1", events });
  assert.match(otherGuild.replies[0].content, /another server/);
  const gone = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "999999999999999999" }, userId: "dm1", events });
  assert.match(gone.replies[0].content, /Could not read that event: Unknown Guild Scheduled Event/);
  const old = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "111111111111111111" }, userId: "dm1", events });
  assert.match(old.replies[0].content, /pick an upcoming one/);
  const playerEvent = await run(c, { command: "session", subcommand: "event", options: { campaign: "lost-mines", link: "876543210987654321" }, userId: "p1", events });
  assert.equal(playerEvent.replies[0].content, NOT_DM_MESSAGE);
  assert.equal(c.state.campaign(G, "lost-mines").nextSession.at, "2026-03-14T18:30:00.000Z");

  const showOne = await run(c, { command: "session", subcommand: "show", options: { campaign: "lost-mines" }, userId: "p1" });
  assert.match(showOne.replies[0].content, /Next session <t:1773513000:F> \(<t:1773513000:R>\) · \[Discord event\]/);
  await run(c, { command: "campaign", subcommand: "create", options: { name: "Other", world: "other", dm: "dm9" }, admin: true });
  const showAll = await run(c, { command: "session", subcommand: "show", userId: "p1" });
  assert.match(showAll.replies[0].content, /\*\*Lost Mines\*\* \(DM <@dm1>\): Next session/);
  assert.match(showAll.replies[0].content, /\*\*Other\*\* \(DM <@dm9>\): No session planned/);

  const clearDenied = await run(c, { command: "session", subcommand: "clear", options: { campaign: "lost-mines" }, userId: "p1" });
  assert.equal(clearDenied.replies[0].content, NOT_DM_MESSAGE);
  const cleared = await run(c, { command: "session", subcommand: "clear", options: { campaign: "lost-mines" }, userId: "dm1" });
  assert.match(cleared.replies[0].content, /was removed/);
  assert.equal(c.state.campaign(G, "lost-mines").nextSession, null);
  const nothing = await run(c, { command: "session", subcommand: "clear", options: { campaign: "lost-mines" }, admin: true });
  assert.match(nothing.replies[0].content, /had no planned session/);
  const unknown = await run(c, { command: "session", subcommand: "set", options: { campaign: "nope", when: "2026-03-07 19:00" }, admin: true });
  assert.match(unknown.replies[0].content, /no campaign called/);
  const empty = ctx();
  const none = await run(empty, { command: "session", subcommand: "show" });
  assert.match(none.replies[0].content, /No campaigns yet/);
});

test("autocomplete suggests campaigns of this server and worlds on disk", async () => {
  const c = ctx({ listWorlds: () => [{ id: "lost-mines", title: "Lost Mines of Phandelver" }, { id: "strahd", title: "strahd" }] });
  await run(c, { command: "campaign", subcommand: "create", options: { name: "Lost Mines", world: "lost-mines", dm: "dm1" }, admin: true });
  await run(c, { command: "campaign", subcommand: "create", options: { name: "Strahd", world: "strahd", dm: "dm1" }, admin: true });

  const all = await run(c, { command: "session", focused: { name: "campaign", value: "" } });
  assert.deepEqual(all.replies[0].choices, [{ name: "Lost Mines", value: "lost-mines" }, { name: "Strahd", value: "strahd" }]);
  const some = await run(c, { command: "campaign", focused: { name: "campaign", value: "MIN" } });
  assert.deepEqual(some.replies[0].choices, [{ name: "Lost Mines", value: "lost-mines" }]);
  const elsewhere = await run(c, { command: "campaign", focused: { name: "campaign", value: "" }, guildId: "g2" });
  assert.deepEqual(elsewhere.replies[0].choices, []);
  const worlds = await run(c, { command: "campaign", focused: { name: "world", value: "" } });
  assert.deepEqual(worlds.replies[0].choices, [{ name: "Lost Mines of Phandelver (lost-mines)", value: "lost-mines" }, { name: "strahd", value: "strahd" }]);
  const byTitle = await run(c, { command: "campaign", focused: { name: "world", value: "phandelver" } });
  assert.deepEqual(byTitle.replies[0].choices, [{ name: "Lost Mines of Phandelver (lost-mines)", value: "lost-mines" }]);
  const other = await run(c, { command: "campaign", focused: { name: "name", value: "x" } });
  assert.deepEqual(other.replies[0].choices, []);

  const broken = ctx({ listWorlds: () => { throw new Error("disk"); } });
  const safe = await run(broken, { command: "campaign", focused: { name: "world", value: "" } });
  assert.deepEqual(safe.replies[0].choices, [], "a failing world scan still answers");
  const noAuto = await run(c, { command: "status", focused: { name: "x", value: "" } });
  assert.equal(noAuto.replies.length, 0, "commands without autocomplete are ignored");
});

test("resolveWorld accepts a suggestion label and keeps just the world id", () => {
  const worlds = () => [{ id: "dnd-online", title: "DND-Online" }];
  assert.equal(resolveWorld("DND-Online (dnd-online)", worlds), "dnd-online");
  assert.equal(resolveWorld("DND-Online (dnd-online)", () => []), "dnd-online");
  assert.equal(resolveWorld("dnd-online", worlds), "dnd-online");
});
