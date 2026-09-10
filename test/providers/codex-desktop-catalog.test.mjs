import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getProvider } from "../../lib/providers/index.mjs";
import { deleteDesktopCatalogs, readDesktopCatalogs, restoreDesktopCatalogs } from "../../lib/providers/codex/desktop-catalog.mjs";
import { runSessionCleanup } from "../../lib/session-cleanup.mjs";
import { createCodexHomeFixture, fixtureSessionIds, removeCodexHomeFixture } from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
const selected = fixtureSessionIds.standalone;
const other = fixtureSessionIds.parent;

async function fixture(context, filenames = ["codex.db", "codex-dev.db"]) {
  const home = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(home.codexHome));
  await fs.mkdir(path.join(home.codexHome, "sqlite"));
  const paths = filenames.map((name) => path.join(home.codexHome, "sqlite", name));
  for (const file of paths) {
    const db = new DatabaseSync(file);
    db.exec(`
      create table local_thread_catalog (
        host_id text not null, thread_id text not null, display_title text not null,
        source_created_at real not null, source_updated_at real not null, cwd text,
        source_kind text not null, source_detail text, model_provider text, git_branch text,
        observation_sequence integer not null, missing_candidate integer not null default 0,
        thread_source text, source_recency_at real not null default 0,
        pending_observed_title integer not null default 0, project_id text, conversation_origin text,
        primary key (host_id, thread_id));
      create table local_thread_catalog_scan_entries (host_id text, thread_id text, removed integer not null default 0, primary key(host_id, thread_id)) without rowid;
      create table local_thread_catalog_metadata (id integer primary key, catalog_revision integer not null);
      create table local_thread_catalog_scan_checkpoints (host_id text primary key, checkpoint text not null, failed_at integer);
      create table local_thread_catalog_sync_state (host_id text primary key, observation_sequence integer not null);
      create table local_thread_catalog_hosts (host_id text primary key, host_kind text not null);
      create table unrelated_settings (key text primary key, value text);
      insert into unrelated_settings values ('theme', 'dark');
      insert into local_thread_catalog_hosts values ('local','local'), ('remote-test','ssh'), ('chatgpt:test','chatgpt');
      insert into local_thread_catalog_sync_state values ('local', 10), ('remote-test', 90);
      insert into local_thread_catalog_metadata values (1, 5);
      insert into local_thread_catalog_scan_checkpoints values ('local','opaque-checkpoint',null);
    `);
    const insert = db.prepare(`insert into local_thread_catalog
      (host_id, thread_id, display_title, source_created_at, source_updated_at, source_kind, observation_sequence)
      values (?, ?, ?, 1, 2, 'cli', 10)`);
    for (const host of ["local", "remote-test", "chatgpt:test"]) {
      for (const id of [selected, other]) insert.run(host, id, `${host} title`);
      db.prepare("insert into local_thread_catalog_scan_entries values (?, ?, 0)").run(host, selected);
    }
    db.close();
  }
  return { ...home, paths };
}

function query(file, sql, ...args) {
  const db = new DatabaseSync(file);
  try { return db.prepare(sql).all(...args).map((row) => ({ ...row })); } finally { db.close(); }
}

