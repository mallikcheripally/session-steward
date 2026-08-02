import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { getProvider, listProviders } from "../../lib/providers/index.mjs";
import { queryRows } from "../../lib/storage/sqlite.mjs";
import {
  appendTranscriptOnlySubagent,
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");

test("the provider registry exposes Codex explicitly", () => {
  assert.ok(listProviders().map(({ id }) => id).includes("codex"));
  assert.equal(codex.displayName, "Codex");
});

test("Codex discovery preserves relationships and readable names", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.equal(store.records.length, 3);

  const parent = store.recordsById.get(fixtureSessionIds.parent);
  const child = store.recordsById.get(fixtureSessionIds.child);
  assert.equal(parent.displayName, "Safer cleanup");
  assert.deepEqual(parent.childThreadIds, [fixtureSessionIds.child]);
  assert.equal(child.parentThreadId, fixtureSessionIds.parent);
  assert.equal(child.isSubagent, true);
  const archived = store.recordsById.get(fixtureSessionIds.standalone);
  assert.equal(archived.archived, true);
  assert.equal(archived.rolloutMissing, false);
  assert.match(archived.rolloutPath, /archived_sessions/u);
});

test("Codex cleanup backs up and removes archived transcripts", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.standalone],
  });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.standalone],
    store,
  });

  assert.equal(plan.records[0].archived, true);
  assert.deepEqual(plan.transcriptPaths, [fixture.transcripts.standalone]);
  const result = await codex.executeSessionDeletion({ plan, scope: "core", store });
  const verification = await codex.verifySessionDeletion({ plan, scope: "core", store });

  assert.equal(verification.complete, true);
  await assert.rejects(access(fixture.transcripts.standalone), { code: "ENOENT" });
  await access(path.join(
    result.backupDirectory,
    "transcripts",
    path.basename(fixture.transcripts.standalone),
  ));
});

test("Codex plans cascade from parent to child but not child to parent", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });

  const parentPlan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });
  assert.deepEqual(new Set(parentPlan.ids), new Set([
    fixtureSessionIds.parent,
    fixtureSessionIds.child,
  ]));
  assert.equal(parentPlan.childCount, 1);
  assert.equal(
    parentPlan.newestLinkedActivityAtMs,
    store.recordsById.get(fixtureSessionIds.child).updatedAtMs,
  );
  const transcriptBytes = (await Promise.all([
    readFile(fixture.transcripts.parent),
    readFile(fixture.transcripts.child),
  ])).reduce((total, contents) => total + contents.length, 0);
  assert.equal(parentPlan.transcriptFileCount, 2);
  assert.equal(parentPlan.transcriptBytes, transcriptBytes);

  const childPlan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.child],
    store,
  });
  assert.deepEqual(childPlan.ids, [fixtureSessionIds.child]);
  assert.equal(childPlan.childCount, 0);
  assert.equal(childPlan.newestLinkedActivityAtMs, 0);
});

test("Codex cleanup cascades to transcript-only subagents", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const transcriptOnly = await appendTranscriptOnlySubagent(fixture);
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  assert.equal(store.recordsById.get(transcriptOnly.id).parentThreadId, transcriptOnly.parentId);
  assert.equal(store.recordsById.get(transcriptOnly.parentId).childThreadIds.includes(transcriptOnly.id), true);
  assert.equal(plan.ids.includes(transcriptOnly.id), true);
  assert.equal(plan.transcriptPaths.includes(transcriptOnly.transcriptPath), true);
});

test("Codex compatibility reports an unfamiliar database without claiming support", async (context) => {
  const fixture = await createCodexHomeFixture({ includeUnknownDatabase: true });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const compatibility = await codex.diagnoseStorageCompatibility({
    codexHome: fixture.codexHome,
  });
  assert.equal(compatibility.status, "newer-version");
  assert.deepEqual(
    compatibility.newlyDiscovered,
    ["Other local database found: future_1.sqlite"],
  );
  await assert.rejects(
    codex.assertDeepCleanupSupported({ codexHome: fixture.codexHome }),
    /unrecognized Codex storage/u,
  );
});

