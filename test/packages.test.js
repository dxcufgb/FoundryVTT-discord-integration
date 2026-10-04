import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normaliseManifest, readFoundryVersion, readWorld, resolveDataFolder, scanPackages } from "../src/foundry/packages.js";
import { fakeDataFolder, tmpDir } from "./helpers.js";

test("normaliseManifest handles v13 and legacy manifests", () => {
  const m = normaliseManifest("module", { id: "lib-wrapper", title: "libWrapper", version: "1.13.2", compatibility: { minimum: "11", verified: "13" }, changelog: "https://x/changes", url: "https://x" });
  assert.deepEqual(m, { type: "module", id: "lib-wrapper", title: "libWrapper", version: "1.13.2", compatibility: "13", manifest: null, changelog: "https://x/changes", url: "https://x" });
  const legacy = normaliseManifest("module", { name: "old-mod", version: 2, compatibleCoreVersion: "0.8.9" }, "old-mod-folder");
  assert.equal(legacy.id, "old-mod");
  assert.equal(legacy.title, "old-mod");
  assert.equal(legacy.version, "2");
  assert.equal(legacy.compatibility, "0.8.9");
  assert.equal(normaliseManifest("module", null, "x"), null);
  assert.equal(normaliseManifest("module", {}, ""), null);
  assert.equal(normaliseManifest("module", {}, "from-folder").id, "from-folder");
});

test("scanPackages reads systems and modules and skips broken folders", () => {
  const root = fakeDataFolder([
    { type: "system", id: "dnd5e", title: "D&D 5e", version: "5.1.0" },
    { type: "module", id: "b-mod", title: "B", version: "2.0.0" },
    { type: "module", id: "a-mod", title: "A", version: "1.0.0" },
  ]);
  fs.mkdirSync(path.join(root, "Data", "modules", "broken"));
  fs.writeFileSync(path.join(root, "Data", "modules", "broken", "module.json"), "{oops");
  fs.mkdirSync(path.join(root, "Data", "modules", "empty-folder"));
  fs.writeFileSync(path.join(root, "Data", "modules", "stray-file.txt"), "ignored");

  const pkgs = scanPackages(root);
  assert.deepEqual(pkgs.map((p) => `${p.type}:${p.id}`), ["system:dnd5e", "module:a-mod", "module:b-mod"]);
  assert.deepEqual(scanPackages(root, { modules: false }).map((p) => p.id), ["dnd5e"]);
  assert.deepEqual(scanPackages(path.join(root, "Data")).length, 3, "accepts the Data folder itself");
  assert.equal(resolveDataFolder(root), path.join(root, "Data"));
  assert.deepEqual(scanPackages(path.join(root, "does-not-exist")), []);
  assert.deepEqual(scanPackages(undefined), []);
});

test("readWorld and readFoundryVersion", () => {
  const root = fakeDataFolder([{ type: "world", id: "my-world", title: "My World", system: "dnd5e", version: "1.0" }]);
  assert.equal(readWorld(root, "my-world").title, "My World");
  assert.equal(readWorld(root, "missing"), null);
  assert.equal(readWorld(root, null), null);

  const app = tmpDir("fvtt-app-");
  fs.mkdirSync(path.join(app, "resources", "app"), { recursive: true });
  fs.writeFileSync(path.join(app, "resources", "app", "package.json"), JSON.stringify({ name: "foundryvtt", version: "13.346" }));
  assert.equal(readFoundryVersion(app), "13.346");
  assert.equal(readFoundryVersion(path.join(app, "resources", "app")), "13.346");
  assert.equal(readFoundryVersion(path.join(app, "nope")), null);
  assert.equal(readFoundryVersion(undefined), null);
});
