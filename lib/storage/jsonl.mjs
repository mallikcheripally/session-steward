import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { finished } from "node:stream/promises";

export const DEFAULT_JSONL_MAX_LINE_BYTES = 8 * 1024 * 1024;

const JSONL_READ_CHUNK_BYTES = 64 * 1024;
const JSONL_STARTING_LINE_BYTES = 4 * 1024;

function parseLine(raw, index) {
  try {
    return { index, parsed: JSON.parse(raw), raw };
  } catch {
    return { index, parsed: null, raw };
  }
}

export async function* readJsonlEntries(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ crlfDelay: Infinity, input });
  let index = 0;

  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      yield parseLine(line, index);
      index += 1;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
}

function appendLineBytes(state, bytes, maxLineBytes) {
  if (state.oversized || bytes.length === 0) return;

  if (state.length + bytes.length > maxLineBytes) {
    state.length = 0;
    state.oversized = true;
    return;
  }

  const requiredBytes = state.length + bytes.length;
  if (state.buffer.length < requiredBytes) {
    const capacity = Math.min(
      maxLineBytes,
      Math.max(requiredBytes, state.buffer.length * 2),
    );
    const buffer = Buffer.allocUnsafe(capacity);
    state.buffer.copy(buffer, 0, 0, state.length);
    state.buffer = buffer;
  }

  bytes.copy(state.buffer, state.length);
  state.length += bytes.length;
}

function createLineState(maxLineBytes) {
  return {
    buffer: Buffer.allocUnsafe(Math.min(JSONL_STARTING_LINE_BYTES, maxLineBytes)),
    length: 0,
    oversized: false,
  };
}

function resetLineState(state) {
  state.length = 0;
  state.oversized = false;
}

function snapshotEntry(state, index) {
  if (state.oversized) {
    return {
      index,
      oversized: true,
      parsed: null,
      raw: null,
    };
  }

  let bytes = state.buffer.subarray(0, state.length);
  if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
  if (bytes.length === 0) return null;

  const entry = parseLine(bytes.toString("utf8"), index);
  return {
    index: entry.index,
    oversized: false,
    parsed: entry.parsed,
    raw: entry.raw,
  };
}

export async function visitJsonlSnapshotEntries(
  filePath,
  visit,
  { maxLineBytes = DEFAULT_JSONL_MAX_LINE_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new TypeError("maxLineBytes must be a positive integer.");
  }

  const handle = await fs.open(filePath, "r");

  try {
    const { size: snapshotBytes } = await handle.stat();
    let complete = true;
    let index = 0;
    let offset = 0;
    const buffer = Buffer.allocUnsafe(Math.min(JSONL_READ_CHUNK_BYTES, Math.max(1, snapshotBytes)));
    const state = createLineState(maxLineBytes);
    let stoppedEarly = false;

    async function flushLine() {
      const entry = snapshotEntry(state, index);
      resetLineState(state);
      if (!entry) return true;
      index += 1;
      return (await visit(entry)) !== false;
    }

    while (offset < snapshotBytes) {
      const requestedBytes = Math.min(JSONL_READ_CHUNK_BYTES, snapshotBytes - offset);
      let bytesRead;

      try {
        ({ bytesRead } = await handle.read(buffer, 0, requestedBytes, offset));
      } catch (error) {
        if (error?.code === "ENOENT") {
          complete = false;
          break;
        }

        throw error;
      }

      if (bytesRead === 0) {
        complete = false;
        break;
      }

      offset += bytesRead;
      let start = 0;

      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        appendLineBytes(state, buffer.subarray(start, end), maxLineBytes);

        if (newline === -1 || newline >= bytesRead) break;

        if (!(await flushLine())) {
          stoppedEarly = true;
          break;
        }

        start = newline + 1;
      }

      if (stoppedEarly) break;
    }

    if (!stoppedEarly && (state.oversized || state.length > 0)) {
      if (!(await flushLine())) stoppedEarly = true;
    }

    return {
      complete: complete && !stoppedEarly,
      snapshotBytes,
      stoppedEarly,
    };
  } finally {
    await handle.close();
  }
}

export async function inspectJsonlMatches(filePath, matches, { sampleLimit = 100 } = {}) {
  let count = 0;
  const samples = [];

  for await (const entry of readJsonlEntries(filePath)) {
    if (!matches(entry)) continue;
    count += 1;

    if (samples.length < sampleLimit) {
      samples.push(entry);
    }
  }

  return { count, samples };
}

export async function rewriteJsonlFile(filePath, keep) {
  const fileStats = await fs.stat(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const output = createWriteStream(temporaryPath, {
    encoding: "utf8",
    mode: fileStats.mode,
  });
  let retainedCount = 0;
  let removedCount = 0;

  try {
    for await (const entry of readJsonlEntries(filePath)) {
      if (!keep(entry)) {
        removedCount += 1;
        continue;
      }

      retainedCount += 1;
      if (!output.write(`${entry.raw}\n`)) {
        await once(output, "drain");
      }
    }

    output.end();
    await finished(output);
    await fs.rename(temporaryPath, filePath);
    return { removedCount, retainedCount };
  } catch (error) {
    output.destroy();
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
