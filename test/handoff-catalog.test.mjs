import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHandoffCatalog } from "../lib/handoff-catalog.mjs";
import { createSessionHandoff, HANDOFF_DIRECTORY } from "../lib/session-handoff.mjs";
import { createCodexHomeFixture, fixtureSessionIds } from "./fixtures/codex-home.mjs";
import { createClaudeHomeFixture } from "./fixtures/claude-home.mjs";

const line = text => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";
async function setup(context, { clock } = {}) {
  const fixture = await createCodexHomeFixture();
  const configDirectory = path.join(fixture.codexHome, "catalog-config");
  const catalog = await createHandoffCatalog({ dataDirectory: configDirectory, ...(clock ? { now: clock } : {}) });
  await fs.appendFile(fixture.transcripts.parent, line("Continue the synthetic catalog test without publishing."));
  context.after(async () => { catalog.close(); await fs.rm(fixture.codexHome, { recursive: true, force: true }); });
  const prepare = (extra = {}) => createSessionHandoff({ providerId: "codex", providerHome: fixture.codexHome, id: fixtureSessionIds.parent, target: "claude", catalog, ...(clock ? { now: clock } : {}), ...extra });
  return { fixture, configDirectory, catalog, prepare };
}

test("archives stay project-local while their durable catalog lives in application data", async context => {
  const { fixture, catalog, configDirectory, prepare } = await setup(context);
  const source = await fs.readFile(fixture.transcripts.parent);
  const nativeDatabase = await fs.readFile(fixture.stateDatabasePath);
  const result = await prepare();
  assert.equal(path.dirname(result.directory), path.join(await fs.realpath(fixture.workspace), HANDOFF_DIRECTORY));
  assert.equal(catalog.databasePath, path.join(configDirectory, "handoffs.sqlite"));
  assert.ok(!catalog.databasePath.startsWith(result.directory));
  const listed = await catalog.list();
  assert.equal(listed.total, 1); assert.equal(listed.allCount, 1);
  assert.ok(listed.allBytes > 0);
  assert.equal(listed.records[0].availability, "available");
  assert.deepEqual(await fs.readFile(fixture.transcripts.parent), source);
  assert.deepEqual(await fs.readFile(fixture.stateDatabasePath), nativeDatabase);
});

test("unchanged handoffs reuse the existing archive and update the last-handoff time", async context => {
  let time = Date.now();
  const { catalog, prepare } = await setup(context, { clock: () => time });
  const first = await prepare(); const created = (await catalog.list()).records[0].createdAtMs;
  time += 40 * 86_400_000;
  const second = await prepare({ target: "chatgpt" });
  assert.equal(first.directory, second.directory); assert.equal(second.reused, true);
  const result = await catalog.list();
  assert.equal(result.total, 1); assert.equal(result.records[0].createdAtMs, created);
  assert.equal(result.records[0].lastHandoffAtMs, time);
  assert.equal(result.records[0].target, "chatgpt");
  assert.equal((await catalog.list({ olderDays: 30 })).total, 0);
});

test("changed sources and changed archive contents cannot reuse stale context", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const first = await prepare();
  await fs.appendFile(fixture.transcripts.parent, line("The current requirement changed."));
  const second = await prepare(); assert.notEqual(first.directory, second.directory);
  await fs.appendFile(path.join(second.directory, "history", "part-000001.md"), "Archive edited after creation");
  await assert.rejects(catalog.getReady(path.basename(second.directory)), /changed/);
  const third = await prepare(); assert.notEqual(second.directory, third.directory);
  assert.equal((await catalog.list()).total, 3);
});

test("source activity during archive verification prevents stale reuse", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const first = await prepare();
  const original = catalog.findReusable;
  context.mock.method(catalog, "findReusable", async key => {
    const reusable = await original(key);
    await fs.appendFile(fixture.transcripts.parent, line("Requirement recorded during verification."));
    return reusable;
  });
  const second = await prepare();
  assert.notEqual(first.directory, second.directory);
  assert.equal(second.reused, false);
  assert.match(await fs.readFile(path.join(second.directory, "history", "part-000001.md"), "utf8"), /Requirement recorded during verification/);
});

