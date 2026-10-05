import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../src/notifier.js";
import { quietLog, tmpState } from "./helpers.js";

function fakeClient(channels) {
  const sent = [];
  return {
    sent,
    channels: {
      async fetch(id) {
        const ch = channels[id];
        if (ch === "missing") return null;
        if (ch === "error") throw new Error("Unknown Channel");
        if (ch === "voice") return { id };
        return { id, send: async (payload) => (sent.push({ id, payload }), { id: "msg" }) };
      },
    },
  };
}

test("routes each message type to the right channel in every server, with default fallback", async () => {
  const state = tmpState();
  state.setChannel("g1", "status", "c-status");
  state.setChannel("g1", "default", "c-default");
  state.setChannel("g2", "default", "c-g2");
  state.setMentionRole("g2", "role2");
  const client = fakeClient({});
  const n = new Notifier({ client, state, log: quietLog, now: () => new Date("2026-03-01T00:00:00Z") });

  assert.equal(await n.deliver({ type: "down", error: "x", expected: false }), 2);
  assert.deepEqual(client.sent.map((s) => s.id), ["c-status", "c-g2"]);
  assert.equal(client.sent[0].payload.content, undefined);
  assert.equal(client.sent[1].payload.content, "<@&role2>");
  assert.equal("messageType" in client.sent[0].payload, false, "internal field stripped");

  client.sent.length = 0;
  assert.equal(await n.deliver({ type: "worldStopped", world: "w", status: {} }), 2);
  assert.deepEqual(client.sent.map((s) => s.id), ["c-default", "c-g2"]);
});

test("no configured channel drops the event quietly; all failures throw; partial failures do not", async () => {
  const state = tmpState();
  const n = new Notifier({ client: fakeClient({}), state, log: quietLog });
  assert.equal(await n.deliver({ type: "up", status: {} }), 0);

  state.setChannel("g1", "updates", "gone");
  state.setChannel("g2", "updates", "nope");
  const failing = new Notifier({ client: fakeClient({ gone: "missing", nope: "error" }), state, log: quietLog });
  await assert.rejects(() => failing.deliver({ type: "foundryUpdated", version: "1" }), /could not deliver/);

  state.setChannel("g3", "updates", "ok");
  const partial = new Notifier({ client: fakeClient({ gone: "missing", nope: "error" }), state, log: quietLog });
  assert.equal(await partial.deliver({ type: "foundryUpdated", version: "1" }), 1);

  const voiceState = tmpState();
  voiceState.setChannel("g", "updates", "v");
  await assert.rejects(() => new Notifier({ client: fakeClient({ v: "voice" }), state: voiceState, log: quietLog }).deliver({ type: "foundryUpdated", version: "1" }), /could not deliver/);
});

test("campaign events go to their own server only, to the campaign channel when set", async () => {
  const state = tmpState();
  state.setChannel("g1", "default", "c-default");
  state.setChannel("g1", "session", "c-session");
  state.setChannel("g2", "default", "c-g2");
  const client = fakeClient({});
  const n = new Notifier({ client, state, log: quietLog, now: () => new Date("2026-03-01T00:00:00Z") });
  const campaign = { id: "c", name: "C", world: "w", dm: "dm", players: ["p"] };

  assert.equal(await n.deliver({ type: "worldReady", guildId: "g1", channelId: null, campaign, status: {}, session: null }), 1);
  assert.deepEqual(client.sent.map((s) => s.id), ["c-session"], "only the campaign's server, via its session channel");
  assert.equal(client.sent[0].payload.content, "<@p>");
  assert.deepEqual(client.sent[0].payload.allowedMentions, { users: ["p"] });

  client.sent.length = 0;
  assert.equal(await n.deliver({ type: "sessionWorldNotUp", guildId: "g1", channelId: "c-campaign", campaign, at: new Date("2026-03-01T00:15:00Z"), foundry: { status: "down" } }), 1);
  assert.deepEqual(client.sent.map((s) => s.id), ["c-campaign"], "campaign channel wins");

  client.sent.length = 0;
  assert.equal(await n.deliver({ type: "worldReady", guildId: "g2", channelId: null, campaign, status: {}, session: null }), 1);
  assert.deepEqual(client.sent.map((s) => s.id), ["c-g2"], "default channel fallback");

  client.sent.length = 0;
  assert.equal(await n.deliver({ type: "worldReady", guildId: "g3", channelId: null, campaign, status: {}, session: null }), 0, "server without channels: dropped quietly");
  assert.equal(client.sent.length, 0);
});
