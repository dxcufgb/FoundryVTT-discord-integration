import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleUsage, readModuleConfiguration, requiredModuleIds, scanWorlds, scanWorldsWithModules } from "../src/foundry/worlds.js";
import { fakeDataFolder } from "./helpers.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leveldb");

/** Build a data folder with worlds; each world's settings come from a LevelDB fixture, a NeDB text or nothing. */
function worldsFolder(worlds) {
  const root = fakeDataFolder(worlds.map(({ id, title, system, requires, settings, nedb, ...rest }) => ({ type: "world", id, title, system, version: "1.0", relationships: requires ? { requires: requires.map((r) => ({ id: r, type: "module" })) } : undefined, ...rest })));
  for (const w of worlds) {
    const dataDir = path.join(root, "Data", "worlds", w.id, "data");
    if (w.settings) fs.cpSync(path.join(FIXTURES, w.settings), path.join(dataDir, "settings"), { recursive: true });
    if (w.nedb) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "settings.db"), w.nedb);
    }
  }
  return root;
}

test("requiredModuleIds reads v10+ relationships and legacy dependencies", () => {
  assert.deepEqual(requiredModuleIds({ relationships: { requires: [{ id: "lib-wrapper", type: "module" }, { id: "dnd5e", type: "system" }, { id: "socketlib" }] } }), ["lib-wrapper", "socketlib"]);
  assert.deepEqual(requiredModuleIds({ dependencies: [{ name: "old-dep" }, { name: "sys", type: "system" }] }), ["old-dep"]);
  assert.deepEqual(requiredModuleIds({}), []);
  assert.deepEqual(requiredModuleIds(null), []);
});

test("scanWorlds lists worlds with system and required modules", () => {
  const root = worldsFolder([
    { id: "zeta", title: "Zeta", system: "pf2e" },
    { id: "alpha", title: "Alpha World", system: "dnd5e", requires: ["lib-wrapper"], coreVersion: "13.346" },
  ]);
  fs.mkdirSync(path.join(root, "Data", "worlds", "broken"));
  const worlds = scanWorlds(root);
  assert.deepEqual(worlds.map((w) => w.id), ["alpha", "zeta"]);
  assert.equal(worlds[0].title, "Alpha World");
  assert.equal(worlds[0].system, "dnd5e");
  assert.equal(worlds[0].coreVersion, "13.346");
  assert.deepEqual(worlds[0].requires, ["lib-wrapper"]);
  assert.deepEqual(scanWorlds(path.join(root, "nope")), []);
  assert.deepEqual(scanWorlds(undefined), []);
});

test("readModuleConfiguration: LevelDB, NeDB, never launched", () => {
  const nedb = [
    JSON.stringify({ key: "core.moduleConfiguration", value: JSON.stringify({ a: true, b: false }), _id: "x1" }),
    JSON.stringify({ key: "core.time", value: "0", _id: "x2" }),
    JSON.stringify({ key: "core.moduleConfiguration", value: JSON.stringify({ a: true, b: true }), _id: "x1" }), // NeDB appends updates
    "not json",
    "",
  ].join("\n");
  const root = worldsFolder([
    { id: "ldb", title: "L", system: "dnd5e", settings: "settings-ldb" },
    { id: "log", title: "G", system: "dnd5e", settings: "settings-log" },
    { id: "old", title: "O", system: "dnd5e", nedb },
    { id: "fresh", title: "F", system: "dnd5e" },
  ]);
  const w = Object.fromEntries(scanWorlds(root).map((x) => [x.id, x]));
  assert.deepEqual(readModuleConfiguration(w.ldb.path), { ok: true, source: "leveldb", modules: { "lib-wrapper": true, "old-module": false, "dice-so-nice": true, "new-module": true } });
  assert.deepEqual(readModuleConfiguration(w.log.path).modules, { "lib-wrapper": true, "dice-so-nice": true, "tidy5e-sheet": true });
  assert.deepEqual(readModuleConfiguration(w.old.path), { ok: true, source: "nedb", modules: { a: true, b: true } });
  const fresh = readModuleConfiguration(w.fresh.path);
  assert.equal(fresh.ok, false);
  assert.match(fresh.reason, /never launched/);
});

test("moduleUsage finds modules that no world uses", () => {
  const root = worldsFolder([
    { id: "ldb", title: "L", system: "dnd5e", settings: "settings-ldb", requires: ["required-only"] },
    { id: "log", title: "G", system: "dnd5e", settings: "settings-log" },
    { id: "fresh", title: "F", system: "dnd5e" },
  ]);
  const installed = [
    { id: "lib-wrapper", title: "libWrapper", version: "1.13.2" },
    { id: "old-module", title: "Old", version: "0.1" },
    { id: "tidy5e-sheet", title: "Tidy 5e", version: "3.0" },
    { id: "never-enabled", title: "Never", version: "1.0" },
    { id: "required-only", title: "Required", version: "1.0" },
  ];
  const worlds = scanWorldsWithModules(root);
  const result = moduleUsage(installed, worlds);
  const byId = Object.fromEntries(result.usage.map((u) => [u.id, u]));
  assert.deepEqual(byId["lib-wrapper"].activeIn, ["ldb", "log"]);
  assert.deepEqual(byId["old-module"].activeIn, [], "disabled (false) does not count as active");
  assert.deepEqual(byId["tidy5e-sheet"].activeIn, ["log"]);
  assert.deepEqual(byId["required-only"], { id: "required-only", title: "Required", version: "1.0", activeIn: [], requiredBy: ["ldb"], used: true });
  assert.deepEqual(result.unused.map((u) => u.id), ["never-enabled", "old-module"]);
  assert.deepEqual(result.unreadable.map((u) => u.id), ["fresh"]);
  assert.deepEqual(result.worlds.map((w) => [w.id, w.activeModules]), [["fresh", null], ["ldb", 3], ["log", 3]]);
});