test("catalog filtering separates projects, paginates, and supports older/larger archives", async context => {
  let time = Date.now();
  const { fixture, catalog, prepare } = await setup(context, { clock: () => time });
  const first = await prepare(); time += 45 * 86_400_000;
  const other = path.join(fixture.codexHome, "another-project"); await fs.mkdir(other);
  await fs.appendFile(fixture.transcripts.parent, line("More recorded material ".repeat(100)));
  const second = await prepare({ workspace: other });
  const search = await catalog.list({ search: "another-project" });
  assert.equal(search.total, 1); assert.equal(search.records[0].directory, second.directory);
  const old = await catalog.list({ olderDays: 30 }); assert.equal(old.total, 1); assert.equal(old.records[0].directory, first.directory);
  const largest = await catalog.list({ sort: "size", pageSize: 1 }); assert.equal(largest.pages, 2); assert.equal(largest.records[0].directory, second.directory);
  assert.equal((await catalog.list({ page: 999, pageSize: 1 })).page, 2);
  assert.equal((await catalog.list({ pageSize: 1000 })).pageSize, 100);
  await assert.rejects(catalog.list({ olderDays: NaN }));
});

test("session-scoped handoffs use exact provider and session identity across snapshots", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const first = await prepare();
  await fs.appendFile(fixture.transcripts.parent, line("A later snapshot of the same source session."));
  const second = await prepare();
  const claude = await createClaudeHomeFixture();
  context.after(() => fs.rm(claude.root, { recursive: true, force: true }));
  assert.equal(claude.cliId, fixtureSessionIds.parent);
  const otherProvider = await createSessionHandoff({ providerId: "claude-code", providerHome: claude.claudeHome, desktopDataHome: claude.desktopDataHome, id: claude.cliId, workspace: fixture.workspace, target: "chatgpt", catalog });
  const codexScope = await catalog.list({ providerId: "codex", sessionId: fixtureSessionIds.parent, pageSize: 1, sort: "size" });
  assert.equal(codexScope.total, 2); assert.equal(codexScope.allCount, 3); assert.equal(codexScope.pages, 2);
  assert.equal(codexScope.records[0].directory, second.directory);
  assert.equal(codexScope.scope.providerId, "codex"); assert.equal(codexScope.scope.sessionId, fixtureSessionIds.parent);
  assert.ok(codexScope.scope.title);
  const pageTwo = await catalog.list({ providerId: "codex", sessionId: fixtureSessionIds.parent, pageSize: 1, page: 2, sort: "size" });
  assert.equal(pageTwo.records[0].directory, first.directory);
  const claudeScope = await catalog.list({ providerId: "claude-code", sessionId: fixtureSessionIds.parent });
  assert.equal(claudeScope.total, 1); assert.equal(claudeScope.records[0].directory, otherProvider.directory);
  assert.equal((await catalog.list({ providerId: "codex", sessionId: fixtureSessionIds.parent.slice(0, 8) })).total, 0);
  assert.equal((await catalog.list({ providerId: "codex", sessionId: fixtureSessionIds.parent, search: "no matching project" })).total, 0);
  assert.equal((await catalog.list()).scope, null);
});

test("a partial or invalid session scope is rejected instead of showing global handoffs", async context => {
  const { catalog } = await setup(context);
  for (const scope of [{ providerId: "codex" }, { sessionId: fixtureSessionIds.parent }, { providerId: "unknown", sessionId: fixtureSessionIds.parent }, { providerId: "codex", sessionId: "" }]) {
    await assert.rejects(catalog.list(scope), /provider and session together/);
  }
});

