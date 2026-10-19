import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FoundryMonitor } from "../src/foundry/monitor.js";
import { createCampaign } from "../src/campaigns.js";
import { clip, describeSummary, postedKey, postSessionSummaries, summaryFolder, summaryOverview } from "../src/sessionSummaries.js";
import { fakeClock, quietLog, tmpDir, tmpState, upStatus } from "./helpers.js";

const NOW = "2026-10-19T23:00:00Z";

/** A Discord client whose channels collect what is sent; "missing", "error" and "fail" channels misbehave. */
function fakeClient(behaviour = {}) {
  const sent = [];
  return {
    sent,
    channels: {
      async fetch(id) {
        const b = behaviour[id];
        if (b === "missing") return null;
        if (b === "error") throw new Error("Unknown Channel");
        return {
          id,
          send: async (payload) => {
            if (behaviour[id] === "fail") throw new Error("Missing Permissions");
            sent.push({ id, payload });
            return { id: "msg" };
          },
        };
      },
    },
  };
}

/** A log that records warnings and debug lines. */
function recordingLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {};
  for (const level of Object.keys(lines)) log[level] = (...args) => lines[level].push(args.join(" "));
  return { log, lines };
}

function summary({ id = "s1", number = 1, title = "The Crypt", world = "my-world", endedAt = "2026-10-19T21:00:00Z", inProgress = false, markdown = `## Session ${number}`, schema = 1 } = {}) {
  const out = { schema, session: { id, number, title, startedAt: "2026-10-19T17:00:00Z", endedAt, inProgress, world: { id: world, title: "My World" } } };
  if (markdown !== null) out.markdown = markdown;
  return out;
}

const base = (s) => `session-${String(s.session.number).padStart(3, "0")}_2026-10-19`;

/** A Foundry user-data folder with Data/session-summaries holding the given summaries (newest first in index.json). */
function writeFolder(summaries, { index = true, latest = true, md = true } = {}) {
  const root = tmpDir("fvtt-summaries-");
  const dir = path.join(root, "Data", "session-summaries");
  fs.mkdirSync(dir, { recursive: true });
  for (const s of summaries) {
    fs.writeFileSync(path.join(dir, `${base(s)}.json`), JSON.stringify(s));
    if (md) fs.writeFileSync(path.join(dir, `${base(s)}.md`), `md file of ${s.session.id}`);
  }
  if (index) {
    const sessions = summaries.map((s) => ({ id: s.session.id, number: s.session.number, title: s.session.title, endedAt: s.session.endedAt, json: `${base(s)}.json`, md: `${base(s)}.md` }));
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ schema: 1, world: { id: "my-world" }, updatedAt: NOW, sessions }));
  }
  if (latest && summaries[0]) {
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(summaries[0]));
    if (md) fs.writeFileSync(path.join(dir, "latest.md"), `latest md of ${summaries[0].session.id}`);
  }
  return { root, dir };
}

/** State with a campaign bound to my-world (channel c1) in server g1, unless campaign is false. */
function setup({ root, campaign = true, channel = "c1", guild = "g1", world = "my-world", behaviour = {}, config = {} } = {}) {
  const state = tmpState();
  if (campaign) state.saveCampaign(guild, createCampaign({ name: "Crypt Crawl", world, dm: "dm1", channel }));
  const client = fakeClient(behaviour);
  const { log, lines } = recordingLog();
  const clock = fakeClock(NOW);
  const ctx = { state, client, log, now: clock.now, config: { foundry: { dataPath: root }, ...config } };
  return { ctx, state, client, lines, clock };
}

test("posts the stopped world's summary to the campaign channel, once, without mentions", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.deepEqual(t.client.sent, [{ id: "c1", payload: { content: "## Session 1", allowedMentions: { parse: [] } } }]);
  assert.ok(t.state.wasNotified(postedKey("s1", "c1")));

  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0, "already posted");
  assert.equal(t.client.sent.length, 1);
});

test("several summaries are posted oldest first; in-progress, other worlds and old ones are skipped", async () => {
  const { root } = writeFolder([
    summary({ id: "new", number: 4, endedAt: "2026-10-19T22:00:00Z" }),
    summary({ id: "live", number: 3, endedAt: "2026-10-19T21:30:00Z", inProgress: true }),
    summary({ id: "other", number: 2, endedAt: "2026-10-19T21:00:00Z", world: "other-world" }),
    summary({ id: "old", number: 1, endedAt: "2026-10-18T20:00:00Z" }),
    summary({ id: "mid", number: 0, endedAt: "2026-10-19T20:00:00Z" }),
  ]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 2);
  assert.deepEqual(t.client.sent.map((s) => s.payload.content), ["## Session 0", "## Session 4"]);
  assert.ok(t.lines.debug.some((l) => /in-progress/.test(l)));
  assert.ok(t.lines.debug.some((l) => /belongs to world other-world/.test(l)));
  assert.ok(t.lines.debug.some((l) => /more than 24 h/.test(l)));
});

