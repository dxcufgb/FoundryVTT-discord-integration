import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOf,
  compatibilityWith,
  findAvailableUpdates,
  FoundryWebsite,
  generationOf,
  latestCompatibleVersion,
  majorUpgradeReport,
  maxVersion,
  normaliseCompatibility,
  parseManifestAsPackage,
  parsePackageResponse,
  parseReleasesPage,
  summariseReleases,
} from "../src/foundry/releases.js";
import { fakeClock, quietLog } from "./helpers.js";

test("generationOf / buildOf / maxVersion", () => {
  assert.equal(generationOf("13.346"), 13);
  assert.equal(generationOf("13"), 13);
  assert.equal(generationOf("0.8.9"), 8);
  assert.equal(generationOf("14.368 "), 14);
  assert.equal(generationOf(null), null);
  assert.equal(generationOf("latest"), null);
  assert.equal(buildOf("13.346"), 346);
  assert.equal(buildOf("13"), null);
  assert.equal(maxVersion(["1.2.9", "1.2.10", null]), "1.2.10");
  assert.equal(maxVersion([]), null);
});

test("normaliseCompatibility accepts manifests, compatibility objects and legacy fields", () => {
  assert.deepEqual(normaliseCompatibility({ compatibility: { minimum: "11", verified: "13.346" } }), { minimum: "11", verified: "13.346", maximum: null });
  assert.deepEqual(normaliseCompatibility({ minimum: 12, verified: 12, maximum: 12 }), { minimum: "12", verified: "12", maximum: "12" });
  assert.deepEqual(normaliseCompatibility({ minimumCoreVersion: "0.8.6", compatibleCoreVersion: "9" }), { minimum: "0.8.6", verified: "9", maximum: null });
  assert.equal(normaliseCompatibility({}), null);
  assert.equal(normaliseCompatibility("13"), null);
});

test("compatibilityWith a generation", () => {
  assert.equal(compatibilityWith({ minimum: "11", verified: "13" }, 13), "verified");
  assert.equal(compatibilityWith({ minimum: "11", verified: "13.346" }, 12), "verified", "verified for a later generation covers earlier allowed ones");
  assert.equal(compatibilityWith({ minimum: "12", verified: "12" }, 13), "untested");
  assert.equal(compatibilityWith({ minimum: "12", verified: "12", maximum: "12" }, 13), "incompatible");
  assert.equal(compatibilityWith({ minimum: "14" }, 13), "incompatible");
  assert.equal(compatibilityWith({ minimum: "11", maximum: "14" }, 13), "untested");
  assert.equal(compatibilityWith(null, 13), "unknown");
  assert.equal(compatibilityWith({ verified: "13" }, null), "unknown");
});

const API = {
  status: "success",
  package: {
    id: "lib-wrapper",
    title: "libWrapper",
    url: "https://foundryvtt.com/packages/lib-wrapper",
    versions: [
      { version: "1.12.0", manifest: "https://x/1.12.0/module.json", compatibility: { minimum: "11", verified: "12", maximum: "12" } },
      { version: "1.13.2", manifest: "https://x/1.13.2/module.json", compatibility: { minimum: "11", verified: "13" } },
      { version: "2.0.0", manifest: "https://x/2.0.0/module.json", compatibility: { minimum: "14", verified: "14" } },
      { version: "1.13.1", manifest: "https://x/1.13.1/module.json", compatibility: { minimum: "11", verified: "13.341" } },
    ],
  },
};

test("parsePackageResponse and parseManifestAsPackage", () => {
  const info = parsePackageResponse(API);
  assert.equal(info.id, "lib-wrapper");
  assert.equal(info.source, "api");
  assert.deepEqual(info.versions.map((v) => v.version), ["2.0.0", "1.13.2", "1.13.1", "1.12.0"], "newest first");
  assert.deepEqual(info.versions[1].compatibility, { minimum: "11", verified: "13", maximum: null });
  assert.equal(parsePackageResponse({ status: "error", errors: ["no such package"] }), null);
  assert.equal(parsePackageResponse(null), null);
  // versions keyed by version string, no envelope
  const keyed = parsePackageResponse({ id: "x", versions: { "1.0.0": { compatibility: { verified: 13 } } } });
  assert.equal(keyed.versions[0].version, "1.0.0");
  assert.equal(keyed.url, "https://foundryvtt.com/packages/x");
  assert.equal(parsePackageResponse({ id: "x" }, null, "https://mirror.test/").url, "https://mirror.test/packages/x");

  const m = parseManifestAsPackage({ id: "dice-so-nice", title: "Dice So Nice", version: "5.1.3", manifest: "https://y/module.json", compatibility: { minimum: "12", verified: "13" }, url: "https://y" });
  assert.equal(m.source, "manifest");
  assert.deepEqual(m.versions.map((v) => [v.version, v.compatibility.verified]), [["5.1.3", "13"]]);
  assert.equal(parseManifestAsPackage({ title: "no id or version" }), null);
});

