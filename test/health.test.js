import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { checkGuildHealth, inviteUrl, missingPermissions, REQUIRED_PERMISSIONS } from "../src/discord/health.js";
import { writeWorldNextSession } from "../src/foundry/packages.js";
import { fakeDataFolder, quietLog, tmpState } from "./helpers.js";

const allow = (...flags) => ({ has: (f) => flags.includes(f) });
const ALL = REQUIRED_PERMISSIONS.map(([f]) => PermissionFlagsBits[f]);

function env({ guildPerms = ALL, channelPerms = ALL, scopeError = null } = {}) {
  const state = tmpState();
  state.setChannel("g1", "status", "status-chan");
  const sent = [];
  const channel = { send: async (p) => sent.push(p), permissionsFor: () => allow(...channelPerms) };
  const guild = { id: "g1", name: "Test", members: { me: { permissions: allow(...guildPerms) } } };
  const client = {
    channels: { fetch: async () => channel },
    application: { commands: { fetch: async () => { if (scopeError) throw Object.assign(new Error("Missing Access"), { code: scopeError }); return []; } } },
  };
  return { ctx: { state, client, config: { discord: { clientId: "123" } }, log: quietLog }, guild, sent, state };
}

test("no problems: nothing is announced", async () => {
  const e = env();
  await checkGuildHealth(e.guild, e.ctx);
  assert.equal(e.sent.length, 0);
});

test("missing permissions are announced in the status channel once, and again when the problem changes or returns", async () => {
  const e = env({ guildPerms: ALL.filter((f) => f !== PermissionFlagsBits.CreateEvents) });
  await checkGuildHealth(e.guild, e.ctx);
  await checkGuildHealth(e.guild, e.ctx);
  assert.equal(e.sent.length, 1);
  assert.match(e.sent[0].content, /Missing permissions: \*\*Create Events\*\*/);
  assert.match(e.sent[0].content, /No reinstall is needed/);

  e.guild.members.me.permissions = allow(...ALL.filter((f) => f !== PermissionFlagsBits.EmbedLinks));
  await checkGuildHealth(e.guild, e.ctx);
  assert.equal(e.sent.length, 2);
  assert.match(e.sent[1].content, /Embed Links/);

  e.guild.members.me.permissions = allow(...ALL);
  await checkGuildHealth(e.guild, e.ctx);
  assert.equal(e.state.guild("g1").healthIssue, null);
  e.guild.members.me.permissions = allow(...ALL.filter((f) => f !== PermissionFlagsBits.EmbedLinks));
  await checkGuildHealth(e.guild, e.ctx);
  assert.equal(e.sent.length, 3);
});

test("a missing applications.commands scope means reinstall, with the invite link", async () => {
  const e = env({ scopeError: 50001 });
  await checkGuildHealth(e.guild, e.ctx);
  assert.match(e.sent[0].content, /has to be reinstalled/);
  assert.ok(e.sent[0].content.includes(inviteUrl("123")));
  assert.match(inviteUrl("123"), /scope=bot\+applications\.commands&permissions=\d+/);
  // other API errors are not taken for a missing scope
  const other = env({ scopeError: 40001 });
  await checkGuildHealth(other.guild, other.ctx);
  assert.equal(other.sent.length, 0);
});

test("channel-level permission problems and a missing status channel", async () => {
  const e = env({ channelPerms: [PermissionFlagsBits.ViewChannel] });
  assert.deepEqual(missingPermissions(e.guild, { permissionsFor: () => allow(PermissionFlagsBits.ViewChannel) }), ["Send Messages", "Send Messages in Threads", "Embed Links"]);
  await checkGuildHealth(e.guild, e.ctx);
  assert.match(e.sent[0].content, /In this channel the bot lacks/);

  const none = env({ guildPerms: [] });
  none.state.clearChannel("g1", "status");
  await checkGuildHealth(none.guild, none.ctx);
  assert.equal(none.sent.length, 0);
});

test("writeWorldNextSession changes only nextSession and keeps the file's layout", () => {
  const root = fakeDataFolder([{ type: "world", id: "w1", title: "W1", system: "dnd5e" }]);
  const file = path.join(root, "Data", "worlds", "w1", "world.json");
  fs.writeFileSync(file, '{\n    "id": "w1",\n    "title": "W1",\n    "nextSession": null\n}\n');
  assert.deepEqual(writeWorldNextSession(root, "w1", new Date("2026-03-06T18:00:00Z")), { ok: true });
  assert.equal(fs.readFileSync(file, "utf8"), '{\n    "id": "w1",\n    "title": "W1",\n    "nextSession": "2026-03-06T18:00:00.000Z"\n}\n');
  assert.deepEqual(writeWorldNextSession(root, "w1", null), { ok: true });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).nextSession, null);
  assert.equal(writeWorldNextSession(root, "nope", new Date()).ok, false);
  assert.equal(writeWorldNextSession(root, "../x", new Date()).ok, false);
  assert.equal(writeWorldNextSession(null, "w1", new Date()).ok, false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["world.json"]);
});
