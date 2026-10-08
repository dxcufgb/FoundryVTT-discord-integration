import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PermissionFlagsBits } from "discord.js";
import { announceUpdate, collectRecipients, extractChangelogSection, noticeContent, takeNoticeFile } from "../src/updateNotice.js";
import { buildUpdateNoticeMessage, EMBED_LIMITS, truncate } from "../src/messages.js";
import { DISALLOWED_INTENTS_MESSAGE, INTENTS, intentsFor, isDisallowedIntents } from "../src/discord/client.js";
import { GatewayIntentBits } from "discord.js";
import { quietLog, tmpDir, tmpState } from "./helpers.js";

const CHANGELOG = `# Changelog

## [Unreleased]

- next thing

## [1.3.0] - 2026-10-10

### Added

- Automatic updates.

[1.3.0]: https://github.com/o/r/releases/tag/v1.3.0

## [1.2.2] - 2026-10-06

- older
`;

test("extractChangelogSection returns one version's section without heading or link references", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "1.3.0"), "### Added\n\n- Automatic updates.");
  assert.equal(extractChangelogSection(CHANGELOG, "v1.2.2"), "- older");
  assert.equal(extractChangelogSection(CHANGELOG, "1.4.0"), null);
  assert.equal(extractChangelogSection(CHANGELOG, "nonsense"), null);
});

test("takeNoticeFile returns a matching notice, ignores others, and always deletes the file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "update-notice.json");
  fs.writeFileSync(file, JSON.stringify({ version: "1.3.0", body: "From GitHub", html_url: "https://github.com/o/r/releases/tag/v1.3.0" }));
  assert.equal(takeNoticeFile(file, "1.3.0", quietLog).body, "From GitHub");
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ version: "1.2.0", body: "stale" }));
  assert.equal(takeNoticeFile(file, "1.3.0", quietLog), null);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "{broken");
  assert.equal(takeNoticeFile(file, "1.3.0", quietLog), null);
  assert.equal(takeNoticeFile(file, "1.3.0", quietLog), null, "missing file");
});

test("noticeContent prefers the updater's notice, else CHANGELOG.md", () => {
  const dir = tmpDir();
  const changelogFile = path.join(dir, "CHANGELOG.md");
  fs.writeFileSync(changelogFile, CHANGELOG);
  const noticeFile = path.join(dir, "update-notice.json");
  fs.writeFileSync(noticeFile, JSON.stringify({ version: "1.3.0", body: "Release body", html_url: "https://x/rel" }));
  assert.deepEqual(noticeContent({ version: "1.3.0", noticeFile, changelogFile, log: quietLog }), { changelog: "Release body", url: "https://x/rel" });
  assert.deepEqual(noticeContent({ version: "1.3.0", noticeFile, changelogFile, log: quietLog }), { changelog: "### Added\n\n- Automatic updates.", url: null });
  assert.deepEqual(noticeContent({ version: "9.9.9", noticeFile, changelogFile: path.join(dir, "nope.md"), log: quietLog }), { changelog: null, url: null });
});

const admin = (id, { bot = false, isAdmin = true } = {}) => ({ id, user: { id, bot }, permissions: { has: (flag) => isAdmin && flag === PermissionFlagsBits.Administrator } });
function fakeGuild(id, name, ownerId, members, { failFetch = false } = {}) {
  return { id, name, ownerId, members: { fetch: async () => { if (failFetch) throw Object.assign(new Error("Missing Access"), { code: 50001 }); return new Map(members.map((m) => [m.id, m])); } } };
}

test("collectRecipients: owners plus administrators, bots skipped, one entry per person with all their servers", async () => {
  const guilds = [
    fakeGuild("g1", "Alpha", "u1", [admin("u1"), admin("u2"), admin("u3", { isAdmin: false }), admin("bot", { bot: true })]),
    fakeGuild("g2", "Beta", "u2", [admin("u2"), admin("u4")]),
  ];
  const r = await collectRecipients(guilds, { mode: "admins", log: quietLog });
  assert.deepEqual(Object.fromEntries(r), { u1: ["Alpha"], u2: ["Alpha", "Beta"], u4: ["Beta"] });
  assert.deepEqual(Object.fromEntries(await collectRecipients(guilds, { mode: "owner", log: quietLog })), { u1: ["Alpha"], u2: ["Beta"] });
});

