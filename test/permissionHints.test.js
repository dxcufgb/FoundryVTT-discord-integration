// When the bot lacks a Discord permission for what it was asked, it says which one and where to add it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { handleInteraction, failureMessage } from "../src/discord/client.js";
import { createCampaign } from "../src/campaigns.js";
import { explainError, permissionProblem, POST_PERMISSIONS } from "../src/discord/health.js";
import { fakeInteraction, quietLog, tmpState } from "./helpers.js";

const { ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory, CreateEvents, Connect } = PermissionFlagsBits;
const allow = (...flags) => ({ has: (f) => flags.includes(f) });

/** A server whose bot role (@Foundry) has `guildPerms`, and channels where it has `perms`. */
function server({ guildPerms = [ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory, CreateEvents], channels = {} } = {}) {
  const cache = new Map(Object.entries(channels).map(([id, { perms, type = ChannelType.GuildText }]) => [id, { id, type, permissionsFor: () => allow(...perms), isThread: () => false }]));
  return {
    id: "g1",
    members: { me: { permissions: allow(...guildPerms), roles: { botRole: { name: "Foundry" } } } },
    channels: { cache, fetch: async (id) => cache.get(id) ?? null },
    scheduledEvents: { create: async () => ({ id: "e1" }) },
  };
}

async function run(guild, spec) {
  const state = spec.state ?? tmpState();
  const i = fakeInteraction(spec);
  i.guild = guild;
  if (spec.channel) i.channel = spec.channel;
  await handleInteraction(i, { state, config: { timezone: "Europe/Stockholm" }, notifier: spec.notifier, log: quietLog, now: () => new Date("2026-03-01T12:00:00Z") }, { log: quietLog });
  return i;
}

test("permissionProblem names the missing permissions, the channel, the bot's role and where to add them", () => {
  const guild = server({ guildPerms: [ViewChannel], channels: { c1: { perms: [ViewChannel] } } });
  assert.equal(
    permissionProblem(guild, guild.channels.cache.get("c1"), POST_PERMISSIONS),
    "the bot lacks **Send Messages, Embed Links** in <#c1>. An administrator can add them in <#c1> → *Edit Channel → Permissions* (add **@Foundry** and allow them), or under *Server Settings → Roles →* **@Foundry**; a ❌ on the channel overrides the role.",
  );
  assert.match(permissionProblem(guild, null, [["CreateEvents", "Create Events"]]), /^the bot lacks \*\*Create Events\*\* in this server\. An administrator can add it under \*Server Settings → Roles →\* \*\*@Foundry\*\*\.$/);
  assert.equal(permissionProblem(server(), null, [["CreateEvents", "Create Events"]]), null);
  assert.equal(permissionProblem({ id: "g1" }, null, POST_PERMISSIONS), null, "nothing known, nothing claimed");
  assert.equal(explainError(new Error("Unknown Message"), guild, null, POST_PERMISSIONS), "Unknown Message");
  assert.match(explainError(Object.assign(new Error("x"), { code: 50013 }), { id: "g1" }, { id: "c2" }, POST_PERMISSIONS), /needs \*\*View Channel, Send Messages, Embed Links\*\* in <#c2>/);
});

test("a planning poll is not posted where the bot cannot post, and the user is told what to add", async () => {
  const state = tmpState();
  state.saveCampaign("g1", createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", players: ["p1"] }));
  const guild = server();
  let sent = 0;
  const channel = { id: "chan", isThread: () => false, permissionsFor: () => allow(ViewChannel, SendMessages, EmbedLinks), async send() { sent += 1; return { id: "m1" }; } };
  const i = fakeInteraction({ command: null, userId: "dm1" });
  Object.assign(i, {
    customId: "poll:create:lost-mines",
    values: ["2026-03-06"],
    guild,
    channel,
    member: { roles: [] },
    isChatInputCommand: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    async update(p) { this.replies.push(p); },
  });
  await handleInteraction(i, { state, config: { timezone: "Europe/Stockholm" }, log: quietLog }, { log: quietLog });
  assert.equal(sent, 0);
  assert.match(i.replies.at(-1).content, /^⚠️ The poll cannot be posted here: the bot lacks \*\*Read Message History\*\* in <#chan>\. An administrator can add it in <#chan> → \*Edit Channel → Permissions\*/);
});

test("/test-message names what the bot lacks in the target channel", async () => {
  const state = tmpState();
  state.setChannel("g1", "status", "c1");
  let tried = 0;
  const notifier = { sendTo: async () => { tried += 1; } };
  const i = await run(server({ channels: { c1: { perms: [ViewChannel, EmbedLinks] } } }), { command: "test-message", options: { type: "status" }, admin: true, state, notifier });
  assert.equal(tried, 0);
  assert.match(i.replies[0].content, /Could not post in <#c1>: the bot lacks \*\*Send Messages\*\* in <#c1>\. .*\*\*@Foundry\*\*/);
});

test("/channel set and /campaign voice-channel save, but warn what the bot still needs there", async () => {
  const guild = server({ channels: { c1: { perms: [ViewChannel] }, vc: { perms: [ViewChannel], type: ChannelType.GuildVoice } } });
  const set = await run(guild, { command: "channel", subcommand: "set", options: { type: "status", channel: guild.channels.cache.get("c1") }, admin: true });
  assert.match(set.replies[0].content, /\*\*status\*\* messages will be posted in <#c1>\.\n⚠️ The bot cannot post in <#c1> yet: the bot lacks \*\*Send Messages, Embed Links\*\* in <#c1>\./);
  const fine = await run(server({ channels: { c1: { perms: [ViewChannel, SendMessages, EmbedLinks] } } }), { command: "channel", subcommand: "set", options: { type: "status", channel: { id: "c1", permissionsFor: () => allow(ViewChannel, SendMessages, EmbedLinks) } }, admin: true });
  assert.doesNotMatch(fine.replies[0].content, /⚠️/);

  const state = tmpState();
  state.saveCampaign("g1", createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1" }));
  const voice = await run(guild, { command: "campaign", subcommand: "voice-channel", options: { campaign: "lost-mines", channel: guild.channels.cache.get("vc") }, userId: "dm1", state });
  assert.match(voice.replies[0].content, /is now the default voice channel.*\n⚠️ Session events cannot be held in <#vc> yet: the bot lacks \*\*Connect\*\* in <#vc>\./s);
  assert.equal(state.campaign("g1", "lost-mines").voiceChannel, "vc");
});

test("a command Discord refuses for a permission says which one and where, not just 'something went wrong'", () => {
  const err = Object.assign(new Error("Missing Permissions"), { code: 50013 });
  const guild = server({ guildPerms: [ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory], channels: {} });
  const channel = { id: "chan", isThread: () => false, permissionsFor: () => allow(ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory, Connect) };
  assert.equal(failureMessage(err, { guild, channel }), "⚠️ Discord refused that because the bot lacks **Send Messages in Threads, Create Events** in this server. An administrator can add them under *Server Settings → Roles →* **@Foundry**.");
  assert.match(failureMessage(err, { guild: { id: "g1" }, channel: { id: "chan" } }), /missing a permission \(Missing Permissions\)\. Check the bot's role under \*Server Settings → Roles\* and <#chan> → \*Edit Channel → Permissions\*/);
  assert.match(failureMessage(new Error("kaboom"), {}), /Something went wrong/);
});
