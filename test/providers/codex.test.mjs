import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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

for (const layout of ["state_5", "state_6"]) {
  test(`Codex ${layout} layout supports listing, inspection, cleanup, and restore`, async (context) => {
    const fixture = await createCodexHomeFixture({ layout });
    context.after(() => removeCodexHomeFixture(fixture.codexHome));
    const compatibility = await codex.diagnoseStorageCompatibility({ codexHome: fixture.codexHome });
    assert.equal(compatibility.status, "ready");
    assert.equal(compatibility.builtFor.codexCli.includes("0.148.0"), true);
    assert.equal(compatibility.builtFor.chatgptDesktop.includes("26.818.22352"), true);
    assert.equal(compatibility.resolvedDatabases.state.primary.filename, `${layout}.sqlite`);
    const listed = await codex.listSessions({
      codexHome: fixture.codexHome,
      includeInternals: true,
      includeSupporting: true,
      pageSize: 25,
    });
    assert.equal(listed.total, 3);
    assert.equal((await codex.listSessions({ codexHome: fixture.codexHome, search: "safer cleanup", sort: "name" })).records[0].id, fixtureSessionIds.parent);
    assert.equal((await codex.listSessions({ archiveStatus: "archived", codexHome: fixture.codexHome })).total, 1);
    assert.equal((await codex.getSessionRecord({ codexHome: fixture.codexHome, id: fixtureSessionIds.parent })).id, fixtureSessionIds.parent);
    assert.equal((await codex.getSessionOverview({ codexHome: fixture.codexHome, refresh: true })).sessionCount, 3);
    const store = await codex.loadDeletionStore({
      codexHome: fixture.codexHome,
      recordIds: [fixtureSessionIds.parent],
    });
    const plan = await codex.planSessionDeletion({ recordIds: [fixtureSessionIds.parent], store });
    const result = await codex.executeSessionDeletion({ plan, scope: "core", store });
    assert.equal((await codex.verifySessionDeletion({ plan, scope: "core", store })).complete, true);
    await codex.restoreSessionDeletionBackup({ backupDirectory: result.backupDirectory, codexHome: fixture.codexHome });
    assert.equal((await codex.getSessionRecord({ codexHome: fixture.codexHome, id: fixtureSessionIds.parent })).id, fixtureSessionIds.parent);
    const deepStore = await codex.loadDeletionStore({
      codexHome: fixture.codexHome,
      recordIds: [fixtureSessionIds.standalone],
    });
    const deepPlan = await codex.planSessionDeletion({ recordIds: [fixtureSessionIds.standalone], store: deepStore });
    const deepResult = await codex.executeSessionDeletion({ plan: deepPlan, scope: "deep", store: deepStore });
    assert.equal((await codex.verifySessionDeletion({ plan: deepPlan, scope: "deep", store: deepStore })).complete, true);
    await codex.restoreSessionDeletionBackup({ backupDirectory: deepResult.backupDirectory, codexHome: fixture.codexHome });
    assert.equal((await codex.getSessionRecord({ codexHome: fixture.codexHome, id: fixtureSessionIds.standalone })).id, fixtureSessionIds.standalone);
  });
}

