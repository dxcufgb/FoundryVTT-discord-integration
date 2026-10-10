import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import { handleInteraction } from "../src/discord/client.js";
import { createCampaign, NOT_DM_MESSAGE } from "../src/campaigns.js";
import { canRunPoll, dateLabel, parseClock, timeSlots, topDates, upcomingDates } from "../src/polls.js";
import { fakeInteraction, quietLog, tmpState } from "./helpers.js";

const NOW = new Date("2026-03-01T12:00:00Z");

function setup({ gmRole = null } = {}) {
  const state = tmpState();
  state.saveCampaign("g1", createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", players: ["p1", "p2"] }, { now: () => NOW }));
  if (gmRole) state.setGmRole("g1", gmRole);
  const sent = [];
  const created = [];
  const pollMessage = { id: "m1", edits: [], async edit(p) { this.edits.push(p); } };
  const channel = {
    id: "chan",
    async send(p) { sent.push(p); return { id: "m1" }; },
    messages: { fetch: async () => pollMessage },
  };
  const guild = { id: "g1", scheduledEvents: { create: async (o) => { created.push(o); return { id: "e1", name: o.name }; } } };
  const worldWrites = [];
  const ctx = { setWorldNextSession: (w, at) => { worldWrites.push([w, at.toISOString()]); return { ok: true }; }, state, config: { timezone: "Europe/Stockholm" }, worldTitle: () => "The Lost Mines", now: () => NOW, log: quietLog };
  return { ctx, state, sent, created, channel, guild, pollMessage, worldWrites };
}

/** A fake button / select / modal interaction. */
function component(env, { customId, userId = "dm1", admin = false, values = [], roles = [], messageId = "m1", fields = {} }) {
  const base = fakeInteraction({ command: null, userId, admin });
  const message = { id: messageId, deleted: false, edits: [], async delete() { this.deleted = true; }, async edit(p) { this.edits.push(p); } };
  return Object.assign(base, {
    customId,
    values,
    message,
    channel: env.channel,
    guild: env.guild,
    member: { roles },
    fields: { getTextInputValue: (k) => fields[k] },
    isChatInputCommand: () => false,
    isButton: () => !values.length && !Object.keys(fields).length,
    isStringSelectMenu: () => values.length > 0,
    isModalSubmit: () => Object.keys(fields).length > 0,
    async update(p) { this.replied = true; this.replies.push({ update: true, ...p }); },
    async deferUpdate() { this.deferred = true; this.replies.push({ deferUpdate: true }); },
    async showModal(m) { this.replies.push({ modal: m }); },
  });
}

async function startPoll(env, dates = ["2026-03-05", "2026-03-06"]) {
  const i = component(env, { customId: "poll:create:lost-mines", values: dates });
  await handleInteraction(i, env.ctx, { log: quietLog });
  return i;
}

/** Tap the date buttons for one user. */
async function voteFor(env, userId, dates) {
  for (const d of dates) await handleInteraction(component(env, { customId: `poll:toggle:${d}`, userId }), env.ctx, { log: quietLog });
}

const last = (i) => i.replies.at(-1);

test("/planning-poll offers the next 20 days to the DM, admins and the game master role, and refuses others", async () => {
  const env = setup({ gmRole: "role-gm" });
  const run = async (opts) => {
    const i = fakeInteraction({ command: "planning-poll", options: { campaign: "lost-mines" }, ...opts });
    if (opts.roles) i.member = { roles: opts.roles };
    await handleInteraction(i, env.ctx, { log: quietLog });
    return last(i);
  };
  for (const opts of [{ userId: "dm1" }, { userId: "x", admin: true }, { userId: "x", roles: ["role-gm"] }]) {
    const reply = await run(opts);
    const menu = reply.components[0].toJSON().components[0];
    assert.equal(menu.options.length, 20);
    assert.equal(menu.options[0].value, "2026-03-01");
    assert.equal(menu.custom_id, "poll:create:lost-mines");
  }
  assert.match((await run({ userId: "p1" })).content, new RegExp(NOT_DM_MESSAGE.slice(0, 30)));
  const missing = fakeInteraction({ command: "planning-poll", options: { campaign: "nope" } });
  await handleInteraction(missing, env.ctx, { log: quietLog });
  assert.match(last(missing).content, /no campaign/);
});

test("choosing dates posts a poll that tags the DM and the players", async () => {
  const env = setup();
  const i = await startPoll(env);
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].content, /<@dm1> <@p1> <@p2>/);
  assert.deepEqual(env.sent[0].allowedMentions.users, ["dm1", "p1", "p2"]);
  const buttons = env.sent[0].components[1].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.label), ["Toggle all dates", "Decide date", "Delete poll"]);
  assert.deepEqual(env.state.poll("g1", "m1").dates, ["2026-03-05", "2026-03-06"]);
  assert.match(last(i).content, /Poll posted/);
});

