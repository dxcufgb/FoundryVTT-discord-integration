import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, GuildScheduledEventEntityType } from "discord.js";
import { handleInteraction } from "../src/discord/client.js";
import { createCampaign, describeCampaign, NOT_DM_MESSAGE } from "../src/campaigns.js";
import { NOT_VOICE_MANAGER_MESSAGE } from "../src/discord/sessionEvents.js";
import { fakeInteraction, quietLog, tmpState } from "./helpers.js";

const NOW = new Date("2026-03-01T12:00:00Z");
const AT = 1772906400; // 2026-03-07 19:00 in Stockholm

function setup({ voiceChannel = null, gmRole = null } = {}) {
  const state = tmpState();
  state.saveCampaign("g1", createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", players: ["p1"], voiceChannel }, { now: () => NOW }));
  if (gmRole) state.setGmRole("g1", gmRole);
  const created = [];
  const edited = [];
  const sent = [];
  const channels = new Map([["vc9", { id: "vc9", type: ChannelType.GuildVoice }], ["stage1", { id: "stage1", type: ChannelType.GuildStageVoice }]]);
  const guild = {
    id: "g1",
    channels: { cache: channels, fetch: async (id) => { throw new Error(`Unknown Channel ${id}`); } },
    scheduledEvents: {
      create: async (o) => { created.push(o); return { id: `e${created.length}`, name: o.name }; },
      edit: async (id, o) => { edited.push([id, o]); return { id, name: o.name }; },
    },
  };
  const channel = { id: "chan", async send(p) { sent.push(p); return { id: "m1" }; }, messages: { fetch: async () => ({ async edit() {} }) } };
  const ctx = { state, config: { timezone: "Europe/Stockholm" }, worldTitle: () => "The Lost Mines", now: () => NOW, log: quietLog, setWorldNextSession: () => ({ ok: true }) };
  return { ctx, state, created, edited, sent, guild, channel };
}

const last = (i) => i.replies.at(-1);

async function command(env, spec) {
  const i = fakeInteraction(spec);
  i.guild = env.guild;
  if (spec.roles) i.member = { roles: spec.roles };
  await handleInteraction(i, env.ctx, { log: quietLog });
  return i;
}

/** A fake button / select / modal interaction. */
async function component(env, { customId, userId = "dm1", admin = false, values = [], roles = [], fields = {} }) {
  const i = Object.assign(fakeInteraction({ command: null, userId, admin }), {
    customId,
    values,
    guild: env.guild,
    channel: env.channel,
    member: { roles },
    message: { id: "eph" },
    fields: { getTextInputValue: (k) => fields[k] },
    isChatInputCommand: () => false,
    isButton: () => !values.length && !Object.keys(fields).length,
    isChannelSelectMenu: () => values.length > 0,
    isModalSubmit: () => Object.keys(fields).length > 0,
    async update(p) { this.replies.push({ update: true, ...p }); },
    async deferUpdate() { this.replies.push({ deferUpdate: true }); },
  });
  await handleInteraction(i, env.ctx, { log: quietLog });
  return i;
}

const customIds = (reply) => reply.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));

