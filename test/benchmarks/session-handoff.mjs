import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createSessionHandoff } from "../../lib/session-handoff.mjs";
import { createHandoffCatalog } from "../../lib/handoff-catalog.mjs";
import { createCodexHomeFixture, fixtureSessionIds } from "../fixtures/codex-home.mjs";

const me = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
if (process.argv[2] === "--measure") {
  const codexHome = process.argv[3];
  const catalog = await createHandoffCatalog({ dataDirectory: path.join(codexHome, "benchmark-catalog") });
  global.gc?.();
  const baselineRssMiB = process.resourceUsage().maxRSS / 1024;
  const baselineHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await createSessionHandoff({ providerId: "codex", providerHome: codexHome, id: fixtureSessionIds.parent, target: "claude", catalog });
  const exportDurationMs = performance.now() - started;
  const reuseStarted = performance.now();
  const reused = await createSessionHandoff({ providerId: "codex", providerHome: codexHome, id: fixtureSessionIds.parent, target: "claude", catalog });
  const reuseDurationMs = performance.now() - reuseStarted;
  assert.equal(reused.reused, true); assert.equal(reused.directory, result.directory);
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  global.gc?.();
  const retainedHeapMiB = (process.memoryUsage().heapUsed - baselineHeap) / 1024 / 1024;
  const startBytes = (await fs.stat(result.startPath)).size;
  assert.equal(result.partial, false);
  assert.ok(startBytes < 8192);
  console.log(JSON.stringify({ durationMs: +exportDurationMs.toFixed(2), reuseDurationMs: +reuseDurationMs.toFixed(2), baselineRssMiB, peakRssMiB, increaseRssMiB: peakRssMiB - baselineRssMiB, retainedHeapMiB, events: result.eventCount, chunks: result.chunkCount, startBytes }));
  catalog.close();
  assert.ok(peakRssMiB < 256, "export worker must stay below 256 MiB peak RSS");
  assert.ok(retainedHeapMiB < 16, "archive contents and index pages must not be retained after export");
} else {
  const measurements = [];
  for (const size of [32, 256]) {
    const fixture = await createCodexHomeFixture();
    try {
      const handle = await fs.open(fixture.transcripts.parent, "a");
      await handle.write(JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Preserve this early request while exporting the entire archive." }] } }) + "\n");
      let bytes = 0; let event = 0;
      while (bytes < size * 1024 * 1024) {
        const batch = Array.from({ length: 64 }, () => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Event ${event++}: ${"Synthetic history with Unicode 東京 🙂. ".repeat(100)}` }] } }) + "\n").join("");
        await handle.write(batch); bytes += Buffer.byteLength(batch);
      }
      await handle.close();
      const { stdout } = await execute(process.execPath, ["--expose-gc", me, "--measure", fixture.codexHome], { maxBuffer: 1024 * 1024 });
      const result = { sourceBytes: bytes, ...JSON.parse(stdout) };
      assert.equal(result.events, event + 1);
      measurements.push(result);
    } finally { await fs.rm(fixture.codexHome, { recursive: true, force: true }); }
  }
  assert.ok(measurements[1].peakRssMiB - measurements[0].peakRssMiB < 64);
  console.log(JSON.stringify(measurements, null, 2));
}