for (const scope of ["core", "deep"]) {
  test(`Codex ${scope} removes local sidebar ghosts and restores only their rows`, async (context) => {
    const f = await fixture(context);
    const before = readDesktopCatalogs(f.codexHome, [selected]);
    const untouched = f.paths.map((file) => query(file, "select * from local_thread_catalog where host_id != 'local' or thread_id != ? order by host_id, thread_id", selected));
    const store = await codex.loadDeletionStore({ codexHome: f.codexHome, recordIds: [selected] });
    const plan = await codex.planSessionDeletion({ recordIds: [selected], store });
    const result = await codex.executeSessionDeletion({ plan, store, scope });
    assert.equal((await codex.verifySessionDeletion({ plan, store, scope })).complete, true);
    const operation = JSON.parse(await fs.readFile(path.join(result.backupDirectory, "operation.json"), "utf8"));
    assert.deepEqual(operation.desktopCatalogs, JSON.parse(JSON.stringify(before)));
    assert.equal(operation.files.some((entry) => entry.originalPath.endsWith(".db")), false);
    for (const [index, file] of f.paths.entries()) {
      assert.deepEqual(query(file, "select * from local_thread_catalog where host_id != 'local' or thread_id != ? order by host_id, thread_id", selected), untouched[index]);
      assert.deepEqual(query(file, "select removed from local_thread_catalog_scan_entries where host_id='local' and thread_id=?", selected), [{ removed: 1 }]);
      assert.deepEqual(query(file, "select catalog_revision from local_thread_catalog_metadata"), [{ catalog_revision: 6 }]);
      query(file, "update unrelated_settings set value='light' returning *");
      query(file, "update local_thread_catalog set display_title='newer unrelated title' where host_id='local' and thread_id=? returning *", other);
    }
    await codex.restoreSessionDeletionBackup({ codexHome: f.codexHome, backupDirectory: result.backupDirectory });
    assert.deepEqual(readDesktopCatalogs(f.codexHome, [selected]), before);
    for (const file of f.paths) {
      assert.deepEqual(query(file, "select value from unrelated_settings"), [{ value: "light" }]);
      assert.deepEqual(query(file, "select display_title from local_thread_catalog where host_id='local' and thread_id=?", other), [{ display_title: "newer unrelated title" }]);
      assert.deepEqual(query(file, "select checkpoint from local_thread_catalog_scan_checkpoints"), [{ checkpoint: "opaque-checkpoint" }]);
    }
  });
}

test("catalogue fingerprints track selected rows, not unrelated app changes", async (context) => {
  const f = await fixture(context);
  const store = await codex.loadDeletionStore({ codexHome: f.codexHome, recordIds: [selected] });
  const plan = await codex.planSessionDeletion({ recordIds: [selected], store });
  const fingerprint = () => codex.fingerprintSessionDeletion({ plan, store, scope: "core" });
  const before = await fingerprint();
  query(f.paths[0], "update unrelated_settings set value='light' returning *");
  assert.equal(await fingerprint(), before);
  query(f.paths[0], "update local_thread_catalog set display_title='changed' where host_id='local' and thread_id=? returning *", selected);
  assert.notEqual(await fingerprint(), before);
});

test("catalogue changes after backup stop deletion without losing the changed row", async (context) => {
  const f = await fixture(context);
  const backup = readDesktopCatalogs(f.codexHome, [selected]);
  query(f.paths[0], "update local_thread_catalog set display_title='changed' where host_id='local' and thread_id=? returning *", selected);
  assert.throws(() => deleteDesktopCatalogs(f.codexHome, [selected], backup), /changed after backup/);
  assert.equal(readDesktopCatalogs(f.codexHome, [selected]).every((entry) => entry.rows.length === 1), true);
});

test("restore does not overwrite a newer row and rejects foreign-host backup rows", async (context) => {
  const f = await fixture(context);
  const backup = readDesktopCatalogs(f.codexHome, [selected]);
  query(f.paths[0], "update local_thread_catalog set display_title='newer' where host_id='local' and thread_id=? returning *", selected);
  restoreDesktopCatalogs(f.codexHome, [selected], backup);
  assert.equal(readDesktopCatalogs(f.codexHome, [selected])[0].rows[0].display_title, "newer");
  backup[0].rows[0].host_id = "chatgpt:test";
  assert.throws(() => restoreDesktopCatalogs(f.codexHome, [selected], backup), /Invalid/);
});

test("missing catalogues are optional and unknown schemas stop before session deletion", async (context) => {
  const f = await fixture(context, []);
  assert.deepEqual(readDesktopCatalogs(f.codexHome, [selected]), []);
  const file = path.join(f.codexHome, "sqlite", "codex.db");
  query(file, "create table other_data (id text)");
  assert.deepEqual(readDesktopCatalogs(f.codexHome, [selected]), []);
  query(file, "create table local_thread_catalog (thread_id text)");
  const store = await codex.loadDeletionStore({ codexHome: f.codexHome, recordIds: [selected] });
  const plan = await codex.planSessionDeletion({ recordIds: [selected], store });
  await assert.rejects(codex.executeSessionDeletion({ plan, store, scope: "core" }), /layout is not recognized/);
  assert.ok(await codex.getSessionRecord({ codexHome: f.codexHome, id: selected }));
});

