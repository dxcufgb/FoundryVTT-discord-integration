// Decides what counts as an "update" and makes sure each one is announced only
// once. Pure functions: feed them the previous snapshot and the current scan.

export function packageKey(pkg) {
  return `${pkg.type}:${pkg.id}`;
}

export function notifiedKey(pkg) {
  return `${packageKey(pkg)}@${pkg.version ?? "unknown"}`;
}

/**
 * Compare the stored snapshot with a fresh scan.
 * @param {Record<string,{type:string,id:string,title:string,version:string|null}>} previous keyed by packageKey
 * @param {Array<{type:string,id:string,title:string,version:string|null}>} current
 * @returns {{updated:Array, installed:Array, removed:Array, snapshot:Record<string,object>}}
 */
export function diffPackages(previous, current) {
  const snapshot = {};
  const updated = [];
  const installed = [];
  for (const pkg of current) {
    const key = packageKey(pkg);
    const stored = { type: pkg.type, id: pkg.id, title: pkg.title, version: pkg.version ?? null };
    snapshot[key] = stored;
    const before = previous[key];
    if (!before) {
      installed.push({ ...pkg, previousVersion: null });
    } else if ((before.version ?? null) !== (pkg.version ?? null)) {
      updated.push({ ...pkg, previousVersion: before.version ?? null });
    }
  }
  const removed = [];
  for (const [key, before] of Object.entries(previous)) {
    if (!snapshot[key]) removed.push({ ...before });
  }
  return { updated, installed, removed, snapshot };
}

/** Key used to announce a removal once (cleared again if the package is reinstalled). */
export function removedKey(pkg) {
  return `${packageKey(pkg)}@removed`;
}

/** Compare version strings like Foundry does: numeric parts first, then as text. */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[.\-+]/);
  const pb = String(b ?? "").split(/[.\-+]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
