// What is available out there, and does it fit this Foundry? This file knows
//   - Foundry's version scheme: <generation>.<build>, e.g. 13.346 is build 346 of
//     Foundry v13 ("major version" = generation, "minor update" = newer build)
//   - package compatibility declarations ({ minimum, verified, maximum })
//   - the foundryvtt.com website: the package API (GET /_api/packages/get?id=…)
//     that lists every published version of a package with its compatibility,
//     a package's own manifest URL as a fallback, and the release notes index
//     (/releases/) to find the newest build of each generation.
// The pure functions are at the top; the FoundryWebsite class at the bottom does
// the fetching with a cache, so a chatty Discord server does not hammer the site.

import { compareVersions } from "./updates.js";

export const DEFAULT_WEBSITE_URL = "https://foundryvtt.com";
export const CHANNELS = Object.freeze(["stable", "testing", "development", "prototype"]);

// --- versions ----------------------------------------------------------------------

/** Foundry generation of a version: "13.346" → 13, "0.8.9" → 8 (the 0.x era), "11" → 11. */
export function generationOf(version) {
  if (version === null || version === undefined) return null;
  const m = String(version).trim().match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]);
  if (major === 0) return m[2] !== undefined ? Number(m[2]) : null;
  return major;
}

/** Build number of a Foundry version: "13.346" → 346. */
export function buildOf(version) {
  const m = String(version ?? "").trim().match(/^\d+\.(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Highest version in a list (by compareVersions), or null. */
export function maxVersion(versions) {
  let best = null;
  for (const v of versions) if (v !== null && v !== undefined && (best === null || compareVersions(v, best) > 0)) best = v;
  return best;
}

// --- compatibility -------------------------------------------------------------------

/**
 * Normalise the many ways a package can say which Foundry it works with.
 * Accepts a manifest, a `compatibility` object, legacy manifest fields and the
 * website's version records.
 * @returns {{minimum:string|null, verified:string|null, maximum:string|null}|null} null when nothing is declared
 */
export function normaliseCompatibility(raw) {
  if (!raw || typeof raw !== "object") return null;
  const c = raw.compatibility && typeof raw.compatibility === "object" ? raw.compatibility : raw;
  const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  const out = {
    minimum: str(c.minimum ?? raw.minimumCoreVersion ?? raw.minimum_core_version ?? raw.required_core_version),
    verified: str(c.verified ?? raw.compatibleCoreVersion ?? raw.compatible_core_version),
    maximum: str(c.maximum ?? raw.maximum_core_version),
  };
  return out.minimum || out.verified || out.maximum ? out : null;
}

/**
 * How a compatibility declaration relates to a Foundry generation.
 *   verified      the package was verified for that generation (or a later one)
 *   untested      allowed (minimum/maximum do not exclude it) but not verified
 *   incompatible  the package says it needs an older or newer Foundry
 *   unknown       nothing declared
 */
export function compatibilityWith(compat, generation) {
  const c = normaliseCompatibility(compat);
  if (!c || generation === null || generation === undefined) return "unknown";
  const min = generationOf(c.minimum);
  const max = generationOf(c.maximum);
  const verified = generationOf(c.verified);
  if (min !== null && min > generation) return "incompatible";
  if (max !== null && max < generation) return "incompatible";
  if (verified !== null && verified >= generation) return "verified";
  // Allowed by minimum/maximum (or nothing said against it) but never verified for this generation:
  // Foundry installs such a package with a warning.
  return "untested";
}

/** Short human label for a compatibilityWith() result. */
export function describeCompatibility(status, generation) {
  switch (status) {
    case "verified": return `✅ verified for v${generation}`;
    case "untested": return `⚠️ not verified for v${generation}`;
    case "incompatible": return `❌ incompatible with v${generation}`;
    default: return "❔ compatibility unknown";
  }
}

// --- package records from the website / manifests ------------------------------------------

function str(v) {
  return v === undefined || v === null || v === "" ? null : String(v);
}

function normaliseVersionRecord(v, fallbackVersion = null) {
  if (!v || typeof v !== "object") return null;
  const version = str(v.version) ?? fallbackVersion;
  if (!version) return null;
  return {
    version,
    manifest: str(v.manifest),
    download: str(v.download),
    notes: str(v.notes ?? v.changelog),
    released: str(v.released ?? v.created ?? v.time),
    compatibility: normaliseCompatibility(v),
  };
}

/**
 * Parse the JSON of GET /_api/packages/get?id=<id>. Tolerates the envelope
 * ({status, package}) being present or not, and versions given as an array or
 * as an object keyed by version.
 * @returns {{id:string, title:string|null, url:string|null, type:string|null, versions:Array}|null}
 */
export function parsePackageResponse(json, expectedId = null, websiteUrl = DEFAULT_WEBSITE_URL) {
  if (!json || typeof json !== "object") return null;
  if (json.status && json.status !== "success") return null;
  const pkg = json.package && typeof json.package === "object" ? json.package : json;
  const id = str(pkg.id ?? pkg.name) ?? expectedId;
  if (!id) return null;
  let rawVersions = pkg.versions ?? pkg.releases ?? [];
  if (rawVersions && typeof rawVersions === "object" && !Array.isArray(rawVersions)) {
    rawVersions = Object.entries(rawVersions).map(([key, value]) => (value && typeof value === "object" ? { version: key, ...value } : { version: key }));
  }
  const versions = (Array.isArray(rawVersions) ? rawVersions : [])
    .map((v) => normaliseVersionRecord(v))
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));
  return { id, title: str(pkg.title), url: str(pkg.url) ?? `${String(websiteUrl).replace(/\/+$/, "")}/packages/${encodeURIComponent(id)}`, type: str(pkg.type), versions, source: "api" };
}

/** Treat a package's published manifest (the `manifest` URL in module.json) as a one-version package record. */
export function parseManifestAsPackage(json, expectedId = null) {
  if (!json || typeof json !== "object") return null;
  const id = str(json.id ?? json.name) ?? expectedId;
  const record = normaliseVersionRecord({ version: json.version, manifest: json.manifest, download: json.download, changelog: json.changelog, compatibility: json.compatibility, minimumCoreVersion: json.minimumCoreVersion, compatibleCoreVersion: json.compatibleCoreVersion });
  if (!id || !record) return null;
  return { id, title: str(json.title), url: str(json.url), type: null, versions: [record], source: "manifest" };
}

/**
 * The newest published version that may be installed on a given generation.
 * Verified versions are preferred over merely "untested" ones only when the
 * untested one is not newer: we report the newest allowed version and tag it.
 */
export function latestCompatibleVersion(versions, generation) {
  let best = null;
  for (const v of versions ?? []) {
    const status = compatibilityWith(v.compatibility, generation);
    if (status === "incompatible" || status === "unknown") continue;
    if (!best || compareVersions(v.version, best.version) > 0) best = { ...v, status };
  }
  return best;
}

/**
 * Which installed packages have an update that fits the installed Foundry?
 * @param {Array<{type:string,id:string,title:string,version:string|null,compatibility?:string|null}>} installed
 * @param {Map<string, object|null>} infoByKey  "<type>:<id>" → parsePackageResponse() result (or null when unknown)
 * @param {number} generation  the running Foundry generation (13 for v13.x)
 * @returns {{updates:Array, upToDate:Array, heldBack:Array, unknown:Array}}
 *   updates:  newer version available for this generation
 *   upToDate: no newer compatible version
 *   heldBack: newer versions exist but all of them need a different Foundry
 *   unknown:  nothing known about the package (not on foundryvtt.com and no manifest reachable)
 */
export function findAvailableUpdates(installed, infoByKey, generation) {
  const result = { updates: [], upToDate: [], heldBack: [], unknown: [] };
  for (const pkg of [...installed].sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title))) {
    const info = infoByKey.get(`${pkg.type}:${pkg.id}`);
    if (!info || !info.versions?.length) {
      result.unknown.push({ pkg });
      continue;
    }
    const newest = info.versions.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b));
    const latest = latestCompatibleVersion(info.versions, generation);
    const entry = { pkg, installedVersion: pkg.version ?? null, newest, latest, url: info.url, source: info.source };
    if (latest && pkg.version !== null && compareVersions(latest.version, pkg.version) > 0) result.updates.push(entry);
    else if (pkg.version !== null && compareVersions(newest.version, pkg.version) > 0) result.heldBack.push(entry);
    else result.upToDate.push(entry);
  }
  return result;
}