test("cleanup stops before creating a backup when disk capacity is insufficient", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  await assert.rejects(
    codex.preflightSessionDeletion({ availableDiskBytes: 0, plan, store }),
    (error) => {
      assert.match(error.message, /Not enough disk space to create a backup/u);
      assert.equal(error.availableDiskBytes, 0);
      assert.equal(error.estimatedBackupBytes > 0, true);
      return true;
    },
  );
  await assert.rejects(
    access(path.join(fixture.codexHome, "session-steward-backups")),
    { code: "ENOENT" },
  );
});

test("cleanup failures after backup creation include the backup location", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });
  const failingStore = {
    ...store,
    logsDatabasePath: store.stateDatabasePath,
  };

  let cleanupError = null;

  try {
    await codex.executeSessionDeletion({ plan, scope: "core", store: failingStore });
  } catch (error) {
    cleanupError = error;
  }

  assert.match(cleanupError?.message ?? "", /Cleanup stopped after the backup was created/u);
  assert.equal(cleanupError.message.includes(cleanupError.backupDirectory), true);
  await access(cleanupError.backupDirectory);
  await access(path.join(cleanupError.backupDirectory, "operation.json"));
  assert.equal(
    queryRows(store.stateDatabasePath, "select count(*) as count from threads")[0].count,
    3,
  );
});

test("deep cleanup backs up, removes, and verifies only the selected family", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  const result = await codex.executeSessionDeletion({ plan, scope: "deep", store });
  const verification = await codex.verifySessionDeletion({ plan, scope: "deep", store });
  assert.equal(verification.complete, true);
  await access(result.backupDirectory);
  await access(path.join(result.backupDirectory, "history.jsonl"));
  await access(path.join(result.backupDirectory, "session_index.jsonl"));
  await access(path.join(result.backupDirectory, "transcripts", path.basename(fixture.transcripts.parent)));
  await access(path.join(result.backupDirectory, "transcripts", path.basename(fixture.transcripts.child)));
  const backupThreads = queryRows(
    path.join(result.backupDirectory, "databases", "state_5.sqlite"),
    "select id from threads order by id",
  );
  assert.equal(backupThreads.some(({ id }) => id === fixtureSessionIds.parent), true);
  assert.equal(backupThreads.some(({ id }) => id === fixtureSessionIds.child), true);
  const operation = JSON.parse(await readFile(
    path.join(result.backupDirectory, "operation.json"),
    "utf8",
  ));
  assert.deepEqual(new Set(operation.ids), new Set(plan.ids));
  assert.equal(operation.version, 2);
  assert.equal(operation.files.every(({ backupPath, originalPath }) => backupPath && originalPath), true);

  const remainingStore = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.deepEqual(remainingStore.records.map(({ id }) => id), [fixtureSessionIds.standalone]);
  await codex.deleteSessionDeletionBackup({
    backupDirectory: result.backupDirectory,
    codexHome: fixture.codexHome,
  });
  await assert.rejects(access(result.backupDirectory), { code: "ENOENT" });
});

test("cleanup cancellation stops at a safe boundary", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.parent],
  });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });
  let cancelRequested = false;
  let cancellationError = null;

  try {
    await codex.executeSessionDeletion({
      onProgress: ({ phase }) => {
        if (phase === "backup") cancelRequested = true;
      },
      plan,
      shouldCancel: () => cancelRequested,
      store,
    });
  } catch (error) {
    cancellationError = error;
  }

  assert.equal(cancellationError?.cancelled, true);
  await access(path.join(cancellationError.backupDirectory, "operation.json"));
  assert.equal(
    queryRows(store.stateDatabasePath, "select count(*) as count from threads")[0].count,
    3,
  );
  await access(fixture.transcripts.parent);
  await access(fixture.transcripts.child);
});

test("a cleanup backup can restore the selected session family", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({
    codexHome: fixture.codexHome,
    recordIds: [fixtureSessionIds.parent],
  });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });
  const result = await codex.executeSessionDeletion({ plan, scope: "deep", store });
  assert.equal((await codex.verifySessionDeletion({ plan, scope: "deep", store })).complete, true);

  const restored = await codex.restoreSessionDeletionBackup({
    backupDirectory: result.backupDirectory,
    codexHome: fixture.codexHome,
  });
  assert.equal(restored.restoredFileCount > 0, true);
  await access(restored.safetyBackupDirectory);
  await access(fixture.transcripts.parent);
  await access(fixture.transcripts.child);
  const restoredStore = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.deepEqual(new Set(restoredStore.records.map(({ id }) => id)), new Set(Object.values(fixtureSessionIds)));
});