test("the age limit comes from the settings, and the feature can be turned off", async () => {
  const { root } = writeFolder([summary({ endedAt: "2026-10-18T20:00:00Z" })]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0, "27 h old");
  t.state.update((d) => { d.sessionSummaries = { enabled: false, maxAgeHours: 48 }; });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0, "off");
  t.state.update((d) => { d.sessionSummaries.enabled = true; });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1, "within 48 h");
});

test("no campaign, or a campaign without a channel: nothing is posted, the reason is logged at debug level", async () => {
  const { root } = writeFolder([summary()]);
  const none = setup({ root, campaign: false });
  assert.equal(await postSessionSummaries(none.ctx, "my-world"), 0);
  assert.ok(none.lines.debug.some((l) => /no campaign is bound/.test(l)));

  const noChannel = setup({ root, channel: null });
  noChannel.state.setChannel("g1", "default", "default-channel");
  noChannel.state.setChannel("g1", "session", "session-channel");
  assert.equal(await postSessionSummaries(noChannel.ctx, "my-world"), 0);
  assert.equal(noChannel.client.sent.length, 0, "no fallback to the server's channels");
  assert.ok(noChannel.lines.debug.some((l) => /have no channel/.test(l)));
  assert.equal(noChannel.lines.warn.length, 0);
});

test("campaigns of the same world in two servers each get the summary in their own channel", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root });
  t.state.saveCampaign("g2", createCampaign({ name: "Other table", world: "my-world", dm: "dm2", channel: "c2" }));
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 2);
  assert.deepEqual(t.client.sent.map((s) => s.id).sort(), ["c1", "c2"]);
  assert.ok(t.state.wasNotified(postedKey("s1", "c1")) && t.state.wasNotified(postedKey("s1", "c2")));
});

test("a failed send is not marked as posted and is retried the next time the world stops", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root, behaviour: { c1: "fail" } });
  t.state.saveCampaign("g2", createCampaign({ name: "Other table", world: "my-world", dm: "dm2", channel: "c2" }));
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1, "c2 worked");
  assert.equal(t.state.wasNotified(postedKey("s1", "c1")), false);
  assert.ok(t.lines.warn.some((l) => /could not post session summary .* channel c1/.test(l) && /Missing Permissions/.test(l)));

  t.ctx.client = fakeClient();
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.deepEqual(t.ctx.client.sent.map((s) => s.id), ["c1"], "only the channel that failed");
});

test("a deleted channel or a missing client is a warning, not a crash", async () => {
  const { root } = writeFolder([summary()]);
  for (const behaviour of [{ c1: "missing" }, { c1: "error" }]) {
    const t = setup({ root, behaviour });
    assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0);
    assert.equal(t.lines.warn.length, 1);
    assert.equal(t.state.wasNotified(postedKey("s1", "c1")), false);
  }
  const t = setup({ root });
  t.ctx.client = undefined;
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0);
});

test("without index.json the newest export (latest.json) is used", async () => {
  const { root } = writeFolder([summary({ id: "latest-one" })], { index: false });
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.ok(t.state.wasNotified(postedKey("latest-one", "c1")));
});

