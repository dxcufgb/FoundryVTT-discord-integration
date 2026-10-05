import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleInteraction } from "../src/discord/client.js";
import { FoundryWebsite } from "../src/foundry/releases.js";
import { scanPackages } from "../src/foundry/packages.js";
import { scanWorldsWithModules } from "../src/foundry/worlds.js";
import { fakeDataFolder, fakeInteraction, quietLog, tmpState } from "./helpers.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leveldb");

const RELEASES_HTML = `
<li><a href="/releases/14.368">Release 14.368</a> Stable</li>
<li><a href="/releases/13.351">Release 13.351</a> Stable</li>
<li><a href="/releases/13.346">Release 13.346</a> Stable</li>`;

function dataFolder() {
  const root = fakeDataFolder([
    { type: "system", id: "dnd5e", title: "D&D 5e", version: "5.0.0", compatibility: { minimum: "13", verified: "13" } },
    { type: "module", id: "lib-wrapper", title: "libWrapper", version: "1.13.1", compatibility: { minimum: "11", verified: "13" }, manifest: "https://x/lw/module.json" },
    { type: "module", id: "old-module", title: "Old Module", version: "0.1.0", compatibility: { verified: "12", maximum: "13" } },
    { type: "module", id: "never-enabled", title: "Never Enabled", version: "1.0.0", manifest: "https://x/never/module.json" },
    { type: "world", id: "campaign", title: "The Campaign", system: "dnd5e" },
    { type: "world", id: "oneshot", title: "One Shot", system: "dnd5e" },
  ]);
  fs.cpSync(path.join(FIXTURES, "settings-ldb"), path.join(root, "Data", "worlds", "campaign", "data", "settings"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "settings-log"), path.join(root, "Data", "worlds", "oneshot", "data", "settings"), { recursive: true });
  return root;
}

function fakeFetch(routes) {
  return async (url) => {
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    return { ok: true, status: 200, text: async () => (typeof hit === "string" ? hit : JSON.stringify(hit)) };
  };
}

const ROUTES = {
  "https://site.test/releases/": RELEASES_HTML,
  "https://site.test/_api/packages/get?id=dnd5e": { status: "success", package: { id: "dnd5e", title: "D&D 5e", url: "https://site.test/packages/dnd5e", versions: [{ version: "5.0.0", compatibility: { verified: "13" } }, { version: "5.1.0", compatibility: { minimum: "14", verified: "14" } }] } },
  "https://site.test/_api/packages/get?id=lib-wrapper": { status: "success", package: { id: "lib-wrapper", title: "libWrapper", versions: [{ version: "1.13.2", compatibility: { minimum: "11", verified: "13" } }, { version: "2.0.0", compatibility: { minimum: "14", verified: "14" } }] } },
  "https://site.test/_api/packages/get?id=old-module": { status: "success", package: { id: "old-module", versions: [{ version: "0.1.0", compatibility: { verified: "12", maximum: "13" } }] } },
  "https://x/never/module.json": { id: "never-enabled", version: "1.2.0", compatibility: { minimum: "13", verified: "14" } },
};

function ctx({ routes = ROUTES, foundryVersion = "13.346", dataPath = dataFolder() } = {}) {
  const state = tmpState();
  state.update((d) => {
    d.foundry.version = foundryVersion;
  });
  return {
    state,
    config: { timezone: "UTC", foundry: { url: "http://localhost:30000" } },
    scanPackages: () => scanPackages(dataPath),
    worldsWithModules: () => scanWorldsWithModules(dataPath, { log: quietLog }),
    readFoundryVersion: () => null,
    website: new FoundryWebsite({ baseUrl: "https://site.test", fetch: fakeFetch(routes), log: quietLog }),
    now: () => new Date("2026-03-01T12:00:00Z"),
    monitor: { tick: async () => {}, maybeScanPackages: async () => {} },
    log: quietLog,
  };
}

