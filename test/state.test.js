import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StateStore, defaultState } from "../src/state.js";
import { tmpDir } from "./helpers.js";

test("a missing state file yields defaults and save creates it", () => {
  const file = path.join(tmpDir(), "nested", "state.json");
  const s = new StateStore(file).load();
  assert.deepEqual(s.data, defaultState());
  s.save();
  assert.ok(fs.existsSync(file));
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left behind");
});

test("state survives a save/load round trip and old files gain new defaults", () => {
  const file = path.join(tmpDir(), "state.json");
  fs.writeFileSync(file, JSON.stringify({ guilds: { g1: { channels: { status: "c1" } } }, foundry: { status: "up" } }));
  const s = new StateStore(file).load();
  assert.equal(s.data.guilds.g1.channels.status, "c1");
  assert.equal(s.data.foundry.status, "up");
  assert.equal(s.data.monitor.enabled.world, true, "default merged in");
  s.setChannel("g1", "world", "c2");
  const again = new StateStore(file).load();
  assert.equal(again.data.guilds.g1.channels.world, "c2");
});

test("corrupt state file gives a clear error", () => {
  const file = path.join(tmpDir(), "state.json");
  fs.writeFileSync(file, "{not json");
  assert.throws(() => new StateStore(file).load(), /not valid JSON/);
});

test("channel resolution falls back to default and rejects unknown types", () => {
  const s = new StateStore(path.join(tmpDir(), "s.json")).load();
  assert.equal(s.resolveChannel("g", "status"), null);
  s.setChannel("g", "default", "dflt");
  assert.equal(s.resolveChannel("g", "status"), "dflt");
  s.setChannel("g", "status", "stat");
  assert.equal(s.resolveChannel("g", "status"), "stat");
  assert.equal(s.resolveChannel("g", "updates"), "dflt");
  assert.equal(s.clearChannel("g", "status"), true);
  assert.equal(s.clearChannel("g", "status"), false);
  assert.equal(s.resolveChannel("g", "status"), "dflt");
  assert.throws(() => s.setChannel("g", "bogus", "x"), /Unknown message type/);
});

test("notified keys are remembered", () => {
  const s = new StateStore(path.join(tmpDir(), "s.json")).load();
  assert.equal(s.wasNotified("module:x@1.0"), false);
  s.markNotified("module:x@1.0", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.wasNotified("module:x@1.0"), true);
  assert.equal(s.data.notified["module:x@1.0"], "2026-01-01T00:00:00.000Z");
});
