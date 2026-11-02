// The password-protected administration page, served under /_admin on its own port
// (see src/admin/server.js). Modelled on the admin pages of the Foundry world backup and
// the release proxy: one HTML page (src/admin/ui/) whose views are picked by the URL
// fragment, and a small JSON API:
//
//   POST /api/login, POST /api/logout, GET /api/state, PUT /api/password
//   PUT  /api/monitor                   announcement and update-tracking switches (state.monitor)
//   PUT  /api/session-summaries         { enabled, maxAgeHours }
//   POST /api/session-summaries/post    { world }: post that world's summaries now
//   PUT  /api/guilds/<id>               { channels: { <type>: id|null }, mentionRole, gmRole } (as /channel, /gm-role)
//   PUT  /api/guilds/<id>/campaigns/<c> { channel, voiceChannel } (as /campaign edit)
//
// Every response is no-store with a strict CSP (the page puts server values in with
// textContent only). Every call but login needs the session cookie (HttpOnly,
// SameSite=Strict, Path=/_admin); every change also the X-CSRF-Token header and a JSON
// body; unknown Host / Origin headers get 403 (DNS rebinding). Five failed logins lock an
// address out for five minutes. The Discord token never appears in a response.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureGuild, MESSAGE_TYPES, MONITORS } from "../state.js";
import { describeWindow } from "../restartWindow.js";
import { isCurrentSession } from "../campaigns.js";
import { MAX_AGE_HOURS, postSessionSummaries, summaryOverview, summarySettings } from "../sessionSummaries.js";
import { hashPassword, passwordProblem, saveAdminSettings, verifyPassword } from "./settings.js";
import { findChannel, findRole, guildOptions, postingProblem, TEXT_CHANNEL_TYPES, VOICE_CHANNEL_TYPES, voiceProblem } from "./guilds.js";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
// Across all addresses: more failed logins than this within GLOBAL_WINDOW_MS pause every login.
const GLOBAL_FAILURES = 50;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const COOKIE = "fvtt_discord_admin";
export const PREFIX = "/_admin";
export const UPDATE_SWITCHES = Object.freeze(["trackFoundry", "trackSystems", "trackModules", "announceNewPackages", "announceRemovedPackages"]);
const UI_FILES = {
  "": { file: "index.html", type: "text/html; charset=utf-8" },
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/logo.png": { file: "logo.png", type: "image/png" },
  "/favicon.png": { file: "favicon.png", type: "image/png" },
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

/** A client error in an API call: answered with its status and message. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

let machineCache = { at: 0, names: new Set() };
/** This machine's host name (and name.local) and IP addresses: a browser on the LAN may use any of them. */
function machineHosts(now) {
  if (now - machineCache.at < 30000) return machineCache.names;
  const names = new Set();
  const host = os.hostname().toLowerCase();
  names.add(host);
  if (!host.includes(".")) names.add(`${host}.local`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const addr = a.address.replace(/%.*$/, "").toLowerCase();
      names.add(a.family === "IPv6" || a.family === 6 ? `[${addr}]` : addr);
    }
  }
  machineCache = { at: now, names };
  return names;
}

