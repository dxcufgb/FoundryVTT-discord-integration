import { test } from "node:test";
import assert from "node:assert/strict";
import { createStatusFetcher, parseStatus } from "../src/foundry/status.js";

test("parseStatus normalises Foundry's answer", () => {
  assert.deepEqual(parseStatus({ active: true, version: "13.346", world: "w", system: "dnd5e", users: 3, uptime: 42, partner: null }), {
    active: true, version: "13.346", world: "w", system: "dnd5e", systemVersion: null, users: 3, uptime: 42,
  });
  assert.deepEqual(parseStatus({ active: false, version: "13.346", world: null, system: null, users: 0, uptime: 7 }), {
    active: false, version: "13.346", world: null, system: null, systemVersion: null, users: 0, uptime: 7,
  });
  assert.throws(() => parseStatus("nope"), /not a JSON object/);
});

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

test("fetcher hits /api/status and reports success", async () => {
  let seen;
  const fetchStatus = createStatusFetcher("http://localhost:30000/", {
    fetch: fakeFetch(async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ active: true, version: "13.346", world: "w" }) };
    }),
  });
  const r = await fetchStatus();
  assert.equal(seen, "http://localhost:30000/api/status");
  assert.equal(r.ok, true);
  assert.equal(r.status.world, "w");
});

test("fetcher reports HTTP errors, connection errors and timeouts", async () => {
  assert.deepEqual(await createStatusFetcher("http://x", { fetch: fakeFetch(async () => ({ ok: false, status: 502 })) })(), { ok: false, error: "HTTP 502" });

  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.deepEqual(await createStatusFetcher("http://x", { fetch: fakeFetch(async () => { throw refused; }) })(), { ok: false, error: "ECONNREFUSED" });

  const slow = createStatusFetcher("http://x", {
    timeoutMs: 20,
    fetch: fakeFetch((url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))),
  });
  assert.deepEqual(await slow(), { ok: false, error: "timed out after 20 ms" });
});
