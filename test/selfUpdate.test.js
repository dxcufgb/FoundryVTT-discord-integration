import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareSemver, evaluateRelease, headersFor, parseChecksums, parseVersion, runUpdate, selectAssets } from "../src/selfUpdate.js";
import { tmpDir } from "./helpers.js";

const quiet = { info() {}, warn() {} };

test("parseVersion accepts semantic versions with or without v", () => {
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, pre: [], version: "1.2.3" });
  assert.deepEqual(parseVersion("1.2.3-beta.1+build.5").pre, ["beta", "1"]);
  assert.equal(parseVersion("1.2.3-beta.1+build.5").version, "1.2.3-beta.1");
  for (const bad of ["1.2", "01.2.3", "v1.2.3.4", "latest", "", null, "1.2.3-"]) assert.equal(parseVersion(bad), null, String(bad));
});

test("compareSemver follows semver precedence, not string order", () => {
  assert.equal(compareSemver("1.10.0", "1.9.9"), 1);
  assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.2.3+a", "1.2.3+b"), 0);
  assert.equal(compareSemver("2.0.0", "10.0.0"), -1);
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareSemver(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareSemver(ordered[i + 1], ordered[i]), 1);
  }
  assert.throws(() => compareSemver("1.2", "1.2.0"), /Not a semantic version/);
});

test("evaluateRelease only upgrades to a strictly newer full release", () => {
  assert.equal(evaluateRelease({ tag_name: "v1.3.0" }, "1.2.9").status, "update");
  assert.equal(evaluateRelease({ tag_name: "v1.2.9" }, "1.2.9").status, "current");
  assert.equal(evaluateRelease({ tag_name: "v1.2.8" }, "1.2.9").status, "newer-installed");
  assert.equal(evaluateRelease({ tag_name: "v1.2.9" }, "1.2.9-beta.1").status, "update");
  assert.throws(() => evaluateRelease({ tag_name: "v2.0.0", prerelease: true }, "1.0.0"), /pre-release/);
  assert.throws(() => evaluateRelease({ tag_name: "v2.0.0", draft: true }, "1.0.0"), /draft/);
  assert.throws(() => evaluateRelease({ tag_name: "v2.0.0-rc.1" }, "1.0.0"), /pre-release/);
  assert.throws(() => evaluateRelease({ tag_name: "nightly" }, "1.0.0"), /not a version/);
  assert.throws(() => evaluateRelease({ tag_name: "v2.0.0" }, "dev"), /installed version/);
});

test("parseChecksums reads sha256sum and Get-FileHash output, with directories, BOM and CRLF", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = parseChecksums(`﻿${a}  dist/foundryvtt-discord-integration-1.2.2-linux.tar.gz\r\n${b} *install.sh\r\nnot a line\n${"c".repeat(63)}  short.txt\n`);
  assert.equal(sums.get("foundryvtt-discord-integration-1.2.2-linux.tar.gz"), a);
  assert.equal(sums.get("install.sh"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

/** Build a GitHub release fixture with API and public download URLs for the named assets. */
const release = (version, names) => ({
  tag_name: `v${version}`,
  assets: names.map((name) => ({ name, url: `https://api.github.com/repos/o/r/releases/assets/${name}`, browser_download_url: `https://github.com/o/r/releases/download/v${version}/${name}` })),
});

test("selectAssets picks the platform's bundle and checksum file", () => {
  const r = release("1.3.0", ["foundryvtt-discord-integration-1.3.0-linux.tar.gz", "foundryvtt-discord-integration-1.3.0-windows.zip", "foundryvtt-discord-integration-1.3.0-setup.exe", "install.sh", "SHA256SUMS.txt", "SHA256SUMS-setup.txt"]);
  assert.equal(selectAssets(r, "linux").asset.name, "foundryvtt-discord-integration-1.3.0-linux.tar.gz");
  assert.equal(selectAssets(r, "linux").sums.name, "SHA256SUMS.txt");
  assert.equal(selectAssets(r, "windows-zip").asset.name, "foundryvtt-discord-integration-1.3.0-windows.zip");
  assert.equal(selectAssets(r, "windows-setup").sums.name, "SHA256SUMS-setup.txt");
  assert.match(selectAssets(release("1.3.0", ["foundryvtt-discord-integration-1.3.0-linux.tar.gz"]), "linux").error, /publishes no SHA256SUMS.txt/);
  assert.match(selectAssets(release("1.3.0", ["SHA256SUMS.txt"]), "linux").error, /has no foundryvtt-discord-integration-1.3.0-linux.tar.gz/);
  assert.throws(() => selectAssets(r, "mac"), /Unknown platform/);
});

test("headersFor sends the token to api.github.com only", () => {
  assert.equal(headersFor("https://api.github.com/repos/o/r/releases/latest", "tok").Authorization, "Bearer tok");
  assert.equal(headersFor("https://github.com/o/r/releases/download/v1/x", "tok").Authorization, undefined);
  assert.equal(headersFor("https://objects.githubusercontent.com/x?sig=1", "tok").Authorization, undefined);
  assert.equal(headersFor("https://api.github.com.evil.example/x", "tok").Authorization, undefined);
  assert.equal(headersFor("https://api.github.com/x", null).Authorization, undefined);
});

/** A fake GitHub: the API, a redirecting download URL and a pre-signed storage host. */
function fakeGithub({ version = "1.3.0", bundle = Buffer.from("bundle bytes"), sumsFor = bundle, extra = {} } = {}) {
  const name = `foundryvtt-discord-integration-${version}-linux.tar.gz`;
  const hash = crypto.createHash("sha256").update(sumsFor).digest("hex");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect });
    if (extra[url]) return extra[url]();
    if (url === "https://api.github.com/repos/o/r/releases/latest") return Response.json({ ...release(version, [name, "SHA256SUMS.txt"]), html_url: "https://github.com/o/r/releases/v" + version });
    const asset = /\/(?:releases\/download\/v[^/]+|releases\/assets)\/(.+)$/.exec(url)?.[1];
    if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.example/${asset}?X-Amz-Signature=abc` } });
    if (url === `https://objects.example/${name}?X-Amz-Signature=abc`) return new Response(bundle);
    if (url === "https://objects.example/SHA256SUMS.txt?X-Amz-Signature=abc") return new Response(`${hash}  dist/${name}\n`);
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, name };
}