test("each date is a button that toggles the user's vote and shows the count", async () => {
  const env = setup();
  await startPoll(env);
  const dateRow = env.sent[0].components[0].toJSON().components;
  assert.deepEqual(dateRow.map((b) => [b.label, b.custom_id]), [["Thu 5 Mar (0)", "poll:toggle:2026-03-05"], ["Fri 6 Mar (0)", "poll:toggle:2026-03-06"]]);

  const stranger = component(env, { customId: "poll:toggle:2026-03-05", userId: "zz" });
  await handleInteraction(stranger, env.ctx, { log: quietLog });
  assert.match(last(stranger).content, /Only the DM and the players/);

  const tap = component(env, { customId: "poll:toggle:2026-03-05", userId: "p1" });
  await handleInteraction(tap, env.ctx, { log: quietLog });
  assert.deepEqual(env.state.poll("g1", "m1").votes, { p1: ["2026-03-05"] });
  assert.equal(last(tap).components[0].toJSON().components[0].label, "Thu 5 Mar (1)", "the buttons are refreshed with the new count");

  await voteFor(env, "p1", ["2026-03-06"]);
  await voteFor(env, "p2", ["2026-03-06"]);
  assert.deepEqual(env.state.poll("g1", "m1").votes, { p1: ["2026-03-05", "2026-03-06"], p2: ["2026-03-06"] });
  await voteFor(env, "p1", ["2026-03-05"]); // tapping again takes the vote back
  assert.deepEqual(env.state.poll("g1", "m1").votes, { p1: ["2026-03-06"], p2: ["2026-03-06"] });
  assert.deepEqual(topDates(env.state.poll("g1", "m1")), { votes: 2, dates: ["2026-03-06"] });
});

test("Toggle all dates votes for every date, then withdraws them all", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-05", "2026-03-06", "2026-03-07"]);
  const all = () => handleInteraction(component(env, { customId: "poll:all", userId: "p1" }), env.ctx, { log: quietLog });
  await all();
  assert.deepEqual(env.state.poll("g1", "m1").votes, { p1: ["2026-03-05", "2026-03-06", "2026-03-07"] });
  await all();
  assert.deepEqual(env.state.poll("g1", "m1").votes, {});
  await voteFor(env, "p1", ["2026-03-05"]); // some but not all: it selects the rest
  await all();
  assert.deepEqual(env.state.poll("g1", "m1").votes.p1, ["2026-03-05", "2026-03-06", "2026-03-07"]);
  const stranger = component(env, { customId: "poll:all", userId: "zz" });
  await handleInteraction(stranger, env.ctx, { log: quietLog });
  assert.match(last(stranger).content, /Only the DM and the players/);
});

test("a full poll fits the button layout, and polls posted with the old menu keep working", async () => {
  const env = setup();
  const dates = upcomingDates(NOW, "Europe/Stockholm", 20);
  await startPoll(env, dates);
  const rows = env.sent[0].components.map((r) => r.toJSON().components);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.length), [5, 5, 5, 5, 3]);
  assert.equal(upcomingDates(NOW, "Europe/Stockholm").length, 20, "the date picker offers 20 days");

  const legacy = component(env, { customId: "poll:vote", userId: "p1", values: [dates[0], dates[3]] });
  await handleInteraction(legacy, env.ctx, { log: quietLog });
  assert.deepEqual(env.state.poll("g1", "m1").votes, { p1: [dates[0], dates[3]] });
  assert.equal(last(legacy).components, undefined, "old polls only refresh the embed");
});

test("delete poll: creator and DM may, other members may not", async () => {
  const env = setup();
  await startPoll(env);
  const denied = component(env, { customId: "poll:delete", userId: "p1" });
  await handleInteraction(denied, env.ctx, { log: quietLog });
  assert.match(last(denied).content, /Only the person who created the poll/);
  assert.ok(env.state.poll("g1", "m1"));

  const ok = component(env, { customId: "poll:delete", userId: "dm1" });
  await handleInteraction(ok, env.ctx, { log: quietLog });
  assert.equal(ok.message.deleted, true);
  assert.equal(env.state.poll("g1", "m1"), null);

  const again = component(env, { customId: "poll:delete", userId: "dm1" });
  await handleInteraction(again, env.ctx, { log: quietLog });
  assert.match(last(again).content, /no longer active/);
});