test("deleting a selected archive leaves chats, code, unrelated folders and other archives intact", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const first = await prepare();
  await fs.appendFile(fixture.transcripts.parent, line("Another snapshot"));
  const second = await prepare();
  const source = await fs.readFile(fixture.transcripts.parent);
  const database = await fs.readFile(fixture.stateDatabasePath);
  await fs.writeFile(path.join(fixture.workspace, "project-file.txt"), "preserve me");
  const unknown = path.join(path.dirname(first.directory), randomUUID()); await fs.mkdir(unknown); await fs.writeFile(path.join(unknown, "not-an-archive.txt"), "preserve me too");
  const removed = await catalog.remove([path.basename(first.directory)]);
  assert.equal(removed.deletedIds.length, 1); assert.equal(removed.failures.length, 0);
  assert.ok(removed.freedBytes > 0);
  await assert.rejects(fs.access(first.directory), { code: "ENOENT" });
  await fs.access(second.startPath); await fs.access(path.join(unknown, "not-an-archive.txt"));
  assert.equal(await fs.readFile(path.join(fixture.workspace, "project-file.txt"), "utf8"), "preserve me");
  assert.deepEqual(await fs.readFile(fixture.transcripts.parent), source);
  assert.deepEqual(await fs.readFile(fixture.stateDatabasePath), database);
  assert.equal((await catalog.list()).total, 1);
  const unregistered = await catalog.remove([path.basename(unknown)]); assert.equal(unregistered.failures.length, 1);
  await assert.rejects(catalog.remove(["../../workspace"]));
});

test("replaced and corrupted archives are refused rather than deleting unrelated data", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const first = await prepare(); const id = path.basename(first.directory);
  const preserved = path.join(fixture.codexHome, "preserved-original");
  await fs.rename(first.directory, preserved); await fs.mkdir(first.directory);
  await fs.writeFile(path.join(first.directory, "unrelated.txt"), "leave this alone");
  const result = await catalog.remove([id]); assert.equal(result.failures.length, 1);
  assert.equal((await catalog.list()).records[0].availability, "changed");
  assert.equal(await fs.readFile(path.join(first.directory, "unrelated.txt"), "utf8"), "leave this alone");
  await fs.access(path.join(preserved, "START.md"));
});

test("missing entries can be forgotten without touching the project or source session", async context => {
  const { catalog, prepare } = await setup(context);
  const result = await prepare(); const id = path.basename(result.directory);
  await assert.rejects(catalog.forgetMissing(id), /still exists/);
  await fs.rm(result.directory, { recursive: true, force: true });
  assert.equal((await catalog.list()).records[0].availability, "missing");
  await catalog.forgetMissing(id); assert.equal((await catalog.list()).total, 0);
});

test("interrupted cleanup can be retried even after some archive files were removed", async context => {
  const { catalog, prepare } = await setup(context);
  const result = await prepare(); const id = path.basename(result.directory);
  const original = fs.rm;
  context.mock.method(fs, "rm", async (target, options) => {
    if (path.basename(target) === `.deleting-${id}`) {
      await fs.unlink(path.join(target, "START.md"));
      throw Object.assign(new Error("Temporary file lock"), { code: "EPERM" });
    }
    return original(target, options);
  });
  const first = await catalog.remove([id]); assert.equal(first.failures.length, 1);
  assert.equal((await catalog.list()).records[0].availability, "cleanup-incomplete");
  context.mock.restoreAll();
  const retry = await catalog.remove([id]); assert.equal(retry.failures.length, 0); assert.deepEqual(retry.deletedIds, [id]);
  assert.equal((await catalog.list()).total, 0);
});

test("a failed rename leaves the original archive usable", async context => {
  const { catalog, prepare } = await setup(context);
  const result = await prepare(); const id = path.basename(result.directory);
  context.mock.method(fs, "rename", async () => { throw Object.assign(new Error("Folder is busy"), { code: "EPERM" }); });
  assert.equal((await catalog.remove([id])).failures.length, 1);
  await catalog.getReady(id);
  assert.equal((await catalog.list()).records[0].availability, "available");
});

test("cleanup resumes after a crash between catalog marking and folder rename", async context => {
  const { catalog, prepare } = await setup(context);
  const result = await prepare(); const id = path.basename(result.directory);
  const db = new DatabaseSync(catalog.databasePath);
  db.prepare("update handoffs set state = 'deleting' where id = ?").run(id); db.close();
  assert.equal((await catalog.list()).records[0].availability, "cleanup-incomplete");
  await assert.rejects(catalog.forgetMissing(id), /still exists/);
  assert.deepEqual((await catalog.remove([id])).deletedIds, [id]);
  await assert.rejects(fs.access(result.directory), { code: "ENOENT" });
});

