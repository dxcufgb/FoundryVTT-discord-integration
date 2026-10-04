import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state.js";

export function tmpDir(prefix = "fvtt-bot-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tmpState() {
  const dir = tmpDir();
  return new StateStore(path.join(dir, "state.json")).load();
}

/** A controllable clock. */
export function fakeClock(start = "2026-03-01T12:00:00Z") {
  let t = new Date(start).getTime();
  const clock = {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(iso) {
      t = new Date(iso).getTime();
    },
  };
  return clock;
}

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

export function upStatus(overrides = {}) {
  return { active: true, version: "13.346", world: "my-world", system: "dnd5e", systemVersion: "5.1.0", users: 2, uptime: 100, ...overrides };
}

/** Write a fake Foundry user-data folder with the given packages. */
export function fakeDataFolder(packages) {
  const root = tmpDir("fvtt-data-");
  for (const pkg of packages) {
    const dir = path.join(root, "Data", `${pkg.type}s`, pkg.folder ?? pkg.id);
    fs.mkdirSync(dir, { recursive: true });
    const { type, folder, ...manifest } = pkg;
    fs.writeFileSync(path.join(dir, `${type}.json`), JSON.stringify(manifest));
  }
  return root;
}