test("verification detects recreated catalogue rows and shared cleanup recovers the backup", async (context) => {
  const f = await fixture(context);
  const before = readDesktopCatalogs(f.codexHome, [selected]);
  const provider = { ...codex, verifySessionDeletion: async (args) => {
    restoreDesktopCatalogs(f.codexHome, [selected], before);
    const verification = await codex.verifySessionDeletion(args);
    assert.equal(verification.complete, false);
    assert.equal(verification.remainingDesktopCatalogEntries.length, 2);
    return verification;
  } };
  const result = await runSessionCleanup({ provider, options: { codexHome: f.codexHome }, recordIds: [selected], scope: "core" });
  assert.equal(result.status, "restored");
  assert.deepEqual(readDesktopCatalogs(f.codexHome, [selected]), before);
});

test("catalogue paths reject symlinks rather than following them outside the home", { skip: process.platform === "win32" }, async (context) => {
  const f = await fixture(context, ["codex.db"]);
  await fs.symlink(f.paths[0], path.join(f.codexHome, "sqlite", "codex-dev.db"));
  assert.throws(() => readDesktopCatalogs(f.codexHome, [selected]), /not a regular/);
});

test("a scan without a checkpoint cannot resurrect a deleted catalogue entry", async (context) => {
  const f = await fixture(context, ["codex.db"]);
  query(f.paths[0], "delete from local_thread_catalog_scan_checkpoints returning *");
  const before = readDesktopCatalogs(f.codexHome, [selected]);
  deleteDesktopCatalogs(f.codexHome, [selected], before);
  assert.deepEqual(query(f.paths[0], "select removed from local_thread_catalog_scan_entries where host_id='local' and thread_id=?", selected), [{ removed: 1 }]);
  assert.deepEqual(query(f.paths[0], "select observation_sequence from local_thread_catalog_sync_state where host_id='local'"), [{ observation_sequence: 11 }]);
});

test("a failure after catalogue deletion rolls its rows back through normal recovery", async (context) => {
  const f = await fixture(context);
  const before = readDesktopCatalogs(f.codexHome, [selected]);
  let failed = false;
  const result = await runSessionCleanup({
    provider: codex, options: { codexHome: f.codexHome }, recordIds: [selected], scope: "core",
    onProgress: (update) => {
      if (!failed && update.message === "Updating session records") {
        failed = true;
        assert.equal(readDesktopCatalogs(f.codexHome, [selected]).every((entry) => entry.rows.length === 0), true);
        throw new Error("simulated failure after catalogue mutation");
      }
    },
  });
  assert.equal(failed, true);
  assert.equal(result.status, "restored");
  assert.deepEqual(readDesktopCatalogs(f.codexHome, [selected]), before);
});

test("catalogue restore rejects path traversal and unknown layouts before restoring session files", async (context) => {
  const f = await fixture(context);
  const backup = readDesktopCatalogs(f.codexHome, [selected]);
  const bad = structuredClone(backup);
  bad[0].filename = "../state_5.sqlite";
  assert.throws(() => restoreDesktopCatalogs(f.codexHome, [selected], bad), /Invalid/);
  query(f.paths[0], "alter table local_thread_catalog add column future_data text");
  assert.throws(() => restoreDesktopCatalogs(f.codexHome, [selected], backup), /schema changed/);
});

test("empty catalogue snapshots do not prevent restoring sessions if the app cache was removed", async (context) => {
  const f = await fixture(context, ["codex.db"]);
  const backup = readDesktopCatalogs(f.codexHome, ["absent"]);
  await fs.unlink(f.paths[0]);
  assert.doesNotThrow(() => restoreDesktopCatalogs(f.codexHome, ["absent"], backup));
});
