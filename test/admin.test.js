import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createAdmin } from "../src/admin/page.js";
import { adminTls, createAdminServer, startAdmin } from "../src/admin/server.js";
import { adminFile, hashPassword, loadAdminSettings, passwordProblem, saveAdminSettings, verifyPassword } from "../src/admin/settings.js";
import { createCampaign } from "../src/campaigns.js";
import { buildConfig } from "../src/config.js";
import { quietLog, tmpDir, tmpState } from "./helpers.js";

const PASSWORD = "correct horse battery";
const TOKEN = "discord-token-that-must-never-leak";

// A channel the bot can use fully, or (deny) one where it lacks those permissions.
const fakeChannel = (id, name, type, { deny = [], position = 0 } = {}) => ({
  id, name, type, rawPosition: position,
  isThread: () => false,
  permissionsFor: () => ({ has: (flag) => !deny.includes(flag) }),
});

function fakeClient() {
  const sent = [];
  const guild = {
    id: "g1",
    name: "Table Top",
    members: { me: { permissions: { has: () => true }, roles: { botRole: { name: "Foundry Bot" } } } },
    channels: { cache: new Map([
      ["c1", fakeChannel("c1", "crypt-crawl", ChannelType.GuildText, { position: 1 })],
      ["c2", fakeChannel("c2", "muted", ChannelType.GuildText, { position: 2, deny: [PermissionFlagsBits.SendMessages] })],
      ["v1", fakeChannel("v1", "Tavern", ChannelType.GuildVoice, { position: 3 })],
      ["v2", fakeChannel("v2", "Locked", ChannelType.GuildVoice, { position: 4, deny: [PermissionFlagsBits.Connect] })],
    ]) },
    roles: { cache: new Map([["g1", { id: "g1", name: "@everyone", position: 0 }], ["r1", { id: "r1", name: "Players", position: 2 }], ["r2", { id: "r2", name: "GMs", position: 3 }]]) },
  };
  return {
    sent,
    user: { tag: "bot#0001" },
    guilds: { cache: new Map([["g1", guild]]) },
    channels: { fetch: async (id) => ({ id, send: async (p) => (sent.push({ id, p }), {}) }) },
  };
}

