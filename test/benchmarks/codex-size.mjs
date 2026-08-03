import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  attachSizedTranscripts,
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const sessionArgumentIndex = process.argv.indexOf("--sessions");

if (sessionArgumentIndex < 0) {
  const measurements = [5_000, 20_000].map((sessionCount) => {
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", fileURLToPath(import.meta.url), "--sessions", String(sessionCount)],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr || "Size benchmark failed.");
    return JSON.parse(result.stdout);
  });
  process.stdout.write(`${JSON.stringify(measurements, null, 2)}\n`);
} else {
  const sessionCount = Number(process.argv[sessionArgumentIndex + 1]);
  const fixture = await createLargeCodexHomeFixture({ sessionCount });

  try {
    await attachSizedTranscripts(fixture);
    const provider = getProvider("codex");
    provider.invalidateSessionCache({ codexHome: fixture.codexHome });
    global.gc?.();
    const peakRssBefore = process.resourceUsage().maxRSS * 1024;
    const coldStartedAt = performance.now();
    const cold = await provider.listSessions({
      codexHome: fixture.codexHome,
      includeInternals: true,
      includeSupporting: true,
      page: 1,
      pageSize: 25,
      sort: "size",
    });
    const coldBuildMs = performance.now() - coldStartedAt;
    global.gc?.();
    const warmStartedAt = performance.now();
    const warm = await provider.listSessions({
      codexHome: fixture.codexHome,
      includeInternals: true,
      includeSupporting: true,
      page: 2,
      pageSize: 25,
      sort: "size",
    });
    const warmPageMs = performance.now() - warmStartedAt;
    const peakRssBytes = process.resourceUsage().maxRSS * 1024;

    if (
      cold.total !== sessionCount + 3
      || cold.records.length !== 25
      || warm.records.length !== 25
    ) {
      throw new Error("Size measurement returned an unexpected session page.");
    }

    process.stdout.write(`${JSON.stringify({
      coldBuildMs: Number(coldBuildMs.toFixed(2)),
      peakRssGrowthMb: Number(((peakRssBytes - peakRssBefore) / 1024 / 1024).toFixed(2)),
      peakRssMb: Number((peakRssBytes / 1024 / 1024).toFixed(2)),
      sessions: cold.total,
      warmPageMs: Number(warmPageMs.toFixed(2)),
    })}\n`);
  } finally {
    await removeCodexHomeFixture(fixture.codexHome);
  }
}
