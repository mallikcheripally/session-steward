import assert from "node:assert/strict";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { executePreparedSessionCleanup, prepareSessionCleanup, runSessionCleanup } from "../../lib/session-cleanup.mjs";
import { queryRows } from "../../lib/storage/sqlite.mjs";
import { createCodexHomeFixture, fixtureSessionIds, removeCodexHomeFixture } from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
function ownedTables(version) {
  return [
    ...["thread_attachments", "guardian_review_feedback", "thread_read_receipts"]
      .map((name) => ({ name, idColumn: "thread_id" })),
    ...(version !== "0.169.0" ? [{ name: "session_model_ids", idColumn: "session_id" }] : []),
  ];
}

async function currentFixture(context, version = "0.172.0") {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const threads = queryRows(fixture.stateDatabasePath, "select * from threads");
  await rm(fixture.stateDatabasePath);
  // Upstream 0.172.0 has the same 64 state migrations as 0.171.0.
  const schemaVersion = version === "0.172.0" ? "0.171.0" : version;
  const schema = await readFile(new URL(`../fixtures/codex-${schemaVersion}-state.sql`, import.meta.url), "utf8");
  const database = new DatabaseSync(fixture.stateDatabasePath);
  try {
    database.exec(schema);
    database.exec("insert into projects values ('shared-project', 'Shared project', '{}', 0, 1, 1)");
    for (const row of threads) {
      const values = { ...row, source: "cli", model_provider: "openai", sandbox_policy: "{}", approval_mode: "on-request", project_id: "shared-project" };
      const columns = Object.keys(values);
      database.prepare(`insert into threads (${columns.join(",")}) values (${columns.map(() => "?").join(",")})`).run(...Object.values(values));
      database.prepare("insert into thread_attachments values (?, ?, 'test', ?, '{}', 1)").run(`attachment-${row.id}`, row.id, row.id);
      database.prepare("insert into guardian_review_feedback values (?, ?, ?)").run(`review-${row.id}`, row.id, Buffer.from("review"));
      database.prepare("insert into thread_read_receipts values (?, null, 'revision-1', null)").run(row.id);
      if (version !== "0.169.0") {
        const insert = database.prepare("insert into session_model_ids values (?, 'artifact', ?, ?, ?)");
        insert.run(row.id, `first-${row.id}`, 0, "seed");
        insert.run(row.id, `second-${row.id}`, 1, null);
      }
    }
    database.prepare("insert into thread_spawn_edges values (?, ?, 'completed')").run(fixtureSessionIds.parent, fixtureSessionIds.child);
    database.prepare("update threads set name = 'A renamed session' where id = ?").run(fixtureSessionIds.parent);
  } finally {
    database.close();
  }
  return fixture;
}

for (const version of ["0.169.0", "0.171.0", "0.172.0"]) {
  for (const scope of ["core", "deep"]) {
    test(`Codex ${version} ${scope} cleanup removes owned metadata, verifies it, and restores it`, async (context) => {
      const fixture = await currentFixture(context, version);
      const tables = ownedTables(version);
      const compatibility = await codex.diagnoseStorageCompatibility(fixture);
      assert.equal(compatibility.status, "ready");
      assert.ok(compatibility.builtFor.codexCli.includes(version));
      // A second current store also exercises versioned-store cleanup and recovery.
      const secondPath = path.join(fixture.codexHome, "state_6.sqlite");
      await copyFile(fixture.stateDatabasePath, secondPath);
      codex.invalidateSessionCache(fixture);
      const store = await codex.loadDeletionStore({ ...fixture, recordIds: [fixtureSessionIds.parent] });
      const plan = await codex.planSessionDeletion({ store, recordIds: [fixtureSessionIds.parent] });
      assert.equal(plan.stateRelatedRowCount, version !== "0.169.0" ? 20 : 12);
      assert.equal(plan.records.find(({ id }) => id === fixtureSessionIds.parent).displayName, "A renamed session");
      const before = await codex.fingerprintSessionDeletion({ store, plan, scope });
      const changed = new DatabaseSync(secondPath);
      try {
        if (version !== "0.169.0") {
          changed.prepare("update session_model_ids set initial_state = 'unrelated' where session_id = ? and ordinal = 0").run(fixtureSessionIds.standalone);
          assert.equal(await codex.fingerprintSessionDeletion({ store, plan, scope }), before);
          changed.prepare("update session_model_ids set initial_state = 'changed' where session_id = ? and ordinal = 0").run(fixtureSessionIds.parent);
        } else {
          changed.prepare("update guardian_review_feedback set record = ? where thread_id = ?").run(Buffer.from("changed"), fixtureSessionIds.parent);
        }
      } finally { changed.close(); }
      assert.notEqual(await codex.fingerprintSessionDeletion({ store, plan, scope }), before);
      const snapshots = new Map([fixture.stateDatabasePath, secondPath].map((file) => [file,
        tables.map(({ name, idColumn }) => queryRows(file, `select * from ${name} order by ${idColumn}`)),
      ]));
      const result = await codex.executeSessionDeletion({ store, plan, scope });
      assert.equal((await codex.verifySessionDeletion({ store, plan, scope })).complete, true);
      for (const file of snapshots.keys()) {
        for (const { name, idColumn } of tables) {
          const remaining = queryRows(file, `select ${idColumn} from ${name}`);
          assert.equal(remaining.length, name === "session_model_ids" ? 2 : 1);
          assert.ok(remaining.every((row) => row[idColumn] === fixtureSessionIds.standalone));
        }
        assert.equal(queryRows(file, "select count(*) as count from projects")[0].count, 1);
      }
      // Neither read receipts nor model IDs have a foreign key. Verification
      // must detect recreation even after the owning thread has disappeared.
      const recreated = new DatabaseSync(secondPath);
      try {
        if (version !== "0.169.0") recreated.prepare("insert into session_model_ids values (?, 'artifact', 'recreated', 0, 'new')").run(fixtureSessionIds.parent);
        else recreated.prepare("insert into thread_read_receipts values (?, null, 'new', null)").run(fixtureSessionIds.parent);
      } finally { recreated.close(); }
      const verification = await codex.verifySessionDeletion({ store, plan, scope });
      assert.equal(verification.complete, false);
      assert.equal(verification.remainingStateRelatedRecords.length, 1);
      await codex.restoreSessionDeletionBackup({ ...fixture, backupDirectory: result.backupDirectory });
      for (const [file, rows] of snapshots) {
        assert.deepEqual(tables.map(({ name, idColumn }) => queryRows(file, `select * from ${name} order by ${idColumn}`)), rows);
      }
    });
  }
}

