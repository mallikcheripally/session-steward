import assert from "node:assert/strict";
import path from "node:path";
import { access, stat, truncate } from "node:fs/promises";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { readJsonlEntries } from "../../lib/storage/jsonl.mjs";
import {
  appendLargeJsonlFixture,
  appendTranscriptOnlySessions,
  createLargeCodexHomeFixture,
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
const fixtureSessionSearch = "Build a safer cleanup flow";

test("Codex listing stays bounded for a large session collection", async (context) => {
  const fixture = await createLargeCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const firstPage = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    page: 1,
    pageSize: 25,
  });
  const secondPage = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    page: 2,
    pageSize: 25,
  });

  assert.equal(firstPage.total, fixture.sessionCount + 3);
  assert.equal(firstPage.records.length, 25);
  assert.equal(secondPage.records.length, 25);
  assert.equal(firstPage.pageSize, 25);
  assert.equal(
    firstPage.records.some(({ id }) => secondPage.records.some((record) => record.id === id)),
    false,
  );
  assert.ok(JSON.stringify(firstPage).length < 50_000);
});

test("cleanup loads only the selected family from a large collection", async (context) => {
  const fixture = await createLargeCodexHomeFixture({ sessionCount: 50_000 });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.parent],
  });

  assert.deepEqual(new Set(store.records.map(({ id }) => id)), new Set([
    fixtureSessionIds.parent,
    fixtureSessionIds.child,
  ]));
  assert.equal(store.recordsById.size, 2);
});

test("Codex listing does not read a large transcript body", async (context) => {
  const fixture = await createLargeCodexHomeFixture({ sessionCount: 10 });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  await truncate(fixture.transcripts.parent, 256 * 1024 * 1024);
  assert.equal((await stat(fixture.transcripts.parent)).size, 256 * 1024 * 1024);

  const result = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    pageSize: 25,
    search: fixtureSessionSearch,
  });

  assert.equal(result.total, 1);
  assert.equal(result.records[0].id, "11111111-1111-4111-8111-111111111111");
});

test("Codex discovery keeps transcript-only sessions visible", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const transcriptOnly = await appendTranscriptOnlySessions(fixture);
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });

  assert.equal(store.records.length, transcriptOnly.sessionCount + 3);
  assert.equal(store.recordsById.get(transcriptOnly.firstId).recordSource, "transcript");
  assert.equal(store.recordsById.get(transcriptOnly.lastId).recordSource, "transcript");
});

test("Codex discovery and cleanup stream large JSONL files", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const largeFiles = await appendLargeJsonlFixture(fixture);
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.parent],
  });

  assert.equal(store.records.length, 2);
  assert.equal(store.recordsById.has("bulk-0"), false);
  assert.equal(store.recordsById.get(fixtureSessionIds.child).displayName, "Repeated child");

  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  assert.equal(plan.historyMatchCount, 3);
  assert.equal(plan.sessionIndexMatchCount, 3);
  const result = await codex.executeSessionDeletion({ plan, scope: "core", store });
  const verification = await codex.verifySessionDeletion({ plan, scope: "core", store });
  assert.equal(verification.complete, true);
  assert.equal(verification.remainingHistoryEntryCount, 0);
  assert.equal(verification.remainingSessionIndexEntryCount, 0);
  await access(path.join(result.backupDirectory, "history.jsonl"));
  await access(path.join(result.backupDirectory, "session_index.jsonl"));

  let historyBulkCount = 0;
  let malformedHistoryPreserved = false;
  for await (const entry of readJsonlEntries(largeFiles.historyPath)) {
    if (entry.parsed?.session_id?.startsWith("bulk-")) historyBulkCount += 1;
    if (entry.raw === "malformed history line") malformedHistoryPreserved = true;
    assert.equal(plan.ids.includes(String(entry.parsed?.session_id)), false);
  }

  let sessionIndexBulkCount = 0;
  let standaloneCount = 0;
  let malformedIndexPreserved = false;
  for await (const entry of readJsonlEntries(largeFiles.sessionIndexPath)) {
    if (entry.parsed?.id?.startsWith("bulk-")) sessionIndexBulkCount += 1;
    if (entry.parsed?.id === fixtureSessionIds.standalone) standaloneCount += 1;
    if (entry.raw === "malformed index line") malformedIndexPreserved = true;
    assert.equal(plan.ids.includes(String(entry.parsed?.id)), false);
  }

  assert.equal(historyBulkCount, largeFiles.entryCount);
  assert.equal(sessionIndexBulkCount, largeFiles.entryCount);
  assert.equal(standaloneCount, 3);
  assert.equal(malformedHistoryPreserved, true);
  assert.equal(malformedIndexPreserved, true);
});