test("Codex unions versioned stores, prefers the newest duplicate, and cleans every recognized store", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const state5 = fixture.stateDatabasePath;
  const state6 = path.join(fixture.codexHome, "state_6.sqlite");
  await copyFile(state5, state6);
  const versionedStores = [
    ["logs_2.sqlite", "logs_3.sqlite", "logs", "thread_id"],
    ["memories_1.sqlite", "memories_2.sqlite", "stage1_outputs", "thread_id"],
    ["goals_1.sqlite", "goals_2.sqlite", "thread_goals", "thread_id"],
    ["queue_1.sqlite", "queue_2.sqlite", "queued_items", "thread_id"],
    ["thread_history_1.sqlite", "thread_history_2.sqlite", "thread_items", "thread_id"],
  ];
  for (const [source, destination] of versionedStores) {
    await copyFile(path.join(fixture.codexHome, source), path.join(fixture.codexHome, destination));
  }
  const olderOnly = "44444444-4444-4444-8444-444444444444";
  const newerOnly = "55555555-5555-4555-8555-555555555555";
  for (const [databasePath, id, title] of [
    [state5, olderOnly, "Older store session"],
    [state6, newerOnly, "Newer store session"],
  ]) {
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`insert into threads (id, rollout_path, cwd, title, first_user_message, archived, is_pinned, created_at, updated_at, created_at_ms, updated_at_ms) values (?, null, ?, ?, ?, 0, 0, 1, 1, 1000, 1000)`)
        .run(id, fixture.workspace, title, title);
      if (databasePath === state6) database.prepare("update threads set title = ? where id = ?").run("Primary copy", fixtureSessionIds.parent);
      if (databasePath === state5) database.prepare("update threads set updated_at_ms = ? where id = ?").run(9_999_999_999_999, olderOnly);
    } finally {
      database.close();
    }
  }
  codex.invalidateSessionCache({ codexHome: fixture.codexHome });
  const compatibility = await codex.diagnoseStorageCompatibility({ codexHome: fixture.codexHome });
  assert.equal(compatibility.resolvedDatabases.state.primary.filename, "state_6.sqlite");
  assert.deepEqual(compatibility.resolvedDatabases.state.secondaries, [{ filename: "state_5.sqlite", version: 5 }]);
  const firstPage = await codex.listSessions({ codexHome: fixture.codexHome, includeInternals: true, includeSupporting: true, page: 1, pageSize: 3 });
  const secondPage = await codex.listSessions({ codexHome: fixture.codexHome, includeInternals: true, includeSupporting: true, page: 2, pageSize: 3 });
  assert.equal(firstPage.total, 5);
  assert.equal(new Set([...firstPage.records, ...secondPage.records].map(({ id }) => id)).size, 5);
  assert.equal((await codex.getSessionRecord({ codexHome: fixture.codexHome, id: fixtureSessionIds.parent })).displayName, "Primary copy");
  const activityPage = await codex.listSessions({ codexHome: fixture.codexHome, includeInternals: true, includeSupporting: true, page: 1, pageSize: 1, sort: "updated" });
  assert.equal(activityPage.records[0].id, olderOnly);
  const selectedIds = [fixtureSessionIds.parent, olderOnly, newerOnly];
  let store = await codex.loadDeletionStore({ codexHome: fixture.codexHome, recordIds: selectedIds });
  let plan = await codex.planSessionDeletion({ recordIds: selectedIds, store });
  const initialFingerprint = await codex.fingerprintSessionDeletion({ plan, scope: "deep", store });
  const secondary = new DatabaseSync(state5);
  try {
    secondary.prepare("update threads set title = ? where id = ?").run("Secondary changed during review", fixtureSessionIds.parent);
  } finally {
    secondary.close();
  }
  store = await codex.loadDeletionStore({ codexHome: fixture.codexHome, recordIds: selectedIds });
  plan = await codex.planSessionDeletion({ recordIds: selectedIds, store });
  assert.notEqual(await codex.fingerprintSessionDeletion({ plan, scope: "deep", store }), initialFingerprint);
  await codex.executeSessionDeletion({ plan, scope: "deep", store });
  for (const databasePath of [state5, state6]) {
    assert.equal(queryRows(databasePath, "select count(*) as count from threads where id = ?", [fixtureSessionIds.parent])[0].count, 0);
    assert.equal(queryRows(databasePath, "select count(*) as count from threads where id in (?, ?)", [olderOnly, newerOnly])[0].count, 0);
  }
  for (const [source, destination, table, column] of versionedStores) {
    for (const filename of [source, destination]) {
      assert.equal(queryRows(path.join(fixture.codexHome, filename), `select count(*) as count from ${table} where ${column} = ?`, [fixtureSessionIds.parent])[0].count, 0);
    }
  }
});

