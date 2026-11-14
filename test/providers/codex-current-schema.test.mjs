import assert from "node:assert/strict";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { queryRows } from "../../lib/storage/sqlite.mjs";
import { createCodexHomeFixture, fixtureSessionIds, removeCodexHomeFixture } from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
const ownedTables = ["thread_attachments", "guardian_review_feedback", "thread_read_receipts"];

async function currentFixture(context) {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const threads = queryRows(fixture.stateDatabasePath, "select * from threads");
  await rm(fixture.stateDatabasePath);
  const schema = await readFile(new URL("../fixtures/codex-0.169.0-state.sql", import.meta.url), "utf8");
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
    }
    database.prepare("insert into thread_spawn_edges values (?, ?, 'completed')").run(fixtureSessionIds.parent, fixtureSessionIds.child);
    database.prepare("update threads set name = 'A renamed session' where id = ?").run(fixtureSessionIds.parent);
  } finally {
    database.close();
  }
  return fixture;
}

for (const scope of ["core", "deep"]) {
  test(`Codex 0.169.0 ${scope} cleanup removes owned metadata, verifies it, and restores it`, async (context) => {
    const fixture = await currentFixture(context);
    assert.equal((await codex.diagnoseStorageCompatibility(fixture)).status, "ready");
    // A second current store also exercises versioned-store cleanup and recovery.
    const secondPath = path.join(fixture.codexHome, "state_6.sqlite");
    await copyFile(fixture.stateDatabasePath, secondPath);
    codex.invalidateSessionCache(fixture);
    const store = await codex.loadDeletionStore({ ...fixture, recordIds: [fixtureSessionIds.parent] });
    const plan = await codex.planSessionDeletion({ store, recordIds: [fixtureSessionIds.parent] });
    assert.equal(plan.stateRelatedRowCount, 12);
    assert.equal(plan.records.find(({ id }) => id === fixtureSessionIds.parent).displayName, "A renamed session");
    const before = await codex.fingerprintSessionDeletion({ store, plan, scope });
    const changed = new DatabaseSync(secondPath);
    changed.prepare("update guardian_review_feedback set record = ? where thread_id = ?").run(Buffer.from("changed"), fixtureSessionIds.parent);
    changed.close();
    assert.notEqual(await codex.fingerprintSessionDeletion({ store, plan, scope }), before);
    const snapshots = new Map([fixture.stateDatabasePath, secondPath].map((file) => [file,
      ownedTables.map((table) => queryRows(file, `select * from ${table} order by thread_id`)),
    ]));
    const result = await codex.executeSessionDeletion({ store, plan, scope });
    assert.equal((await codex.verifySessionDeletion({ store, plan, scope })).complete, true);
    for (const file of snapshots.keys()) {
      for (const table of ownedTables) {
        assert.deepEqual(queryRows(file, `select thread_id from ${table}`).map(({ thread_id }) => thread_id), [fixtureSessionIds.standalone]);
      }
      assert.equal(queryRows(file, "select count(*) as count from projects")[0].count, 1);
    }
    // Read receipts have no foreign key: verification must detect recreation.
    const recreated = new DatabaseSync(secondPath);
    recreated.prepare("insert into thread_read_receipts values (?, null, 'new', null)").run(fixtureSessionIds.parent);
    recreated.close();
    const verification = await codex.verifySessionDeletion({ store, plan, scope });
    assert.equal(verification.complete, false);
    assert.equal(verification.remainingStateRelatedRecords.length, 1);
    await codex.restoreSessionDeletionBackup({ ...fixture, backupDirectory: result.backupDirectory });
    for (const [file, rows] of snapshots) {
      assert.deepEqual(ownedTables.map((table) => queryRows(file, `select * from ${table} order by thread_id`)), rows);
    }
  });
}

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