/**
 * If Foundry were upgraded to `targetGeneration`, which packages would be ready?
 * @param {Array<{type:string,id:string,title:string,version:string|null,compatibilityInfo?:object|null,compatibility?:object|null}>} installed  (the installed manifests' declarations)
 * @param {Map<string, object|null>} infoByKey
 * @param {number} targetGeneration
 * @returns {{ready:Array, updateFirst:Array, notReady:Array, unknown:Array}}
 *   ready:        the installed version is verified for the target
 *   updateFirst:  the installed version is not, but a newer published version is (verified or at least allowed)
 *   untested:     nothing rules the target out, but no version was verified for it
 *   notReady:     the package (every published version) excludes the target
 *   unknown:      neither the installed manifest nor the website say anything
 */
export function majorUpgradeReport(installed, infoByKey, targetGeneration) {
  const report = { ready: [], updateFirst: [], untested: [], notReady: [], unknown: [] };
  for (const pkg of [...installed].sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title))) {
    const info = infoByKey.get(`${pkg.type}:${pkg.id}`) ?? null;
    const versions = info?.versions ?? [];
    const installedStatus = compatibilityWith(pkg.compatibilityInfo ?? pkg.compatibility, targetGeneration);
    const published = latestCompatibleVersion(versions, targetGeneration);
    const newest = versions.length ? versions.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b)) : null;
    const entry = { pkg, installedStatus, published, newest, url: info?.url ?? null };
    if (installedStatus === "verified") report.ready.push(entry);
    else if (published && pkg.version !== null && compareVersions(published.version, pkg.version) > 0) report.updateFirst.push(entry);
    else if (published) (published.status === "verified" ? report.ready : report.untested).push(entry); // the website vouches for the installed version
    else if (installedStatus === "untested") report.untested.push(entry);
    else if (installedStatus === "incompatible" || versions.some((v) => compatibilityWith(v.compatibility, targetGeneration) === "incompatible")) report.notReady.push(entry);
    else report.unknown.push(entry);
  }
  return report;
}

