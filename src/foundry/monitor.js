// The monitoring state machine. It owns no timers of its own: call tick() on
// whatever schedule you like (index.js uses setInterval, tests call it by hand).
// Every observation is turned into events handed to `emit(event)`; the notifier
// decides how those become Discord messages.
//
// Events:
//   { type: "up",   downtimeMs, status, expected }       Foundry answers again
//   { type: "down", error, expected, window }             Foundry stopped answering
//   { type: "worldStarted", world, previousWorld, status }
//   { type: "worldStopped", world, status }
//   { type: "restartWindowStarted", window }
//   { type: "restartOverdue", window, downSince }         still down after window + grace
//   { type: "foundryUpdated", version, previousVersion }
//   { type: "packageUpdated" | "packageInstalled" | "packageRemoved", pkg }

import { diffPackages, notifiedKey, packageKey, removedKey } from "./updates.js";
import { isInsideWindow, windowAt } from "../restartWindow.js";

export class FoundryMonitor {
  /**
   * @param {object} deps
   * @param {() => Promise<{ok:boolean, status?:object, error?:string}>} deps.fetchStatus
   * @param {() => Array<object>} deps.scanPackages   returns installed systems/modules (may be empty)
   * @param {() => string|null} [deps.readFoundryVersion]  fallback version source while Foundry is down
   * @param {import("../state.js").StateStore} deps.state
   * @param {(event: object) => Promise<void>|void} deps.emit
   * @param {{downAfterFailures:number, packageScanEveryMs?:number}} deps.options
   * @param {() => Date} [deps.now]
   * @param {{debug:Function,info:Function,warn:Function,error:Function}} [deps.log]
   */
  constructor({ fetchStatus, scanPackages, readFoundryVersion = () => null, state, emit, options, now = () => new Date(), log = console }) {
    this.fetchStatus = fetchStatus;
    this.scanPackages = scanPackages;
    this.readFoundryVersion = readFoundryVersion;
    this.state = state;
    this.emit = emit;
    this.options = { packageScanEveryMs: 5 * 60_000, ...options };
    this.now = now;
    this.log = log;
    this.failures = 0;
    this.lastPackageScan = 0;
    this.ticking = false;
    this.lastWindowKey = null;
  }

  get settings() {
    return this.state.data.monitor;
  }

  get foundry() {
    return this.state.data.foundry;
  }