test("collectRecipients falls back to the owner when the member list cannot be read", async () => {
  const warnings = [];
  const r = await collectRecipients([fakeGuild("g1", "Alpha", "u1", [], { failFetch: true })], { log: { ...quietLog, warn: (m) => warnings.push(m) } });
  assert.deepEqual(Object.fromEntries(r), { u1: ["Alpha"] });
  assert.match(warnings[0], /only its owner/);
});

test("buildUpdateNoticeMessage: title, link, servers, no mentions, and Discord's size limits", () => {
  const m = buildUpdateNoticeMessage({ version: "1.3.0", changelog: "- New", url: "https://x/rel", servers: ["Alpha", "Beta"] });
  const e = m.embeds[0];
  assert.equal(e.title, "FoundryVTT Discord integration updated to v1.3.0");
  assert.match(e.description, /^- New\n\n\[Release notes\]\(https:\/\/x\/rel\)$/);
  assert.deepEqual(e.fields, [{ name: "Servers", value: "Alpha\nBeta" }]);
  assert.deepEqual(m.allowedMentions, { parse: [] });

  const big = buildUpdateNoticeMessage({ version: "1.3.0", changelog: "x".repeat(10_000), url: "https://x/rel", servers: Array.from({ length: 300 }, (_, i) => `Server number ${i}`) });
  const be = big.embeds[0];
  assert.ok(be.description.length <= EMBED_LIMITS.description);
  assert.ok(be.description.includes("…\n\n[Release notes](https://x/rel)"));
  assert.ok(be.fields[0].value.length <= EMBED_LIMITS.fieldValue);
  assert.match(be.fields[0].value, /…and \d+ more$/);
  assert.ok(be.title.length + be.description.length + be.fields[0].name.length + be.fields[0].value.length <= EMBED_LIMITS.total);

  assert.match(buildUpdateNoticeMessage({ version: "1.3.0", servers: ["A"] }).embeds[0].description, /now running version 1\.3\.0/);
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

function fakeClient(guilds, { failFor = {} } = {}) {
  const sent = [];
  return {
    sent,
    guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
    users: {
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          if (failFor[id]) throw Object.assign(new Error(failFor[id].message), { code: failFor[id].code });
          sent.push({ id, payload });
        },
      }),
    },
  };
}

function setup({ recorded, running = "1.3.0", notice = null, failFor = {} } = {}) {
  const state = tmpState();
  if (recorded !== undefined) state.data.botVersion = recorded;
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), CHANGELOG);
  const dataDir = tmpDir();
  if (notice) fs.writeFileSync(path.join(dataDir, "update-notice.json"), JSON.stringify(notice));
  const client = fakeClient([fakeGuild("g1", "Alpha", "u1", [admin("u1"), admin("u2")]), fakeGuild("g2", "Beta", "u2", [admin("u2")])], { failFor });
  const logs = [];
  const log = { debug() {}, info: (...a) => logs.push(["info", a.join(" ")]), warn: (...a) => logs.push(["warn", a.join(" ")]), error: (...a) => logs.push(["error", a.join(" ")]) };
  const run = (mode = "admins") => announceUpdate({ client, state, version: running, mode, botDataDir: dataDir, projectRoot: root, repoUrl: "https://github.com/o/r", log, sleep: async () => {}, pauseMs: 0 });
  return { state, client, run, logs, dataDir };
}

test("announceUpdate: first run only records the version", async () => {
  const s = setup();
  assert.equal((await s.run()).status, "first-run");
  assert.equal(s.state.data.botVersion, "1.3.0");
  assert.equal(s.client.sent.length, 0);
});