test("an explicit scan reconnects a moved project without changing its history", async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const result = await prepare();
  const moved = path.join(fixture.codexHome, "moved-project");
  await fs.rename(fixture.workspace, moved);
  assert.equal((await catalog.list()).records[0].availability, "missing");
  assert.equal((await catalog.importWorkspace({ workspace: moved })).imported, 1);
  const listed = await catalog.list(); assert.equal(listed.total, 1);
  assert.equal(listed.records[0].availability, "available");
  const relocatedStart = path.join(moved, HANDOFF_DIRECTORY, path.basename(result.directory), "START.md");
  await fs.access(relocatedStart);
  assert.deepEqual((await catalog.remove([path.basename(result.directory)])).deletedIds, [path.basename(result.directory)]);
});

test("catalog entries survive a server restart", async context => {
  const { catalog, configDirectory, prepare } = await setup(context);
  const result = await prepare(); catalog.close();
  const reopened = await createHandoffCatalog({ dataDirectory: configDirectory });
  try {
    assert.equal((await reopened.list()).total, 1);
    assert.equal((await reopened.getReady(path.basename(result.directory))).row.directory, result.directory);
  } finally { reopened.close(); }
});

test("an explicit project scan registers earlier archives without scanning other projects", async context => {
  const { fixture, catalog } = await setup(context);
  const result = await createSessionHandoff({ providerId: "codex", providerHome: fixture.codexHome, id: fixtureSessionIds.parent, target: "claude" });
  assert.equal((await catalog.list()).total, 0);
  const imported = await catalog.importWorkspace({ workspace: fixture.workspace });
  assert.equal(imported.imported, 1); assert.equal(imported.nextOffset, null);
  assert.equal((await catalog.list()).records[0].directory, result.directory);
});

test("an earlier version-one archive can be cataloged and cleaned without expanding source format support", async context => {
  const { fixture, catalog } = await setup(context);
  const result = await createSessionHandoff({ providerId: "codex", providerHome: fixture.codexHome, id: fixtureSessionIds.parent, target: "claude" });
  const file = path.join(result.directory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  manifest.formatVersion = 1; delete manifest.archiveId; delete manifest.createdBy; delete manifest.sourceKey;
  await fs.writeFile(file, JSON.stringify(manifest));
  assert.equal((await catalog.importWorkspace({ workspace: fixture.workspace })).imported, 1);
  assert.equal((await catalog.remove([path.basename(result.directory)])).failures.length, 0);
});

test("a linked catalog cannot overwrite a provider database", { skip: process.platform === "win32" }, async context => {
  const fixture = await createCodexHomeFixture(); context.after(() => fs.rm(fixture.codexHome, { recursive: true, force: true }));
  const configDirectory = path.join(fixture.codexHome, "unsafe-config"); await fs.mkdir(configDirectory);
  const before = await fs.readFile(fixture.stateDatabasePath);
  await fs.symlink(fixture.stateDatabasePath, path.join(configDirectory, "handoffs.sqlite"));
  await assert.rejects(createHandoffCatalog({ dataDirectory: configDirectory }), /regular file/);
  assert.deepEqual(await fs.readFile(fixture.stateDatabasePath), before);
});

test("deleting an archive does not follow a nested link outside it", { skip: process.platform === "win32" }, async context => {
  const { fixture, catalog, prepare } = await setup(context);
  const result = await prepare();
  const outside = path.join(fixture.codexHome, "outside.txt"); await fs.writeFile(outside, "keep outside data");
  await fs.symlink(outside, path.join(result.directory, "external-link"));
  assert.equal((await catalog.remove([path.basename(result.directory)])).failures.length, 0);
  assert.equal(await fs.readFile(outside, "utf8"), "keep outside data");
});
