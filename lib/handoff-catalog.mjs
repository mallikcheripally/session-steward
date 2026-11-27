import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";

import { HANDOFF_DIRECTORY } from "./session-handoff.mjs";
import { getDefaultDataDirectory } from "./platform.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_MANIFEST_BYTES = 256 * 1024;

function error(message) { return Object.assign(new Error(message), { code: "HANDOFF_CATALOG_ERROR" }); }
function idValue(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw error("Choose a recognized handoff archive.");
  return value;
}
function publicRow(row) {
  return {
    id: row.id, directory: row.directory, workspace: row.workspace,
    providerId: row.provider_id, sessionId: row.session_id, title: row.title,
    target: row.target, createdAtMs: row.created_at_ms, lastHandoffAtMs: row.last_handoff_at_ms,
    byteCount: row.byte_count, eventCount: row.event_count, partial: Boolean(row.partial), state: row.state,
  };
}

async function readManifest(directory) {
  const file = path.join(directory, "manifest.json");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw error("The archive manifest is not recognized.");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  if (![1, 2].includes(manifest.formatVersion) || !["codex", "claude-code"].includes(manifest.providerId)
    || typeof manifest.sessionId !== "string" || manifest.sessionId.length > 512
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isSafeInteger(manifest.chunkCount)
    || manifest.chunkCount < 1 || manifest.chunkCount > 200_000 || !Number.isSafeInteger(manifest.eventCount)
    || manifest.eventCount < 1 || !Array.isArray(manifest.warnings) || manifest.warnings.length > 20
    || manifest.warnings.some(value => typeof value !== "string" || value.length > 4096)) throw error("The archive manifest is not recognized.");
  return manifest;
}

