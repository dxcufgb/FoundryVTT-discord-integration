// Opt-in self-update: is there a newer GitHub release of the bot, and fetch + verify its bundle.
// Used by scripts/self-update.js, which the platform updaters (deploy/linux/auto-update.sh,
// deploy/windows/auto-update.ps1) call; they do the extracting, installing and restarting.
// Security: HTTPS only (every redirect hop too), a timeout on every request, a size cap on
// downloads, SHA-256 checked against the release's checksum file, and the optional GitHub token
// is only ever sent to api.github.com (never to the pre-signed download hosts) and never logged.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_REPO = "dxcufgb/FoundryVTT-discord-integration";
export const API_HOST = "api.github.com";
const APP = "foundryvtt-discord-integration";
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Release asset and checksum file per install flavour. */
export const PLATFORMS = Object.freeze({
  linux: { suffix: "linux.tar.gz", sums: "SHA256SUMS.txt" },
  "windows-zip": { suffix: "windows.zip", sums: "SHA256SUMS.txt" },
  "windows-setup": { suffix: "setup.exe", sums: "SHA256SUMS-setup.txt" },
});

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** "v1.2.3-beta.1" -> { major, minor, patch, pre: ["beta", "1"], version: "1.2.3-beta.1" }, or null. */
export function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [], version: String(v).trim().replace(/^v/, "").replace(/\+.*$/, "") };
}

/** Semantic version precedence (semver.org §11): -1, 0 or 1. Throws on invalid versions. */
export function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Not a semantic version: ${!pa ? a : b}`);
  for (const k of ["major", "minor", "patch"]) if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Parse `sha256sum` / Get-FileHash style lines ("<hex>  [*][dir/]name") into Map(name -> hex). */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$/.exec(line.trim());
    if (m) sums.set(path.posix.basename(m[2].replace(/\\/g, "/")), m[1].toLowerCase());
  }
  return sums;
}

/** Bundle and checksum assets of a release for a platform, or an error message. */
export function selectAssets(release, platform) {
  const p = PLATFORMS[platform];
  if (!p) throw new Error(`Unknown platform '${platform}' (one of ${Object.keys(PLATFORMS).join(", ")})`);
  const version = parseVersion(release.tag_name)?.version;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const name = `${APP}-${version}-${p.suffix}`;
  const asset = assets.find((a) => a.name === name);
  const sums = assets.find((a) => a.name === p.sums);
  if (!asset) return { error: `release ${release.tag_name} has no ${name}` };
  if (!sums) return { error: `release ${release.tag_name} publishes no ${p.sums}, so ${name} cannot be verified` };
  return { asset, sums };
}

/**
 * Compare the latest published release with the installed version.
 * @returns {{status: "current"|"update"|"newer-installed", current: string, latest: string, tag: string, release: object}}
 */
export function evaluateRelease(release, currentVersion) {
  if (!release || typeof release !== "object") throw new Error("GitHub returned no release");
  if (release.draft || release.prerelease) throw new Error(`latest release ${release.tag_name} is a draft or pre-release; ignoring it`);
  const latest = parseVersion(release.tag_name);
  if (!latest) throw new Error(`latest release tag '${release.tag_name}' is not a version (vX.Y.Z)`);
  if (latest.pre.length) throw new Error(`latest release ${release.tag_name} is a pre-release version; ignoring it`);
  if (!parseVersion(currentVersion)) throw new Error(`installed version '${currentVersion}' is not a semantic version`);
  const cmp = compareSemver(latest.version, currentVersion);
  return { status: cmp > 0 ? "update" : cmp === 0 ? "current" : "newer-installed", current: String(currentVersion), latest: latest.version, tag: release.tag_name, release };
}

/** Request headers for a URL: the token only for https://api.github.com. */
export function headersFor(url, token, accept = "application/vnd.github+json") {
  const u = new URL(url);
  const h = { "User-Agent": `${APP}-updater`, Accept: accept };
  if (u.host === API_HOST) h["X-GitHub-Api-Version"] = "2022-11-28";
  if (token && u.protocol === "https:" && u.host === API_HOST) h.Authorization = `Bearer ${token}`;
  return h;
}

/** fetch with manual redirects: every hop must be HTTPS, and headers are recomputed per hop (drops the token off api.github.com). */
export async function fetchFollow(url, { fetchImpl = globalThis.fetch, token = null, accept, timeoutMs = 30_000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (new URL(url).protocol !== "https:") throw new Error(`refusing non-HTTPS URL ${new URL(url).origin}`);
    const res = await fetchImpl(url, { headers: headersFor(url, token, accept), redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).href;
      await res.body?.cancel?.();
      continue;
    }
    if (!res.ok) {
      const detail = res.status === 403 || res.status === 429 ? await res.json().then((j) => `: ${String(j.message).slice(0, 200)}`, () => "") : "";
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}${detail}`);
    }
    return { res, signal };
  }
  throw new Error("too many redirects");
}

