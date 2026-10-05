// Regenerates the LevelDB fixtures under test/fixtures/leveldb, shaped like a
// world's data/settings database in Foundry v11+. Needs classic-level (the
// LevelDB binding Foundry itself uses), which is deliberately not a dependency
// of the bot, so run it from a scratch folder:
//
//   mkdir /tmp/ldb && cd /tmp/ldb && npm init -y && npm install classic-level
//   NODE_PATH=/tmp/ldb/node_modules node scripts/make-leveldb-fixtures.js test/fixtures/leveldb
//
// Afterwards delete the LOCK and LOG files; they carry nothing the reader needs.
import { createRequire } from "node:module";
const { ClassicLevel } = createRequire(import.meta.url)(process.env.CLASSIC_LEVEL ?? "classic-level");
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/make-leveldb-fixtures.js <output folder>");
  process.exit(2);
}
fs.rmSync(out, { recursive: true, force: true });

const setting = (id, key, value, extra = {}) => [`!settings!${id}`, { key, value: JSON.stringify(value), _id: id, _stats: { systemId: "dnd5e", systemVersion: "5.1.0", coreVersion: "13.346", createdTime: 1700000000000, modifiedTime: 1700000001000, lastModifiedBy: "aaaaaaaaaaaaaaaa" }, ...extra }];

// Fixture 1: log only (a freshly written DB that was never compacted)
{
  const db = new ClassicLevel(path.join(out, "settings-log"), { keyEncoding: "utf8", valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  for (const [k, v] of [
    setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": true, "dice-so-nice": false, "tidy5e-sheet": true }),
    setting("bbbbbbbbbbbbbbbb", "core.time", 0),
    setting("cccccccccccccccc", "core.combatTrackerConfig", { resource: "attributes.hp" }),
  ]) batch.put(k, v);
  await batch.write();
  // an overwrite in the same log: the later value must win
  await db.put(...setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": true, "dice-so-nice": true, "tidy5e-sheet": true }));
  await db.put(...setting("dddddddddddddddd", "core.rollMode", "publicroll"));
  await db.del("!settings!dddddddddddddddd");
  await db.close();
}

// Fixture 2: compacted into .ldb table files (snappy, several blocks), then more writes in the log.
{
  const db = new ClassicLevel(path.join(out, "settings-ldb"), { keyEncoding: "utf8", valueEncoding: "json" });
  await db.open();
  const batch = db.batch();
  batch.put(...setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": true, "old-module": true, "dice-so-nice": true }));
  batch.put(...setting("bbbbbbbbbbbbbbbb", "core.time", 12345));
  batch.put(...setting("eeeeeeeeeeeeeeee", "core.sheetClasses", { Actor: { character: "dnd5e.ActorSheet5eCharacter" } }));
  for (let i = 0; i < 400; i++) {
    const id = String(i).padStart(16, "0");
    batch.put(...setting(id, `some-module.setting${i}`, { index: i, text: "lorem ipsum dolor sit amet ".repeat(8) }));
  }
  await batch.write();
  await db.compactRange("!", "~");
  // After compaction: a newer moduleConfiguration lands in the log and must win over the table file.
  await db.put(...setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": true, "old-module": false, "dice-so-nice": true, "new-module": true }));
  await db.del("!settings!bbbbbbbbbbbbbbbb");
  await db.close();
}

// Fixture 3: everything compacted, including a deletion tombstone and overwrite inside the table.
{
  const db = new ClassicLevel(path.join(out, "settings-ldb-only"), { keyEncoding: "utf8", valueEncoding: "json" });
  await db.open();
  await db.put(...setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": false }));
  await db.put(...setting("bbbbbbbbbbbbbbbb", "core.time", 1));
  await db.put(...setting("aaaaaaaaaaaaaaaa", "core.moduleConfiguration", { "lib-wrapper": true, "monks-tokenbar": true }));
  await db.del("!settings!bbbbbbbbbbbbbbbb");
  await db.compactRange("!", "~");
  await db.close();
}
console.log("done");
for (const d of fs.readdirSync(out)) console.log(d, fs.readdirSync(path.join(out, d)).map((f) => `${f}(${fs.statSync(path.join(out, d, f)).size})`).join(" "));