test("latestCompatibleVersion picks the newest version allowed on the generation", () => {
  const versions = parsePackageResponse(API).versions;
  assert.equal(latestCompatibleVersion(versions, 13).version, "1.13.2");
  assert.equal(latestCompatibleVersion(versions, 13).status, "verified");
  assert.equal(latestCompatibleVersion(versions, 14).version, "2.0.0");
  assert.equal(latestCompatibleVersion(versions, 12).version, "1.13.2", "verified for 13 and no maximum: fine on 12");
  assert.equal(latestCompatibleVersion(versions, 10), null, "every version needs at least v11");
  assert.equal(latestCompatibleVersion(undefined, 13), null);
});

test("findAvailableUpdates only reports updates that fit the running generation", () => {
  const installed = [
    { type: "module", id: "lib-wrapper", title: "libWrapper", version: "1.13.1" },
    { type: "module", id: "v14-only", title: "Future", version: "1.0.0" },
    { type: "module", id: "current", title: "Current", version: "3.0.0" },
    { type: "module", id: "offline", title: "Offline", version: "1.0.0" },
    { type: "system", id: "dnd5e", title: "D&D 5e", version: "5.0.0" },
  ];
  const info = new Map([
    ["module:lib-wrapper", parsePackageResponse(API)],
    ["module:v14-only", parsePackageResponse({ id: "v14-only", versions: [{ version: "1.0.0", compatibility: { verified: "13" } }, { version: "2.0.0", compatibility: { minimum: "14", verified: "14" } }] })],
    ["module:current", parsePackageResponse({ id: "current", versions: [{ version: "3.0.0", compatibility: { verified: "13" } }] })],
    ["module:offline", null],
    ["system:dnd5e", parsePackageResponse({ id: "dnd5e", versions: [{ version: "5.1.0", compatibility: { minimum: "13", verified: "13" } }, { version: "5.0.0", compatibility: { verified: "13" } }] })],
  ]);
  const r = findAvailableUpdates(installed, info, 13);
  assert.deepEqual(r.updates.map((u) => [u.pkg.id, u.installedVersion, u.latest.version, u.latest.status]), [["lib-wrapper", "1.13.1", "1.13.2", "verified"], ["dnd5e", "5.0.0", "5.1.0", "verified"]]);
  assert.deepEqual(r.heldBack.map((u) => [u.pkg.id, u.newest.version]), [["v14-only", "2.0.0"]]);
  assert.deepEqual(r.upToDate.map((u) => u.pkg.id), ["current"]);
  assert.deepEqual(r.unknown.map((u) => u.pkg.id), ["offline"]);
  assert.deepEqual(findAvailableUpdates(installed, info, 14).updates.map((u) => [u.pkg.id, u.latest.status]), [["v14-only", "verified"], ["lib-wrapper", "verified"], ["dnd5e", "untested"]], "on v14: sorted by type and title; no maximum means allowed but untested");
});

test("majorUpgradeReport sorts packages by readiness for the next generation", () => {
  const installed = [
    { type: "module", id: "lib-wrapper", title: "libWrapper", version: "1.13.2", compatibility: { minimum: "11", verified: "13" } },
    { type: "module", id: "ready", title: "Ready", version: "2.0.0", compatibility: { verified: "14" } },
    { type: "module", id: "stuck", title: "Stuck", version: "1.0.0", compatibility: { verified: "13", maximum: "13" } },
    { type: "module", id: "loose", title: "Loose", version: "1.0.0", compatibility: { verified: "12" } },
    { type: "module", id: "mystery", title: "Mystery", version: "1.0.0", compatibility: null },
    { type: "module", id: "vouched", title: "Vouched", version: "1.0.0", compatibility: { verified: "13" } },
  ];
  const info = new Map([
    ["module:lib-wrapper", parsePackageResponse(API)],
    ["module:stuck", parsePackageResponse({ id: "stuck", versions: [{ version: "1.0.0", compatibility: { verified: "13", maximum: "13" } }] })],
    ["module:vouched", parsePackageResponse({ id: "vouched", versions: [{ version: "1.0.0", compatibility: { verified: "14" } }] })],
  ]);
  const r = majorUpgradeReport(installed, info, 14);
  assert.deepEqual(r.ready.map((e) => e.pkg.id), ["ready", "vouched"]);
  assert.deepEqual(r.updateFirst.map((e) => [e.pkg.id, e.published.version]), [["lib-wrapper", "2.0.0"]]);
  assert.deepEqual(r.untested.map((e) => e.pkg.id), ["loose"]);
  assert.deepEqual(r.notReady.map((e) => e.pkg.id), ["stuck"]);
  assert.deepEqual(r.unknown.map((e) => e.pkg.id), ["mystery"]);
});

