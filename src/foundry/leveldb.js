// A small, read-only LevelDB reader. Foundry VTT v11+ keeps world data (including
// the world settings, where the list of active modules lives) in LevelDB
// databases. Opening them with a LevelDB library is not an option while Foundry
// is running (the database is locked) and would pull a native dependency into
// the bot, so this file reads the on-disk files directly:
//
//   *.log  write-ahead log: 32 KiB blocks of records, each record a WriteBatch
//   *.ldb  sorted table files: data blocks (optionally Snappy-compressed), an
//          index block and a footer that says where the index block is
//
// Every entry carries a sequence number; for a key that occurs several times
// (in the log and in one or more tables) the highest sequence number is the
// current value, and a deletion with the highest sequence number means the key
// is gone. That rule is enough to read a consistent snapshot without touching
// MANIFEST, and it tolerates files that a compaction has not yet cleaned up.
// Nothing here writes anything.

import fs from "node:fs";
import path from "node:path";

const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const TABLE_FOOTER_SIZE = 48;
const TABLE_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]);
const TYPE_DELETION = 0;
const TYPE_VALUE = 1;

// --- varints ------------------------------------------------------------------------

/** Read a LEB128 varint (up to 64 bits, returned as a Number). Returns [value, nextOffset]. */
export function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("varint too long");
  }
  return [result, pos];
}

// --- Snappy -------------------------------------------------------------------------

/** Decompress a Snappy block (the raw format LevelDB uses, no framing). */
export function decodeSnappy(src) {
  let [length, pos] = readVarint(src, 0);
  const out = Buffer.allocUnsafe(length);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 0x03;
    let len;
    let offset;
    if (kind === 0) {
      len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59;
        if (pos + extra > src.length) throw new Error("snappy: truncated literal length");
        len = 0;
        for (let i = 0; i < extra; i++) len += src[pos + i] * 2 ** (8 * i);
        pos += extra;
      }
      len += 1;
      if (pos + len > src.length || op + len > length) throw new Error("snappy: literal overruns buffer");
      src.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
      continue;
    }
    if (kind === 1) {
      len = ((tag >>> 2) & 0x07) + 4;
      offset = ((tag >>> 5) << 8) | src[pos];
      pos += 1;
    } else if (kind === 2) {
      len = (tag >>> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      len = (tag >>> 2) + 1;
      offset = src.readUInt32LE(pos);
      pos += 4;
    }
    if (offset === 0 || offset > op || op + len > length) throw new Error("snappy: bad copy");
    // Copies may overlap their own output (run-length style), so copy byte by byte.
    for (let i = 0; i < len; i++) out[op + i] = out[op - offset + i];
    op += len;
  }
  if (op !== length) throw new Error("snappy: length mismatch");
  return out;
}

// --- write-ahead log -----------------------------------------------------------------

/**
 * Walk every entry in a .log file.
 * @param {Buffer} buf
 * @param {(entry: {key:Buffer, value:Buffer|null, seq:number, type:number}) => void} visit
 */
export function readLogFile(buf, visit) {
  let pos = 0;
  let pending = [];
  while (pos + LOG_HEADER_SIZE <= buf.length) {
    const inBlock = pos % LOG_BLOCK_SIZE;
    if (LOG_BLOCK_SIZE - inBlock < LOG_HEADER_SIZE) {
      pos += LOG_BLOCK_SIZE - inBlock; // trailer padding
      continue;
    }
    const length = buf.readUInt16LE(pos + 4);
    const type = buf[pos + 6];
    const start = pos + LOG_HEADER_SIZE;
    const end = start + length;
    if (end > buf.length) break; // torn write at the tail: stop here
    pos = end;
    if (type === 0 && length === 0) {
      // zero padding (pre-allocated space): the rest of this block is empty
      pos = (Math.floor((pos - 1) / LOG_BLOCK_SIZE) + 1) * LOG_BLOCK_SIZE;
      continue;
    }
    const fragment = buf.subarray(start, end);
    if (type === 1) {
      pending = [];
      readWriteBatch(fragment, visit);
    } else if (type === 2) {
      pending = [fragment];
    } else if (type === 3) {
      pending.push(fragment);
    } else if (type === 4) {
      pending.push(fragment);
      readWriteBatch(Buffer.concat(pending), visit);
      pending = [];
    } else {
      break; // unknown record type: corrupt tail
    }
  }
}