/** A running admin page on 127.0.0.1 (plain HTTP) with a fake bot behind it. */
async function startPage({ summaries = null, trustProxy = [] } = {}) {
  const dir = tmpDir("fvtt-admin-");
  const file = adminFile(dir);
  saveAdminSettings(file, { passwordHash: await hashPassword(PASSWORD) });
  const state = tmpState();
  state.setChannel("g1", "default", "c1");
  state.setMentionRole("g1", "r1");
  state.saveCampaign("g1", createCampaign({ name: "Crypt Crawl", world: "my-world", dm: "dm1", channel: "c1" }));
  const config = buildConfig({ DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: "1", BOT_DATA_DIR: dir, FOUNDRY_DATA_PATH: summaries ?? dir });
  const client = fakeClient();
  const ctx = { state, config, client, log: quietLog, now: () => new Date("2026-10-19T23:00:00Z"), worldTitle: (id) => (id === "my-world" ? "My World" : null) };
  const page = createAdmin({ file, settings: loadAdminSettings(file), ctx, version: "1.5.0", trustProxy });
  const server = createAdminServer(page, null, { log: quietLog });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  let csrf = "";
  async function call(method, route, body, { headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (method !== "GET") {
      h["Content-Type"] ??= "application/json";
      h["X-CSRF-Token"] ??= csrf;
    }
    const res = await fetch(`${base}/_admin/api/${route}`, { method, headers: h, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (data?.csrf) csrf = data.csrf;
    return raw ? { res, data, text } : { status: res.status, data, text, headers: res.headers };
  }
  const login = () => call("POST", "login", { password: PASSWORD });
  return { server, base, call, login, state, ctx, file, client, close: () => new Promise((r) => server.close(r)) };
}

test("settings: password rules, hashing, and admin.json", async () => {
  assert.match(passwordProblem("short"), /at least 8/);
  assert.equal(passwordProblem("long enough"), "");
  const hash = await hashPassword("long enough");
  assert.ok(await verifyPassword("long enough", hash));
  assert.equal(await verifyPassword("wrong one!", hash), false);
  assert.equal(await verifyPassword("x", "scrypt$1$1$1$a$b"), false, "a broken hash never matches");
  const dir = tmpDir();
  assert.deepEqual(loadAdminSettings(adminFile(dir)), { passwordHash: "" });
  fs.writeFileSync(adminFile(dir), "{ nope");
  assert.throws(() => loadAdminSettings(adminFile(dir)), /not valid JSON/);
  saveAdminSettings(adminFile(dir), { passwordHash: hash });
  assert.equal(loadAdminSettings(adminFile(dir)).passwordHash, hash);
  if (process.platform !== "win32") assert.equal(fs.statSync(adminFile(dir)).mode & 0o777, 0o600);
});

test("config: ADMIN_* variables, off by default", () => {
  const base = { DISCORD_TOKEN: "t", DISCORD_CLIENT_ID: "1" };
  assert.equal(buildConfig(base).admin, null);
  assert.equal(buildConfig({ ...base, ADMIN_PORT: "off" }).admin, null);
  const c = buildConfig({ ...base, ADMIN_PORT: "8486", ADMIN_HOSTS: "Bot.example.com, pi.lan", ADMIN_TLS: "off", ADMIN_TRUST_PROXY: "1" }).admin;
  assert.deepEqual([c.port, c.host, c.hosts, c.tls, c.trustProxy], [8486, "0.0.0.0", ["bot.example.com", "pi.lan"], false, ["loopback"]]);
  assert.deepEqual(buildConfig({ ...base, ADMIN_PORT: "1", ADMIN_TRUST_PROXY: "10.0.0.2,::1" }).admin.trustProxy, ["10.0.0.2", "::1"]);
  assert.throws(() => buildConfig({ ...base, ADMIN_PORT: "99999" }), /ADMIN_PORT/);
  assert.throws(() => buildConfig({ ...base, ADMIN_PORT: "1", ADMIN_TRUST_PROXY: "proxy.lan" }), /ADMIN_TRUST_PROXY/);
  assert.equal(buildConfig({ ...base, SESSION_SUMMARY_DIR: "exports" }).sessionSummaryDir, "exports");
  assert.equal(buildConfig(base).sessionSummaryDir, undefined);
});

test("login, state, logout; the Discord token never appears", async () => {
  const t = await startPage();
  try {
    assert.equal((await t.call("GET", "state")).status, 401);
    assert.equal((await t.call("POST", "login", { password: "wrong password" })).status, 401);
    const ok = await t.login();
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.match(ok.headers.get("content-security-policy"), /default-src 'none'/);
    const s = (await t.call("GET", "state")).data;
    assert.equal(s.version, "1.5.0");
    assert.equal(s.discord.user, "bot#0001");
    assert.equal(s.guilds[0].name, "Table Top");
    assert.deepEqual(s.guilds[0].channels.default, { id: "c1", name: "crypt-crawl" });
    assert.deepEqual(s.guilds[0].mentionRole, { id: "r1", name: "Players" });
    assert.equal(s.guilds[0].campaigns[0].worldTitle, "My World");
    assert.deepEqual(s.sessionSummaries.worlds, [{ id: "my-world", title: "My World" }]);
    assert.deepEqual([s.sessionSummaries.enabled, s.sessionSummaries.maxAgeHours], [true, 24]);
    for (const r of [ok, await t.call("GET", "state")]) assert.equal(r.text.includes(TOKEN), false);
    assert.equal((await t.call("POST", "logout", {})).status, 200);
    assert.equal((await t.call("GET", "state")).status, 401);
  } finally {
    await t.close();
  }
});

test("changes need the CSRF token, JSON and a known host and origin", async () => {
  const t = await startPage();
  try {
    await t.login();
    assert.equal((await t.call("PUT", "monitor", { enabled: { world: false } }, { headers: { "X-CSRF-Token": "nope" } })).status, 403);
    assert.equal((await t.call("PUT", "monitor", "enabled=1", { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await t.call("PUT", "monitor", { enabled: { world: false } }, { headers: { Origin: "https://evil.example" } })).status, 403);
    // DNS rebinding: a request for another host name (fetch cannot set Host, so http.request)
    const port = t.server.address().port;
    const status = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/_admin/", headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
    assert.equal(status, 403);
    assert.equal(t.state.data.monitor.enabled.world, true, "nothing changed");
  } finally {
    await t.close();
  }
});

test("five failed logins lock the address out", async () => {
  const t = await startPage();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await t.call("POST", "login", { password: "wrong password" })).status, 401);
    assert.equal((await t.login()).status, 429);
  } finally {
    await t.close();
  }
});

test("parallel wrong logins cannot get past the lockout", async () => {
  const t = await startPage();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => t.call("POST", "login", { password: "wrong password" })));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 401).length, 5);
    assert.equal(statuses.filter((s) => s === 429).length, 7);
    assert.equal((await t.login()).status, 429, "still locked");
  } finally {
    await t.close();
  }
});

