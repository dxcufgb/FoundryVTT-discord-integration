import { test } from "node:test";
import assert from "node:assert/strict";
import { FoundryMonitor } from "../src/foundry/monitor.js";
import { createWindow } from "../src/restartWindow.js";
import { fakeClock, quietLog, tmpState, upStatus } from "./helpers.js";

/** Build a monitor whose Foundry answer and package list can be changed between ticks. */
function setup({ start, downAfterFailures = 2, packages = [], foundryVersionOnDisk = null } = {}) {
  const clock = fakeClock(start);
  const state = tmpState();
  const events = [];
  const world = { result: { ok: true, status: upStatus() }, packages, foundryVersionOnDisk, failDelivery: false };
  const monitor = new FoundryMonitor({
    fetchStatus: async () => world.result,
    scanPackages: () => world.packages,
    readFoundryVersion: () => world.foundryVersionOnDisk,
    state,
    emit: async (event) => {
      if (world.failDelivery) throw new Error("discord down");
      events.push(event);
    },
    options: { downAfterFailures, packageScanEveryMs: 5 * 60_000 },
    now: clock.now,
    log: quietLog,
  });
  const up = (overrides) => (world.result = { ok: true, status: upStatus(overrides) });
  const down = (error = "ECONNREFUSED") => (world.result = { ok: false, error });
  return { monitor, state, events, clock, world, up, down, types: () => events.map((e) => e.type) };
}

test("first observation is silent, then down needs N failures and up reports downtime", async () => {
  const t = setup();
  await t.monitor.tick();
  assert.deepEqual(t.types(), [], "nothing announced on the first check");
  assert.equal(t.state.data.foundry.status, "up");
  assert.equal(t.state.data.foundry.world, "my-world");

  t.down();
  t.clock.advance(30_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), [], "one failure is not yet down");
  assert.equal(t.state.data.foundry.status, "up");
  t.clock.advance(30_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down"]);
  assert.equal(t.events[0].expected, false);
  assert.equal(t.events[0].error, "ECONNREFUSED");
  assert.equal(t.state.data.foundry.status, "down");

  t.clock.advance(30_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down"], "no repeated down messages");

  t.up();
  t.clock.advance(60_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down", "up"]);
  assert.equal(t.events[1].downtimeMs, 90_000);
  assert.equal(t.events[1].expected, false);
});

test("first observation while down is silent until Foundry appears", async () => {
  const t = setup();
  t.down();
  await t.monitor.tick();
  assert.deepEqual(t.types(), []);
  assert.equal(t.state.data.foundry.status, "down");
  t.up();
  t.clock.advance(60_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["up"]);
  assert.equal(t.events[0].downtimeMs, 60_000);
});

test("a restart inside the window is expected; outlasting it raises an alert once", async () => {
  const t = setup({ start: "2026-03-01T03:58:00Z" });
  t.state.update((d) => {
    d.monitor.restartWindow = createWindow({ start: "04:00", durationMinutes: 10, timezone: "UTC", graceMinutes: 5 });
  });
  await t.monitor.tick(); // baseline, up
  t.clock.set("2026-03-01T04:01:00Z");
  t.down();
  await t.monitor.tick();
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down"]);
  assert.equal(t.events[0].expected, true);
  assert.equal(t.events[0].window.start.toISOString(), "2026-03-01T04:00:00.000Z");

  t.clock.set("2026-03-01T04:12:00Z"); // window over, inside grace
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down"]);
  t.clock.set("2026-03-01T04:15:00Z"); // grace over
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down", "restartOverdue"]);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down", "restartOverdue"], "alert only once");

  t.up();
  t.clock.set("2026-03-01T04:20:00Z");
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down", "restartOverdue", "up"]);
  assert.equal(t.events[2].expected, true, "came back after a window restart");
  assert.equal(t.state.data.foundry.restartWindowAlerted, false);
});

test("downtime outside the window is not expected and never raises the overdue alert", async () => {
  const t = setup({ start: "2026-03-01T10:00:00Z", downAfterFailures: 1 });
  t.state.update((d) => {
    d.monitor.restartWindow = createWindow({ start: "04:00", durationMinutes: 10, timezone: "UTC" });
  });
  await t.monitor.tick();
  t.down();
  await t.monitor.tick();
  t.clock.advance(3 * 3600_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["down"]);
  assert.equal(t.events[0].expected, false);
});

test("restart window start is announced only when asked, once per opening", async () => {
  const t = setup({ start: "2026-03-01T03:59:00Z" });
  t.state.update((d) => {
    d.monitor.restartWindow = createWindow({ start: "04:00", durationMinutes: 10, timezone: "UTC", announceStart: true });
  });
  await t.monitor.tick();
  t.clock.set("2026-03-01T04:00:30Z");
  await t.monitor.tick();
  t.clock.set("2026-03-01T04:05:00Z");
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["restartWindowStarted"]);
  t.clock.set("2026-03-02T04:00:30Z");
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["restartWindowStarted", "restartWindowStarted"]);
});

test("world started, switched and stopped", async () => {
  const t = setup();
  t.up({ active: false, world: null, system: null });
  await t.monitor.tick();
  t.up({ world: "my-world" });
  await t.monitor.tick();
  t.up({ world: "other" });
  await t.monitor.tick();
  t.up({ active: false, world: null });
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["worldStarted", "worldStarted", "worldStopped"]);
  assert.equal(t.events[0].previousWorld, null);
  assert.equal(t.events[1].previousWorld, "my-world");
  assert.equal(t.events[1].world, "other");
  assert.equal(t.events[2].world, "other");

  t.state.update((d) => {
    d.monitor.enabled.world = false;
  });
  t.up({ world: "quiet" });
  await t.monitor.tick();
  assert.equal(t.types().length, 3, "world monitor off");
  assert.equal(t.state.data.foundry.world, "quiet", "state still tracked");
});

