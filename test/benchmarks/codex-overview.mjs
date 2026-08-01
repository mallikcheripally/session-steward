import { performance } from "node:perf_hooks";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  appendTranscriptOnlySessions,
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const sessionCount = 50_000;
const transcriptOnlyCount = 5_000;
const fixture = await createLargeCodexHomeFixture({ sessionCount });

try {
  await appendTranscriptOnlySessions(fixture, { sessionCount: transcriptOnlyCount });
  const provider = getProvider("codex");

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const overview = await provider.getSessionOverview({ codexHome: fixture.codexHome });
  const filtered = await provider.listSessions({
    codexHome: fixture.codexHome,
    inactiveBeforeMs: Date.now(),
    includeInternals: true,
    includeSupporting: true,
    page: 1,
    pageSize: 25,
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  if (
    overview.sessionCount !== sessionCount + 3
    || overview.primarySessionCount !== sessionCount + 2
    || overview.transcriptFileCount !== transcriptOnlyCount + 3
    || filtered.records.length !== 25
  ) {
    throw new Error("Overview measurement returned unexpected session data.");
  }

  process.stdout.write(`${JSON.stringify({
    durationMs: Number(durationMs.toFixed(2)),
    heapChangeMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    sessions: overview.sessionCount,
    transcriptFiles: overview.transcriptFileCount,
    workspaces: overview.workspaces.length,
  }, null, 2)}\n`);
} finally {
  await removeCodexHomeFixture(fixture.codexHome);
}
