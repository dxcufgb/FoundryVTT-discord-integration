import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildConfig, DEFAULTS, parseEnv, PROJECT_ROOT, resolveEnvFile } from "../src/config.js";
import { tmpDir } from "./helpers.js";

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

test("buildConfig validates the Foundry website URL and defaults it", () => {
  assert.equal(buildConfig(minimal).foundry.websiteUrl, "https://foundryvtt.com");
  assert.equal(buildConfig({ ...minimal, FOUNDRY_WEBSITE_URL: "https://mirror.example/foundry/" }).foundry.websiteUrl, "https://mirror.example/foundry");
  assert.throws(() => buildConfig({ ...minimal, FOUNDRY_WEBSITE_URL: "ftp://x" }), /FOUNDRY_WEBSITE_URL/);
});

test("buildConfig errors never repeat the rejected values", () => {
  assert.throws(
    () => buildConfig({ ...minimal, FOUNDRY_URL: "ftp://user:hunter2@host", FOUNDRY_WEBSITE_URL: "ftp://other:hunter3@host", POLL_INTERVAL_SECONDS: "hunter4", TIMEZONE: "hunter5", LOG_LEVEL: "hunter6" }),
    (err) => {
      assert.ok(err.problems.length >= 5);
      assert.ok(!/hunter\d/.test(err.message), err.message);
      return true;
    },
  );
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

test("resolveEnvFile prefers --env, then the environment variable, then the local file, then ProgramData on Windows", () => {
  const local = path.join(PROJECT_ROOT, ".env");
  assert.equal(resolveEnvFile(["node", "x", "--env", "/tmp/custom.env"], {}, "linux"), path.resolve("/tmp/custom.env"));
  assert.equal(resolveEnvFile(["node", "x"], { FOUNDRY_DISCORD_ENV_FILE: "/tmp/from-env" }, "linux"), path.resolve("/tmp/from-env"));
  assert.equal(resolveEnvFile(["node", "x"], {}, "linux"), local);

  const programData = tmpDir();
  assert.equal(resolveEnvFile(["node", "x"], { ProgramData: programData }, "win32"), local, "no shared file yet");
  if (!fs.existsSync(local)) {
    const shared = path.join(programData, "FoundryVTT Discord integration", ".env");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, "DISCORD_TOKEN=x\n");
    assert.equal(resolveEnvFile(["node", "x"], { ProgramData: programData }, "win32"), shared);
    assert.equal(resolveEnvFile(["node", "x"], { ProgramData: programData }, "linux"), local, "ProgramData is Windows only");
  }
});

test("a relative BOT_DATA_DIR is resolved against the .env file's folder", () => {
  const c = buildConfig({ ...minimal, BOT_DATA_DIR: "data" }, { baseDir: "/srv/bot-config" });
  assert.equal(c.botDataDir, path.resolve("/srv/bot-config", "data"));
  assert.equal(buildConfig({ ...minimal, BOT_DATA_DIR: "/var/lib/bot" }).botDataDir, path.resolve("/var/lib/bot"));
});
