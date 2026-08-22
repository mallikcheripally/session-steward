import fs from "node:fs/promises";

// A token count is a pure function of a transcript's bytes, so an unchanged
// file never needs reading twice — which matters most for a fork, whose parent
// is a whole extra file scanned only to find where the replay ends.
//
// Identity is dev+inode alongside size and mtime, mirroring
// `transcriptActivityCache` (`lib/providers/claude-code/store.mjs:39`): a path
// that has been replaced is a different file, not a stale entry. An active
// session's mtime moves on every write, so it re-reads rather than serving a
// count that has stopped growing.
// Two limits, because entries are not the same size. A session summary is about
// a kilobyte whatever the transcript weighed; a fork parent's signature
// recording is 16 bytes a turn, so 512 of those is a number with no ceiling.
// Counting entries bounds the bookkeeping, counting bytes bounds the memory.
const MAX_ENTRIES = 512;
const MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map();
let cachedBytes = 0;

export async function readFileStamp(filePath) {
  if (!filePath) return null;
  try {
    const stats = await fs.stat(filePath);
    return `${stats.dev ?? ""}:${stats.ino ?? ""}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

export function readCachedTokens(kind, filePath, stamp) {
  if (!stamp) return undefined;
  const entry = cache.get(`${kind} ${filePath}`);
  return entry?.stamp === stamp ? entry.value : undefined;
}

function evict(key) {
  const entry = cache.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  cache.delete(key);
}

export function writeCachedTokens(kind, filePath, stamp, value, bytes = 1024) {
  if (!stamp) return value;
  // An entry that cannot fit inside the budget would evict everything else and
  // then sit there alone. Reading it again is cheaper than that.
  if (bytes > MAX_BYTES) return value;

  const key = `${kind} ${filePath}`;
  evict(key);
  cache.set(key, { bytes, stamp, value });
  cachedBytes += bytes;

  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === key) break;
    evict(oldest);
  }

  return value;
}

// Two numbers a turn, in arrays V8 stores unboxed.
export function signatureBytes(signatures) {
  return signatures ? signatures.runningTotals.length * 16 : 0;
}

export function sessionTokenCacheStats() {
  return { bytes: cachedBytes, entries: cache.size, maxBytes: MAX_BYTES, maxEntries: MAX_ENTRIES };
}

export function clearSessionTokenCache() {
  cache.clear();
  cachedBytes = 0;
}
