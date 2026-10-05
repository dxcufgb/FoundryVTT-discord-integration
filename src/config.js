// Loads the bot configuration from (in order of precedence):
//   1. real environment variables
//   2. a .env file next to package.json
// and validates it. Nothing here touches Discord or Foundry.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = Object.freeze({
  FOUNDRY_URL: "http://localhost:30000",
  FOUNDRY_WEBSITE_URL: "https://foundryvtt.com",
  BOT_DATA_DIR: "./data",
  POLL_INTERVAL_SECONDS: 30,
  DOWN_AFTER_FAILURES: 2,
  TIMEZONE: "UTC",
  LOG_LEVEL: "info",
});

/** Parse the text of a .env file into a plain object. Supports comments, blank lines and quoted values. */
export function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Where the .env file lives. In order: `--env <file>` on the command line, the
 * FOUNDRY_DISCORD_ENV_FILE variable, .env next to package.json, and on Windows
 * the file the installer writes under %ProgramData%.
 */
export function resolveEnvFile(argv = process.argv, env = process.env, platform = process.platform) {
  const flag = argv.indexOf("--env");
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  const fromEnv = env.FOUNDRY_DISCORD_ENV_FILE;
  if (fromEnv) return path.resolve(fromEnv);
  const local = path.join(PROJECT_ROOT, ".env");
  if (fs.existsSync(local)) return local;
  if (platform === "win32" && env.ProgramData) {
    const shared = path.join(env.ProgramData, "FoundryVTT Discord integration", ".env");
    if (fs.existsSync(shared)) return shared;
  }
  return local;
}

export function readEnvFile(file = resolveEnvFile()) {
  try {
    return parseEnv(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function pick(env, key) {
  const value = env[key];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInt(env, key, fallback) {
  const raw = pick(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a whole number greater than 0 (got "${raw}")`);
  return n;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a validated config object from an environment-like object.
 * @param {Record<string,string|undefined>} env
 * @param {{ requireDiscord?: boolean, baseDir?: string }} [options]  baseDir: what a relative BOT_DATA_DIR is relative to
 */
export function buildConfig(env, { requireDiscord = true, baseDir = PROJECT_ROOT } = {}) {
  const errors = [];

  const token = pick(env, "DISCORD_TOKEN");
  const clientId = pick(env, "DISCORD_CLIENT_ID");
  if (requireDiscord) {
    if (!token) errors.push("DISCORD_TOKEN is missing");
    if (!clientId) errors.push("DISCORD_CLIENT_ID is missing");
  }

  let foundryUrl = pick(env, "FOUNDRY_URL") ?? DEFAULTS.FOUNDRY_URL;
  try {
    const parsed = new URL(foundryUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("not http(s)");
    foundryUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    errors.push(`FOUNDRY_URL is not a valid http(s) URL (got "${foundryUrl}")`);
  }

  let websiteUrl = pick(env, "FOUNDRY_WEBSITE_URL") ?? DEFAULTS.FOUNDRY_WEBSITE_URL;
  try {
    const parsed = new URL(websiteUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("not http(s)");
    websiteUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    errors.push(`FOUNDRY_WEBSITE_URL is not a valid http(s) URL (got "${websiteUrl}")`);
  }

  const timezone = pick(env, "TIMEZONE") ?? DEFAULTS.TIMEZONE;
  if (!isValidTimezone(timezone)) errors.push(`TIMEZONE "${timezone}" is not a known IANA timezone (example: Europe/Stockholm)`);

  let pollIntervalSeconds = DEFAULTS.POLL_INTERVAL_SECONDS;
  let downAfterFailures = DEFAULTS.DOWN_AFTER_FAILURES;
  try { pollIntervalSeconds = positiveInt(env, "POLL_INTERVAL_SECONDS", DEFAULTS.POLL_INTERVAL_SECONDS); } catch (e) { errors.push(e.message); }
  try { downAfterFailures = positiveInt(env, "DOWN_AFTER_FAILURES", DEFAULTS.DOWN_AFTER_FAILURES); } catch (e) { errors.push(e.message); }
  if (pollIntervalSeconds < 5) errors.push("POLL_INTERVAL_SECONDS must be at least 5");

  const logLevel = (pick(env, "LOG_LEVEL") ?? DEFAULTS.LOG_LEVEL).toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) errors.push(`LOG_LEVEL "${logLevel}" must be debug, info, warn or error`);

  const dataPath = pick(env, "FOUNDRY_DATA_PATH");
  const appPath = pick(env, "FOUNDRY_APP_PATH");
  const botDataDir = path.resolve(baseDir, pick(env, "BOT_DATA_DIR") ?? DEFAULTS.BOT_DATA_DIR);

  if (errors.length) {
    const err = new Error(`Configuration problems:\n  - ${errors.join("\n  - ")}`);
    err.problems = errors;
    throw err;
  }

  return Object.freeze({
    discord: Object.freeze({ token, clientId, guildId: pick(env, "DISCORD_GUILD_ID") }),
    foundry: Object.freeze({ url: foundryUrl, websiteUrl, dataPath: dataPath ? path.resolve(dataPath) : undefined, appPath: appPath ? path.resolve(appPath) : undefined }),
    botDataDir,
    pollIntervalSeconds,
    downAfterFailures,
    timezone,
    logLevel,
  });
}

/** Load config from process.env layered over the .env file. */
export function loadConfig(options = {}) {
  const envFile = resolveEnvFile();
  const env = { ...readEnvFile(envFile), ...process.env };
  return buildConfig(env, { baseDir: path.dirname(envFile), ...options });
}