test("decide: needs votes, offers only the dates with the most votes, then a time, then creates the event", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-05", "2026-03-06", "2026-03-07"]);
  const none = component(env, { customId: "poll:decide" });
  await handleInteraction(none, env.ctx, { log: quietLog });
  assert.match(last(none).content, /Nobody has voted/);

  for (const [userId, values] of [["p1", ["2026-03-05", "2026-03-06"]], ["p2", ["2026-03-06", "2026-03-07"]], ["dm1", ["2026-03-06", "2026-03-05"]]]) {
    await voteFor(env, userId, values);
  }
  const denied = component(env, { customId: "poll:decide", userId: "p2" });
  await handleInteraction(denied, env.ctx, { log: quietLog });
  assert.match(last(denied).content, /Only the person who created the poll/);

  const decide = component(env, { customId: "poll:decide" });
  await handleInteraction(decide, env.ctx, { log: quietLog });
  assert.deepEqual(last(decide).components[0].toJSON().components[0].options.map((o) => o.value), ["2026-03-06"]);

  const date = component(env, { customId: "poll:date:m1", values: ["2026-03-06"], messageId: "eph" });
  await handleInteraction(date, env.ctx, { log: quietLog });
  const menu = last(date).components[0].toJSON().components[0];
  assert.equal(menu.custom_id, "poll:time:m1:2026-03-06");
  assert.equal(menu.options.length, 25);

  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"], messageId: "eph" });
  await handleInteraction(time, env.ctx, { log: quietLog });

  // 19:00 in Stockholm (CET, UTC+1) is 18:00 UTC.
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].scheduledStartTime.toISOString(), "2026-03-06T18:00:00.000Z");
  assert.equal(env.created[0].scheduledEndTime.toISOString(), "2026-03-06T21:00:00.000Z");
  assert.deepEqual(env.worldWrites, [["lost-mines", "2026-03-06T18:00:00.000Z"]]);
  const campaign = env.state.campaign("g1", "lost-mines");
  assert.equal(campaign.nextSession.at, "2026-03-06T18:00:00.000Z");
  assert.equal(campaign.nextSession.source, "event");
  assert.equal(campaign.nextSession.eventUrl, "https://discord.com/events/g1/e1");
  assert.equal(env.sent.length, 2); // the poll, then the announcement
  assert.match(env.sent[1].content, /<@dm1> <@p1> <@p2>.*next session of \*\*Lost Mines\*\*/s);
  assert.match(env.sent[1].content, /events\/g1\/e1/);
  assert.deepEqual(env.pollMessage.edits[0].components, []);
  assert.equal(env.state.poll("g1", "m1"), null);
  assert.match(last(time).content, /Decided/);
});

test("deciding with a typed time; an invalid or past time is refused and keeps the poll", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-01", "2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-01", "2026-03-06"]);

  const button = component(env, { customId: "poll:custom:m1:2026-03-06", messageId: "eph" });
  await handleInteraction(button, env.ctx, { log: quietLog });
  assert.equal(last(button).modal.toJSON().custom_id, "poll:modal:m1:2026-03-06");

  const bad = component(env, { customId: "poll:modal:m1:2026-03-06", fields: { time: "evening" }, messageId: "eph" });
  await handleInteraction(bad, env.ctx, { log: quietLog });
  assert.match(last(bad).content, /not a time/);
  const past = component(env, { customId: "poll:modal:m1:2026-03-01", fields: { time: "08:00" }, messageId: "eph" });
  await handleInteraction(past, env.ctx, { log: quietLog });
  assert.match(last(past).content, /in the past/);
  assert.ok(env.state.poll("g1", "m1"));
  assert.equal(env.created.length, 0);

  const ok = component(env, { customId: "poll:modal:m1:2026-03-06", fields: { time: "19:30" }, messageId: "eph" });
  await handleInteraction(ok, env.ctx, { log: quietLog });
  assert.equal(env.state.campaign("g1", "lost-mines").nextSession.at, "2026-03-06T18:30:00.000Z");
  assert.match(last(ok).content, /Decided/);
});