test("/modules unused lists modules no world has enabled", async () => {
  const c = ctx();
  const i = fakeInteraction({ command: "modules", subcommand: "unused" });
  await handleInteraction(i, c, { log: quietLog });
  const text = i.replies[0].content;
  assert.match(text, /2 of 3 installed \(2 of 2 worlds checked\)/);
  assert.match(text, /\*\*Never Enabled\*\* `never-enabled` – 1\.0\.0/);
  assert.match(text, /\*\*Old Module\*\* `old-module`/, "disabled in the world's settings counts as unused");
  assert.doesNotMatch(text, /lib-wrapper/);
  assert.equal(i.replies[0].flags !== undefined, true, "ephemeral");
});

test("/modules usage: per world, and for one module", async () => {
  const c = ctx();
  const all = fakeInteraction({ command: "modules", subcommand: "usage" });
  await handleInteraction(all, c, { log: quietLog });
  assert.match(all.replies[0].content, /\*\*The Campaign\*\* `campaign` – dnd5e: 3 active modules/);
  assert.match(all.replies[0].content, /\*\*One Shot\*\* `oneshot` – dnd5e: 3 active modules/);
  assert.match(all.replies[0].content, /Unused modules: 2/);

  const one = fakeInteraction({ command: "modules", subcommand: "usage", options: { module: "lib-wrapper" } });
  await handleInteraction(one, c, { log: quietLog });
  assert.match(one.replies[0].content, /Active in 2 worlds: The Campaign \(`campaign`\), One Shot \(`oneshot`\)/);

  const none = fakeInteraction({ command: "modules", subcommand: "usage", options: { module: "never-enabled" } });
  await handleInteraction(none, c, { log: quietLog });
  assert.match(none.replies[0].content, /Not active in any world/);

  const unknown = fakeInteraction({ command: "modules", subcommand: "usage", options: { module: "nope" } });
  await handleInteraction(unknown, c, { log: quietLog });
  assert.match(unknown.replies[0].content, /No installed module with the id/);
});

test("/modules without a data folder explains itself", async () => {
  const c = ctx({ dataPath: null });
  const i = fakeInteraction({ command: "modules", subcommand: "unused" });
  await handleInteraction(i, c, { log: quietLog });
  assert.match(i.replies[0].content, /FOUNDRY_DATA_PATH/);
});

test("/updates available: newer build and newer major for Foundry, only compatible package updates", async () => {
  const c = ctx();
  const i = fakeInteraction({ command: "updates", subcommand: "available" });
  await handleInteraction(i, c, { log: quietLog });
  assert.ok(i.replies[0].deferred);
  const embed = i.replies[1].embeds[0];
  assert.equal(embed.title, "🔎 3 updates available", "Foundry build + two modules");
  const d = embed.description;
  assert.match(d, /\*\*Foundry VTT\*\* v13\.346 → \*\*v13\.351\*\* is the latest v13 build \(\[release notes\]\(https:\/\/site\.test\/releases\/13\.351\)\)/);
  assert.match(d, /New major version:\*\* Foundry \*\*v14\*\* is out, latest build v14\.368/);
  assert.match(d, /\*\*Systems\*\* – all 1 are up to date for v13/, "dnd5e 5.1.0 needs v14 and is not offered");
  assert.match(d, /\*\*Modules – 2 updates for v13\*\*\n• 🧩 \*\*libWrapper\*\* `lib-wrapper` 1\.13\.1 → \*\*1\.13\.2\*\* · \[page\]\(https:\/\/site\.test\/packages\/lib-wrapper\)\n/);
  assert.match(d, /• 🧩 \*\*Never Enabled\*\* `never-enabled` 1\.0\.0 → \*\*1\.2\.0\*\*\n/, "found through the manifest URL; minimum 13 and verified 14 cover v13");
  assert.doesNotMatch(d, /Old Module/, "nothing newer: not listed");
  assert.match(d, /1 with newer releases that need a different Foundry version: `dnd5e`/);
  assert.doesNotMatch(d, /not found on foundryvtt\.com/);

  const foundryOnly = fakeInteraction({ command: "updates", subcommand: "available", options: { type: "foundry" } });
  await handleInteraction(foundryOnly, c, { log: quietLog });
  assert.doesNotMatch(foundryOnly.replies[1].embeds[0].description, /Modules/);

  const systemsOnly = fakeInteraction({ command: "updates", subcommand: "available", options: { type: "system" } });
  await handleInteraction(systemsOnly, c, { log: quietLog });
  assert.equal(systemsOnly.replies[1].embeds[0].title, "🔎 Everything is up to date");
  assert.doesNotMatch(systemsOnly.replies[1].embeds[0].description, /Foundry VTT\*\* v13/);
});

