import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionScheduler } from "../src/sessions.js";
import { createCampaign, createSession } from "../src/campaigns.js";
import { fakeClock, quietLog, tmpState } from "./helpers.js";

function setup({ start = "2026-03-01T18:00:00Z" } = {}) {
  const clock = fakeClock(start);
  const state = tmpState();
  const events = [];
  const world = { failDelivery: false };
  const scheduler = new SessionScheduler({
    state,
    emit: async (event) => {
      if (world.failDelivery) throw new Error("discord down");
      events.push(event);
    },
    now: clock.now,
    log: quietLog,
  });
  const foundry = (status, worldId) => state.update((d) => {
    d.foundry.status = status;
    d.foundry.world = worldId;
  });
  const campaign = createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", players: ["p1", "p2"] }, { now: clock.now });
  state.saveCampaign("g1", campaign);
  const plan = (iso, guildId = "g1", id = campaign.id) => state.updateCampaign(guildId, id, (c) => {
    c.nextSession = createSession({ at: iso }, { now: clock.now });
    c.reminderSentFor = null;
  });
  return { scheduler, state, events, clock, world, foundry, campaign, plan, types: () => events.map((e) => e.type) };
}

test("15 minutes before a session the DM is warned once when the world is not up", async () => {
  const t = setup();
  t.foundry("up", null); // setup screen
  t.plan("2026-03-01T19:00:00Z");

  t.clock.set("2026-03-01T18:44:30Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), [], "too early");

  t.clock.set("2026-03-01T18:45:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), ["sessionWorldNotUp"]);
  const e = t.events[0];
  assert.equal(e.guildId, "g1");
  assert.equal(e.channelId, null);
  assert.equal(e.campaign.id, "lost-mines");
  assert.equal(e.campaign.dm, "dm1");
  assert.equal(e.at.toISOString(), "2026-03-01T19:00:00.000Z");
  assert.deepEqual(e.foundry, { status: "up", world: null });
  assert.equal(t.state.campaign("g1", "lost-mines").reminderSentFor, "2026-03-01T19:00:00.000Z");

  t.clock.set("2026-03-01T18:50:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), ["sessionWorldNotUp"], "not repeated");

  t.clock.set("2026-03-01T19:00:00Z");
  await t.scheduler.tick();
  assert.ok(t.state.campaign("g1", "lost-mines").nextSession, "the session stays visible while it runs");
  t.clock.set("2026-03-01T23:00:00Z");
  await t.scheduler.tick();
  const c = t.state.campaign("g1", "lost-mines");
  assert.equal(c.nextSession, null, "archived after the session");
  assert.equal(c.lastSession.at, "2026-03-01T19:00:00.000Z");
  assert.equal(c.reminderSentFor, null);
});

test("no warning when the right world is running; warning when Foundry is down or another world runs", async () => {
  const t = setup();
  t.foundry("up", "lost-mines");
  t.plan("2026-03-01T19:00:00Z");
  t.clock.set("2026-03-01T18:46:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), []);
  assert.equal(t.state.campaign("g1", "lost-mines").reminderSentFor, "2026-03-01T19:00:00.000Z", "checked and found fine");

  t.plan("2026-03-01T21:00:00Z");
  t.foundry("down", null);
  t.clock.set("2026-03-01T20:46:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), ["sessionWorldNotUp"]);
  assert.equal(t.events[0].foundry.status, "down");

  t.plan("2026-03-01T23:00:00Z");
  t.foundry("up", "other-world");
  t.clock.set("2026-03-01T22:50:00Z");
  await t.scheduler.tick();
  assert.equal(t.types().length, 2);
  assert.equal(t.events[1].foundry.world, "other-world");
});

test("a new session time resets the reminder; a failed delivery is retried; nothing happens after the start", async () => {
  const t = setup();
  t.foundry("down", null);
  t.plan("2026-03-01T19:00:00Z");
  t.world.failDelivery = true;
  t.clock.set("2026-03-01T18:46:00Z");
  await t.scheduler.tick();
  assert.equal(t.state.campaign("g1", "lost-mines").reminderSentFor, null, "not marked when Discord failed");
  t.world.failDelivery = false;
  t.clock.set("2026-03-01T18:46:30Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), ["sessionWorldNotUp"]);

  t.plan("2026-03-01T19:30:00Z"); // DM moved the session
  t.clock.set("2026-03-01T19:16:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.types(), ["sessionWorldNotUp", "sessionWorldNotUp"], "warned again for the new time");

  t.plan("2026-03-01T20:00:00Z");
  t.clock.set("2026-03-01T20:01:00Z"); // bot was offline over the reminder window
  await t.scheduler.tick();
  assert.equal(t.types().length, 2, "no warning once the session has started");
});

test("campaign channel override and several servers", async () => {
  const t = setup();
  t.state.updateCampaign("g1", "lost-mines", (c) => (c.channel = "camp-chan"));
  const other = createCampaign({ name: "Elsewhere", world: "lost-mines", dm: "dm2" }, { now: t.clock.now });
  t.state.saveCampaign("g2", other);
  t.foundry("down", null);
  t.plan("2026-03-01T19:00:00Z", "g1");
  t.plan("2026-03-01T19:00:00Z", "g2", "elsewhere");
  t.clock.set("2026-03-01T18:50:00Z");
  await t.scheduler.tick();
  assert.deepEqual(t.events.map((e) => [e.guildId, e.channelId]), [["g1", "camp-chan"], ["g2", null]]);
});

test("a world start tags the players of every campaign bound to that world", async () => {
  const t = setup();
  t.state.saveCampaign("g2", createCampaign({ name: "Same world, other server", world: "lost-mines", dm: "dm2", players: ["q1"] }, { now: t.clock.now }));
  t.state.saveCampaign("g1", createCampaign({ name: "Other", world: "other", dm: "dm3" }, { now: t.clock.now }));
  t.plan("2026-03-01T19:00:00Z");

  assert.equal(await t.scheduler.onMonitorEvent({ type: "worldStopped", world: "lost-mines" }), 0);
  assert.equal(await t.scheduler.onMonitorEvent({ type: "worldStarted", world: "unbound", status: {} }), 0);
  assert.deepEqual(t.types(), []);

  t.clock.set("2026-03-01T18:40:00Z");
  assert.equal(await t.scheduler.onMonitorEvent({ type: "worldStarted", world: "lost-mines", previousWorld: null, status: { system: "dnd5e" } }), 2);
  assert.deepEqual(t.types(), ["worldReady", "worldReady"]);
  assert.deepEqual(t.events.map((e) => e.guildId), ["g1", "g2"]);
  assert.deepEqual(t.events[0].campaign.players, ["p1", "p2"]);
  assert.equal(t.events[0].session.at, "2026-03-01T19:00:00.000Z", "the planned session is included");
  assert.equal(t.events[1].session, null);
  assert.equal(t.events[0].status.system, "dnd5e");

  t.world.failDelivery = true;
  assert.equal(await t.scheduler.onMonitorEvent({ type: "worldStarted", world: "lost-mines", status: {} }), 0, "delivery failures are counted, not thrown");
});