test("Codex single-store SQL paging matches union paging", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const database = new DatabaseSync(fixture.stateDatabasePath);
  try {
    database.prepare("update threads set updated_at_ms = ?").run(1_751_367_600_000);
  } finally {
    database.close();
  }
  codex.invalidateSessionCache({ codexHome: fixture.codexHome });
  const queries = [
    { includeInternals: true, includeSupporting: true, page: 1, pageSize: 1, sort: "updated" },
    { includeInternals: true, includeSupporting: true, page: 2, pageSize: 1, sort: "updated" },
    { includeInternals: true, includeSupporting: true, page: 1, pageSize: 2, sort: "created" },
    { includeInternals: true, includeSupporting: true, page: 2, pageSize: 2, sort: "cwd" },
    { includeInternals: true, includeSupporting: true, page: 1, pageSize: 2, sort: "name" },
    { archiveStatus: "archived", includeInternals: true, includeSupporting: true, page: 1, pageSize: 1 },
    { includeInternals: true, includeSupporting: true, page: 1, pageSize: 1, search: "safer cleanup" },
    { includeInternals: true, includeSupporting: true, page: 99, pageSize: 2, sort: "updated" },
  ];

  for (const query of queries) {
    const fast = await codex.listSessions({ codexHome: fixture.codexHome, ...query });
    const union = await codex.listSessions({ codexHome: fixture.codexHome, forceUnion: true, ...query });
    assert.deepEqual(fast, union);
  }
});

test("Codex tolerates missing optional thread fields and a missing spawn table", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const state7 = path.join(fixture.codexHome, "state_7.sqlite");
  const database = new DatabaseSync(state7);
  try {
    database.exec("create table threads (id text primary key, rollout_path text)");
    database.prepare("insert into threads values (?, ?)").run(fixtureSessionIds.parent, fixture.transcripts.parent);
    database.prepare("insert into threads values (?, null)").run("minimal-state-session");
  } finally {
    database.close();
  }
  await rm(fixture.stateDatabasePath);
  codex.invalidateSessionCache({ codexHome: fixture.codexHome });
  const archived = await codex.listSessions({
    archiveStatus: "archived",
    codexHome: fixture.codexHome,
    includeInternals: false,
    includeSupporting: false,
    search: "minimal-state-session",
    workspace: "/unavailable",
  });
  assert.equal(archived.total, 0);
  const listed = await codex.listSessions({
    archiveStatus: "active",
    codexHome: fixture.codexHome,
    includeInternals: false,
    includeSupporting: false,
    search: "minimal-state-session",
    workspace: "/unavailable",
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].id, "minimal-state-session");
  assert.equal(listed.records[0].parentThreadId, null);
  assert.equal(listed.records[0].cwd, "");
});

test("Codex reports an invalid newer database instead of replacing a valid primary", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const invalid = new DatabaseSync(path.join(fixture.codexHome, "state_9.sqlite"));
  try {
    invalid.exec("create table threads (id text primary key)");
  } finally {
    invalid.close();
  }
  const compatibility = await codex.diagnoseStorageCompatibility({ codexHome: fixture.codexHome });
  assert.equal(compatibility.status, "unsupported");
  assert.equal(compatibility.resolvedDatabases.state.primary.filename, "state_5.sqlite");
  assert.equal(compatibility.resolvedDatabases.state.invalid[0].filename, "state_9.sqlite");
});

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

async function listParentWithTitle(context, title, { firstUserMessage = "Fallback title", search = "" } = {}) {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const database = new DatabaseSync(path.join(fixture.codexHome, "state_5.sqlite"));
  try {
    database.prepare("update threads set title = ?, first_user_message = ? where id = ?")
      .run(title, firstUserMessage, fixtureSessionIds.parent);
  } finally {
    database.close();
  }
  const result = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    includeSupporting: true,
    search,
  });
  return result.records.find(({ id }) => id === fixtureSessionIds.parent);
}

test("Codex titles remove a leading compacted role marker", async (context) => {
  const record = await listParentWithTitle(context, "[2] user: Review the release");
  assert.equal(record.displayName, "Review the release");
});

test("Codex titles stop at the next compacted role marker", async (context) => {
  const record = await listParentWithTitle(context, "Review the release [3] assistant: Working on it");
  assert.equal(record.displayName, "Review the release");
});

test("Codex titles render one Markdown link as its label", async (context) => {
  const record = await listParentWithTitle(context, "Read [release.md](docs/release.md)");
  assert.equal(record.displayName, "Read release.md");
});

test("Codex titles render repeated Markdown links as labels", async (context) => {
  const record = await listParentWithTitle(context, "Compare [one.md](docs/one.md) and [two.md](docs/two.md)");
  assert.equal(record.displayName, "Compare one.md and two.md");
});