function hostOf(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const isBool = (v) => typeof v === "boolean";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The /_admin handler.
 * @param {object} deps
 * @param {string} deps.file        admin.json
 * @param {{passwordHash:string}} deps.settings
 * @param {object} deps.ctx         the bot's context (state, config, client, worldTitle, log, now)
 * @param {string|null} [deps.version]
 * @param {string[]} [deps.extraHosts]  more host names the page may be opened with (ADMIN_HOSTS)
 * @param {string[]} [deps.trustProxy]  reverse proxies whose X-Forwarded-* headers count ("loopback" or addresses)
 * @returns {{ handles(pathname:string): boolean, handle(req, res, pathname, opts?): Promise<void> }}
 */
export function createAdmin({ file, settings, ctx, version = null, extraHosts = [], trustProxy = [], now = Date.now }) {
  const log = ctx.log ?? console;
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", ...extraHosts.map((h) => String(h).toLowerCase())]);
  const sessions = new Map(); // id -> { csrf, expires }
  const failures = new Map(); // remote address -> { count, until }
  let globalFailures = [];
  const hostAllowed = (h) => hosts.has(h) || machineHosts(now()).has(h);
  const ui = Object.create(null);
  for (const [route, { file: name, type }] of Object.entries(UI_FILES)) ui[route] = { body: fs.readFileSync(path.join(UI_DIR, name)), type };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  // Always JSON: error messages in it are never read as HTML.
  function sendJson(res, status, obj, headers = {}) {
    res.writeHead(status, { "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  }

  function session(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const s = id ? sessions.get(id) : null;
    if (!s) return null;
    if (s.expires < now()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...s };
  }

  function newSession() {
    for (const [id, s] of sessions) if (s.expires < now()) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(32).toString("base64url");
    sessions.set(id, { csrf, expires: now() + SESSION_MS });
    return { id, csrf };
  }

  // Forwarded headers count only from a trusted reverse proxy (ADMIN_TRUST_PROXY).
  function fromProxy(req) {
    if (!trustProxy.length) return false;
    const peer = String(req.socket.remoteAddress || "").replace(/^::ffff:/i, "").toLowerCase();
    if (trustProxy.includes("loopback") && (/^127\./.test(peer) || peer === "::1")) return true;
    return trustProxy.includes(peer);
  }
  const isSecure = (req) => Boolean(req.socket.encrypted) || (fromProxy(req) && /^https$/i.test(String(req.headers["x-forwarded-proto"] || "")));
  function clientIp(req) {
    const fwd = fromProxy(req) ? String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean) : [];
    return fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress || "?";
  }
  const cookie = (req, id, maxAge) => `${COOKIE}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (isSecure(req) ? "; Secure" : "");

  // --- the page's data --------------------------------------------------------------

  const worldTitle = (id) => {
    try {
      return ctx.worldTitle?.(id) ?? null;
    } catch {
      return null;
    }
  };
  const guildOf = (id) => ctx.client?.guilds?.cache?.get?.(id) ?? null;
  const channelView = (guild, id) => (id ? { id, name: guild?.channels?.cache?.get?.(id)?.name ?? null } : null);
  const roleView = (guild, id) => (id ? { id, name: guild?.roles?.cache?.get?.(id)?.name ?? null } : null);

  function guildsView() {
    const { state } = ctx;
    const ids = new Set([...Object.keys(state.data.guilds), ...(ctx.client?.guilds?.cache?.keys?.() ?? [])]);
    const at = ctx.now ? ctx.now() : new Date();
    return [...ids].map((id) => {
      const guild = guildOf(id);
      const g = state.guild(id);
      const channels = {};
      for (const type of MESSAGE_TYPES) channels[type] = channelView(guild, g.channels[type]);
      return {
        id,
        name: guild?.name ?? null,
        joined: Boolean(guild),
        channels,
        mentionRole: roleView(guild, g.mentionRole),
        gmRole: roleView(guild, g.gmRole),
        healthIssue: g.healthIssue ?? null,
        // What the page can pick from; null when the bot is not in the server (nothing can be checked there).
        options: guild ? guildOptions(guild) : null,
        campaigns: state.campaigns(id).map((c) => ({
          id: c.id,
          name: c.name,
          world: c.world,
          worldTitle: worldTitle(c.world),
          dm: c.dm,
          players: c.players?.length ?? 0,
          channel: channelView(guild, c.channel),
          voiceChannel: channelView(guild, c.voiceChannel),
          nextSession: isCurrentSession(c.nextSession, at) ? c.nextSession.at : null,
        })),
      };
    }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  async function state(csrf) {
    const { state: store, config } = ctx;
    const f = store.data.foundry;
    const m = store.data.monitor;
    const overview = await summaryOverview({ state: store, config, log });
    const user = ctx.client?.user;
    return {
      csrf,
      version,
      discord: { connected: Boolean(user), user: user?.tag ?? null, servers: ctx.client?.guilds?.cache?.size ?? 0 },
      foundry: { status: f.status, since: f.since, world: f.world, worldTitle: f.world ? worldTitle(f.world) : null, worldSince: f.worldSince, version: f.version, lastSeenUpAt: f.lastSeenUpAt },
      config: {
        foundryUrl: config.foundry.url,
        dataPath: config.foundry.dataPath ?? null,
        appPath: config.foundry.appPath ?? null,
        websiteUrl: config.foundry.websiteUrl,
        botDataDir: config.botDataDir,
        pollIntervalSeconds: config.pollIntervalSeconds,
        downAfterFailures: config.downAfterFailures,
        timezone: config.timezone,
        logLevel: config.logLevel,
        updateNotify: config.updateNotify,
        commandsGuild: config.discord.guildId ?? null,
        sessionSummaryDir: config.sessionSummaryDir ?? null,
      },
      monitor: { enabled: { ...m.enabled }, updates: { ...m.updates }, restartWindow: m.restartWindow ? describeWindow(m.restartWindow) : null },
      guilds: guildsView(),
      sessionSummaries: {
        ...summarySettings(store),
        limits: MAX_AGE_HOURS,
        folder: overview.folder,
        exists: overview.exists,
        sessions: overview.sessions,
        problems: overview.problems,
        worlds: boundWorlds().map((id) => ({ id, title: worldTitle(id) })),
      },
    };
  }

  /** Every world a campaign is bound to, in any server. */
  function boundWorlds() {
    const out = new Set();
    for (const id of Object.keys(ctx.state.data.guilds)) for (const c of ctx.state.campaigns(id)) out.add(c.world);
    return [...out].sort();
  }

  // --- channels and roles ------------------------------------------------------------

  // A channel id from the page: null/"" clears it; the stored value may stay even if the channel is gone;
  // anything else must be a channel of that kind in the server.
  function pickChannel(guild, value, current, types, what) {
    if (value === null || value === "") return null;
    if (typeof value !== "string") throw new HttpError(400, `${what}: invalid channel`);
    if (value === current) return value;
    if (!findChannel(guild, value, types)) throw new HttpError(400, `${what}: that channel is not in this server or is the wrong kind`);
    return value;
  }

  function pickRole(guild, value, current, what) {
    if (value === null || value === "") return null;
    if (typeof value !== "string") throw new HttpError(400, `${what}: invalid role`);
    if (value === current) return value;
    if (!findRole(guild, value)) throw new HttpError(400, `${what}: that role is not in this server`);
    return value;
  }

  async function saveGuild(req, res, s, guild, body) {
    const current = ctx.state.guild(guild.id);
    const channels = body.channels ?? {};
    if (!isObject(channels)) throw new HttpError(400, '"channels" must be an object');
    const next = {};
    for (const [type, value] of Object.entries(channels)) {
      if (!MESSAGE_TYPES.includes(type)) throw new HttpError(400, `unknown message type "${type}"`);
      next[type] = pickChannel(guild, value, current.channels[type] ?? null, TEXT_CHANNEL_TYPES, `${type} channel`);
    }
    const mentionRole = body.mentionRole === undefined ? undefined : pickRole(guild, body.mentionRole, current.mentionRole ?? null, "mention role");
    const gmRole = body.gmRole === undefined ? undefined : pickRole(guild, body.gmRole, current.gmRole ?? null, "GM role");

    const warnings = [];
    for (const [type, id] of Object.entries(next)) {
      if (id && id !== current.channels[type]) {
        const problem = postingProblem(guild, findChannel(guild, id, TEXT_CHANNEL_TYPES));
        if (problem && !warnings.includes(problem)) warnings.push(problem);
      }
    }
    ctx.state.update((d) => {
      const g = ensureGuild(d, guild.id);
      for (const [type, id] of Object.entries(next)) {
        if (id) g.channels[type] = id;
        else delete g.channels[type];
      }
      if (mentionRole !== undefined) g.mentionRole = mentionRole;
      if (gmRole !== undefined) g.gmRole = gmRole;
    });
    log.info(`admin page: channels and roles of server ${guild.id} changed`);
    return sendJson(res, 200, { warnings, ...(await state(s.csrf)) });
  }

  async function saveCampaignChannels(req, res, s, guild, campaignId, body) {
    const campaign = ctx.state.campaign(guild.id, campaignId);
    if (!campaign) throw new HttpError(404, "no such campaign");
    const channel = body.channel === undefined ? undefined : pickChannel(guild, body.channel, campaign.channel ?? null, TEXT_CHANNEL_TYPES, "campaign channel");
    const voice = body.voiceChannel === undefined ? undefined : pickChannel(guild, body.voiceChannel, campaign.voiceChannel ?? null, VOICE_CHANNEL_TYPES, "voice channel");
    const warnings = [];
    if (channel && channel !== campaign.channel) warnings.push(postingProblem(guild, findChannel(guild, channel, TEXT_CHANNEL_TYPES)));
    if (voice && voice !== campaign.voiceChannel) warnings.push(voiceProblem(guild, findChannel(guild, voice, VOICE_CHANNEL_TYPES)));
    ctx.state.updateCampaign(guild.id, campaign.id, (c) => {
      if (channel !== undefined) c.channel = channel;
      if (voice !== undefined) c.voiceChannel = voice;
    });
    log.info(`admin page: channels of campaign "${campaign.name}" (server ${guild.id}) changed`);
    return sendJson(res, 200, { warnings: warnings.filter(Boolean), ...(await state(s.csrf)) });
  }

  // --- login ------------------------------------------------------------------------

  async function login(req, res, body) {
    const ip = clientIp(req);
    const f = failures.get(ip);
    globalFailures = globalFailures.filter((t) => t > now() - GLOBAL_WINDOW_MS);
    // A per-address lockout is a hard stop. The global flood pause never blocks a request that proves it knows
    // the password, so failed logins from other addresses cannot lock the real administrator out.
    if (f && f.until > now()) {
      return sendJson(res, 429, { error: "too many failed logins; try again in a few minutes" });
    }
    const flooded = globalFailures.length >= GLOBAL_FAILURES;
    // Count the attempt before the slow password check, so parallel requests cannot get past the limits.
    const count = (f && !f.until ? f.count : 0) + 1;
    failures.set(ip, { count, until: count >= LOGIN_FAILURES ? now() + LOCKOUT_MS : 0 });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
    const stamp = now();
    globalFailures.push(stamp);
    if (await verifyPassword(body.password, settings.passwordHash)) {
      failures.delete(ip);
      const i = globalFailures.indexOf(stamp);
      if (i >= 0) globalFailures.splice(i, 1);
      const s = newSession();
      log.info("admin page: login");
      return sendJson(res, 200, await state(s.csrf), { "Set-Cookie": cookie(req, s.id, SESSION_MS / 1000) });
    }
    log.warn(`admin page: failed login from ${ip}`);
    if (flooded) return sendJson(res, 429, { error: "too many failed logins; try again in a few minutes" });
    return sendJson(res, 401, { error: "wrong password" });
  }

  // --- the API ----------------------------------------------------------------------

  async function api(req, res, route, s) {
    const method = req.method;
    let body = {};
    if (method !== "GET" && method !== "HEAD") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "expected application/json");
      const origin = req.headers.origin;
      if (origin && origin !== "null" && !hostAllowed(hostOf(origin.replace(/^[a-z]+:\/\//i, "")))) throw new HttpError(403, "cross-origin request refused");
      const text = await readBody(req);
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, "invalid JSON");
      }
      if (!isObject(body)) throw new HttpError(400, "invalid JSON");
    }

    if (route === "/api/login" && method === "POST") return login(req, res, body);
    if (!s) throw new HttpError(401, "not logged in");
    if (route === "/api/state" && method === "GET") return sendJson(res, 200, await state(s.csrf));
    if (method !== "GET" && !sameSecret(req.headers["x-csrf-token"] || "", s.csrf)) throw new HttpError(403, "missing or wrong CSRF token; reload the page");

    if (route === "/api/logout" && method === "POST") {
      sessions.delete(s.id);
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0) });
    }

    if (route === "/api/monitor" && method === "PUT") {
      const enabled = body.enabled ?? {};
      const updates = body.updates ?? {};
      if (!isObject(enabled) || !isObject(updates)) throw new HttpError(400, '"enabled" and "updates" must be objects');
      for (const [k, v] of Object.entries(enabled)) if (!MONITORS.includes(k) || !isBool(v)) throw new HttpError(400, `invalid announcement switch "${k}"`);
      for (const [k, v] of Object.entries(updates)) if (!UPDATE_SWITCHES.includes(k) || !isBool(v)) throw new HttpError(400, `invalid update switch "${k}"`);
      ctx.state.update((d) => {
        Object.assign(d.monitor.enabled, enabled);
        Object.assign(d.monitor.updates, updates);
      });
      log.info("admin page: monitoring settings changed");
      return sendJson(res, 200, await state(s.csrf));
    }

    const g = /^\/api\/guilds\/(\d{5,25})(?:\/campaigns\/([a-z0-9-]{1,80}))?$/.exec(route);
    if (g && method === "PUT") {
      const guild = guildOf(g[1]);
      if (!guild) throw new HttpError(404, "the bot is not in that server");
      return g[2] ? saveCampaignChannels(req, res, s, guild, g[2], body) : saveGuild(req, res, s, guild, body);
    }

    if (route === "/api/session-summaries" && method === "PUT") {
      const next = { ...summarySettings(ctx.state) };
      if (body.enabled !== undefined) {
        if (!isBool(body.enabled)) throw new HttpError(400, '"enabled" must be true or false');
        next.enabled = body.enabled;
      }
      if (body.maxAgeHours !== undefined) {
        const h = Number(body.maxAgeHours);
        if (!Number.isInteger(h) || h < MAX_AGE_HOURS.min || h > MAX_AGE_HOURS.max) throw new HttpError(400, `the age limit must be a whole number of hours from ${MAX_AGE_HOURS.min} to ${MAX_AGE_HOURS.max}`);
        next.maxAgeHours = h;
      }
      ctx.state.update((d) => {
        d.sessionSummaries = next;
      });
      log.info(`admin page: session summaries ${next.enabled ? `on (last ${next.maxAgeHours} h)` : "off"}`);
      return sendJson(res, 200, await state(s.csrf));
    }

    if (route === "/api/session-summaries/post" && method === "POST") {
      if (typeof body.world !== "string" || !boundWorlds().includes(body.world)) throw new HttpError(400, "pick a world that a campaign is bound to");
      if (!summarySettings(ctx.state).enabled) throw new HttpError(409, "session summaries are turned off");
      const sent = await postSessionSummaries(ctx, body.world);
      log.info(`admin page: posted ${sent} session summary message(s) for world ${body.world}`);
      return sendJson(res, 200, { sent, ...(await state(s.csrf)) });
    }

    if (route === "/api/password" && method === "PUT") {
      if (!(await verifyPassword(body.current, settings.passwordHash))) throw new HttpError(403, "the current password is wrong");
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      const next = { ...settings, passwordHash: await hashPassword(body.password) };
      saveAdminSettings(file, next);
      settings = next;
      // Every other session ends; this one gets a fresh id.
      sessions.clear();
      const fresh = newSession();
      log.info("admin page: password changed");
      return sendJson(res, 200, await state(fresh.csrf), { "Set-Cookie": cookie(req, fresh.id, SESSION_MS / 1000) });
    }

    throw new HttpError(404, "not found");
  }

  return {
    handles: (pathname) => pathname === PREFIX || pathname.startsWith(`${PREFIX}/`),

    // A Host header as "name[:port]" when the name is one the page may be opened with, else null.
    // The name is taken from the allow-list, not the request, so a redirect built from it cannot point elsewhere.
    knownHost(value) {
      let url;
      try {
        url = new URL(`http://${value}`);
      } catch {
        return null;
      }
      const name = url.hostname.toLowerCase();
      const known = [...hosts, ...machineHosts(now())].find((h) => h === name);
      if (!known) return null;
      const port = /^\d{1,5}$/.test(url.port) ? Number.parseInt(url.port, 10) : null;
      return port ? `${known}:${port}` : known;
    },

    // certificate: the port's self-signed certificate (PEM), offered for download so a browser can trust it.
    async handle(req, res, pathname, { certificate } = {}) {
      if (!settings.passwordHash) return send(res, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
      if (!hostAllowed(hostOf(req.headers.host || ""))) {
        return send(res, 403, "admin page: unknown host name (add it to ADMIN_HOSTS)", { "Content-Type": "text/plain; charset=utf-8" });
      }
      const route = pathname.slice(PREFIX.length);
      if (Object.hasOwn(ui, route)) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { Allow: "GET, HEAD" });
        return send(res, 200, req.method === "HEAD" ? undefined : ui[route].body, { "Content-Type": ui[route].type });
      }
      if (route === "/certificate.crt" && certificate) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { Allow: "GET, HEAD" });
        return send(res, 200, req.method === "HEAD" ? undefined : certificate, {
          "Content-Type": "application/x-x509-ca-cert",
          "Content-Disposition": 'attachment; filename="foundryvtt-discord-integration.crt"',
        });
      }
      if (!route.startsWith("/api/")) return send(res, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
      try {
        await api(req, res, route, session(req));
      } catch (err) {
        if (err instanceof HttpError) {
          if (!res.headersSent) sendJson(res, err.status, { error: err.message });
          return;
        }
        throw err;
      }
    },
  };
}
