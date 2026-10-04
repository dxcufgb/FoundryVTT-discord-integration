import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, diffPackages, notifiedKey, packageKey, removedKey } from "../src/foundry/updates.js";

const mod = (id, version, type = "module") => ({ type, id, title: id.toUpperCase(), version });

test("keys", () => {
  assert.equal(packageKey(mod("a", "1")), "module:a");
  assert.equal(notifiedKey(mod("a", "1.2.3")), "module:a@1.2.3");
  assert.equal(notifiedKey(mod("a", null)), "module:a@unknown");
  assert.equal(removedKey(mod("a", "1")), "module:a@removed");
});

test("diffPackages finds updates, installs and removals", () => {
  const previous = { "module:a": mod("a", "1.0.0"), "module:b": mod("b", "2.0.0"), "system:dnd5e": mod("dnd5e", "5.0.0", "system") };
  const current = [mod("a", "1.1.0"), mod("c", "0.1.0"), mod("dnd5e", "5.0.0", "system")];
  const diff = diffPackages(previous, current);
  assert.deepEqual(diff.updated.map((p) => [p.id, p.previousVersion, p.version]), [["a", "1.0.0", "1.1.0"]]);
  assert.deepEqual(diff.installed.map((p) => p.id), ["c"]);
  assert.deepEqual(diff.removed.map((p) => p.id), ["b"]);
  assert.deepEqual(Object.keys(diff.snapshot).sort(), ["module:a", "module:c", "system:dnd5e"]);
  assert.equal(diff.snapshot["module:a"].version, "1.1.0");
});

test("diffPackages treats a downgrade as an update too and ignores unchanged", () => {
  const diff = diffPackages({ "module:a": mod("a", "2.0.0") }, [mod("a", "1.9.0")]);
  assert.equal(diff.updated.length, 1);
  assert.equal(diffPackages({ "module:a": mod("a", "2.0.0") }, [mod("a", "2.0.0")]).updated.length, 0);
});

test("compareVersions", () => {
  assert.equal(compareVersions("13.346", "13.345"), 1);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-alpha"), 1);
  assert.equal(compareVersions("2", "10"), -1);
});
