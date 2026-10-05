// Reads the manifests of everything installed in Foundry's user data folder:
//   <data>/Data/systems/<id>/system.json
//   <data>/Data/modules/<id>/module.json
//   <data>/Data/worlds/<id>/world.json
// plus the Foundry version itself from the install folder when configured.
// All functions are read-only and tolerate missing or broken manifests.

import fs from "node:fs";
import path from "node:path";

export const PACKAGE_TYPES = Object.freeze({ system: "system.json", module: "module.json", world: "world.json" });

/** Accept either the user-data root (containing Data/) or the Data folder itself. */
export function resolveDataFolder(dataPath) {
  if (!dataPath) return null;
  const direct = path.join(dataPath, "Data");
  if (isDir(direct)) return direct;
  if (isDir(path.join(dataPath, "modules")) || isDir(path.join(dataPath, "systems")) || isDir(path.join(dataPath, "worlds"))) return dataPath;
  return direct;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Normalise a manifest. Foundry v10+ uses `id`; very old packages used `name`.
 * `compatibility` is the single version Foundry shows ("verified for"), `compatibilityInfo` the full declaration.
 * @returns {{type:string,id:string,title:string,version:string|null,compatibility:string|null,compatibilityInfo:{minimum:string|null,verified:string|null,maximum:string|null}|null,manifest:string|null,changelog:string|null,url:string|null}|null}
 */
export function normaliseManifest(type, json, folderName) {
  if (!json || typeof json !== "object") return null;
  const id = String(json.id ?? json.name ?? folderName ?? "").trim();
  if (!id) return null;
  const compat = json.compatibility ?? {};
  const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  return {
    type,
    id,
    title: str(json.title) ?? id,
    version: str(json.version),
    compatibility: str(compat.verified ?? compat.maximum ?? compat.minimum ?? json.compatibleCoreVersion),
    compatibilityInfo: compatibilityInfo(compat, json),
    manifest: str(json.manifest),
    changelog: str(json.changelog),
    url: str(json.url),
  };
}

function compatibilityInfo(compat, json) {
  const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  const info = {
    minimum: str(compat.minimum ?? json.minimumCoreVersion),
    verified: str(compat.verified ?? json.compatibleCoreVersion),
    maximum: str(compat.maximum),
  };
  return info.minimum || info.verified || info.maximum ? info : null;
}

/**
 * Scan one package type folder.
 * @returns {Array<ReturnType<typeof normaliseManifest>>}
 */
export function scanPackageType(dataFolder, type) {
  const manifestName = PACKAGE_TYPES[type];
  if (!manifestName) throw new Error(`Unknown package type "${type}"`);
  const dir = path.join(dataFolder, `${type}s`);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifest = normaliseManifest(type, readJson(path.join(dir, entry.name, manifestName)), entry.name);
    if (manifest) result.push(manifest);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** Scan systems and modules (the things whose updates we announce). */
export function scanPackages(dataPath, { systems = true, modules = true } = {}) {
  const folder = resolveDataFolder(dataPath);
  if (!folder) return [];
  const out = [];
  if (systems) out.push(...scanPackageType(folder, "system"));
  if (modules) out.push(...scanPackageType(folder, "module"));
  return out;
}

/** Look up a world's manifest (for its title and system) by id. */
export function readWorld(dataPath, worldId) {
  const folder = resolveDataFolder(dataPath);
  if (!folder || !worldId) return null;
  return normaliseManifest("world", readJson(path.join(folder, "worlds", worldId, "world.json")), worldId);
}

/**
 * Read the installed Foundry version from the install folder. Accepts the
 * folder that contains resources/app, or resources/app itself.
 */
export function readFoundryVersion(appPath) {
  if (!appPath) return null;
  for (const candidate of [path.join(appPath, "resources", "app", "package.json"), path.join(appPath, "package.json")]) {
    const json = readJson(candidate);
    if (json?.version) return String(json.version);
  }
  return null;
}