// --- Foundry releases ----------------------------------------------------------------------

/**
 * Pull the release list out of the HTML of https://foundryvtt.com/releases/.
 * Every link to /releases/<generation>.<build> counts; the release channel is
 * taken from the words near the link (Stable, Testing, Development, Prototype).
 * @returns {Array<{version:string, generation:number, build:number, channel:string|null}>} newest first
 */
export function parseReleasesPage(html) {
  const text = String(html ?? "");
  const re = /\/releases\/(\d+)\.(\d+)(?![\d.])/g;
  const matches = [];
  let m;
  while ((m = re.exec(text))) matches.push({ index: m.index, generation: Number(m[1]), build: Number(m[2]) });
  const byVersion = new Map();
  matches.forEach((hit, i) => {
    const version = `${hit.generation}.${hit.build}`;
    const windowEnd = i + 1 < matches.length ? Math.min(matches[i + 1].index, hit.index + 600) : hit.index + 600;
    const nearby = text.slice(hit.index, windowEnd);
    const channel = nearby.match(/\b(stable|testing|development|prototype)\b/i)?.[1]?.toLowerCase() ?? null;
    const have = byVersion.get(version);
    if (!have) byVersion.set(version, { version, generation: hit.generation, build: hit.build, channel });
    else if (!have.channel && channel) have.channel = channel;
  });
  return [...byVersion.values()].sort((a, b) => b.generation - a.generation || b.build - a.build);
}

/**
 * Compare the installed Foundry with the known releases.
 * @param {Array<{version:string, generation:number, build:number, channel:string|null}>} releases
 * @param {string|null} installedVersion e.g. "13.346"
 * @returns {{
 *   installed: string|null, generation: number|null, channelKnown: boolean,
 *   latestInGeneration: object|null, buildUpdate: object|null,
 *   newerGenerations: Array<object>, majorUpdate: object|null
 * }}
 */
export function summariseReleases(releases, installedVersion) {
  const generation = generationOf(installedVersion);
  const channelKnown = releases.some((r) => r.channel);
  const stable = releases.filter((r) => (channelKnown ? r.channel === "stable" : true));
  const latestOf = (gen) => stable.filter((r) => r.generation === gen).sort((a, b) => b.build - a.build)[0] ?? null;
  const latestInGeneration = generation === null ? null : latestOf(generation);
  const installedBuild = buildOf(installedVersion);
  const buildUpdate = latestInGeneration && installedBuild !== null && latestInGeneration.build > installedBuild ? latestInGeneration : null;
  const newerGenerations = [...new Set(stable.map((r) => r.generation))]
    .filter((g) => generation === null || g > generation)
    .sort((a, b) => a - b)
    .map((g) => latestOf(g))
    .filter(Boolean);
  return { installed: installedVersion ?? null, generation, channelKnown, latestInGeneration, buildUpdate, newerGenerations, majorUpdate: newerGenerations.at(-1) ?? null };
}

// --- fetching ------------------------------------------------------------------------------

/**
 * Talks to foundryvtt.com (or a mirror) with a cache. Every method resolves to a
 * result object and never throws for network problems.
 */