test("/updates available when Foundry is current and the website is unreachable", async () => {
  const current = ctx({ foundryVersion: "14.368" });
  const i = fakeInteraction({ command: "updates", subcommand: "available", options: { type: "foundry" } });
  await handleInteraction(i, current, { log: quietLog });
  assert.match(i.replies[1].embeds[0].description, /v14\.368 is the latest v14 build\./);
  assert.doesNotMatch(i.replies[1].embeds[0].description, /New major version/);

  const offline = ctx({ routes: {} });
  const j = fakeInteraction({ command: "updates", subcommand: "available" });
  await handleInteraction(j, offline, { log: quietLog });
  const d = j.replies[1].embeds[0].description;
  assert.match(d, /could not check https:\/\/site\.test\/releases\/ \(HTTP 404\)/);
  assert.match(d, /4 not found on foundryvtt\.com/);

  const unknownVersion = ctx({ foundryVersion: null });
  const k = fakeInteraction({ command: "updates", subcommand: "available", options: { type: "module" } });
  await handleInteraction(k, unknownVersion, { log: quietLog });
  assert.match(k.replies[1].embeds[0].description, /installed Foundry version is not known/);
});

test("/updates compatibility reports readiness for the next major version", async () => {
  const c = ctx();
  const i = fakeInteraction({ command: "updates", subcommand: "compatibility" });
  await handleInteraction(i, c, { log: quietLog });
  const embed = i.replies[1].embeds[0];
  assert.equal(embed.title, "🧭 Foundry v14: 4 packages need attention before upgrading");
  const d = embed.description;
  assert.match(d, /Newest release of v14: 14\.368/);
  assert.match(d, /✅ ready 0 · 🔼 update first 3 · ⚠️ untested 0 · ❌ not ready 1 · ❔ unknown 0/);
  assert.match(d, /❌ Not ready[^\n]*\n• 🧩 \*\*Old Module\*\* `old-module` 0\.1\.0 ❌ incompatible with v14/);
  assert.match(d, /• 🎲 \*\*D&D 5e\*\* `dnd5e` 5\.0\.0 → \*\*5\.1\.0\*\* ✅ verified for v14/);
  assert.match(d, /• 🧩 \*\*libWrapper\*\* `lib-wrapper` 1\.13\.1 → \*\*2\.0\.0\*\* ✅ verified for v14/);
  assert.match(d, /• 🧩 \*\*Never Enabled\*\* `never-enabled` 1\.0\.0 → \*\*1\.2\.0\*\* ✅ verified for v14/);

  const explicit = fakeInteraction({ command: "updates", subcommand: "compatibility", options: { generation: 13 } });
  await handleInteraction(explicit, c, { log: quietLog });
  const e = explicit.replies[1].embeds[0];
  assert.match(e.title, /Foundry v13: 1 package needs attention/);
  assert.match(e.description, /✅ ready 2 · 🔼 update first 1 · ⚠️ untested 1/);
  assert.match(e.description, /Ready[^\n]*\n`lib-wrapper`, `dnd5e`/);
  assert.match(e.description, /Untested[^\n]*\n• 🧩 \*\*Old Module\*\* `old-module` 0\.1\.0 ⚠️ not verified for v13/);

  const unknownVersion = ctx({ foundryVersion: null, routes: {} });
  const k = fakeInteraction({ command: "updates", subcommand: "compatibility" });
  await handleInteraction(k, unknownVersion, { log: quietLog });
  assert.match(k.replies[1].embeds[0].description, /not known yet/);
});