const RELEASES_HTML = `
<html><body>
<nav><a href="/releases/14.368">Latest</a></nav>
<ul>
<li><a href="https://foundryvtt.com/releases/14.368">Release 14.368</a> <span class="tag">Stable</span> April 2026</li>
<li><a href="/releases/14.370">Release 14.370</a> <span class="tag">Testing</span></li>
<li><a href="/releases/14.359">Release 14.359</a> <span class="tag">Stable</span></li>
<li><a href="/releases/13.351">Release 13.351</a> <span class="tag">Stable</span></li>
<li><a href="/releases/13.346">Release 13.346</a> <span class="tag">Stable</span></li>
<li><a href="/releases/13.339">Release 13.339</a> <span class="tag">Testing</span></li>
<li><a href="/releases/12.343">Release 12.343</a> <span class="tag">Stable</span></li>
</ul></body></html>`;

test("parseReleasesPage and summariseReleases", () => {
  const releases = parseReleasesPage(RELEASES_HTML);
  assert.deepEqual(releases.map((r) => `${r.version}:${r.channel}`), ["14.370:testing", "14.368:stable", "14.359:stable", "13.351:stable", "13.346:stable", "13.339:testing", "12.343:stable"]);

  const s = summariseReleases(releases, "13.346");
  assert.equal(s.generation, 13);
  assert.equal(s.channelKnown, true);
  assert.equal(s.latestInGeneration.version, "13.351");
  assert.equal(s.buildUpdate.version, "13.351");
  assert.deepEqual(s.newerGenerations.map((r) => r.version), ["14.368"], "testing builds are not offered");
  assert.equal(s.majorUpdate.version, "14.368");

  const current = summariseReleases(releases, "13.351");
  assert.equal(current.buildUpdate, null);
  assert.equal(current.majorUpdate.version, "14.368");

  const newest = summariseReleases(releases, "14.368");
  assert.equal(newest.buildUpdate, null);
  assert.deepEqual(newest.newerGenerations, []);

  const noChannels = summariseReleases(parseReleasesPage('<a href="/releases/13.351">x</a><a href="/releases/13.346">y</a>'), "13.346");
  assert.equal(noChannels.channelKnown, false);
  assert.equal(noChannels.buildUpdate.version, "13.351");
  assert.deepEqual(parseReleasesPage(""), []);
  assert.equal(summariseReleases([], null).generation, null);
});

function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    if (hit instanceof Error) throw hit;
    return { ok: true, status: 200, text: async () => (typeof hit === "string" ? hit : JSON.stringify(hit)) };
  };
  return { fetch, calls };
}

test("FoundryWebsite: API first, manifest fallback, caching, failures", async () => {
  const clock = fakeClock();
  const { fetch, calls } = fakeFetch({
    "https://example.test/_api/packages/get?id=lib-wrapper": API,
    "https://example.test/_api/packages/get?id=html": "<html>oops</html>",
    "https://example.test/_api/packages/get?id=unlisted": { status: "error", errors: ["Package not found"] },
    "https://x/unlisted/module.json": { id: "unlisted", version: "2.1.0", compatibility: { verified: "13" } },
    "https://example.test/releases/": RELEASES_HTML,
  });
  const site = new FoundryWebsite({ baseUrl: "https://example.test/", fetch, now: clock.now, log: quietLog, concurrency: 2 });

  const infos = await site.getPackageInfos([
    { type: "module", id: "lib-wrapper", manifest: "https://x/lw/module.json" },
    { type: "module", id: "unlisted", manifest: "https://x/unlisted/module.json" },
    { type: "module", id: "missing", manifest: "https://x/missing/module.json" },
    { type: "module", id: "html", manifest: null },
  ]);
  assert.equal(infos.get("module:lib-wrapper").source, "api");
  assert.equal(infos.get("module:lib-wrapper").versions.length, 4);
  assert.equal(infos.get("module:unlisted").source, "manifest", "falls back to the manifest URL");
  assert.equal(infos.get("module:unlisted").versions[0].version, "2.1.0");
  assert.equal(infos.get("module:missing"), null);
  assert.equal(infos.get("module:html"), null);
  assert.ok(!calls.includes("https://x/lw/module.json"), "no manifest fetch when the API answered");

  const before = calls.length;
  await site.getPackage("lib-wrapper");
  assert.equal(calls.length, before, "cached");
  clock.advance(31 * 60_000);
  await site.getPackage("lib-wrapper");
  assert.equal(calls.length, before + 1, "cache expired");

  const releases = await site.getReleases();
  assert.equal(releases.ok, true);
  assert.equal(releases.releases[0].version, "14.370");
  assert.equal(site.releaseNotesUrl("14.368"), "https://example.test/releases/14.368");

  const broken = new FoundryWebsite({ baseUrl: "https://down.test", fetch: async () => { throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" }); }, log: quietLog });
  const r = await broken.getReleases();
  assert.deepEqual(r, { ok: false, error: "ECONNREFUSED" });
  assert.deepEqual(await broken.getPackage("x"), { error: "ECONNREFUSED" });
  assert.equal(await broken.getPackageInfo({ id: "x", type: "module", manifest: "https://down.test/m.json" }), null);
});