test("a summary without markdown is posted from its .md file; latest.json from latest.md", async () => {
  const { root } = writeFolder([summary({ markdown: null })]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.equal(t.client.sent[0].payload.content, "md file of s1");

  const latest = writeFolder([summary({ id: "l", markdown: "" })], { index: false });
  const u = setup({ root: latest.root });
  assert.equal(await postSessionSummaries(u.ctx, "my-world"), 1);
  assert.equal(u.client.sent[0].payload.content, "latest md of l");

  const nothing = writeFolder([summary({ markdown: null })], { md: false });
  const v = setup({ root: nothing.root });
  assert.equal(await postSessionSummaries(v.ctx, "my-world"), 0);
  assert.ok(v.lines.warn.some((l) => /no text to post/.test(l)));
});

test("an unknown or newer schema is posted from its markdown field only", async () => {
  const { root } = writeFolder([summary({ id: "v2", schema: 2, markdown: "v2 text" }), summary({ id: "v2-no-text", number: 2, schema: 2, markdown: null })]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.equal(t.client.sent[0].payload.content, "v2 text");
  assert.ok(t.lines.warn.some((l) => /unknown schema 2/.test(l)), "no .md fallback for an unknown schema");
});

test("text over 2000 characters is cut at 2000, without splitting an emoji", async () => {
  const { root } = writeFolder([summary({ markdown: "x".repeat(2500) })]);
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.equal(t.client.sent[0].payload.content.length, 2000);
  const emoji = clip(`${"x".repeat(1999)}😀tail`);
  assert.equal(emoji.length, 1999);
  assert.equal(clip("short"), "short");
});

test("no data folder, no summary folder, an empty folder: nothing posted, nothing thrown", async () => {
  const noPath = setup({ root: undefined });
  assert.equal(await postSessionSummaries(noPath.ctx, "my-world"), 0);
  assert.ok(noPath.lines.debug.some((l) => /FOUNDRY_DATA_PATH/.test(l)));

  const bare = setup({ root: tmpDir("fvtt-bare-") });
  assert.equal(await postSessionSummaries(bare.ctx, "my-world"), 0);
  assert.equal(bare.lines.warn.length, 0, "a missing folder is not a problem");

  const empty = writeFolder([], { index: false, latest: false });
  const e = setup({ root: empty.root });
  assert.equal(await postSessionSummaries(e.ctx, "my-world"), 0);
  assert.equal(e.lines.warn.length, 0);
});

test("malformed, empty and partly written files are warnings; the rest is still posted", async () => {
  const { root, dir } = writeFolder([summary({ id: "good", number: 2, endedAt: "2026-10-19T22:00:00Z" }), summary({ id: "broken", number: 1 })]);
  fs.writeFileSync(path.join(dir, `${base(summary({ number: 1 }))}.json`), '{"schema":1,"sess');
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 1);
  assert.equal(t.client.sent[0].payload.content, "## Session 2");
  assert.ok(t.lines.warn.some((l) => /not valid JSON/.test(l)));

  for (const text of ["", "not json", "[]", "null", '{"sessions":"nope"}']) {
    fs.writeFileSync(path.join(dir, "index.json"), text);
    const u = setup({ root });
    // index.json unusable: latest.json (the "good" one) is used instead
    assert.equal(await postSessionSummaries(u.ctx, "my-world"), 1, `index.json = ${JSON.stringify(text)}`);
    assert.ok(u.lines.warn.length >= 1);
  }

  fs.writeFileSync(path.join(dir, "latest.json"), "");
  fs.writeFileSync(path.join(dir, "index.json"), "{");
  const v = setup({ root });
  assert.equal(await postSessionSummaries(v.ctx, "my-world"), 0);
});

test("summaries with missing fields are skipped; odd file names in index.json are ignored", async () => {
  const { root, dir } = writeFolder([]);
  const files = {
    "a.json": { schema: 1 },
    "b.json": { schema: 1, session: { id: "b", world: { id: "my-world" } }, markdown: "no end time" },
    "c.json": "a string",
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  fs.writeFileSync(path.join(root, "Data", "secret.json"), JSON.stringify(summary({ id: "outside" })));
  const sessions = [{ json: "a.json" }, { json: "b.json" }, { json: "c.json" }, { json: "../secret.json" }, { json: 5 }, { nothing: true }, "x", null];
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ schema: 1, sessions }));
  const t = setup({ root });
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0);
  assert.equal(t.client.sent.length, 0);
  assert.equal(describeSummary(null).skip, "not a JSON object");
});

test("a readFile that throws oddly is caught", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root });
  t.ctx.readFile = async () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0);
  assert.ok(t.lines.warn.some((l) => /cannot read .*index.json \(EACCES\)/.test(l)));
  t.ctx.state = null; // even a broken context does not throw
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0);
});

test("SESSION_SUMMARY_DIR: an absolute folder, or one inside the Data folder", () => {
  const { root } = writeFolder([]);
  assert.equal(summaryFolder({ foundry: { dataPath: root } }), path.join(root, "Data", "session-summaries"));
  assert.equal(summaryFolder({ foundry: { dataPath: root }, sessionSummaryDir: "exports/summaries" }), path.join(root, "Data", "exports/summaries"));
  assert.equal(summaryFolder({ foundry: {}, sessionSummaryDir: "/srv/summaries" }), "/srv/summaries");
  assert.equal(summaryFolder({ foundry: {}, sessionSummaryDir: "relative" }), null);
  assert.equal(summaryFolder({ foundry: {} }), null);
});

