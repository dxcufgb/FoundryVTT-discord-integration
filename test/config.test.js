import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, DEFAULTS, parseEnv } from "../src/config.js";

const minimal = { DISCORD_TOKEN: "t", DISCORD_CLIENT_ID: "1" };

test("parseEnv handles comments, quotes, blank lines and export prefix", () => {
  const env = parseEnv(`
# comment
DISCORD_TOKEN="abc def"
export FOUNDRY_URL=http://localhost:30000 # trailing comment
EMPTY=
SINGLE='x'
NOEQUALS
`);
  assert.deepEqual(env, { DISCORD_TOKEN: "abc def", FOUNDRY_URL: "http://localhost:30000", EMPTY: "", SINGLE: "x" });
});

test("buildConfig applies defaults", () => {
  const c = buildConfig(minimal);
  assert.equal(c.foundry.url, DEFAULTS.FOUNDRY_URL);
  assert.equal(c.pollIntervalSeconds, DEFAULTS.POLL_INTERVAL_SECONDS);
  assert.equal(c.downAfterFailures, DEFAULTS.DOWN_AFTER_FAILURES);
  assert.equal(c.timezone, "UTC");
  assert.equal(c.logLevel, "info");
  assert.equal(c.foundry.dataPath, undefined);
});

test("buildConfig strips trailing slashes from the Foundry URL", () => {
  assert.equal(buildConfig({ ...minimal, FOUNDRY_URL: "http://foundry:30000/" }).foundry.url, "http://foundry:30000");
});

test("buildConfig reports all problems at once", () => {
  assert.throws(
    () => buildConfig({ FOUNDRY_URL: "nope", TIMEZONE: "Mars/Olympus", POLL_INTERVAL_SECONDS: "abc", LOG_LEVEL: "loud" }),
    (err) => {
      assert.ok(err.problems.some((p) => p.includes("DISCORD_TOKEN")));
      assert.ok(err.problems.some((p) => p.includes("DISCORD_CLIENT_ID")));
      assert.ok(err.problems.some((p) => p.includes("FOUNDRY_URL")));
      assert.ok(err.problems.some((p) => p.includes("TIMEZONE")));
      assert.ok(err.problems.some((p) => p.includes("POLL_INTERVAL_SECONDS")));
      assert.ok(err.problems.some((p) => p.includes("LOG_LEVEL")));
      return true;
    },
  );
});

test("buildConfig rejects a poll interval under 5 seconds", () => {
  assert.throws(() => buildConfig({ ...minimal, POLL_INTERVAL_SECONDS: "2" }), /at least 5/);
});

test("buildConfig can skip the Discord requirement for offline tools", () => {
  const c = buildConfig({}, { requireDiscord: false });
  assert.equal(c.discord.token, undefined);
});
