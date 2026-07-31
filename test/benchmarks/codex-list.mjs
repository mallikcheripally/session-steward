import { performance } from "node:perf_hooks";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const sessionCount = 50_000;
const fixture = await createLargeCodexHomeFixture({ sessionCount });

try {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = await getProvider("codex").listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    page: 1,
    pageSize: 25,
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  if (result.total !== sessionCount + 3 || result.records.length !== 25) {
    throw new Error("Scale measurement returned an unexpected session page.");
  }

  process.stdout.write(`${JSON.stringify({
    durationMs: Number(durationMs.toFixed(2)),
    heapChangeMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    pageSize: result.records.length,
    sessions: result.total,
  }, null, 2)}\n`);
} finally {
  await removeCodexHomeFixture(fixture.codexHome);
}