test("if the event cannot be created the session is still set and announced", async () => {
  const env = setup();
  env.guild.scheduledEvents.create = async () => { throw new Error("Missing Permissions"); };
  await startPoll(env, ["2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  await handleInteraction(component(env, { customId: "poll:time:m1:2026-03-06", values: ["20:00"], messageId: "eph" }), env.ctx, { log: quietLog });
  const campaign = env.state.campaign("g1", "lost-mines");
  assert.equal(campaign.nextSession.source, "poll");
  assert.equal(campaign.nextSession.eventId, null);
  assert.match(env.sent[1].content, /Discord event could not be created \(Missing Permissions\)/);
});

test("/gm-role is admin-only and stores the role; helpers", async () => {
  const env = setup();
  const denied = fakeInteraction({ command: "gm-role", subcommand: "set", options: { role: { id: "role-gm" } } });
  await handleInteraction(denied, env.ctx, { log: quietLog });
  assert.equal(env.state.guild("g1").gmRole, null);

  const set = fakeInteraction({ command: "gm-role", subcommand: "set", options: { role: { id: "role-gm" } }, admin: true });
  await handleInteraction(set, env.ctx, { log: quietLog });
  assert.equal(env.state.guild("g1").gmRole, "role-gm");
  const clear = fakeInteraction({ command: "gm-role", subcommand: "clear", admin: true });
  await handleInteraction(clear, env.ctx, { log: quietLog });
  assert.equal(env.state.guild("g1").gmRole, null);

  const campaign = env.state.campaign("g1", "lost-mines");
  assert.equal(canRunPoll({ user: { id: "x" }, member: { roles: { cache: new Map([["r", 1]]) } } }, campaign, "r"), true);
  assert.equal(canRunPoll({ user: { id: "x" }, member: { roles: { cache: new Map() } } }, campaign, "r"), false);
  assert.equal(canRunPoll({ user: { id: "x" }, memberPermissions: { has: (f) => f === PermissionFlagsBits.Administrator } }, campaign, null), true);
  assert.equal(dateLabel("2026-03-06"), "Fri 6 Mar");
  assert.deepEqual(upcomingDates(NOW, "Europe/Stockholm", 3), ["2026-03-01", "2026-03-02", "2026-03-03"]);
  assert.equal(timeSlots().length, 25);
  assert.deepEqual(parseClock("7:30"), { hour: 7, minute: 30 });
  assert.equal(parseClock("25:00"), null);
});

test("a throwing world writer does not stop the announcement", async () => {
  const env = setup();
  env.ctx.setWorldNextSession = () => { throw new Error("boom"); };
  await startPoll(env, ["2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["20:00"], messageId: "eph" });
  await handleInteraction(time, env.ctx, { log: quietLog });
  assert.equal(env.sent.length, 2);
  assert.match(last(time).content, /could not be set on world `lost-mines` \(boom\)/);
});

test("a failing announcement still closes the poll and is reported", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-06"]);
  env.channel.send = async () => { throw new Error("Missing Access"); };
  await voteFor(env, "p1", ["2026-03-06"]);
  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["20:00"], messageId: "eph" });
  await handleInteraction(time, env.ctx, { log: quietLog });
  assert.equal(env.state.campaign("g1", "lost-mines").nextSession.at, "2026-03-06T19:00:00.000Z");
  assert.deepEqual(env.pollMessage.edits[0].components, []);
  assert.match(last(time).content, /the announcement failed \(Missing Access\)/);
});

test("only a date with the most votes can be finalized, and an unavailable channel is reported", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-05", "2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  const losing = component(env, { customId: "poll:time:m1:2026-03-05", values: ["19:00"], messageId: "eph" });
  await handleInteraction(losing, env.ctx, { log: quietLog });
  assert.match(last(losing).content, /no longer has the most votes/);
  assert.ok(env.state.poll("g1", "m1"));
  assert.equal(env.created.length, 0);

  const ok = component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"], messageId: "eph" });
  ok.channel = null;
  await handleInteraction(ok, env.ctx, { log: quietLog });
  assert.match(last(ok).content, /the announcement failed \(the announcement channel is unavailable\)/);
});

test("a poll that another interaction already claimed is not finalized twice", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  const realDelete = env.state.deletePoll.bind(env.state);
  env.state.deletePoll = () => { realDelete("g1", "m1"); return false; }; // someone else got there first
  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"], messageId: "eph" });
  await handleInteraction(time, env.ctx, { log: quietLog });
  assert.match(last(time).content, /no longer active/);
  assert.equal(env.created.length, 0);
  assert.equal(env.state.campaign("g1", "lost-mines").nextSession, null);
});

test("a failing acknowledgement leaves the poll open", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"], messageId: "eph" });
  time.deferUpdate = async () => { throw new Error("Unknown interaction"); };
  await handleInteraction(time, env.ctx, { log: quietLog });
  assert.ok(env.state.poll("g1", "m1"));
  assert.equal(env.created.length, 0);
});

test("a vote that lands during the acknowledgement can still stop a date from being finalized", async () => {
  const env = setup();
  await startPoll(env, ["2026-03-05", "2026-03-06"]);
  await voteFor(env, "p1", ["2026-03-06"]);
  const time = component(env, { customId: "poll:time:m1:2026-03-06", values: ["19:00"], messageId: "eph" });
  time.deferUpdate = async () => { env.state.updatePoll("g1", "m1", (p) => { p.votes = { p2: ["2026-03-05"], dm1: ["2026-03-05"] }; }); };
  await handleInteraction(time, env.ctx, { log: quietLog });
  assert.match(last(time).content, /no longer has the most votes/);
  assert.ok(env.state.poll("g1", "m1"));
  assert.equal(env.created.length, 0);
});
