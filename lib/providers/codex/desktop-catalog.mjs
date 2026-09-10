import { lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { batches, placeholders } from "../../storage/sqlite.mjs";

const FILENAMES = ["codex.db", "codex-dev.db"];
const TABLE = "local_thread_catalog";
const SCAN_TABLE = "local_thread_catalog_scan_entries";
const REQUIREMENTS = {
  [TABLE]: ["host_id", "thread_id", "observation_sequence", "missing_candidate"],
  [SCAN_TABLE]: ["host_id", "thread_id", "removed"],
  local_thread_catalog_hosts: ["host_id", "host_kind"],
  local_thread_catalog_metadata: ["id", "catalog_revision"],
  local_thread_catalog_scan_checkpoints: ["host_id", "checkpoint"],
  local_thread_catalog_sync_state: ["host_id", "observation_sequence"],
};

function regularPath(filePath, directory = false) {
  try {
    const stats = lstatSync(filePath);
    if (directory ? !stats.isDirectory() : !stats.isFile()) {
      throw new Error("The Codex desktop catalogue path is not a regular file or directory. It was left unchanged.");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function catalogPath(codexHome, filename) {
  if (!FILENAMES.includes(filename)) throw new Error("Unrecognized Codex desktop catalogue backup.");
  const directory = path.join(codexHome, "sqlite");
  return regularPath(directory, true) ? path.join(directory, filename) : null;
}

function schema(db) {
  if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(TABLE)) return null;
  const columns = {};
  for (const [table, required] of Object.entries(REQUIREMENTS)) {
    const info = db.prepare(`pragma table_info(${table})`).all();
    columns[table] = info.map((column) => column.name);
    if (!required.every((name) => columns[table].includes(name))
      || ([TABLE, SCAN_TABLE].includes(table)
        && info.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name).join() !== "host_id,thread_id")) {
      throw new Error("The Codex desktop catalogue layout is not recognized. Cleanup stopped without changing it.");
    }
  }
  const host = db.prepare("select host_kind from local_thread_catalog_hosts where host_id = 'local'").get();
  const hasLocalRows = db.prepare(`select 1 from ${TABLE} where host_id = 'local' limit 1`).get();
  if ((host && host.host_kind !== "local") || (hasLocalRows && !host)) {
    throw new Error("The Codex desktop catalogue local host could not be verified.");
  }
  if (!db.prepare("select 1 from local_thread_catalog_metadata where id = 1").get()) {
    throw new Error("The Codex desktop catalogue revision is missing.");
  }
  return columns;
}

function selectedRows(db, table, ids) {
  return [...batches([...new Set(ids)].sort())].flatMap((batch) => db.prepare(
    `select * from ${table} where host_id = 'local' and thread_id in (${placeholders(batch)}) order by thread_id`,
  ).all(...batch));
}

function snapshot(db, filename, ids) {
  const columns = schema(db);
  return columns ? {
    filename,
    columns: columns[TABLE],
    rows: selectedRows(db, TABLE, ids),
    scanRows: selectedRows(db, SCAN_TABLE, ids),
  } : null;
}

// Only known app-owned databases beneath this run's Codex home, never a
// process-global/default home or arbitrary database supplied by a backup.
export function readDesktopCatalogs(codexHome, ids) {
  const result = [];
  for (const filename of FILENAMES) {
    const filePath = catalogPath(codexHome, filename);
    if (!filePath || !regularPath(filePath)) continue;
    const db = new DatabaseSync(filePath, { readOnly: true, timeout: 5_000 });
    try {
      db.exec("begin");
      const entry = snapshot(db, filename, ids);
      if (entry) result.push(entry);
    } finally { db.close(); }
  }
  return result;
}

function transaction(codexHome, entry, callback) {
  const filePath = catalogPath(codexHome, entry.filename);
  if (!filePath || !regularPath(filePath)) throw new Error("The Codex desktop catalogue disappeared. Restart cleanup after refreshing.");
  const db = new DatabaseSync(filePath, { timeout: 5_000 });
  try {
    db.exec("begin immediate");
    const columns = schema(db);
    if (!columns) throw new Error("The Codex desktop catalogue layout changed.");
    callback(db, columns);
    db.exec("commit");
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  } finally { db.close(); }
}

export function deleteDesktopCatalogs(codexHome, ids, backup) {
  if (JSON.stringify(readDesktopCatalogs(codexHome, ids)) !== JSON.stringify(backup)) {
    throw new Error("The selected Codex desktop catalogue entries changed after backup. Refresh and try again.");
  }
  for (const entry of backup) {
    transaction(codexHome, entry, (db) => {
      if (JSON.stringify(snapshot(db, entry.filename, ids)) !== JSON.stringify(entry)) {
        throw new Error("The selected Codex desktop catalogue entries changed after backup. Refresh and try again.");
      }
      if (entry.rows.length === 0) return;
      // Match the app's authoritative-removal behavior: an in-flight scan
      // must not reinsert an entry from a page fetched before deletion.
      db.prepare("update local_thread_catalog_sync_state set observation_sequence = observation_sequence + 1 where host_id = 'local'").run();
      for (const batch of batches(entry.rows.map((row) => row.thread_id))) {
        // Also protect a scan whose first page is still in flight (it has no
        // persisted checkpoint yet). The app clears these at the next scan.
        const tombstone = db.prepare(`insert into ${SCAN_TABLE} (host_id, thread_id, removed) values ('local', ?, 1)
          on conflict(host_id, thread_id) do update set removed = 1`);
        for (const id of batch) tombstone.run(id);
        db.prepare(`delete from ${TABLE} where host_id = 'local' and thread_id in (${placeholders(batch)})`).run(...batch);
      }
      db.prepare("update local_thread_catalog_metadata set catalog_revision = catalog_revision + 1 where id = 1").run();
    });
  }
}

export function validateDesktopCatalogBackup(codexHome, ids, backup) {
  if (!Array.isArray(backup)) throw new Error("Invalid Codex desktop catalogue backup.");
  const allowed = new Set(ids);
  const names = new Set();
  for (const entry of backup) {
    if (!FILENAMES.includes(entry?.filename) || names.has(entry.filename)
      || !Array.isArray(entry.columns) || !Array.isArray(entry.rows) || !Array.isArray(entry.scanRows)
      || ![...entry.rows, ...entry.scanRows].every((row) => row.host_id === "local" && allowed.has(row.thread_id))) {
      throw new Error("Invalid Codex desktop catalogue backup.");
    }
    names.add(entry.filename);
    if (entry.rows.length === 0) continue;
    transaction(codexHome, entry, (_db, columns) => {
      if (JSON.stringify(columns[TABLE]) !== JSON.stringify(entry.columns)
        || entry.rows.some((row) => Object.keys(row).join() !== entry.columns.join())
        || entry.scanRows.some((row) => Object.keys(row).join() !== columns[SCAN_TABLE].join())) {
        throw new Error("The Codex desktop catalogue schema changed since backup. Its rows were left unchanged.");
      }
    });
  }
}

export function restoreDesktopCatalogs(codexHome, ids, backup) {
  validateDesktopCatalogBackup(codexHome, ids, backup);
  for (const entry of backup) {
    if (entry.rows.length === 0) continue;
    transaction(codexHome, entry, (db, columns) => {
      if (JSON.stringify(columns[TABLE]) !== JSON.stringify(entry.columns)) throw new Error("The Codex desktop catalogue schema changed during restore.");
      const quoted = entry.columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ");
      const insert = db.prepare(`insert into ${TABLE} (${quoted}) values (${placeholders(entry.columns)}) on conflict(host_id, thread_id) do nothing`);
      const restored = [];
      for (const row of entry.rows) {
        if (insert.run(...entry.columns.map((column) => row[column])).changes) restored.push(row.thread_id);
      }
      // Merge selected rows only: never restore the entire app database or
      // overwrite a newer entry, other hosts, settings, or scan checkpoints.
      for (const id of restored) {
        const prior = entry.scanRows.find((row) => row.thread_id === id);
        db.prepare(`delete from ${SCAN_TABLE} where host_id = 'local' and thread_id = ?`).run(id);
        if (prior) db.prepare(`insert into ${SCAN_TABLE} (host_id, thread_id, removed) values ('local', ?, ?)`).run(id, prior.removed);
      }
      if (restored.length) db.prepare("update local_thread_catalog_metadata set catalog_revision = catalog_revision + 1 where id = 1").run();
    });
  }
}