/** Create a temporary installation containing a package.json with the requested version. */
function installDir(version) {
  const dir = tmpDir("fvtt-selfupdate-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

test("runUpdate downloads and verifies a newer bundle; the token never leaves api.github.com", async () => {
  const gh = fakeGithub();
  const out = tmpDir();
  const r = await runUpdate({ dir: installDir("1.2.2"), platform: "linux", outDir: out, repo: "o/r", token: "secret", fetchImpl: gh.fetchImpl, log: quiet });
  assert.equal(r.status, "update");
  assert.equal(r.latest, "1.3.0");
  assert.equal(r.file, path.join(out, gh.name));
  assert.equal(fs.readFileSync(r.file, "utf8"), "bundle bytes");
  assert.deepEqual(JSON.parse(fs.readFileSync(r.notice, "utf8")), { version: "1.3.0", tag: "v1.3.0", name: "v1.3.0", body: "", html_url: "https://github.com/o/r/releases/v1.3.0" });
  assert.ok(gh.calls.every((c) => c.redirect === "manual"));
  for (const c of gh.calls) assert.equal(c.auth !== null, new URL(c.url).host === "api.github.com", c.url);
  assert.ok(gh.calls.some((c) => c.url.startsWith("https://api.github.com/repos/o/r/releases/assets/")), "with a token, assets go through the API");
});

test("runUpdate without a token uses the public download URLs", async () => {
  const gh = fakeGithub();
  await runUpdate({ dir: installDir("1.2.2"), platform: "linux", outDir: tmpDir(), repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet });
  assert.ok(gh.calls.every((c) => c.auth === null));
  assert.ok(gh.calls.some((c) => c.url.startsWith("https://github.com/o/r/releases/download/")));
});

test("runUpdate does nothing when up to date, and check mode downloads nothing", async () => {
  const gh = fakeGithub({ version: "1.2.2" });
  const out = tmpDir();
  assert.equal((await runUpdate({ dir: installDir("1.2.2"), platform: "linux", outDir: out, repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet })).status, "current");
  assert.equal((await runUpdate({ dir: installDir("1.3.0"), platform: "linux", outDir: out, repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet })).status, "newer-installed");
  const check = await runUpdate({ dir: installDir("1.0.0"), platform: "linux", outDir: out, checkOnly: true, repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet });
  assert.equal(check.status, "update");
  assert.equal(check.file, undefined);
  assert.equal(gh.calls.length, 3);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("runUpdate rejects a checksum mismatch and removes the download", async () => {
  const gh = fakeGithub({ sumsFor: Buffer.from("something else") });
  const out = tmpDir();
  await assert.rejects(runUpdate({ dir: installDir("1.2.2"), platform: "linux", outDir: out, repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet }), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(out), []);
});

test("runUpdate refuses redirects to plain HTTP", async () => {
  const gh = fakeGithub({ extra: { "https://github.com/o/r/releases/download/v1.3.0/SHA256SUMS.txt": async () => new Response(null, { status: 302, headers: { location: "http://objects.example/SHA256SUMS.txt" } }) } });
  await assert.rejects(runUpdate({ dir: installDir("1.2.2"), platform: "linux", outDir: tmpDir(), repo: "o/r", fetchImpl: gh.fetchImpl, log: quiet }), /non-HTTPS/);
});

test("runUpdate reports GitHub errors (rate limit) and invalid repositories", async () => {
  const fetchImpl = async () => Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  await assert.rejects(runUpdate({ dir: installDir("1.0.0"), platform: "linux", outDir: tmpDir(), repo: "o/r", fetchImpl, log: quiet }), /HTTP 403 from api.github.com: API rate limit exceeded/);
  await assert.rejects(runUpdate({ dir: installDir("1.0.0"), platform: "linux", outDir: tmpDir(), repo: "../x", fetchImpl, log: quiet }), /invalid repository/);
});