/** The latest full release of a repository (GitHub's /releases/latest skips drafts and pre-releases). */
export async function fetchLatestRelease({ repo = DEFAULT_REPO, fetchImpl, token, timeoutMs } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((s) => /^\.+$/.test(s))) throw new Error(`invalid repository '${repo}'`);
  const { res } = await fetchFollow(`https://${API_HOST}/repos/${repo}/releases/latest`, { fetchImpl, token, timeoutMs });
  return res.json();
}

/** With a token, assets are fetched through the API (works for private repositories); otherwise via the public download URL. */
function assetUrl(asset, token) {
  return token && asset.url ? asset.url : asset.browser_download_url;
}

/** Download an asset to a file (size-capped), returning its SHA-256. */
export async function downloadAsset(asset, dest, { fetchImpl, token, timeoutMs = 10 * 60_000, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  const { res } = await fetchFollow(assetUrl(asset, token), { fetchImpl, token, accept: "application/octet-stream", timeoutMs });
  if (Number(res.headers.get("content-length")) > maxBytes) throw new Error(`${asset.name} is larger than ${maxBytes} bytes`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new Error(`${asset.name} is larger than ${maxBytes} bytes`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  return { sha256: hash.digest("hex"), size };
}

/** Download a small text asset (the checksum file). */
export async function fetchText(asset, { fetchImpl, token, timeoutMs } = {}) {
  const { res } = await fetchFollow(assetUrl(asset, token), { fetchImpl, token, accept: "application/octet-stream", timeoutMs });
  const text = await res.text();
  if (text.length > 64 * 1024) throw new Error(`${asset.name} is unexpectedly large`);
  return text;
}

/** Read the GitHub token from a file, if there is one. Never logged. */
export function readToken(file, log = console) {
  if (!file || !fs.existsSync(file)) return null;
  if (process.platform !== "win32" && fs.statSync(file).mode & 0o077) log.warn(`${file} is readable by other users; make it chmod 600`);
  return fs.readFileSync(file, "utf8").trim() || null;
}

/** Installed version from <dir>/package.json. */
export function installedVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
}

/**
 * Check, and unless `checkOnly`, download and verify the bundle for `platform` into `outDir`.
 * @returns {Promise<{status: string, current: string, latest: string, tag: string, file?: string}>}
 */
export async function runUpdate({ dir, platform, outDir, checkOnly = false, repo, token, fetchImpl, log = console }) {
  const result = evaluateRelease(await fetchLatestRelease({ repo, fetchImpl, token }), installedVersion(dir));
  const { release, ...summary } = result;
  if (result.status === "current") log.info(`Up to date: installed ${result.current} is the latest release.`);
  else if (result.status === "newer-installed") log.info(`Installed ${result.current} is newer than the latest release ${result.latest}; nothing to do.`);
  else log.info(`Update available: ${result.current} -> ${result.latest} (${release.html_url ?? result.tag})`);
  if (result.status !== "update") return summary;
  const picked = selectAssets(release, platform);
  if (picked.error) throw new Error(picked.error);
  if (checkOnly) return { ...summary, asset: picked.asset.name };
  const expected = parseChecksums(await fetchText(picked.sums, { fetchImpl, token })).get(picked.asset.name);
  if (!expected) throw new Error(`${picked.sums.name} has no entry for ${picked.asset.name}`);
  const file = path.join(outDir, picked.asset.name);
  log.info(`Downloading ${picked.asset.name}`);
  const { sha256, size } = await downloadAsset(picked.asset, file, { fetchImpl, token });
  if (sha256 !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`checksum mismatch for ${picked.asset.name}: expected ${expected}, got ${sha256}`);
  }
  log.info(`Verified ${picked.asset.name} (${size} bytes, SHA-256 ${sha256})`);
  return { ...summary, asset: picked.asset.name, file };
}
