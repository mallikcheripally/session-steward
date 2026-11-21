import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { getProvider } from "../../lib/providers/index.mjs";
import { queryRows } from "../../lib/storage/sqlite.mjs";
import { createCodexHomeFixture, fixtureSessionIds, removeCodexHomeFixture } from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
const metadataRows = 100_000;
const selectedRows = 90_000;
const maxRssGrowthMb = 64;

if (process.argv[2] === "--measure") {
  const codexHome = process.argv[3];
  global.gc?.();
  const baselineRssMb = process.memoryUsage().rss / 1024 / 1024;
  const store = await codex.loadDeletionStore({ codexHome, recordIds: [fixtureSessionIds.parent] });
  const plan = await codex.planSessionDeletion({ store, recordIds: [fixtureSessionIds.parent] });
  assert.equal(plan.stateRelatedRowCount, selectedRows);
  const responseBytes = Buffer.byteLength(JSON.stringify(plan));
  assert.ok(responseBytes < 50_000, `Cleanup plan grew to ${responseBytes} bytes.`);
  const fingerprintStart = performance.now();
  const fingerprint = await codex.fingerprintSessionDeletion({ store, plan, scope: "core" });
  assert.equal(await codex.fingerprintSessionDeletion({ store, plan, scope: "core" }), fingerprint);
  const fingerprintMs = (performance.now() - fingerprintStart) / 2;
  const cleanupStart = performance.now();
  await codex.executeSessionDeletion({ store, plan, scope: "core" });
  assert.equal((await codex.verifySessionDeletion({ store, plan, scope: "core" })).complete, true);
  assert.equal(queryRows(store.stateDatabasePath, "select count(*) as count from session_model_ids")[0].count, metadataRows - selectedRows);
  const cleanupMs = performance.now() - cleanupStart;
  const peakRssMb = process.resourceUsage().maxRSS / 1024;
  const peakRssGrowthMb = peakRssMb - baselineRssMb;
  assert.ok(peakRssGrowthMb < maxRssGrowthMb, `Cleanup retained too much memory: ${peakRssGrowthMb.toFixed(2)} MB RSS growth.`);
  console.log(JSON.stringify({ metadataRows, selectedRows, responseBytes, fingerprintMs: +fingerprintMs.toFixed(2), cleanupMs: +cleanupMs.toFixed(2), peakRssGrowthMb: +peakRssGrowthMb.toFixed(2), maxRssGrowthMb }));
} else {
  const fixture = await createCodexHomeFixture();
  try {
    const database = new DatabaseSync(fixture.stateDatabasePath);
    try {
      // The current upstream store has no cascading thread foreign key.
      database.exec(`create table session_model_ids (
        session_id text not null, kind text not null, external_key text not null,
        ordinal integer not null check (ordinal >= 0), initial_state text,
        primary key (session_id, kind, external_key),
        unique (session_id, kind, ordinal),
        check ((ordinal = 0) = (initial_state is not null))
      ); begin immediate;`);
      const insert = database.prepare("insert into session_model_ids values (?, 'artifact', ?, ?, ?)");
      for (let index = 0; index < metadataRows; index += 1) {
        const id = index < 80_000 ? fixtureSessionIds.parent : index < selectedRows ? fixtureSessionIds.child : fixtureSessionIds.standalone;
        const ordinal = index % 10_000;
        // Parent ordinals stay unique across all of its eight 10k blocks.
        const sessionOrdinal = id === fixtureSessionIds.parent ? index : ordinal;
        insert.run(id, `${String(index).padStart(6, "0")}-${"x".repeat(512)}`, sessionOrdinal, sessionOrdinal === 0 ? "seed" : null);
      }
      database.exec("commit");
    } finally { database.close(); }
    const worker = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--measure", fixture.codexHome], { encoding: "utf8", maxBuffer: 64 * 1024 });
    if (worker.status !== 0) throw new Error(worker.stderr || worker.error?.message || "Cleanup benchmark failed.");
    console.log(JSON.stringify(JSON.parse(worker.stdout), null, 2));
  } finally { await removeCodexHomeFixture(fixture.codexHome); }
}
