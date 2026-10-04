// Talks to Foundry's public status endpoint (GET /api/status), which exists in
// Foundry VTT v9+ and is unchanged in v13. It needs no login and answers even
// while Foundry is sitting on the setup screen:
//
//   { "active": true, "version": "13.346", "world": "my-world",
//     "system": "dnd5e", "users": 2, "uptime": 1234, "partner": null }
//
// When no world is running: active=false, world=null, system=null.

export const STATUS_PATH = "/api/status";

/**
 * Normalise the JSON Foundry returns into a stable shape.
 * @returns {{active:boolean, version:string|null, world:string|null, system:string|null, systemVersion:string|null, users:number|null, uptime:number|null}}
 */
export function parseStatus(json) {
  if (!json || typeof json !== "object") throw new Error("status response is not a JSON object");
  const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    active: Boolean(json.active),
    version: str(json.version),
    world: str(json.world),
    system: str(json.system),
    systemVersion: str(json.systemVersion),
    users: num(json.users),
    uptime: num(json.uptime),
  };
}

/**
 * Create a status fetcher bound to a Foundry base URL.
 * @param {string} baseUrl e.g. http://localhost:30000
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {() => Promise<{ok:true, status:ReturnType<typeof parseStatus>} | {ok:false, error:string}>}
 */
export function createStatusFetcher(baseUrl, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const url = `${baseUrl.replace(/\/+$/, "")}${STATUS_PATH}`;
  return async function fetchStatus() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json = await res.json();
      return { ok: true, status: parseStatus(json) };
    } catch (err) {
      const reason = err?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
  };
}
