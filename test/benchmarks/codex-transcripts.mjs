import { performance } from "node:perf_hooks";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  appendTranscriptOnlySessions,
  createCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const fixture = await createCodexHomeFixture();
const transcriptOnly = await appendTranscriptOnlySessions(fixture, {
  sessionCount: 5_000,
});

try {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const store = await getProvider("codex").loadSessionStore({
    codexHome: fixture.codexHome,
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  if (store.records.length !== transcriptOnly.sessionCount + 3) {
    throw new Error("Transcript measurement did not discover every session.");
  }

  process.stdout.write(`${JSON.stringify({
    discoveredSessions: store.records.length,
    durationMs: Number(durationMs.toFixed(2)),
    heapChangeMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    transcriptOnlySessions: transcriptOnly.sessionCount,
  }, null, 2)}\n`);
} finally {
  await removeCodexHomeFixture(fixture.codexHome);
}