test("a flood of failed logins from many addresses pauses wrong passwords, never the right one", async () => {
  const t = await startPage({ trustProxy: ["loopback"] });
  const from = (ip) => ({ headers: { "X-Forwarded-For": ip } });
  try {
    for (let i = 0; i < 50; i++) await t.call("POST", "login", { password: "wrong password" }, from(`203.0.113.${i}`));
    assert.equal((await t.call("POST", "login", { password: "wrong password" }, from("198.51.100.1"))).status, 429);
    assert.equal((await t.call("POST", "login", { password: PASSWORD }, from("198.51.100.2"))).status, 200, "the administrator is not locked out");
  } finally {
    await t.close();
  }
});

test("a correct login clears the address's earlier failures", async () => {
  const t = await startPage();
  try {
    for (let i = 0; i < 4; i++) await t.call("POST", "login", { password: "wrong password" });
    assert.equal((await t.login()).status, 200);
    for (let i = 0; i < 4; i++) assert.equal((await t.call("POST", "login", { password: "wrong password" })).status, 401);
  } finally {
    await t.close();
  }
});

test("monitoring switches are validated and saved to the state", async () => {
  const t = await startPage();
  try {
    await t.login();
    assert.equal((await t.call("PUT", "monitor", { enabled: { world: "no" } })).status, 400);
    assert.equal((await t.call("PUT", "monitor", { enabled: { nope: true } })).status, 400);
    assert.equal((await t.call("PUT", "monitor", { updates: { __proto__: true } })).status, 200, "an empty change is fine");
    const r = await t.call("PUT", "monitor", { enabled: { world: false }, updates: { trackModules: false } });
    assert.equal(r.status, 200);
    assert.equal(t.state.data.monitor.enabled.world, false);
    assert.equal(t.state.data.monitor.enabled.status, true);
    assert.equal(t.state.data.monitor.updates.trackModules, false);
    assert.equal(r.data.monitor.enabled.world, false);
  } finally {
    await t.close();
  }
});