test("announceUpdate: a newer version DMs each admin once, with the changelog; never twice", async () => {
  const s = setup({ recorded: "1.2.2" });
  const r = await s.run();
  assert.deepEqual(r, { status: "announced", sent: 2, failed: 0 });
  assert.deepEqual(s.client.sent.map((x) => x.id), ["u1", "u2"]);
  const e = s.client.sent[1].payload.embeds[0];
  assert.match(e.description, /Automatic updates\./);
  assert.match(e.description, /releases\/tag\/v1\.3\.0/);
  assert.equal(e.fields[0].value, "Alpha\nBeta");
  assert.equal(s.state.data.botVersion, "1.3.0");
  assert.equal((await s.run()).status, "same");
  assert.equal(s.client.sent.length, 2);
});

test("announceUpdate uses the updater's notice when it matches, and deletes it", async () => {
  const s = setup({ recorded: "1.2.2", notice: { version: "1.3.0", body: "Notes from the GitHub release", html_url: "https://github.com/o/r/releases/tag/v1.3.0" } });
  await s.run();
  assert.match(s.client.sent[0].payload.embeds[0].description, /^Notes from the GitHub release/);
  assert.equal(fs.existsSync(path.join(s.dataDir, "update-notice.json")), false);
});

test("announceUpdate: older or equal versions, mode off and owner mode", async () => {
  const older = setup({ recorded: "2.0.0" });
  assert.equal((await older.run()).status, "not-newer");
  assert.equal(older.state.data.botVersion, "1.3.0");
  const off = setup({ recorded: "1.2.2" });
  assert.equal((await off.run("off")).status, "off");
  assert.equal(off.client.sent.length, 0);
  assert.equal(off.state.data.botVersion, "1.3.0");
  const owner = setup({ recorded: "1.2.2" });
  await owner.run("owner");
  assert.deepEqual(owner.client.sent.map((x) => [x.id, x.payload.embeds[0].fields[0].value]), [["u1", "Alpha"], ["u2", "Beta"]]);
});

test("announceUpdate: closed DMs and other errors are logged per user and do not stop the loop", async () => {
  const s = setup({ recorded: "1.2.2", failFor: { u1: { code: 50007, message: "Cannot send messages to this user" } } });
  assert.deepEqual(await s.run(), { status: "announced", sent: 1, failed: 1 });
  assert.ok(s.logs.some(([lvl, m]) => lvl === "info" && /u1 does not accept direct messages/.test(m)));
  const t = setup({ recorded: "1.2.2", failFor: { u2: { code: 500, message: "boom" } } });
  assert.deepEqual(await t.run(), { status: "announced", sent: 1, failed: 1 });
  assert.ok(t.logs.some(([lvl, m]) => lvl === "warn" && /user u2: 500 boom/.test(m)));
  assert.ok(!t.logs.some(([, m]) => /Automatic updates/.test(m)), "message content is not logged");
});

test("announceUpdate never throws, even when Discord fails completely", async () => {
  const s = setup({ recorded: "1.2.2" });
  s.client.guilds = { get cache() { throw new Error("gateway gone"); } };
  assert.equal((await s.run()).status, "error");
  assert.equal(s.state.data.botVersion, "1.3.0", "recorded before announcing: at most once");
});

test("the client asks for the Server Members intent only for admins and recognises Discord refusing it", () => {
  assert.ok(INTENTS.includes(GatewayIntentBits.GuildMembers));
  assert.deepEqual(intentsFor("admins"), INTENTS);
  assert.deepEqual(intentsFor("owner"), [GatewayIntentBits.Guilds]);
  assert.deepEqual(intentsFor("off"), [GatewayIntentBits.Guilds]);
  assert.ok(isDisallowedIntents(4014));
  assert.ok(isDisallowedIntents({ code: 4014 }));
  assert.ok(isDisallowedIntents(new Error("Used disallowed intents")));
  assert.ok(isDisallowedIntents({ code: "DisallowedIntents" }));
  assert.ok(!isDisallowedIntents(4004));
  assert.ok(!isDisallowedIntents(new Error("An invalid token was provided.")));
  assert.match(DISALLOWED_INTENTS_MESSAGE, /Server Members Intent/);
});