  async tick() {
    if (this.ticking) return; // a slow Foundry answer must not overlap the next tick
    this.ticking = true;
    try {
      await this.checkRestartWindowStart();
      const result = await this.fetchStatus();
      if (result.ok) await this.handleUp(result.status);
      else await this.handleFailure(result.error);
      await this.checkRestartOverdue();
      await this.maybeScanPackages();
    } catch (err) {
      this.log.error("monitor tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  async send(event) {
    try {
      await this.emit(event);
      return true;
    } catch (err) {
      this.log.error(`failed to deliver ${event.type} event:`, err);
      return false;
    }
  }

  // --- up / down --------------------------------------------------------------

  async handleUp(status) {
    this.failures = 0;
    const now = this.now();
    const previous = this.foundry.status;
    const downSince = this.foundry.since ? new Date(this.foundry.since) : null;
    const firstTimeUp = !this.foundry.lastSeenUpAt; // never seen Foundry answer before: record, do not announce

    if (previous !== "up") {
      const expected = previous === "down" && downSince ? isInsideWindow(this.settings.restartWindow, downSince) : false;
      this.state.update((d) => {
        d.foundry.status = "up";
        d.foundry.since = now.toISOString();
        d.foundry.restartWindowAlerted = false;
      });
      if (previous === "down") {
        await this.send({ type: "up", downtimeMs: downSince ? now - downSince : null, status, expected });
      } else {
        this.log.info(`Foundry is up (version ${status.version ?? "?"}, world ${status.world ?? "none"})`);
      }
    }
    this.state.update((d) => {
      d.foundry.lastSeenUpAt = now.toISOString();
    });

    await this.handleWorld(status, firstTimeUp);
    await this.handleFoundryVersion(status.version, firstTimeUp);
  }

  async handleFailure(error) {
    this.failures += 1;
    const current = this.foundry.status;
    if (current === "down") return;
    if (current === "up" && this.failures < this.options.downAfterFailures) {
      this.log.warn(`Foundry check failed (${this.failures}/${this.options.downAfterFailures}): ${error}`);
      return;
    }
    const now = this.now();
    const window = this.settings.restartWindow;
    const expected = isInsideWindow(window, now);
    const firstObservation = current === null;
    this.state.update((d) => {
      d.foundry.status = "down";
      d.foundry.since = now.toISOString();
      d.foundry.restartWindowAlerted = false;
    });
    if (firstObservation) {
      // Never seen Foundry before: record it, but do not alarm anyone about something that may simply not be configured yet.
      this.log.warn(`Foundry is not reachable (${error}); will announce when it comes up.`);
      return;
    }
    await this.send({ type: "down", error, expected, window: expected ? windowAt(window, now) : null });
  }

  // --- world --------------------------------------------------------------------

  async handleWorld(status, firstObservation) {
    const world = status.active ? status.world : null;
    const previousWorld = this.foundry.world;
    if (world === previousWorld) return;
    const now = this.now();
    this.state.update((d) => {
      d.foundry.world = world;
      d.foundry.worldSince = now.toISOString();
    });
    if (firstObservation) {
      this.log.info(`World on first check: ${world ?? "none"}`);
      return;
    }
    if (!this.settings.enabled.world) return;
    if (world) await this.send({ type: "worldStarted", world, previousWorld, status });
    else await this.send({ type: "worldStopped", world: previousWorld, status });
  }

  // --- Foundry core version ---------------------------------------------------

  async handleFoundryVersion(version, firstObservation) {
    if (!version) return;
    const previous = this.foundry.version;
    if (previous === version) return;
    this.state.update((d) => {
      d.foundry.version = version;
    });
    if (firstObservation || !previous) return; // baseline: nothing to compare against
    if (!this.settings.enabled.updates || !this.settings.updates.trackFoundry) return;
    const key = `foundry@${version}`;
    if (this.state.wasNotified(key)) return;
    if (await this.send({ type: "foundryUpdated", version, previousVersion: previous })) this.state.markNotified(key, this.now());
  }

  // --- systems & modules ------------------------------------------------------------

  async maybeScanPackages(force = false) {
    const now = this.now().getTime();
    if (!force && now - this.lastPackageScan < this.options.packageScanEveryMs) return;
    this.lastPackageScan = now;
    await this.scanForUpdates();
  }

  async scanForUpdates() {
    let current;
    try {
      current = this.scanPackages() ?? [];
    } catch (err) {
      this.log.warn("package scan failed:", err.message ?? err);
      return;
    }
    const previous = this.state.data.packages;
    const diff = diffPackages(previous, current);

    if (Object.keys(previous).length === 0 && !this.state.data.packagesSeeded) {
      this.state.update((d) => {
        d.packages = diff.snapshot;
        d.packagesSeeded = true;
      });
      this.log.info(`Recorded ${current.length} installed packages as the starting point (no announcements).`);
      return;
    }

    // The stored snapshot only moves forward for a package once its change has
    // been announced (or needs no announcement), so a failed Discord delivery is
    // retried on the next scan instead of being lost.
    const next = { ...previous };
    const changed = new Set([...diff.updated, ...diff.installed, ...diff.removed].map(packageKey));
    for (const [key, stored] of Object.entries(diff.snapshot)) if (!changed.has(key)) next[key] = stored;

    const opts = this.settings.updates;
    const tracked = (pkg) => (pkg.type === "system" ? opts.trackSystems : pkg.type === "module" ? opts.trackModules : false);
    const announceAll = this.settings.enabled.updates;
    const pending = [
      ...diff.updated.map((pkg) => ({ type: "packageUpdated", pkg, key: notifiedKey(pkg), announce: tracked(pkg), apply: () => (next[packageKey(pkg)] = diff.snapshot[packageKey(pkg)]) })),
      ...diff.installed.map((pkg) => ({ type: "packageInstalled", pkg, key: notifiedKey(pkg), announce: tracked(pkg) && opts.announceNewPackages, apply: () => (next[packageKey(pkg)] = diff.snapshot[packageKey(pkg)]) })),
      ...diff.removed.map((pkg) => ({ type: "packageRemoved", pkg, key: removedKey(pkg), announce: tracked(pkg) && opts.announceRemovedPackages, apply: () => delete next[packageKey(pkg)] })),
    ];
    for (const item of pending) {
      if (announceAll && item.announce && !this.state.wasNotified(item.key)) {
        if (!(await this.send({ type: item.type, pkg: item.pkg }))) continue; // retry next scan
        this.state.markNotified(item.key, this.now());
      }
      item.apply();
      // A package that comes back may be removed again later; allow that removal to be announced.
      if (item.type === "packageInstalled") this.state.update((d) => { delete d.notified[removedKey(item.pkg)]; });
    }
    this.state.update((d) => {
      d.packages = next;
      d.packagesSeeded = true;
    });

    // Foundry's own version while it is down (status endpoint unavailable).
    if (this.foundry.status !== "up") {
      const version = this.readFoundryVersion();
      if (version) await this.handleFoundryVersion(version, false);
    }
  }

  // --- restart windows -----------------------------------------------------------------

  async checkRestartWindowStart() {
    const window = this.settings.restartWindow;
    if (!window) {
      this.lastWindowKey = null;
      return;
    }
    const now = this.now();
    const at = windowAt(window, now);
    const key = at.inside ? at.start.toISOString() : null;
    const entered = key && key !== this.lastWindowKey;
    this.lastWindowKey = key;
    if (entered && window.announceStart && this.state.data.lastWindowAnnounced !== key) {
      this.state.update((d) => {
        d.lastWindowAnnounced = key;
      });
      await this.send({ type: "restartWindowStarted", window: at });
    }
  }

  async checkRestartOverdue() {
    const window = this.settings.restartWindow;
    if (!window || this.foundry.status !== "down" || this.foundry.restartWindowAlerted || !this.foundry.since) return;
    const downSince = new Date(this.foundry.since);
    const at = windowAt(window, downSince);
    if (!at.inside) return; // unplanned downtime was already announced as such
    const deadline = at.end.getTime() + window.graceMinutes * 60_000;
    if (this.now().getTime() < deadline) return;
    this.state.update((d) => {
      d.foundry.restartWindowAlerted = true;
    });
    await this.send({ type: "restartOverdue", window: at, downSince });
  }
}