async function archiveInventory(directory, manifest) {
  const hash = createHash("sha256"); let bytes = 0;
  async function include(relative) {
    const stat = await fs.lstat(path.join(directory, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) throw error("An archive file was replaced or linked.");
    hash.update(JSON.stringify([relative, stat.size, stat.mtimeMs, stat.ctimeMs, String(stat.ino), String(stat.dev)]));
    bytes += stat.size;
  }
  for await (const entry of await fs.opendir(directory)) {
    if (!["START.md", "RECENT.md", "manifest.json", "history", "index"].includes(entry.name)) throw error("The archive contains unexpected files.");
  }
  for (const [folder, count, pattern] of [
    ["history", manifest.chunkCount, /^part-(\d{6})\.md$/u],
    ["index", manifest.indexPages, /^page-(\d{5})\.md$/u],
  ]) {
    const folderPath = path.join(directory, folder);
    const stat = await fs.lstat(folderPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(count) || count < 1 || count > 200_000) throw error("The archive layout has changed.");
    let found = 0;
    for await (const entry of await fs.opendir(folderPath)) {
      const match = pattern.exec(entry.name);
      if (!entry.isFile() || !match || Number(match[1]) < 1 || Number(match[1]) > count) throw error("The archive layout has changed.");
      if (++found > count) throw error("The archive layout has changed.");
    }
    if (found !== count) throw error("Some archive files are missing.");
    for (let number = 1; number <= count; number += 1) await include(path.join(folder, folder === "history" ? `part-${String(number).padStart(6, "0")}.md` : `page-${String(number).padStart(5, "0")}.md`));
  }
  for (const name of ["START.md", "RECENT.md", "manifest.json"]) await include(name);
  return { signature: hash.digest("hex"), bytes };
}

export async function createHandoffCatalog({ dataDirectory = getDefaultDataDirectory(), now = Date.now } = {}) {
  if (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) throw error("Choose an absolute application data folder.");
  await fs.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDirectory, "handoffs.sqlite");
  try {
    const stat = await fs.lstat(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw error("The handoff catalog path is not a regular file.");
  } catch (issue) { if (issue.code !== "ENOENT") throw issue; }
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  let closed = false;
  try {
    db.exec("begin immediate");
    const version = db.prepare("pragma user_version").get().user_version;
    if (version !== 0 && version !== 1) throw error("This handoff catalog version is not supported.");
    if (version === 0) {
      if (db.prepare("select count(*) as count from sqlite_master where type = 'table'").get().count) throw error("The handoff catalog contains an unexpected schema.");
      db.exec(`create table handoffs (
        id text primary key, directory text not null, workspace text not null,
        provider_id text not null, session_id text not null, title text not null,
        source_key text, target text not null, created_at_ms integer not null,
        last_handoff_at_ms integer not null, byte_count integer not null,
        event_count integer not null, partial integer not null,
        directory_device text not null, directory_inode text not null, archive_signature text not null,
        state text not null default 'ready'
      );
      create index handoff_source on handoffs(source_key, state);
      create index handoff_recent on handoffs(last_handoff_at_ms desc, id);
      create index handoff_workspace on handoffs(workspace);
      pragma user_version = 1;`);
    }
    db.exec("create index if not exists handoff_session on handoffs(provider_id, session_id, last_handoff_at_ms desc, id)");
    db.exec("commit");
    db.exec("pragma journal_mode = wal");
    await fs.chmod(databasePath, 0o600);
  } catch (issue) { if (db.isTransaction) db.exec("rollback"); db.close(); throw issue; }

  function get(id) { return db.prepare("select * from handoffs where id = ?").get(idValue(id)); }

  async function ownedDirectory(row, { deleting = false, requireManifest = true } = {}) {
    idValue(row.id);
    if (!path.isAbsolute(row.workspace) || row.directory !== path.join(row.workspace, HANDOFF_DIRECTORY, row.id)) throw error("The archive location is not recognized.");
    if (await fs.realpath(row.workspace) !== row.workspace) throw error("The project folder has moved or is linked. Reconnect it before cleanup.");
    const root = path.dirname(row.directory);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw error("The handoff folder is linked or has changed.");
    if (typeof process.getuid === "function" && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o022))) throw error("The handoff folder is writable by another user.");
    const directory = deleting ? path.join(root, `.deleting-${row.id}`) : row.directory;
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== row.directory_device || String(stat.ino) !== row.directory_inode) throw error("The archive folder was replaced. It was left untouched.");
    let manifest = null;
    if (requireManifest) {
      manifest = await readManifest(directory);
      if (manifest.providerId !== row.provider_id || manifest.sessionId !== row.session_id
        || (manifest.formatVersion === 2 && (manifest.createdBy !== "session-steward" || manifest.archiveId !== row.id))) throw error("The archive identity has changed. It was left untouched.");
    }
    return { directory, manifest };
  }

  async function register({ directory, metadata, title, target, lastHandoffAtMs = now() }) {
    const id = idValue(path.basename(directory));
    const workspace = await fs.realpath(path.dirname(path.dirname(directory)));
    if (directory !== path.join(workspace, HANDOFF_DIRECTORY, id)) throw error("The archive location is not recognized.");
    const manifest = await readManifest(directory);
    if (manifest.formatVersion === 2 && (manifest.createdBy !== "session-steward" || manifest.archiveId !== id)) throw error("The archive identity is not recognized.");
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("The archive folder is not recognized.");
    const candidate = { id, directory, workspace, directory_device: String(stat.dev), directory_inode: String(stat.ino), provider_id: manifest.providerId, session_id: manifest.sessionId };
    await ownedDirectory(candidate);
    const inventory = await archiveInventory(directory, manifest);
    db.prepare(`insert into handoffs values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
      on conflict(id) do update set directory = excluded.directory, workspace = excluded.workspace,
        directory_device = excluded.directory_device, directory_inode = excluded.directory_inode,
        byte_count = excluded.byte_count, archive_signature = excluded.archive_signature,
        source_key = excluded.source_key, state = 'ready'`).run(
      id, directory, workspace, manifest.providerId, manifest.sessionId, String(title ?? manifest.sessionId).slice(0, 512),
      metadata?.sourceKey ?? null, target === "claude" ? "claude" : "chatgpt", Date.parse(manifest.createdAt), lastHandoffAtMs,
      inventory.bytes, manifest.eventCount ?? 0, Number(Boolean(manifest.partial)), String(stat.dev), String(stat.ino), inventory.signature,
    );
    return publicRow(get(id));
  }

  async function cleanupDirectory(row) {
    if (row.state === "ready") return ownedDirectory(row);
    try { return await ownedDirectory(row, { deleting: true, requireManifest: false }); }
    catch (issue) {
      // A crash can happen after marking the row but before the atomic rename.
      if (issue.code !== "ENOENT") throw issue;
      return ownedDirectory(row);
    }
  }

  async function getReady(id) {
    const row = get(id);
    if (!row || row.state !== "ready") throw error("This handoff is unavailable. Prepare it again.");
    const { manifest } = await ownedDirectory(row);
    if ((await archiveInventory(row.directory, manifest)).signature !== row.archive_signature) throw error("The archive files have changed. Prepare a fresh handoff before opening it.");
    return { row: publicRow(row), manifest };
  }

  return {
    databasePath,
    close: () => { if (!closed) { db.close(); closed = true; } },
    register,
    getReady,
    touch(id, target) { db.prepare("update handoffs set last_handoff_at_ms = ?, target = ? where id = ? and state = 'ready'").run(now(), target, idValue(id)); },
    async findReusable(sourceKey) {
      const row = db.prepare("select * from handoffs where source_key = ? and state = 'ready' order by last_handoff_at_ms desc limit 1").get(sourceKey);
      if (!row) return null;
      try {
        const { manifest } = await ownedDirectory(row);
        if (manifest.formatVersion !== 2 || (await archiveInventory(row.directory, manifest)).signature !== row.archive_signature) return null;
        return { row: publicRow(row), manifest };
      } catch { return null; }
    },
    async list({ page = 1, pageSize = 25, search = "", olderDays = 0, sort = "recent", providerId = null, sessionId = null } = {}) {
      pageSize = Math.max(1, Math.min(Number.isSafeInteger(pageSize) ? pageSize : 25, 100));
      page = Math.max(1, Number.isSafeInteger(page) ? page : 1);
      const conditions = []; const parameters = [];
      let scope = null;
      if (providerId !== null || sessionId !== null) {
        if (!["codex", "claude-code"].includes(providerId) || typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 512) throw error("Choose a valid source provider and session together.");
        conditions.push("provider_id = ? and session_id = ?"); parameters.push(providerId, sessionId);
        const session = db.prepare("select title from handoffs where provider_id = ? and session_id = ? order by last_handoff_at_ms desc, id limit 1").get(providerId, sessionId);
        scope = { providerId, sessionId, title: session?.title ?? null };
      }
      if (search) { conditions.push("instr(lower(workspace || ' ' || title || ' ' || session_id), ?) > 0"); parameters.push(String(search).slice(0, 500).toLowerCase()); }
      if (olderDays !== 0) {
        if (!Number.isSafeInteger(olderDays) || olderDays < 1 || olderDays > 3650) throw error("Choose an age between 1 and 3650 days.");
        conditions.push("last_handoff_at_ms < ?"); parameters.push(now() - olderDays * 86_400_000);
      }
      const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
      const totals = db.prepare(`select count(*) as total, coalesce(sum(byte_count), 0) as totalBytes from handoffs ${where}`).get(...parameters);
      const all = db.prepare("select count(*) as count, coalesce(sum(byte_count), 0) as bytes from handoffs").get();
      const pages = Math.max(1, Math.ceil(totals.total / pageSize)); page = Math.min(page, pages);
      const order = sort === "size" ? "byte_count desc, id" : "last_handoff_at_ms desc, id";
      const rows = db.prepare(`select * from handoffs ${where} order by ${order} limit ? offset ?`).all(...parameters, pageSize, (page - 1) * pageSize);
      const records = [];
      for (const row of rows) {
        let availability = row.state === "ready" ? "available" : "cleanup-incomplete";
        try { await cleanupDirectory(row); }
        catch (issue) { availability = issue.code === "ENOENT" ? "missing" : "changed"; }
        records.push({ ...publicRow(row), availability });
      }
      return { records, page, pages, pageSize, ...totals, allCount: all.count, allBytes: all.bytes, scope };
    },
    async remove(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw error("Select between 1 and 100 handoff archives.");
      ids = [...new Set(ids.map(idValue))];
      let release;
      try { release = await lockfile.lock(databasePath, { realpath: true, retries: 0, stale: 30_000, update: 10_000 }); }
      catch (issue) { if (issue.code === "ELOCKED") throw error("Wait for the current handoff cleanup to finish."); throw issue; }
      const deletedIds = []; const failures = []; let freedBytes = 0;
      try {
        for (const id of ids) {
          const row = get(id);
          if (!row) { failures.push({ id, code: "NOT_LISTED", message: "This handoff is no longer listed." }); continue; }
          let marked = false;
          try {
            const { directory } = await cleanupDirectory(row);
            const interrupted = directory !== row.directory;
            const tombstone = path.join(path.dirname(row.directory), `.deleting-${id}`);
            db.prepare("update handoffs set state = 'deleting' where id = ?").run(id);
            marked = true;
            if (!interrupted) {
              try { await fs.lstat(tombstone); throw error("An unexpected cleanup folder already exists."); }
              catch (issue) { if (issue.code !== "ENOENT") throw issue; }
              await fs.rename(directory, tombstone);
            }
            await fs.rm(tombstone, { recursive: true, force: false });
            db.prepare("delete from handoffs where id = ?").run(id);
            deletedIds.push(id); freedBytes += row.byte_count;
          } catch (issue) {
            // If renaming never happened, keep the ordinary archive usable.
            try {
              if (!marked) throw issue;
              await ownedDirectory(row);
              db.prepare("update handoffs set state = 'ready' where id = ?").run(id);
            } catch { if (marked && row.state === "ready") db.prepare("update handoffs set state = 'error' where id = ?").run(id); }
            failures.push({ id, message: issue.code === "ENOENT" ? "The project or archive folder is unavailable. Reconnect it, or remove only its listing." : issue.message });
          }
        }
      } finally { await release(); }
      return { deletedIds, freedBytes, failures };
    },
    async forgetMissing(id) {
      const row = get(id);
      if (!row) throw error("This handoff is no longer listed.");
      try { await cleanupDirectory(row); }
      catch (issue) {
        if (issue.code !== "ENOENT") throw issue;
        db.prepare("delete from handoffs where id = ?").run(id);
        return;
      }
      throw error("This archive still exists. Use Delete selected to remove its files.");
    },
    async importWorkspace({ workspace, offset = 0 } = {}) {
      if (typeof workspace !== "string" || !path.isAbsolute(workspace) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw error("Choose an existing local project folder.");
      workspace = await fs.realpath(workspace);
      const root = path.join(workspace, HANDOFF_DIRECTORY);
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("That project does not have a recognized handoff folder.");
      const ignored = await fs.lstat(path.join(root, ".gitignore"));
      if (!ignored.isFile() || ignored.isSymbolicLink() || ignored.size > 4 || (await fs.readFile(path.join(root, ".gitignore"), "utf8")).trim() !== "*") throw error("That project does not have a recognized handoff folder.");
      let cursor = 0; let imported = 0; let skipped = 0; let nextOffset = null;
      const started = performance.now();
      for await (const entry of await fs.opendir(root)) {
        if (cursor++ < offset) continue;
        if (cursor - offset > 100 || performance.now() - started > 5000) { nextOffset = cursor - 1; break; }
        if (!UUID.test(entry.name) || !entry.isDirectory()) continue;
        const directory = path.join(root, entry.name);
        if (get(entry.name)?.directory === directory) continue;
        try {
          const manifest = await readManifest(directory);
          await register({ directory, title: manifest.sessionId, target: manifest.providerId === "codex" ? "claude" : "chatgpt", lastHandoffAtMs: Date.parse(manifest.createdAt) });
          imported += 1;
        } catch { skipped += 1; }
      }
      return { imported, skipped, nextOffset, workspace };
    },
  };
}
