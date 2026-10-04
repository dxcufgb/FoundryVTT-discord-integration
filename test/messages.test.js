import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessage, discordTime, EVENT_MESSAGE_TYPE, formatDuration } from "../src/messages.js";

const now = () => new Date("2026-03-01T12:00:00Z");

test("formatDuration and discordTime", () => {
  assert.equal(formatDuration(5000), "5s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_723_000), "1h 2m");
  assert.equal(formatDuration(2 * 86_400_000 + 3600_000), "2d 1h");
  assert.equal(formatDuration(null), "unknown");
  assert.equal(discordTime(new Date("2026-03-01T12:00:00Z")), "<t:1772366400:f>");
});

test("every event type has a message type and builds an embed", () => {
  const window = { start: new Date("2026-03-01T04:00:00Z"), end: new Date("2026-03-01T04:15:00Z") };
  const pkg = { type: "module", id: "x", title: "X", version: "2.0", previousVersion: "1.0", changelog: "https://c", url: "https://u", compatibility: "13" };
  const events = [
    { type: "up", downtimeMs: 90_000, status: { version: "13.346", active: true, world: "w" }, expected: false },
    { type: "down", error: "ECONNREFUSED", expected: false },
    { type: "down", expected: true, window },
    { type: "worldStarted", world: "w", previousWorld: null, status: { system: "dnd5e", systemVersion: "5.1.0", version: "13.346" } },
    { type: "worldStopped", world: "w", status: {} },
    { type: "foundryUpdated", version: "13.347", previousVersion: "13.346" },
    { type: "packageUpdated", pkg },
    { type: "packageInstalled", pkg },
    { type: "packageRemoved", pkg },
    { type: "restartWindowStarted", window },
    { type: "restartOverdue", window, downSince: new Date("2026-03-01T04:05:00Z") },
  ];
  for (const event of events) {
    const msg = buildMessage(event, { now });
    assert.equal(msg.messageType, EVENT_MESSAGE_TYPE[event.type], event.type);
    assert.equal(msg.embeds.length, 1);
    assert.ok(msg.embeds[0].title, `${event.type} has a title`);
    assert.equal(msg.embeds[0].timestamp, "2026-03-01T12:00:00.000Z");
    assert.equal(msg.content, undefined, "no mention without a role");
  }
  assert.throws(() => buildMessage({ type: "mystery" }), /No message defined/);
});

test("messages use world titles, show downtime and ping the role only for alerts", () => {
  const worldTitle = (id) => (id === "w" ? "The World" : null);
  const up = buildMessage({ type: "up", downtimeMs: 125_000, status: { active: true, world: "w", version: "13.346" }, expected: true }, { now, worldTitle, mentionRole: "r1" });
  assert.match(up.embeds[0].title, /scheduled restart/);
  assert.equal(up.embeds[0].fields.find((f) => f.name === "Downtime").value, "2m 5s");
  assert.match(up.embeds[0].fields.find((f) => f.name === "World").value, /The World.*`w`/);
  assert.equal(up.content, undefined);

  const down = buildMessage({ type: "down", error: "x", expected: false }, { now, mentionRole: "r1" });
  assert.equal(down.content, "<@&r1>");
  const expectedDown = buildMessage({ type: "down", expected: true, window: { start: now(), end: now() } }, { now, mentionRole: "r1" });
  assert.equal(expectedDown.content, "<@&r1>", "expected restart still pings since down pings are role-based");
  assert.match(expectedDown.embeds[0].title, /restarting/);

  const switched = buildMessage({ type: "worldStarted", world: "w2", previousWorld: "w", status: {} }, { now, worldTitle });
  assert.match(switched.embeds[0].description, /Switched from .*The World.* to \*\*w2\*\*/);

  const updated = buildMessage({ type: "packageUpdated", pkg: { type: "system", id: "dnd5e", title: "D&D", version: "5.2.0", previousVersion: "5.1.0", changelog: "https://c" } }, { now });
  assert.equal(updated.embeds[0].title, "⬆️ System updated");
  assert.match(updated.embeds[0].description, /\*\*5\.1\.0\*\* to \*\*5\.2\.0\*\*/);
  assert.match(updated.embeds[0].description, /\[Changelog\]\(https:\/\/c\)/);
});