export class FoundryWebsite {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]
   * @param {typeof fetch} [options.fetch]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.cacheTtlMs]    how long successful answers are reused (default 30 min)
   * @param {number} [options.errorTtlMs]    how long failures are remembered (default 5 min)
   * @param {number} [options.concurrency]   parallel requests when looking up many packages
   * @param {() => Date} [options.now]
   * @param {{debug:Function,warn:Function}} [options.log]
   */
  constructor({ baseUrl = DEFAULT_WEBSITE_URL, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000, cacheTtlMs = 30 * 60_000, errorTtlMs = 5 * 60_000, concurrency = 4, now = () => new Date(), log = console } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.errorTtlMs = errorTtlMs;
    this.concurrency = Math.max(1, concurrency);
    this.now = now;
    this.log = log;
    this.cache = new Map(); // url -> { at, ok, value|error }
  }

  packageUrl(id) {
    return `${this.baseUrl}/_api/packages/get?id=${encodeURIComponent(id)}`;
  }

  releasesUrl() {
    return `${this.baseUrl}/releases/`;
  }

  releaseNotesUrl(version) {
    return `${this.baseUrl}/releases/${encodeURIComponent(version)}`;
  }

  clearCache() {
    this.cache.clear();
  }

  /** GET a URL with timeout and cache. Resolves to {ok:true, body, json?} or {ok:false, error}. */
  async get(url, { accept = "application/json" } = {}) {
    const cached = this.cache.get(url);
    const t = this.now().getTime();
    if (cached && t - cached.at < (cached.ok ? this.cacheTtlMs : this.errorTtlMs)) return cached.result;
    const result = await this.#request(url, accept);
    this.cache.set(url, { at: t, ok: result.ok, result });
    return result;
  }

  async #request(url, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(url, { signal: controller.signal, headers: { accept, "user-agent": "foundryvtt-discord-integration (+https://github.com/dxcufgb/FoundryVTT-discord-integration)" }, redirect: "follow" });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
      const body = await res.text();
      let json;
      if (accept.includes("json")) {
        try {
          json = JSON.parse(body);
        } catch {
          return { ok: false, error: "not JSON" };
        }
      }
      return { ok: true, body, json };
    } catch (err) {
      const reason = err?.name === "AbortError" ? `timed out after ${this.timeoutMs} ms` : err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The website's record of a package, or null when it does not know it. */
  async getPackage(id) {
    const res = await this.get(this.packageUrl(id));
    if (!res.ok) {
      this.log.debug?.(`package lookup for ${id} failed: ${res.error}`);
      return res.status === 404 ? null : { error: res.error };
    }
    return parsePackageResponse(res.json, id, this.baseUrl);
  }

  /**
   * Everything we can learn about an installed package: the website first, the
   * package's own manifest URL as a fallback (one version, but better than nothing).
   * @param {{id:string, type:string, manifest?:string|null}} pkg
   * @returns {Promise<object|null>}
   */
  async getPackageInfo(pkg) {
    const fromSite = await this.getPackage(pkg.id);
    if (fromSite && !fromSite.error && fromSite.versions?.length) return fromSite;
    if (pkg.manifest && /^https?:\/\//i.test(pkg.manifest)) {
      const res = await this.get(pkg.manifest);
      if (res.ok) {
        const info = parseManifestAsPackage(res.json, pkg.id);
        if (info) return { ...info, url: info.url ?? fromSite?.url ?? null };
      } else {
        this.log.debug?.(`manifest fetch for ${pkg.id} failed: ${res.error}`);
      }
    }
    if (fromSite && !fromSite.error) return fromSite; // known, but no versions listed
    return null;
  }

  /**
   * Look up many packages, a few at a time.
   * @returns {Promise<Map<string, object|null>>} "<type>:<id>" → info
   */
  async getPackageInfos(packages) {
    const out = new Map();
    const queue = [...packages];
    const worker = async () => {
      for (let pkg = queue.shift(); pkg; pkg = queue.shift()) out.set(`${pkg.type}:${pkg.id}`, await this.getPackageInfo(pkg));
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    return out;
  }

  /** The Foundry release list. Resolves to {ok:true, releases} or {ok:false, error}. */
  async getReleases() {
    const res = await this.get(this.releasesUrl(), { accept: "text/html" });
    if (!res.ok) return { ok: false, error: res.error };
    const releases = parseReleasesPage(res.body);
    if (!releases.length) return { ok: false, error: "no releases found on the page (layout changed?)" };
    return { ok: true, releases };
  }
}
