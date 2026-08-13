import { performance } from "node:perf_hooks";

import { getProvider } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const sessionCount = 10_000;
const fixture = await createClaudeHomeFixture({ extraSessions: sessionCount });

try {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = await getProvider("claude-code").listSessions({
    ...fixture,
    page: 1,
    pageSize: 25,
    sort: "updated",
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;

  if (result.records.length !== 25 || result.total !== sessionCount + 3) {
    throw new Error("Claude discovery measurement returned unexpected sessions.");
  }

  process.stdout.write(`${JSON.stringify({
    durationMs: Number(durationMs.toFixed(2)),
    heapChangeMb: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
    returnedSessions: result.records.length,
    sessions: result.total,
  }, null, 2)}\n`);
} finally {
  await removeClaudeHomeFixture(fixture);
}
