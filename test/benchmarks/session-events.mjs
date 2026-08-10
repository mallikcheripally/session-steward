import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getProvider } from "../../lib/providers/index.mjs";
import { SESSION_EVENT_READ_MODE } from "../../lib/session-events.mjs";
import {
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const executeFile = promisify(execFile);
const mebibyte = 1024 * 1024;
const scriptPath = fileURLToPath(import.meta.url);

async function measure({ codexHome, id, limit, mode }) {
  global.gc?.();
  const baselinePeakRssMb = process.resourceUsage().maxRSS / 1024;
  const startedAt = performance.now();
  const result = await getProvider("codex").readSessionEvents({
    codexHome,
    id,
    limit,
    mode,
  });
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  const peakRssMb = process.resourceUsage().maxRSS / 1024;

  return {
    baselinePeakRssMb: Number(baselinePeakRssMb.toFixed(2)),
    coverage: result.coverage,
    durationMs: Number(durationMs.toFixed(2)),
    events: result.events.length,
    peakRssMb: Number(peakRssMb.toFixed(2)),
    rssIncreaseMb: Number((peakRssMb - baselinePeakRssMb).toFixed(2)),
    window: result.window,
  };
}

async function runMeasurement({ codexHome, id, limit, mode }) {
  const { stdout } = await executeFile(
    process.execPath,
    [
      "--expose-gc",
      scriptPath,
      "--measure",
      codexHome,
      id,
      mode,
      String(limit),
    ],
    { maxBuffer: mebibyte },
  );
  return JSON.parse(stdout);
}

async function writeSyntheticTranscript(filePath, targetBytes, fixture) {
  const header = Buffer.from(`${JSON.stringify({
    payload: {
      cwd: fixture.workspace,
      id: fixtureSessionIds.parent,
      originator: "codex-cli",
    },
    type: "session_meta",
  })}\n`);
  const event = Buffer.from(`${JSON.stringify({
    payload: {
      arguments: "{\"plan\":[]}",
      call_id: "benchmark-plan",
      name: "update_plan",
      padding: "x".repeat(3_500),
      type: "function_call",
    },
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "response_item",
  })}\n`);
  const eventsPerBatch = 256;
  const batch = Buffer.from(event.toString().repeat(eventsPerBatch));
  const handle = await fs.open(filePath, "w");
  let bytesWritten = 0;

  try {
    await handle.write(header);
    bytesWritten += header.length;

    while (bytesWritten + batch.length <= targetBytes) {
      await handle.write(batch);
      bytesWritten += batch.length;
    }

    while (bytesWritten + event.length <= targetBytes) {
      await handle.write(event);
      bytesWritten += event.length;
    }
  } finally {
    await handle.close();
  }

  return bytesWritten;
}

if (process.argv[2] === "--measure") {
  const [, , , codexHome, id, mode, limit] = process.argv;
  process.stdout.write(`${JSON.stringify(await measure({
    codexHome,
    id,
    limit: Number(limit),
    mode,
  }))}\n`);
} else {
  const fixture = await createCodexHomeFixture();

  try {
    const smallBytes = await writeSyntheticTranscript(
      fixture.transcripts.parent,
      27 * mebibyte,
      fixture,
    );
    const small = await runMeasurement({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
      limit: 200,
      mode: SESSION_EVENT_READ_MODE.RECENT,
    });
    small.bytes = smallBytes;
    small.throughputMbPerSecond = Number((
      smallBytes / mebibyte / (small.durationMs / 1_000)
    ).toFixed(2));

    const largeBytes = await writeSyntheticTranscript(
      fixture.transcripts.parent,
      600 * mebibyte,
      fixture,
    );
    const large = await runMeasurement({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
      limit: 200,
      mode: SESSION_EVENT_READ_MODE.RECENT,
    });
    large.bytes = largeBytes;
    large.throughputMbPerSecond = Number((
      largeBytes / mebibyte / (large.durationMs / 1_000)
    ).toFixed(2));

    const preview = await runMeasurement({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
      limit: 200,
      mode: SESSION_EVENT_READ_MODE.PREVIEW,
    });
    preview.bytes = largeBytes;

    process.stdout.write(`${JSON.stringify({
      checks: {
        largePreviewFasterThanFull: preview.durationMs < large.durationMs,
        peakRssComparable: large.peakRssMb <= small.peakRssMb * 1.25,
        smallUnder200Ms: small.durationMs < 200,
      },
      large,
      preview,
      small,
    }, null, 2)}\n`);
  } finally {
    await removeCodexHomeFixture(fixture.codexHome);
  }
}
