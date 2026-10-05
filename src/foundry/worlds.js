// Which modules does each world actually use? Foundry stores the per-world list
// of enabled modules in the world setting `core.moduleConfiguration`:
//
//   v11 and newer:  <data>/Data/worlds/<id>/data/settings/      (LevelDB)
//   v10 and older:  <data>/Data/worlds/<id>/data/settings.db    (NeDB, one JSON document per line)
//
// Both are read without touching Foundry (see leveldb.js). On top of that a
// world manifest may list modules it requires (`relationships.requires`).
// All functions are read-only and tolerate missing or broken files.

import fs from "node:fs";
import path from "node:path";
import { looksLikeLevelDb, readLevelDb } from "./leveldb.js";
import { normaliseManifest, PACKAGE_TYPES, resolveDataFolder } from "./packages.js";

const SETTINGS_PREFIX = "!settings!";
const MODULE_CONFIGURATION_KEY = "core.moduleConfiguration";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Module ids a manifest declares as required (v10+ `relationships.requires`, legacy `dependencies`). */
export function requiredModuleIds(json) {
  const out = new Set();
  const lists = [json?.relationships?.requires, json?.dependencies];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const dep of list) {
      if (!dep || typeof dep !== "object") continue;
      const type = dep.type ?? "module";
      const id = String(dep.id ?? dep.name ?? "").trim();
      if (id && type === "module") out.add(id);
    }
  }
  return [...out];
}

/**
 * Every world in the data folder.
 * @returns {Array<{id:string, title:string, version:string|null, system:string|null, coreVersion:string|null, requires:string[], path:string}>}
 */
export function scanWorlds(dataPath) {
  const folder = resolveDataFolder(dataPath);
  if (!folder) return [];
  const dir = path.join(folder, "worlds");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const worlds = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const worldPath = path.join(dir, entry.name);
    const json = readJson(path.join(worldPath, PACKAGE_TYPES.world));
    const manifest = normaliseManifest("world", json, entry.name);
    if (!manifest) continue;
    const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
    worlds.push({
      id: manifest.id,
      title: manifest.title,
      version: manifest.version,
      system: str(json.system),
      coreVersion: str(json.coreVersion ?? json.compatibility?.verified),
      requires: requiredModuleIds(json),
      path: worldPath,
    });
  }
  return worlds.sort((a, b) => a.id.localeCompare(b.id));
}

function parseModuleConfiguration(doc) {
  if (!doc || doc.key !== MODULE_CONFIGURATION_KEY) return null;
  let value = doc.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const modules = {};
  for (const [id, on] of Object.entries(value)) modules[id] = Boolean(on);
  return modules;
}

/**
 * Read a world's module configuration.
 * @param {string} worldPath  the world folder (…/Data/worlds/<id>)
 * @param {{log?: {warn:Function}}} [options]
 * @returns {{ok:true, modules:Record<string,boolean>, source:"leveldb"|"nedb"} | {ok:false, reason:string}}
 */
export function readModuleConfiguration(worldPath, { log } = {}) {
  const levelDir = path.join(worldPath, "data", "settings");
  if (looksLikeLevelDb(levelDir)) {
    let docs;
    try {
      docs = readLevelDb(levelDir, { keyPrefix: SETTINGS_PREFIX, log });
    } catch (err) {
      return { ok: false, reason: `could not read settings database: ${err.message ?? err}` };
    }
    for (const value of docs.values()) {
      let doc;
      try {
        doc = JSON.parse(value.toString("utf8"));
      } catch {
        continue;
      }
      const modules = parseModuleConfiguration(doc);
      if (modules) return { ok: true, modules, source: "leveldb" };
    }
    if (docs.size === 0) return { ok: false, reason: "settings database is empty (world never launched?)" };
    return { ok: true, modules: {}, source: "leveldb" }; // launched, but no module ever enabled
  }

  const nedbFile = path.join(worldPath, "data", "settings.db");
  let text;
  try {
    text = fs.readFileSync(nedbFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, reason: "no settings database (world never launched?)" };
    return { ok: false, reason: `could not read settings.db: ${err.message ?? err}` };
  }
  // NeDB appends: later lines override earlier ones; `$$deleted` removes a document.
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    const id = doc._id ?? doc.key;
    if (doc.$$deleted) byId.delete(id);
    else byId.set(id, doc);
  }
  for (const doc of byId.values()) {
    const modules = parseModuleConfiguration(doc);
    if (modules) return { ok: true, modules, source: "nedb" };
  }
  return { ok: true, modules: {}, source: "nedb" };
}

/**
 * Scan all worlds together with their module configuration.
 * @returns {Array<ReturnType<typeof scanWorlds>[number] & { config: ReturnType<typeof readModuleConfiguration> }>}
 */
export function scanWorldsWithModules(dataPath, options = {}) {
  return scanWorlds(dataPath).map((w) => ({ ...w, config: readModuleConfiguration(w.path, options) }));
}

/**
 * Work out, for every installed module, where it is used.
 * @param {Array<{id:string,title?:string,version?:string|null}>} modules installed modules
 * @param {ReturnType<typeof scanWorldsWithModules>} worlds
 * @returns {{
 *   usage: Array<{id:string, title:string, version:string|null, activeIn:string[], requiredBy:string[], used:boolean}>,
 *   unused: Array<{id:string, title:string, version:string|null}>,
 *   unreadable: Array<{id:string, title:string, reason:string}>,
 *   worlds: Array<{id:string, title:string, system:string|null, activeModules:number|null}>
 * }}
 */
export function moduleUsage(modules, worlds) {
  const unreadable = worlds.filter((w) => !w.config.ok).map((w) => ({ id: w.id, title: w.title, reason: w.config.reason }));
  const usage = [...modules]
    .sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id))
    .map((m) => {
      const activeIn = worlds.filter((w) => w.config.ok && w.config.modules[m.id] === true).map((w) => w.id);
      const requiredBy = worlds.filter((w) => w.requires.includes(m.id)).map((w) => w.id);
      return { id: m.id, title: m.title ?? m.id, version: m.version ?? null, activeIn, requiredBy, used: activeIn.length > 0 || requiredBy.length > 0 };
    });
  return {
    usage,
    unused: usage.filter((u) => !u.used).map(({ id, title, version }) => ({ id, title, version })),
    unreadable,
    worlds: worlds.map((w) => ({ id: w.id, title: w.title, system: w.system, activeModules: w.config.ok ? Object.values(w.config.modules).filter(Boolean).length : null })),
  };
}
