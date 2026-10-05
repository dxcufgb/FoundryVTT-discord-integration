import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSnappy, looksLikeLevelDb, readLevelDb, readLogFile, readTableFile, readVarint } from "../src/foundry/leveldb.js";
import { tmpDir } from "./helpers.js";

// The fixtures were written by classic-level (the library Foundry uses) with
// scripts/make-leveldb-fixtures.js and mimic a world's data/settings database.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "leveldb");

const moduleConfiguration = (db) => {
  for (const value of db.values()) {
    const doc = JSON.parse(value.toString("utf8"));
    if (doc.key === "core.moduleConfiguration") return JSON.parse(doc.value);
  }
  return null;
};

test("readVarint and decodeSnappy", () => {
  assert.deepEqual(readVarint(Buffer.from([0x05]), 0), [5, 1]);
  assert.deepEqual(readVarint(Buffer.from([0xe7, 0x06]), 0), [871, 2]);
  assert.deepEqual(readVarint(Buffer.from([0x00, 0x80, 0x01]), 1), [128, 3]);
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /truncated/);

  // "abcabcabcabc": literal "abc" then a copy of length 9 at offset 3 (tag 0b10 with 2-byte offset)
  const compressed = Buffer.from([12, 0x08, 0x61, 0x62, 0x63, (8 << 2) | 2, 3, 0]);
  assert.equal(decodeSnappy(compressed).toString(), "abcabcabcabc");
  // 1-byte offset copy: tag kind 1, length 4..11, offset 11 bits
  const c2 = Buffer.from([8, 0x0c, 0x61, 0x62, 0x63, 0x64, ((4 - 4) << 2) | 1, 4]);
  assert.equal(decodeSnappy(c2).toString(), "abcdabcd");
  // long literal (length byte follows)
  const long = Buffer.alloc(70, 0x78);
  const c3 = Buffer.concat([Buffer.from([70, 60 << 2, 69]), long]);
  assert.equal(decodeSnappy(c3).toString(), "x".repeat(70));
  assert.throws(() => decodeSnappy(Buffer.from([5, (8 << 2) | 2, 9, 0])), /bad copy/);
});

test("reads a database that only has a write-ahead log (overwrite and deletion inside the log)", () => {
  const db = readLevelDb(path.join(FIXTURES, "settings-log"));
  assert.deepEqual([...db.keys()].sort(), ["!settings!aaaaaaaaaaaaaaaa", "!settings!bbbbbbbbbbbbbbbb", "!settings!cccccccccccccccc"]);
  assert.deepEqual(moduleConfiguration(db), { "lib-wrapper": true, "dice-so-nice": true, "tidy5e-sheet": true }, "the later write wins");
  assert.equal(db.has("!settings!dddddddddddddddd"), false, "deleted key is gone");
});

test("reads Snappy-compressed table files with several blocks, and the log overrides the table", () => {
  const db = readLevelDb(path.join(FIXTURES, "settings-ldb"));
  assert.equal(db.size, 402);
  assert.deepEqual(moduleConfiguration(db), { "lib-wrapper": true, "old-module": false, "dice-so-nice": true, "new-module": true });
  assert.equal(db.has("!settings!bbbbbbbbbbbbbbbb"), false, "deletion in the log hides the table entry");
  assert.equal(JSON.parse(db.get("!settings!0000000000000399").toString()).key, "some-module.setting399");

  const filtered = readLevelDb(path.join(FIXTURES, "settings-ldb"), { keyPrefix: "!settings!a" });
  assert.deepEqual([...filtered.keys()], ["!settings!aaaaaaaaaaaaaaaa"]);
});

test("reads a fully compacted table (overwrite and tombstone inside the table)", () => {
  const db = readLevelDb(path.join(FIXTURES, "settings-ldb-only"));
  assert.deepEqual([...db.keys()], ["!settings!aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(moduleConfiguration(db), { "lib-wrapper": true, "monks-tokenbar": true });
});

test("low-level readers see every entry with sequence numbers and types", () => {
  const entries = [];
  readTableFile(fs.readFileSync(path.join(FIXTURES, "settings-ldb-only", "000005.ldb")), (e) => entries.push(e));
  assert.deepEqual(
    entries.map((e) => [e.key.toString(), e.type, e.value === null]),
    [["!settings!aaaaaaaaaaaaaaaa", 1, false], ["!settings!aaaaaaaaaaaaaaaa", 1, false], ["!settings!bbbbbbbbbbbbbbbb", 0, true], ["!settings!bbbbbbbbbbbbbbbb", 1, false]],
    "newest first within a key; the deletion is a tombstone",
  );
  assert.ok(entries[0].seq > entries[1].seq);

  const logEntries = [];
  readLogFile(fs.readFileSync(path.join(FIXTURES, "settings-log", "000003.log")), (e) => logEntries.push(e));
  assert.deepEqual(logEntries.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(logEntries[5].type, 0);
});

test("missing, empty and foreign directories are handled", () => {
  assert.equal(readLevelDb(path.join(FIXTURES, "nope")).size, 0);
  const empty = tmpDir();
  assert.equal(readLevelDb(empty).size, 0);
  assert.equal(looksLikeLevelDb(empty), false);
  assert.equal(looksLikeLevelDb(path.join(FIXTURES, "settings-log")), true);
  fs.writeFileSync(path.join(empty, "000001.ldb"), "this is not a table file at all, just some text that is long enough to have a footer");
  const warnings = [];
  assert.equal(readLevelDb(empty, { log: { warn: (m) => warnings.push(m) } }).size, 0);
  assert.match(warnings[0], /bad magic/);
});