test("the overview lists the summaries with where they were posted", async () => {
  const { root } = writeFolder([summary({ id: "a", number: 2 }), summary({ id: "b", number: 1, inProgress: true })]);
  const t = setup({ root });
  await postSessionSummaries(t.ctx, "my-world");
  const o = await summaryOverview({ state: t.state, config: t.ctx.config, log: quietLog });
  assert.equal(o.exists, true);
  assert.deepEqual(o.sessions.map((s) => [s.id, s.inProgress, Boolean(s.posted[0].at)]), [["a", false, true], ["b", true, false]]);
  assert.deepEqual(await summaryOverview({ state: t.state, config: { foundry: {} } }), { folder: null, exists: false, sessions: [], problems: [] });
});

// --- the monitor: when the summaries are posted ----------------------------------------

function monitorSetup({ worldAnnouncements = true, hook } = {}) {
  const clock = fakeClock(NOW);
  const state = tmpState();
  state.update((d) => { d.monitor.enabled.world = worldAnnouncements; });
  const events = [];
  const stopped = [];
  const result = { value: { ok: true, status: upStatus({ world: "my-world" }) } };
  const monitor = new FoundryMonitor({
    fetchStatus: async () => result.value,
    scanPackages: () => [],
    state,
    emit: async (e) => events.push(e),
    onWorldStopped: hook ?? (async (id) => stopped.push(id)),
    options: { downAfterFailures: 1 },
    now: clock.now,
    log: quietLog,
  });
  const set = (status) => (result.value = status.ok === false ? status : { ok: true, status: upStatus(status) });
  return { monitor, state, events, stopped, set };
}

test("world stopped runs the summary step, also with world announcements off", async () => {
  for (const worldAnnouncements of [true, false]) {
    const t = monitorSetup({ worldAnnouncements });
    await t.monitor.tick(); // first check: my-world
    t.set({ active: false, world: null });
    await t.monitor.tick();
    assert.deepEqual(t.stopped, ["my-world"]);
    assert.deepEqual(t.events.map((e) => e.type), worldAnnouncements ? ["worldStopped"] : []);
    t.set({ world: "next" });
    await t.monitor.tick();
    assert.deepEqual(t.stopped, ["my-world"], "starting a world is not a stop");
    t.set({ world: "third" });
    await t.monitor.tick();
    assert.deepEqual(t.stopped, ["my-world", "next"], "a switch between two polls went through setup: next stopped");
  }
});

test("a world that stopped while Foundry restarted is handled when Foundry is back", async () => {
  const t = monitorSetup();
  await t.monitor.tick();
  t.set({ ok: false, error: "ECONNREFUSED" });
  await t.monitor.tick();
  assert.deepEqual(t.stopped, []);
  t.set({ active: false, world: null });
  await t.monitor.tick();
  assert.deepEqual(t.events.map((e) => e.type), ["down", "up", "worldStopped"]);
  assert.deepEqual(t.stopped, ["my-world"]);
});

test("a failing summary step does not stop the announcement or monitoring", async () => {
  const t = monitorSetup({ hook: async () => { throw new Error("boom"); } });
  await t.monitor.tick();
  t.set({ active: false, world: null });
  await t.monitor.tick();
  assert.deepEqual(t.events.map((e) => e.type), ["worldStopped"]);
  t.set({ world: "again" });
  await t.monitor.tick();
  assert.deepEqual(t.events.map((e) => e.type), ["worldStopped", "worldStarted"]);
});

test("the full path: Foundry back to setup posts the summary, world announcements off", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root });
  t.state.update((d) => { d.monitor.enabled.world = false; });
  const result = { value: { ok: true, status: upStatus({ world: "my-world" }) } };
  const monitor = new FoundryMonitor({
    fetchStatus: async () => result.value,
    scanPackages: () => [],
    state: t.state,
    emit: async () => {},
    onWorldStopped: (id) => postSessionSummaries(t.ctx, id),
    options: { downAfterFailures: 1 },
    now: t.clock.now,
    log: quietLog,
  });
  await monitor.tick();
  result.value = { ok: true, status: upStatus({ active: false, world: null }) };
  await monitor.tick();
  assert.deepEqual(t.client.sent.map((s) => s.id), ["c1"]);
});

test("a world stop and Post now at the same time post a summary once", async () => {
  const { root } = writeFolder([summary()]);
  const t = setup({ root });
  const [a, b] = await Promise.all([postSessionSummaries(t.ctx, "my-world"), postSessionSummaries(t.ctx, "my-world")]);
  assert.equal(a + b, 2, "the second call shares the first run");
  assert.equal(t.client.sent.length, 1);
  assert.equal(await postSessionSummaries(t.ctx, "my-world"), 0, "a later run starts fresh and finds it posted");
});