test("Codex cleans orphan model IDs in a recognized secondary store", async (context) => {
  const fixture = await currentFixture(context);
  const secondPath = path.join(fixture.codexHome, "state_6.sqlite");
  await copyFile(fixture.stateDatabasePath, secondPath);
  const database = new DatabaseSync(secondPath);
  try {
    database.prepare("delete from threads where id in (?, ?)").run(fixtureSessionIds.parent, fixtureSessionIds.child);
  } finally { database.close(); }
  const store = await codex.loadDeletionStore({ ...fixture, recordIds: [fixtureSessionIds.parent] });
  const plan = await codex.planSessionDeletion({ store, recordIds: [fixtureSessionIds.parent] });
  assert.ok(plan.stateTargets.some(({ ids }) => ids.length === 0));
  await codex.executeSessionDeletion({ store, plan, scope: "core" });
  assert.equal((await codex.verifySessionDeletion({ store, plan, scope: "core" })).complete, true);
  assert.equal(queryRows(secondPath, "select count(*) as count from session_model_ids")[0].count, 2);
});

test("Codex automatic recovery restores current model IDs after failed cleanup verification", async (context) => {
  const fixture = await currentFixture(context);
  const before = queryRows(fixture.stateDatabasePath, "select * from session_model_ids order by session_id, ordinal");
  const provider = {
    ...codex,
    verifySessionDeletion: async (options) => ({ ...await codex.verifySessionDeletion(options), complete: false }),
  };
  const result = await runSessionCleanup({ provider, options: fixture, recordIds: [fixtureSessionIds.parent], scope: "core" });
  assert.equal(result.status, "restored");
  assert.deepEqual(queryRows(fixture.stateDatabasePath, "select * from session_model_ids order by session_id, ordinal"), before);
});

test("Codex rejects a changed session_model_ids ownership column", async (context) => {
  const fixture = await currentFixture(context);
  const database = new DatabaseSync(fixture.stateDatabasePath);
  try { database.exec("alter table session_model_ids rename column session_id to thread_id"); }
  finally { database.close(); }
  const diagnostic = await codex.diagnoseStorageCompatibility(fixture);
  assert.equal(diagnostic.status, "unsupported");
  assert.match(diagnostic.changed.join(" "), /session_model_ids.*session_id/u);
  await assert.rejects(codex.assertDeepCleanupSupported(fixture), /not supported/u);
});

test("changes to selected Codex model IDs invalidate a reviewed cleanup before deletion", async (context) => {
  const fixture = await currentFixture(context);
  const request = { options: fixture, provider: codex, recordIds: [fixtureSessionIds.parent], scope: "core" };
  const prepared = await prepareSessionCleanup(request);
  const database = new DatabaseSync(fixture.stateDatabasePath);
  try {
    database.prepare("update session_model_ids set initial_state = 'changed after preview' where session_id = ? and ordinal = 0").run(fixtureSessionIds.parent);
  } finally { database.close(); }
  await assert.rejects(executePreparedSessionCleanup({ ...request, expectedFingerprint: prepared.fingerprint }), /changed/u);
  assert.equal(queryRows(fixture.stateDatabasePath, "select count(*) as count from threads")[0].count, 3);
  assert.equal(queryRows(fixture.stateDatabasePath, "select count(*) as count from session_model_ids")[0].count, 6);
  assert.deepEqual(await codex.listSessionDeletionBackups(fixture), []);
});

test("Codex uses current native session names in search, sorting, and inspection", async (context) => {
  const fixture = await currentFixture(context);
  const listed = await codex.listSessions({ ...fixture, search: "renamed session", sort: "name", pageSize: 1 });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].displayName, "A renamed session");
  assert.equal((await codex.listSessions({ ...fixture, sort: "name", pageSize: 1 })).records[0].id, fixtureSessionIds.parent);
  const record = await codex.getSessionRecord({ ...fixture, id: fixtureSessionIds.parent });
  assert.equal(record.displayName, "A renamed session");
  assert.equal(record.titleSource, "sqlite_name");
  assert.equal((await codex.loadSessionStore(fixture)).recordsById.get(record.id).displayName, record.displayName);
});

test("Codex rejects changed ownership columns before thorough cleanup", async (context) => {
  const fixture = await currentFixture(context);
  const database = new DatabaseSync(fixture.stateDatabasePath);
  database.exec("alter table thread_read_receipts rename column thread_id to owner_id");
  database.close();
  const diagnostic = await codex.diagnoseStorageCompatibility(fixture);
  assert.equal(diagnostic.status, "unsupported");
  assert.match(diagnostic.changed.join(" "), /thread_read_receipts.*thread_id/u);
});