test("/session set without a default voice channel asks for one; picking one creates the event there and offers to keep it", async () => {
  const env = setup();
  const set = await command(env, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-07 19:00" }, userId: "dm1" });
  assert.match(last(set).content, /no default voice channel/);
  assert.ok(last(set).flags, "the question is ephemeral");
  const [menu] = last(set).components[0].toJSON().components;
  assert.equal(menu.custom_id, `session:voice:lost-mines:${AT}`);
  assert.deepEqual(menu.channel_types, [ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
  assert.deepEqual(customIds(last(set))[1], `session:novoice:lost-mines:${AT}`);
  assert.equal(env.state.campaign("g1", "lost-mines").nextSession, null, "nothing is planned before the answer");

  const player = await component(env, { customId: `session:voice:lost-mines:${AT}`, userId: "p1", values: ["vc9"] });
  assert.equal(last(player).content, NOT_DM_MESSAGE);

  const pick = await component(env, { customId: `session:voice:lost-mines:${AT}`, values: ["vc9"] });
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].entityType, GuildScheduledEventEntityType.Voice);
  assert.equal(env.created[0].channel, "vc9");
  assert.equal(env.created[0].scheduledStartTime.toISOString(), "2026-03-07T18:00:00.000Z");
  const session = env.state.campaign("g1", "lost-mines").nextSession;
  assert.equal(session.at, "2026-03-07T18:00:00.000Z");
  assert.equal(session.eventUrl, "https://discord.com/events/g1/e1");
  assert.equal(session.eventCreated, true);
  const announcement = pick.replies.find((r) => r.content?.startsWith("📅"));
  assert.ok(announcement && !announcement.flags, "the announcement is public");
  assert.match(announcement.content, /Event: https:\/\/discord\.com\/events\/g1\/e1\n🔊 Voice channel: <#vc9>/);
  assert.match(last(pick).content, /Make <#vc9> the default voice channel of \*\*Lost Mines\*\*/);
  assert.deepEqual(customIds(last(pick)), ["vc:yes:lost-mines:vc9", "vc:no:lost-mines:vc9"]);

  const stranger = await component(env, { customId: "vc:yes:lost-mines:vc9", userId: "p1" });
  assert.equal(last(stranger).content, NOT_VOICE_MANAGER_MESSAGE);
  const yes = await component(env, { customId: "vc:yes:lost-mines:vc9" });
  assert.match(last(yes).content, /<#vc9> is now the default voice channel/);
  assert.equal(env.state.campaign("g1", "lost-mines").voiceChannel, "vc9");

  // With a default, /session set asks nothing and moves the event the bot created instead of adding one.
  const again = await command(env, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-08 19:00" }, userId: "dm1" });
  assert.match(last(again).content, /Next session of \*\*Lost Mines\*\*.*🔊 Voice channel: <#vc9>/s);
  assert.equal(env.created.length, 1);
  assert.equal(env.edited.length, 1);
  assert.equal(env.edited[0][0], "e1");
  assert.equal(env.edited[0][1].scheduledStartTime.toISOString(), "2026-03-08T18:00:00.000Z");
});

test("skipping the voice channel creates an external event and does not ask about a default", async () => {
  const env = setup();
  const skip = await component(env, { customId: `session:novoice:lost-mines:${AT}` });
  assert.equal(env.created[0].entityType, GuildScheduledEventEntityType.External);
  assert.equal(env.created[0].entityMetadata.location, "Foundry VTT: The Lost Mines");
  assert.equal(env.created[0].channel, undefined);
  assert.match(last(skip).content, /without a voice channel/);
  assert.deepEqual(last(skip).components, []);
  assert.equal(env.state.campaign("g1", "lost-mines").voiceChannel, null);

  const late = await component(env, { customId: "session:novoice:lost-mines:1700000000" });
  assert.match(last(late).content, /in the past now/);
});

test("declining the default explains how to set one later", async () => {
  const env = setup();
  const no = await component(env, { customId: "vc:no:lost-mines:vc9" });
  assert.match(last(no).content, /not saved as the default/);
  assert.match(last(no).content, /`\/campaign voice-channel campaign:Lost Mines channel:<voice channel>`/);
  assert.equal(env.state.campaign("g1", "lost-mines").voiceChannel, null);
});

test("planning poll without a default voice channel asks after the time, then uses the pick (stage channels too)", async () => {
  const env = setup();
  await component(env, { customId: "poll:create:lost-mines", values: ["2026-03-06"] });
  env.state.updatePoll("g1", "m1", (p) => (p.votes = { p1: ["2026-03-06"] }));

  const time = await component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"] });
  assert.equal(last(time).update, true);
  assert.deepEqual(customIds(last(time)), ["poll:voice:m1:2026-03-06:1900", "poll:novoice:m1:2026-03-06:1900"]);
  assert.ok(env.state.poll("g1", "m1"), "the poll stays open until the place is chosen");
  assert.equal(env.created.length, 0);

  const typed = await component(env, { customId: "poll:modal:m1:2026-03-06", fields: { time: "19:30" } });
  assert.ok(last(typed).flags, "after a typed time the question is an ephemeral reply");
  assert.deepEqual(customIds(last(typed)), ["poll:voice:m1:2026-03-06:1930", "poll:novoice:m1:2026-03-06:1930"]);

  const pick = await component(env, { customId: "poll:voice:m1:2026-03-06:1900", values: ["stage1"] });
  assert.equal(env.created[0].entityType, GuildScheduledEventEntityType.StageInstance);
  assert.equal(env.created[0].channel, "stage1");
  assert.equal(env.created[0].scheduledStartTime.toISOString(), "2026-03-06T18:00:00.000Z");
  assert.match(env.sent.at(-1).content, /🔊 Voice channel: <#stage1>/);
  assert.equal(env.state.poll("g1", "m1"), null);
  assert.match(last(pick).content, /Decided.*\n\nMake <#stage1> the default/s);
  assert.deepEqual(customIds(last(pick)), ["vc:yes:lost-mines:stage1", "vc:no:lost-mines:stage1"]);
});

test("a default voice channel that is gone is reported and the session is still planned", async () => {
  const env = setup({ voiceChannel: "deleted" });
  const set = await command(env, { command: "session", subcommand: "set", options: { campaign: "lost-mines", when: "2026-03-07 19:00" }, userId: "dm1" });
  assert.match(last(set).content, /event could not be created \(the voice channel <#deleted> no longer exists/);
  assert.equal(env.state.campaign("g1", "lost-mines").nextSession.at, "2026-03-07T18:00:00.000Z");
});

test("/campaign voice-channel shows, sets and clears the default; create and edit take it too", async () => {
  const env = setup({ gmRole: "role-gm" });
  const run = (spec) => command(env, { command: "campaign", subcommand: "voice-channel", ...spec });
  assert.match(last(await run({ options: { campaign: "lost-mines" }, userId: "p1" })).content, /has no default voice channel/);
  assert.equal(last(await run({ options: { campaign: "lost-mines", channel: { id: "vc9" } }, userId: "p1" })).content, NOT_VOICE_MANAGER_MESSAGE);
  assert.match(last(await run({ options: { campaign: "lost-mines", channel: { id: "vc9" } }, userId: "gm", roles: ["role-gm"] })).content, /<#vc9> is now the default/);
  assert.equal(env.state.campaign("g1", "lost-mines").voiceChannel, "vc9");
  assert.match(last(await run({ options: { campaign: "lost-mines" }, userId: "p1" })).content, /held in <#vc9>/);
  assert.match(describeCampaign(env.state.campaign("g1", "lost-mines")), /Voice channel for events: <#vc9>/);
  assert.match(last(await run({ options: { campaign: "lost-mines", clear: true }, userId: "dm1" })).content, /no longer has a default voice channel/);
  assert.equal(env.state.campaign("g1", "lost-mines").voiceChannel, null);

  await command(env, { command: "campaign", subcommand: "create", options: { name: "Other", world: "other", dm: "dm2", "voice-channel": { id: "vc2" } }, admin: true });
  assert.equal(env.state.campaign("g1", "other").voiceChannel, "vc2");
  await command(env, { command: "campaign", subcommand: "edit", options: { campaign: "other", "voice-channel": { id: "vc3" } }, admin: true });
  assert.equal(env.state.campaign("g1", "other").voiceChannel, "vc3");
  await command(env, { command: "campaign", subcommand: "edit", options: { campaign: "other", "clear-voice-channel": true }, admin: true });
  assert.equal(env.state.campaign("g1", "other").voiceChannel, null);
});
