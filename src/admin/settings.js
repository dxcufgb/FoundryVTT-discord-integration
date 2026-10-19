// The administration page's own settings: <BOT_DATA_DIR>/admin.json
//   { "passwordHash": "scrypt$16384$8$1$<salt>$<hash>" }
// Without a password hash the page stays off. The password is set with
// `npm run admin-password` (scripts/admin-password.js) and changed on the page.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 1024;

export const adminFile = (botDataDir) => path.join(botDataDir, "admin.json");

/** Reads admin.json; a missing file means "no password, page off". Throws on a broken file. */
export function loadAdminSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { passwordHash: "" };
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
  let raw;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: top level must be an object`);
  const hash = raw.passwordHash ?? "";
  if (hash !== "" && (typeof hash !== "string" || !parseHash(hash))) throw new Error(`${file}: invalid "passwordHash"`);
  return { passwordHash: hash };
}

/** Writes admin.json atomically, readable by its owner only. */
export function saveAdminSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ passwordHash: settings.passwordHash || undefined }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function parseHash(text) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bounds keep a tampered file from making every login take minutes.
  if (N < 1024 || N > 1048576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(m[4], "base64");
  const hash = Buffer.from(m[5], "base64");
  if (salt.length < 16 || hash.length < 32 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

/** Why a new password cannot be used, or "". */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `the password needs at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return "the password is too long";
  return "";
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(String(password).normalize("NFC"), salt, keylen, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const h = parseHash(stored || "");
  if (!h || typeof password !== "string" || password.length > MAX_PASSWORD) return false;
  const got = await scrypt(password.normalize("NFC"), h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r + 1024 * 1024 });
  return crypto.timingSafeEqual(got, h.hash);
}