test("server channels and roles: choices offered, validated and saved", async () => {
  const t = await startPage();
  try {
    await t.login();
    const g = (await t.call("GET", "state")).data.guilds[0];
    assert.deepEqual(g.options.textChannels.map((c) => c.id), ["c1", "c2"]);
    assert.deepEqual(g.options.voiceChannels.map((c) => c.id), ["v1", "v2"]);
    assert.deepEqual(g.options.roles.map((r) => r.id), ["r2", "r1"], "no @everyone, highest first");

    assert.equal((await t.call("PUT", "guilds/g1", { channels: { status: "v1" } })).status, 404, "not a snowflake-like id");
    const put = (body) => t.call("PUT", "guilds/123456", body);
    t.client.guilds.cache.set("123456", t.client.guilds.cache.get("g1"));
    t.client.guilds.cache.get("123456").id = "123456";
    assert.equal((await put({ channels: { status: "v1" } })).status, 400, "a voice channel cannot take messages");
    assert.equal((await put({ channels: { nope: "c1" } })).status, 400);
    assert.equal((await put({ channels: { status: "c9" } })).status, 400);
    assert.equal((await put({ mentionRole: "123456" })).status, 400, "@everyone is not offered");
    assert.equal((await put({ gmRole: "r9" })).status, 400);
    assert.equal((await t.call("PUT", "guilds/999999", {})).status, 404, "the bot is not in that server");

    const ok = await put({ channels: { default: "c1", status: "c2", world: null }, mentionRole: "r1", gmRole: "r2" });
    assert.equal(ok.status, 200);
    assert.deepEqual(t.state.guild("123456").channels, { default: "c1", status: "c2" });
    assert.equal(t.state.guild("123456").mentionRole, "r1");
    assert.equal(t.state.guild("123456").gmRole, "r2");
    assert.equal(ok.data.warnings.length, 1, "the bot cannot post in #muted");
    assert.match(ok.data.warnings[0], /cannot post in #muted yet: the bot lacks Send Messages in #muted/);
    assert.doesNotMatch(ok.data.warnings[0], /\*\*|<#/, "plain text, no Discord markdown");

    const cleared = await put({ channels: { status: null }, mentionRole: null, gmRole: "" });
    assert.deepEqual(t.state.guild("123456").channels, { default: "c1" });
    assert.equal(t.state.guild("123456").mentionRole, null);
    assert.equal(t.state.guild("123456").gmRole, null);
    assert.deepEqual(cleared.data.warnings, []);

    // A stored channel that was deleted in Discord can be kept (saving the rest of the form must not fail).
    t.state.setChannel("123456", "updates", "gone1");
    assert.equal((await put({ channels: { updates: "gone1", default: "c1" } })).status, 200);
    assert.equal(t.state.guild("123456").channels.updates, "gone1");
    assert.equal((await t.call("PUT", "guilds/123456", { channels: { default: "c2" } }, { headers: { "X-CSRF-Token": "nope" } })).status, 403);
  } finally {
    await t.close();
  }
});

test("campaign channel and voice channel are validated and saved", async () => {
  const t = await startPage();
  try {
    await t.login();
    const guild = t.client.guilds.cache.get("g1");
    t.client.guilds.cache.delete("g1");
    guild.id = "555555";
    t.client.guilds.cache.set("555555", guild);
    const campaign = t.state.saveCampaign("555555", createCampaign({ name: "Lost Mines", world: "lost-mines", dm: "dm1", channel: "c1" }));
    const put = (body) => t.call("PUT", `guilds/555555/campaigns/${campaign.id}`, body);
    assert.equal((await t.call("PUT", "guilds/555555/campaigns/nope", {})).status, 404);
    assert.equal((await put({ voiceChannel: "c1" })).status, 400, "a text channel is not a voice channel");
    assert.equal((await put({ channel: "v1" })).status, 400);

    const ok = await put({ channel: "c2", voiceChannel: "v2" });
    assert.equal(ok.status, 200);
    assert.deepEqual([t.state.campaign("555555", campaign.id).channel, t.state.campaign("555555", campaign.id).voiceChannel], ["c2", "v2"]);
    assert.equal(ok.data.warnings.length, 2);
    assert.match(ok.data.warnings[1], /Session events cannot be held in #Locked yet: the bot lacks Connect/);

    await put({ channel: null, voiceChannel: null });
    assert.deepEqual([t.state.campaign("555555", campaign.id).channel, t.state.campaign("555555", campaign.id).voiceChannel], [null, null]);
    const shown = (await t.call("GET", "state")).data.guilds.find((g) => g.id === "555555");
    assert.equal(shown.campaigns[0].channel, null);
  } finally {
    await t.close();
  }
});

test("session summary settings and Post now", async () => {
  const root = tmpDir("fvtt-data-");
  const dir = path.join(root, "Data", "session-summaries");
  fs.mkdirSync(dir, { recursive: true });
  const summary = { schema: 1, session: { id: "s1", number: 1, endedAt: "2026-10-19T22:00:00Z", world: { id: "my-world" } }, markdown: "## Session 1" };
  fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(summary));
  const t = await startPage({ summaries: root });
  try {
    await t.login();
    let s = (await t.call("GET", "state")).data.sessionSummaries;
    assert.equal(s.exists, true);
    assert.equal(s.sessions[0].posted[0].at, null);
    assert.equal((await t.call("PUT", "session-summaries", { maxAgeHours: 0 })).status, 400);
    assert.equal((await t.call("PUT", "session-summaries", { maxAgeHours: 1.5 })).status, 400);
    assert.equal((await t.call("PUT", "session-summaries", { enabled: "yes" })).status, 400);
    assert.equal((await t.call("PUT", "session-summaries", { enabled: false, maxAgeHours: 48 })).status, 200);
    assert.deepEqual(t.state.data.sessionSummaries, { enabled: false, maxAgeHours: 48 });
    assert.equal((await t.call("POST", "session-summaries/post", { world: "my-world" })).status, 409, "off");
    await t.call("PUT", "session-summaries", { enabled: true });
    assert.equal((await t.call("POST", "session-summaries/post", { world: "unbound" })).status, 400);
    const posted = await t.call("POST", "session-summaries/post", { world: "my-world" });
    assert.equal(posted.status, 200);
    assert.equal(posted.data.sent, 1);
    assert.deepEqual(t.client.sent.map((m) => m.p.content), ["## Session 1"]);
    s = posted.data.sessionSummaries;
    assert.ok(s.sessions[0].posted[0].at);
    assert.equal((await t.call("POST", "session-summaries/post", { world: "my-world" })).data.sent, 0, "posted once");
  } finally {
    await t.close();
  }
});

test("changing the password ends the other sessions", async () => {
  const t = await startPage();
  try {
    await t.login();
    assert.equal((await t.call("PUT", "password", { current: "wrong password", password: "new password!" })).status, 403);
    assert.equal((await t.call("PUT", "password", { current: PASSWORD, password: "short" })).status, 400);
    assert.equal((await t.call("PUT", "password", { current: PASSWORD, password: "new password!" })).status, 200);
    assert.ok(await verifyPassword("new password!", loadAdminSettings(t.file).passwordHash));
    assert.equal((await t.call("GET", "state")).status, 200, "this session goes on");
    assert.equal((await t.call("POST", "login", { password: PASSWORD })).status, 401);
  } finally {
    await t.close();
  }
});

test("the page files, the redirect from / and 404s", async () => {
  const t = await startPage();
  try {
    const html = await fetch(`${t.base}/_admin/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /FoundryVTT Discord Bot/);
    assert.equal((await fetch(`${t.base}/_admin/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    const root = await fetch(`${t.base}/`, { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/_admin/");
    assert.equal((await fetch(`${t.base}/other`)).status, 404);
    assert.equal((await fetch(`${t.base}/_admin/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${t.base}/_admin/certificate.crt`)).status, 404, "no certificate over plain HTTP");
  } finally {
    await t.close();
  }
});

test("HTTPS: a self-signed certificate is made once in the data folder, plain HTTP is redirected", async () => {
  const dir = tmpDir("fvtt-admin-tls-");
  const config = buildConfig({ DISCORD_TOKEN: "t", DISCORD_CLIENT_ID: "1", BOT_DATA_DIR: dir, ADMIN_PORT: "1" });
  const first = adminTls(config, { log: quietLog });
  const again = adminTls(config, { log: quietLog });
  assert.equal(String(first.cert), String(again.cert), "reused, not made on every start");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "admin-tls.key")).mode & 0o777, 0o600);

  const file = adminFile(dir);
  saveAdminSettings(file, { passwordHash: await hashPassword(PASSWORD) });
  const ctx = { state: tmpState(), config, log: quietLog };
  const page = createAdmin({ file, settings: loadAdminSettings(file), ctx });
  const server = createAdminServer(page, first, { log: quietLog });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const plain = await fetch(`http://127.0.0.1:${port}/x`, { redirect: "manual" });
    assert.equal(plain.status, 301);
    assert.equal(plain.headers.get("location"), `https://127.0.0.1:${port}/_admin/`);
    // An unknown Host header is not echoed into a redirect (open redirect).
    const foreign = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
      }).on("error", reject);
    });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.location, undefined);
    const cert = await new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, path: "/_admin/certificate.crt", ca: first.cert }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    assert.equal(cert.status, 200);
    assert.match(cert.body, /BEGIN CERTIFICATE/);
    assert.equal(cert.body.includes("PRIVATE KEY"), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("startAdmin: off without ADMIN_PORT or without a password; a busy port throws", async () => {
  const dir = tmpDir();
  const warnings = [];
  const log = { ...quietLog, warn: (m) => warnings.push(m) };
  const off = buildConfig({ DISCORD_TOKEN: "t", DISCORD_CLIENT_ID: "1", BOT_DATA_DIR: dir });
  assert.equal(await startAdmin({ config: off, state: tmpState(), log }), null);

  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = String(blocker.address().port);
  const on = buildConfig({ DISCORD_TOKEN: "t", DISCORD_CLIENT_ID: "1", BOT_DATA_DIR: dir, ADMIN_PORT: port, ADMIN_HOST: "127.0.0.1", ADMIN_TLS: "off" });
  try {
    assert.equal(await startAdmin({ config: on, state: tmpState(), log }), null);
    assert.match(warnings[0], /no password yet/);
    saveAdminSettings(adminFile(dir), { passwordHash: await hashPassword(PASSWORD) });
    await assert.rejects(() => startAdmin({ config: on, state: tmpState(), log }), /EADDRINUSE/);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
