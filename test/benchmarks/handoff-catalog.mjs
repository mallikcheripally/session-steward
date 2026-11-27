import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHandoffCatalog } from "../../lib/handoff-catalog.mjs";
import { HANDOFF_DIRECTORY } from "../../lib/session-handoff.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "steward-handoff-catalog-scale-"));
const catalog = await createHandoffCatalog({ dataDirectory: root });
try {
  const db = new DatabaseSync(catalog.databasePath);
  try {
    db.exec("begin immediate");
    const insert = db.prepare("insert into handoffs values (?, ?, ?, 'codex', ?, ?, ?, 'claude', ?, ?, ?, 100, 0, '0', '0', ?, 'ready')");
    const now = Date.now();
    for (let index = 0; index < 50000; index += 1) {
      const id = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const workspace = path.join(root, `project-${index % 25}`);
      insert.run(id, path.join(workspace, HANDOFF_DIRECTORY, id), workspace, `session-${index}`, `Session ${index}`, String(index).padStart(64, "0"), now - index * 60000, now - index * 60000, 1024 + index, "0".repeat(64));
    }
    db.exec("commit");
  } finally { db.close(); }
  global.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const recent = await catalog.list({ pageSize: 25 });
  const largest = await catalog.list({ pageSize: 25, sort: "size" });
  const filtered = await catalog.list({ search: "project-17", olderDays: 30, pageSize: 25 });
  const scoped = await catalog.list({ providerId: "codex", sessionId: "session-1700", pageSize: 25 });
  const durationMs = performance.now() - started;
  global.gc?.(); const retainedHeapMiB = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  assert.equal(recent.total, 50000); assert.equal(recent.records.length, 25);
  assert.equal(largest.records[0].byteCount, 51023);
  assert.ok(filtered.total > 0); assert.ok(filtered.records.every(record => record.workspace.endsWith("project-17")));
  assert.equal(scoped.total, 1); assert.equal(scoped.records[0].sessionId, "session-1700");
  const responseBytes = Buffer.byteLength(JSON.stringify(recent));
  assert.ok(responseBytes < 100 * 1024);
  assert.ok(retainedHeapMiB < 20);
  assert.ok(durationMs < 5000);
  console.log(JSON.stringify({ archives: recent.total, projects: 25, queries: 4, durationMs: +durationMs.toFixed(2), responseBytes, retainedHeapMiB: +retainedHeapMiB.toFixed(2) }, null, 2));
} finally { catalog.close(); await fs.rm(root, { recursive: true, force: true }); }