function readWriteBatch(buf, visit) {
  if (buf.length < 12) return;
  const seq = Number(buf.readBigUInt64LE(0));
  const count = buf.readUInt32LE(8);
  let pos = 12;
  for (let i = 0; i < count && pos < buf.length; i++) {
    const type = buf[pos++];
    let len;
    [len, pos] = readVarint(buf, pos);
    const key = buf.subarray(pos, pos + len);
    pos += len;
    let value = null;
    if (type === TYPE_VALUE) {
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (type !== TYPE_DELETION) {
      throw new Error(`unknown write batch entry type ${type}`);
    }
    visit({ key, value, seq: seq + i, type });
  }
}

// --- table files ---------------------------------------------------------------------

function readBlock(buf, offset, size) {
  if (offset + size + 5 > buf.length) throw new Error("block handle points outside the file");
  const data = buf.subarray(offset, offset + size);
  const compression = buf[offset + size];
  if (compression === 0) return data;
  if (compression === 1) return decodeSnappy(data);
  throw new Error(`unsupported block compression type ${compression}`);
}

/** Iterate the (key, value) entries of a block with prefix-compressed keys. */
function* blockEntries(block) {
  if (block.length < 4) return;
  const numRestarts = block.readUInt32LE(block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  if (end < 0) throw new Error("corrupt block restart array");
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < end) {
    let shared, nonShared, valueLength;
    [shared, pos] = readVarint(block, pos);
    [nonShared, pos] = readVarint(block, pos);
    [valueLength, pos] = readVarint(block, pos);
    if (shared > key.length || pos + nonShared + valueLength > block.length) throw new Error("corrupt block entry");
    key = Buffer.concat([key.subarray(0, shared), block.subarray(pos, pos + nonShared)]);
    pos += nonShared;
    const value = block.subarray(pos, pos + valueLength);
    pos += valueLength;
    yield [key, value];
  }
}

/**
 * Walk every entry in a .ldb/.sst file.
 * @param {Buffer} buf
 * @param {(entry: {key:Buffer, value:Buffer|null, seq:number, type:number}) => void} visit
 */
export function readTableFile(buf, visit) {
  if (buf.length < TABLE_FOOTER_SIZE) throw new Error("file too small to be a table");
  const footer = buf.subarray(buf.length - TABLE_FOOTER_SIZE);
  if (!footer.subarray(40).equals(TABLE_MAGIC)) throw new Error("not a LevelDB table file (bad magic)");
  let pos = 0;
  [, pos] = readVarint(footer, pos); // metaindex offset
  [, pos] = readVarint(footer, pos); // metaindex size
  let indexOffset, indexSize;
  [indexOffset, pos] = readVarint(footer, pos);
  [indexSize] = readVarint(footer, pos);
  const index = readBlock(buf, indexOffset, indexSize);
  for (const [, handle] of blockEntries(index)) {
    let offset, size;
    [offset, pos] = readVarint(handle, 0);
    [size] = readVarint(handle, pos);
    for (const [internalKey, value] of blockEntries(readBlock(buf, offset, size))) {
      if (internalKey.length < 8) throw new Error("internal key too short");
      const key = internalKey.subarray(0, internalKey.length - 8);
      const low = internalKey.readUInt32LE(internalKey.length - 8);
      const high = internalKey.readUInt32LE(internalKey.length - 4);
      const type = low & 0xff;
      const seq = high * 2 ** 24 + (low >>> 8);
      visit({ key, value: type === TYPE_VALUE ? value : null, seq, type });
    }
  }
}

// --- the database ---------------------------------------------------------------------

/**
 * Read the current contents of a LevelDB directory.
 * @param {string} dir
 * @param {{ keyPrefix?: string, log?: {warn:Function} }} [options]  keyPrefix: only keep keys starting with it
 * @returns {Map<string, Buffer>} key (utf8) -> value
 */
export function readLevelDb(dir, { keyPrefix, log } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return new Map();
    throw err;
  }
  const latest = new Map(); // key -> { seq, value }
  const prefix = keyPrefix ? Buffer.from(keyPrefix, "utf8") : null;
  const visit = ({ key, value, seq, type }) => {
    if (prefix && (key.length < prefix.length || !key.subarray(0, prefix.length).equals(prefix))) return;
    const k = key.toString("utf8");
    const have = latest.get(k);
    if (have && have.seq >= seq) return;
    latest.set(k, { seq, value: type === TYPE_VALUE ? Buffer.from(value) : null });
  };
  for (const name of names) {
    const isTable = /\.(ldb|sst)$/i.test(name);
    const isLog = /\.log$/i.test(name);
    if (!isTable && !isLog) continue;
    const file = path.join(dir, name);
    try {
      const buf = fs.readFileSync(file);
      if (isTable) readTableFile(buf, visit);
      else readLogFile(buf, visit);
    } catch (err) {
      // A file may vanish or be half-written while Foundry compacts; report and carry on.
      if (err.code !== "ENOENT") log?.warn?.(`could not read ${file}: ${err.message ?? err}`);
    }
  }
  const out = new Map();
  for (const [k, { value }] of latest) if (value !== null) out.set(k, value);
  return out;
}

/** Is this directory a LevelDB database (as far as we can tell without opening it)? */
export function looksLikeLevelDb(dir) {
  try {
    return fs.existsSync(path.join(dir, "CURRENT")) || fs.readdirSync(dir).some((n) => /\.(ldb|sst|log)$/i.test(n) || /^MANIFEST-/.test(n));
  } catch {
    return false;
  }
}