test("Foundry version changes are announced once, also when read from disk while down", async () => {
  const t = setup({ downAfterFailures: 1 });
  await t.monitor.tick(); // baseline 13.346
  t.up({ version: "13.347" });
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["foundryUpdated"]);
  assert.deepEqual([t.events[0].previousVersion, t.events[0].version], ["13.346", "13.347"]);

  // Simulate a restart of the bot that lost its memory of having announced: the notified map protects us.
  t.state.update((d) => {
    d.foundry.version = "13.346";
  });
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["foundryUpdated"], "13.347 was already announced");

  t.down();
  await t.monitor.tick();
  t.world.foundryVersionOnDisk = "13.348";
  t.clock.advance(6 * 60_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["foundryUpdated", "down", "foundryUpdated"]);
  assert.equal(t.events[2].version, "13.348");
});

test("package updates: silent baseline, each update once, installs and removals, retries after failed delivery", async () => {
  const mod = (id, version) => ({ type: "module", id, title: id, version });
  const t = setup({ packages: [mod("a", "1.0"), { type: "system", id: "dnd5e", title: "D&D", version: "5.0" }] });
  await t.monitor.tick();
  assert.deepEqual(t.types(), [], "baseline is silent");
  assert.equal(Object.keys(t.state.data.packages).length, 2);

  t.world.packages = [mod("a", "1.1"), { type: "system", id: "dnd5e", title: "D&D", version: "5.0" }, mod("b", "0.1")];
  await t.monitor.tick();
  assert.deepEqual(t.types(), [], "scans are rate limited");
  t.clock.advance(6 * 60_000);
  await t.monitor.tick();
  assert.deepEqual(t.types(), ["packageUpdated", "packageInstalled"]);
  assert.equal(t.events[0].pkg.id, "a");
  assert.equal(t.events[0].pkg.previousVersion, "1.0");
  assert.equal(t.events[1].pkg.id, "b");

  // Bot restarts and loses the snapshot but not the notified map -> no duplicate.
  t.state.update((d) => {
    d.packages["module:a"].version = "1.0";
  });
  t.clock.advance(6 * 60_000);
  await t.monitor.tick();
  assert.equal(t.types().length, 2, "a@1.1 announced only once");

  // Delivery failure keeps the announcement pending.
  t.world.packages = [mod("a", "1.2"), { type: "system", id: "dnd5e", title: "D&D", version: "5.1" }];
  t.world.failDelivery = true;
  t.clock.advance(6 * 60_000);
  await t.monitor.tick();
  assert.equal(t.types().length, 2);
  t.world.failDelivery = false;
  await t.monitor.maybeScanPackages(true);
  assert.deepEqual(t.types().slice(2), ["packageUpdated", "packageUpdated", "packageRemoved"]);
  assert.equal(t.events[4].pkg.id, "b");
  assert.equal(t.events[4].pkg.version, "0.1");

  // Removal announced once; reinstall then remove again is announced again.
  await t.monitor.maybeScanPackages(true);
  assert.equal(t.types().length, 5);
  t.world.packages = [...t.world.packages, mod("b", "0.1")];
  await t.monitor.maybeScanPackages(true);
  assert.equal(t.types().length, 5, "b@0.1 install was already announced");
  t.world.packages = t.world.packages.filter((p) => p.id !== "b");
  await t.monitor.maybeScanPackages(true);
  assert.deepEqual(t.types().slice(5), ["packageRemoved"]);
});

test("update settings: systems only, updates monitor off", async () => {
  const t = setup({ packages: [{ type: "module", id: "m", title: "M", version: "1" }, { type: "system", id: "s", title: "S", version: "1" }] });
  t.state.update((d) => {
    d.monitor.updates.trackModules = false;
  });
  await t.monitor.tick();
  assert.deepEqual(Object.keys(t.state.data.packages).sort(), ["module:m", "system:s"], "everything is tracked, only announcements are filtered");
  t.world.packages = [{ type: "module", id: "m", title: "M", version: "2" }, { type: "system", id: "s", title: "S", version: "2" }];
  await t.monitor.maybeScanPackages(true);
  assert.deepEqual(t.types(), ["packageUpdated"]);
  assert.equal(t.events[0].pkg.type, "system");

  t.state.update((d) => {
    d.monitor.enabled.updates = false;
  });
  t.world.packages = [{ type: "system", id: "s", title: "S", version: "3" }];
  await t.monitor.maybeScanPackages(true);
  assert.equal(t.types().length, 1);
  assert.equal(t.state.data.packages["system:s"].version, "3", "snapshot still follows reality");
});

test("overlapping ticks are skipped and errors in the fetcher do not crash", async () => {
  const state = tmpState();
  let resolve;
  const monitor = new FoundryMonitor({
    fetchStatus: () => new Promise((r) => (resolve = r)),
    scanPackages: () => [],
    state,
    emit: async () => {},
    options: { downAfterFailures: 1 },
    log: quietLog,
  });
  const first = monitor.tick();
  await monitor.tick(); // returns immediately
  resolve({ ok: true, status: upStatus() });
  await first;
  assert.equal(state.data.foundry.status, "up");

  const throwing = new FoundryMonitor({ fetchStatus: async () => { throw new Error("boom"); }, scanPackages: () => [], state, emit: async () => {}, options: { downAfterFailures: 1 }, log: quietLog });
  await throwing.tick();
  assert.equal(state.data.foundry.status, "up", "unchanged after an internal error");
});
