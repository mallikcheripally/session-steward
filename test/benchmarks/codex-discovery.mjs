import { performance } from "node:perf_hooks";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  appendLargeJsonlFixture,
  createCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const entryCount = 100_000;
const fixture = await createCodexHomeFixture();

try {
  await appendLargeJsonlFixture(fixture, { entryCount });
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const store = await getProvider("codex").loadSessionStore({
    codexHome: fixture.codexHome,
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  if (store.records.length !== 3) {
    throw new Error("Discovery measurement returned unexpected sessions.");
  }

  process.stdout.write(`${JSON.stringify({
    durationMs: Number(durationMs.toFixed(2)),
    heapChangeMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    historyEntries: entryCount + 5,
    indexedSessions: store.records.length,
    sessionIndexEntries: entryCount + 7,
  }, null, 2)}\n`);
} finally {
  await removeCodexHomeFixture(fixture.codexHome);
}