test("Codex title cleanup keeps punctuation-only results conservative", async (context) => {
  const original = "[2] user: --- [3] assistant: Working on it";
  const record = await listParentWithTitle(context, original);
  assert.equal(record.displayName, original);
});

test("Codex titles without cleanup patterns pass through unchanged", async (context) => {
  const original = "Review the release dashboard";
  const record = await listParentWithTitle(context, original);
  assert.equal(record.displayName, original);
});

test("Codex cleans the first-message fallback after an empty title", async (context) => {
  const record = await listParentWithTitle(context, "", {
    firstUserMessage: "[2] user: Read [release.md](docs/release.md)",
  });
  assert.equal(record.displayName, "Read release.md");
});

test("Codex search continues matching text only present in a raw title", async (context) => {
  const record = await listParentWithTitle(
    context,
    "Read [release.md](private/raw-release-target)",
    { search: "private/raw-release-target" },
  );
  assert.equal(record.displayName, "Read release.md");
});

test("Codex discovery cleans names sourced from the session index", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  await writeFile(
    path.join(fixture.codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: fixtureSessionIds.parent, thread_name: "[2] user: Read [release.md](docs/release.md)", updated_at: "2026-07-01T11:00:00.000Z" })}\n`,
  );
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.equal(store.recordsById.get(fixtureSessionIds.parent).displayName, "Read release.md");
});

test("Codex list records expose transcript size and tolerate missing files", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const listed = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    includeSupporting: true,
  });
  const parent = listed.records.find(({ id }) => id === fixtureSessionIds.parent);
  assert.equal(
    parent.transcriptBytes,
    (await readFile(fixture.transcripts.parent)).length,
  );

  await rm(fixture.transcripts.standalone);
  const missing = await codex.getSessionRecord({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.standalone,
  });
  assert.equal(missing.transcriptBytes, null);
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
  const backups = await codex.listSessionDeletionBackups({ codexHome: fixture.codexHome });

  assert.equal(verification.complete, true);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].backupDirectory, result.backupDirectory);
  assert.equal(backups[0].restorable, true);
  assert.equal(backups[0].scope, "core");
  assert.equal(backups[0].sessionCount, 1);
  assert.equal(backups[0].bytes > 0, true);
  assert.equal(backups[0].fileCount > 0, true);
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
  assert.equal(compatibility.status, "partial");
  assert.deepEqual(
    compatibility.newlyDiscovered,
    ["Other local database found: future_1.sqlite"],
  );
  assert.equal((await codex.assertDeepCleanupSupported({ codexHome: fixture.codexHome })).status, "partial");
});

test("Codex discloses retained session attachments", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const attachmentsDirectory = path.join(fixture.codexHome, "attachments", "attachment-id");
  await mkdir(attachmentsDirectory, { recursive: true });
  await writeFile(path.join(attachmentsDirectory, "note.txt"), "kept\n");

  const compatibility = await codex.diagnoseStorageCompatibility({ codexHome: fixture.codexHome });
  assert.equal(compatibility.status, "partial");
  assert.equal(
    compatibility.newlyDiscovered.includes(
      "Session attachments are kept because their ownership cannot be verified safely.",
    ),
    true,
  );
  assert.equal((await codex.assertDeepCleanupSupported({ codexHome: fixture.codexHome })).status, "partial");
});

test("Codex cleanup stops while a selected session has a writer lock", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const locksDirectory = path.join(fixture.codexHome, "thread-writer-locks");
  await mkdir(locksDirectory);
  await writeFile(path.join(locksDirectory, `${fixtureSessionIds.parent}.lock`), "");
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({ recordIds: [fixtureSessionIds.parent], store });

  await assert.rejects(
    codex.preflightSessionDeletion({ plan, store }),
    (error) => {
      assert.match(error.message, /Close the selected Codex session/u);
      assert.deepEqual(error.activeThreadIds, [fixtureSessionIds.parent]);
      return true;
    },
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
    logsDatabasePaths: [store.stateDatabasePath],
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
  assert.equal(plan.dynamicToolRowCount, 2);
  assert.equal(plan.queueRowCount, 2);
  assert.equal(plan.queueRevisionRowCount, 2);
  assert.equal(plan.threadHistoryRowCount, 6);

  const result = await codex.executeSessionDeletion({ plan, scope: "deep", store });
  const verification = await codex.verifySessionDeletion({ plan, scope: "deep", store });
  assert.equal(verification.complete, true);
  assert.deepEqual(verification.remainingDynamicTools, []);
  assert.deepEqual(verification.remainingQueueRecords, []);
  assert.deepEqual(verification.remainingThreadHistoryRecords, []);
  assert.deepEqual(
    queryRows(path.join(fixture.codexHome, "queue_1.sqlite"), "select thread_id from queued_items order by thread_id")
      .map(({ thread_id }) => ({ thread_id })),
    [{ thread_id: fixtureSessionIds.standalone }],
  );
  assert.deepEqual(
    queryRows(path.join(fixture.codexHome, "queue_1.sqlite"), "select thread_id from queued_thread_revisions order by thread_id")
      .map(({ thread_id }) => ({ thread_id })),
    [{ thread_id: fixtureSessionIds.standalone }],
  );
  for (const tableName of ["thread_items", "thread_turns", "thread_history_projection_state"]) {
    assert.deepEqual(
      queryRows(path.join(fixture.codexHome, "thread_history_1.sqlite"), `select thread_id from ${tableName} order by thread_id`)
        .map(({ thread_id }) => ({ thread_id })),
      [{ thread_id: fixtureSessionIds.standalone }],
    );
  }
  assert.deepEqual(
    queryRows(store.stateDatabasePath, "select thread_id from thread_dynamic_tools order by thread_id")
      .map(({ thread_id }) => ({ thread_id })),
    [{ thread_id: fixtureSessionIds.standalone }],
  );
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
  assert.equal(operation.version, 3);
  assert.equal(operation.profileId, "codex-local-store-2026-08");
  assert.equal(operation.compatibilityStatus, "ready");
  assert.equal(operation.resolvedDatabases.state.primary.filename, "state_5.sqlite");
  assert.equal(operation.resolvedDatabases.queue.primary.filename, "queue_1.sqlite");
  assert.equal(operation.resolvedDatabases.threadHistory.primary.filename, "thread_history_1.sqlite");
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

test("Codex continues restoring version 2 recovery manifests", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({ codexHome: fixture.codexHome, recordIds: [fixtureSessionIds.standalone] });
  const plan = await codex.planSessionDeletion({ recordIds: [fixtureSessionIds.standalone], store });
  const result = await codex.executeSessionDeletion({ plan, scope: "core", store });
  const operationPath = path.join(result.backupDirectory, "operation.json");
  const operation = JSON.parse(await readFile(operationPath, "utf8"));
  operation.version = 2;
  delete operation.profileId;
  delete operation.resolvedDatabases;
  delete operation.compatibilityStatus;
  await writeFile(operationPath, `${JSON.stringify(operation, null, 2)}\n`);
  assert.equal((await codex.listSessionDeletionBackups({ codexHome: fixture.codexHome }))[0].restorable, true);
  await codex.restoreSessionDeletionBackup({ backupDirectory: result.backupDirectory, codexHome: fixture.codexHome });
  assert.equal((await codex.getSessionRecord({ codexHome: fixture.codexHome, id: fixtureSessionIds.standalone })).id, fixtureSessionIds.standalone);
});

test("Codex restores recorded paths and notes a changed database layout", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadDeletionStore({ codexHome: fixture.codexHome, recordIds: [fixtureSessionIds.standalone] });
  const plan = await codex.planSessionDeletion({ recordIds: [fixtureSessionIds.standalone], store });
  const result = await codex.executeSessionDeletion({ plan, scope: "core", store });
  await copyFile(fixture.stateDatabasePath, path.join(fixture.codexHome, "state_6.sqlite"));
  const restored = await codex.restoreSessionDeletionBackup({ backupDirectory: result.backupDirectory, codexHome: fixture.codexHome });
  assert.match(restored.note, /storage layout changed/u);
  assert.equal(queryRows(fixture.stateDatabasePath, "select count(*) as count where exists(select 1 from threads where id = ?)", [fixtureSessionIds.standalone])[0].count, 1);
});
