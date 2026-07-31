import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import readline from "node:readline";
import { finished } from "node:stream/promises";

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
