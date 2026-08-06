import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProvider, listProviders } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");

for (const layout of ["current", "alternate"]) {
  test(`Claude ${layout} layout supports listing, cleanup, and restore`, async (context) => {
    const fixture = await createClaudeHomeFixture({ layout });
    context.after(() => removeClaudeHomeFixture(fixture));
    assert.equal((await claude.diagnoseStorageCompatibility(fixture)).status, "ready");
    const listed = await claude.listSessions({ ...fixture, page: 1, pageSize: 25 });
    assert.equal(listed.total, 3);
    const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
    const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
    const result = await claude.executeSessionDeletion({ plan, scope: "core", store });
    assert.equal((await claude.verifySessionDeletion({ plan, scope: "core", store })).complete, true);
    const manifest = JSON.parse(await fs.readFile(path.join(result.backupDirectory, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.profileId, "claude-local-store-2026-08");
    await claude.restoreSessionDeletionBackup({
      backupDirectory: result.backupDirectory,
      claudeHome: fixture.claudeHome,
      desktopDataHome: fixture.desktopDataHome,
    });
    assert.equal((await claude.getSessionRecord({ ...fixture, id: fixture.cliId })).id, fixture.cliId);
  });
}

test("Claude reports unknown locations as partial and leaves them untouched during thorough cleanup", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const unknownDirectory = path.join(fixture.claudeHome, "future-session-data");
  await fs.mkdir(unknownDirectory);
  await fs.writeFile(path.join(unknownDirectory, "record.json"), "{}\n");
  claude.invalidateSessionCache(fixture);
  const compatibility = await claude.diagnoseStorageCompatibility(fixture);
  assert.equal(compatibility.status, "partial");
  assert.deepEqual(compatibility.unrecognized, ["Unrecognized Claude data: future-session-data"]);
  assert.equal((await claude.assertDeepCleanupSupported(fixture)).status, "partial");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  assert.equal(plan.unrecognizedLocationCount, 1);
  const result = await claude.executeSessionDeletion({ plan, scope: "deep", store });
  assert.equal(result.unrecognizedLocationCount, 1);
  assert.equal(await fs.readFile(path.join(unknownDirectory, "record.json"), "utf8"), "{}\n");
});

test("Claude reports a missing projects directory as unsupported", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  await fs.rm(path.join(fixture.claudeHome, "projects"), { force: true, recursive: true });
  claude.invalidateSessionCache(fixture);
  assert.equal((await claude.diagnoseStorageCompatibility(fixture)).status, "unsupported");
  await assert.rejects(claude.assertDeepCleanupSupported(fixture), /project sessions folder could not be read/u);
});

test("the provider registry exposes Codex and Claude Code", () => {
  assert.deepEqual(listProviders().map(({ id }) => id), ["codex", "claude-code"]);
  assert.equal(claude.displayName, "Claude Code");
});

test("Claude discovery separates CLI and linked Desktop sessions", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const store = await claude.loadSessionStore(fixture);
  assert.equal(store.records.length, 3);
  assert.equal(store.recordsById.get(fixture.cliId).surface, "cli");
  assert.equal(store.recordsById.get(fixture.desktopId).surface, "desktop");
  assert.equal(store.recordsById.get(fixture.desktopId).archived, true);
  assert.equal(store.recordsById.get(fixture.desktopId).cwd, "/workspace/demo");
});

test("Claude activity ignores Desktop view timestamps and transcript touches", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const expectedActivityAtMs = Date.parse("2026-01-01T00:00:01.000Z");
  let store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.desktopId).updatedAtMs, expectedActivityAtMs);

  const touchedAt = new Date("2026-03-01T00:00:00.000Z");
  await fs.utimes(fixture.desktopTranscript, touchedAt, touchedAt);
  claude.invalidateSessionCache(fixture);
  store = await claude.loadSessionStore(fixture);

  assert.equal(store.recordsById.get(fixture.desktopId).updatedAtMs, expectedActivityAtMs);
});

test("Claude activity advances only when conversation content is appended", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const originalActivityAtMs = Date.parse("2026-01-01T00:00:01.000Z");
  await claude.loadSessionStore(fixture);

  await fs.appendFile(
    fixture.cliTranscript,
    `${JSON.stringify({ sessionId: fixture.cliId, type: "last-prompt" })}\n`,
  );
  claude.invalidateSessionCache(fixture);
  let store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.cliId).updatedAtMs, originalActivityAtMs);

  const appendedActivityAt = "2026-02-01T00:00:00.000Z";
  await fs.appendFile(
    fixture.cliTranscript,
    `${JSON.stringify({ message: { content: "Continue" }, sessionId: fixture.cliId, timestamp: appendedActivityAt, type: "user" })}\n`,
  );
  claude.invalidateSessionCache(fixture);
  store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.cliId).updatedAtMs, Date.parse(appendedActivityAt));
});

test("Claude activity detects same-size transcript replacement", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  await claude.loadSessionStore(fixture);
  const original = await fs.readFile(fixture.cliTranscript, "utf8");
  const replacement = original.replace(
    "2026-01-01T00:00:01.000Z",
    "2026-01-05T00:00:01.000Z",
  );
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  await fs.writeFile(fixture.cliTranscript, replacement);
  const replacedAt = new Date("2026-01-06T00:00:00.000Z");
  await fs.utimes(fixture.cliTranscript, replacedAt, replacedAt);
  claude.invalidateSessionCache(fixture);

  const store = await claude.loadSessionStore(fixture);
  assert.equal(
    store.recordsById.get(fixture.cliId).updatedAtMs,
    Date.parse("2026-01-05T00:00:01.000Z"),
  );
});

test("Claude activity tolerates a transcript line while it is being written", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const originalActivityAtMs = Date.parse("2026-01-01T00:00:01.000Z");
  const appendedActivityAt = "2026-02-02T00:00:00.000Z";
  await claude.loadSessionStore(fixture);
  await fs.appendFile(
    fixture.cliTranscript,
    `{"sessionId":"${fixture.cliId}","timestamp":"${appendedActivityAt}","type":"user"`,
  );
  claude.invalidateSessionCache(fixture);
  let store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.cliId).updatedAtMs, originalActivityAtMs);

  await fs.appendFile(fixture.cliTranscript, "}\n");
  claude.invalidateSessionCache(fixture);
  store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.cliId).updatedAtMs, Date.parse(appendedActivityAt));
});

test("Claude activity reads across a large final conversation record", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const appendedActivityAt = "2026-02-03T00:00:00.000Z";
  await fs.appendFile(
    fixture.cliTranscript,
    `${JSON.stringify({ message: { content: "x".repeat(2 * 1024 * 1024) }, sessionId: fixture.cliId, timestamp: appendedActivityAt, type: "assistant" })}\n`,
  );
  claude.invalidateSessionCache(fixture);

  const store = await claude.loadSessionStore(fixture);
  assert.equal(store.recordsById.get(fixture.cliId).updatedAtMs, Date.parse(appendedActivityAt));
});

test("Claude cleans compacted markers and Markdown links without narrowing search", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const lines = (await fs.readFile(fixture.cliTranscript, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  lines[1].message.content = "[2] user: Read [release.md](private/raw-release-target) [3] assistant: Working on it";
  await fs.writeFile(
    fixture.cliTranscript,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  claude.invalidateSessionCache(fixture);

  const result = await claude.listSessions({
    ...fixture,
    page: 1,
    pageSize: 25,
    search: "private/raw-release-target",
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].displayName, "Read release.md");
});

test("Claude JSON records include the combined transcript size", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  await fs.copyFile(
    fixture.cliTranscript,
    path.join(path.dirname(fixture.cliTranscript), "duplicate-cli-transcript.jsonl"),
  );
  const store = await claude.loadSessionStore(fixture);
  const record = store.recordsById.get(fixture.cliId);
  const transcriptBytes = (await Promise.all(
    record.transcriptPaths.map((transcriptPath) => fs.stat(transcriptPath)),
  )).reduce((sum, stats) => sum + stats.size, 0);

  assert.equal(claude.formatSessionForJson(record).transcriptBytes, transcriptBytes);
});

test("Claude overview includes transcript size per workspace", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const store = await claude.loadSessionStore(fixture);
  const expectedBytes = store.records.reduce(
    (sum, record) => sum + record.transcriptBytes,
    0,
  );
  const overview = await claude.getSessionOverview({ ...fixture, refresh: true });
  assert.equal(overview.workspaces.length, 1);
  assert.equal(overview.workspaces[0].path, "/workspace/demo");
  assert.equal(overview.workspaces[0].transcriptBytes, expectedBytes);
});

test("Claude sorts the full filtered collection by transcript size", async (context) => {
  const fixture = await createClaudeHomeFixture({ extraSessions: 30 });
  context.after(() => removeClaudeHomeFixture(fixture));
  await fs.appendFile(fixture.cliTranscript, "x".repeat(32 * 1024));
  claude.invalidateSessionCache(fixture);
  const result = await claude.listSessions({
    ...fixture,
    page: 1,
    pageSize: 2,
    sort: "size",
  });
  assert.equal(result.total, 33);
  assert.equal(result.records[0].id, fixture.cliId);
});

test("Claude standard cleanup removes exact artifacts and restores them without touching worktrees", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const worktreeRegistry = path.join(fixture.desktopDataHome, "git-worktrees.json");
  const worktreeBefore = await fs.readFile(worktreeRegistry, "utf8");
  const unrelatedBefore = await fs.readFile(fixture.unrelatedTranscript, "utf8");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.desktopId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.desktopId], store });
  const preflight = await claude.preflightSessionDeletion({ plan, store });
  assert.equal(preflight.activeThreadDetection, "unavailable");
  assert.ok(plan.transcriptPaths.includes(fixture.desktopStatePath));
  const result = await claude.executeSessionDeletion({ plan, scope: "core", store });
  assert.equal((await claude.verifySessionDeletion({ plan, scope: "core", store })).complete, true);
  const backups = await claude.listSessionDeletionBackups({ claudeHome: fixture.claudeHome });
  assert.equal(backups.length, 1);
  assert.equal(backups[0].backupDirectory, result.backupDirectory);
  assert.equal(backups[0].restorable, true);
  assert.equal(backups[0].scope, "core");
  assert.equal(backups[0].bytes > 0, true);
  assert.equal(backups[0].fileCount > 0, true);
  assert.equal(await fs.readFile(worktreeRegistry, "utf8"), worktreeBefore);
  assert.equal(await fs.readFile(fixture.unrelatedTranscript, "utf8"), unrelatedBefore);
  await fs.appendFile(path.join(fixture.claudeHome, "history.jsonl"), `${JSON.stringify({ display: "created after cleanup", sessionId: fixture.unrelatedId, timestamp: 4 })}\n`);
  const restored = await claude.restoreSessionDeletionBackup({
    backupDirectory: result.backupDirectory,
    claudeHome: fixture.claudeHome,
    desktopDataHome: fixture.desktopDataHome,
  });
  assert.ok(restored.restoredEntryCount > 0);
  assert.equal((await fs.stat(fixture.desktopTranscript)).isFile(), true);
  assert.equal((await fs.stat(fixture.desktopStatePath)).isFile(), true);
  const restoredHistory = await fs.readFile(path.join(fixture.claudeHome, "history.jsonl"), "utf8");
  assert.match(restoredHistory, /created after cleanup/u);
  assert.match(restoredHistory, /desktop/u);
});

test("Claude thorough cleanup includes checkpoints while standard cleanup keeps them", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const checkpoint = path.join(fixture.claudeHome, "file-history", fixture.cliId, "checkpoint.txt");
  let store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  let plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  const standard = await claude.executeSessionDeletion({ plan, scope: "core", store });
  assert.equal((await fs.stat(checkpoint)).isFile(), true);
  await claude.restoreSessionDeletionBackup({ backupDirectory: standard.backupDirectory, claudeHome: fixture.claudeHome, desktopDataHome: fixture.desktopDataHome });
  store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  await claude.executeSessionDeletion({ plan, scope: "deep", store });
  await assert.rejects(fs.access(checkpoint), { code: "ENOENT" });
  assert.equal((await claude.verifySessionDeletion({ plan, scope: "deep", store })).complete, true);
});

test("Claude continues restoring version 1 recovery manifests", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  const result = await claude.executeSessionDeletion({ plan, scope: "core", store });
  const manifestPath = path.join(result.backupDirectory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.version = 1;
  delete manifest.profileId;
  delete manifest.compatibilityStatus;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal((await claude.listSessionDeletionBackups({ claudeHome: fixture.claudeHome }))[0].restorable, true);
  await claude.restoreSessionDeletionBackup({
    backupDirectory: result.backupDirectory,
    claudeHome: fixture.claudeHome,
    desktopDataHome: fixture.desktopDataHome,
  });
  assert.equal((await claude.getSessionRecord({ ...fixture, id: fixture.cliId })).id, fixture.cliId);
});

test("Claude notes when compatibility changed after a recovery backup", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  const result = await claude.executeSessionDeletion({ plan, scope: "core", store });
  await fs.writeFile(path.join(fixture.claudeHome, "future-layout"), "{}\n");
  const restored = await claude.restoreSessionDeletionBackup({
    backupDirectory: result.backupDirectory,
    claudeHome: fixture.claudeHome,
    desktopDataHome: fixture.desktopDataHome,
  });
  assert.match(restored.note, /storage layout changed/u);
});

test("Claude discovery stays bounded for ten thousand sessions", async (context) => {
  const fixture = await createClaudeHomeFixture({ extraSessions: 10_000 });
  context.after(() => removeClaudeHomeFixture(fixture));
  const start = performance.now();
  const result = await claude.listSessions({ ...fixture, page: 1, pageSize: 25, sort: "updated" });
  assert.equal(result.records.length, 25);
  assert.equal(result.total, 10_003);
  assert.ok(performance.now() - start < 10_000);
});

test("Claude listing does not read a long transcript body", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const handle = await fs.open(fixture.unrelatedTranscript, "a");
  try {
    const chunk = `${JSON.stringify({ payload: "x".repeat(1024 * 1024), type: "tool-result" })}\n`;
    for (let index = 0; index < 32; index += 1) await handle.write(chunk);
  } finally {
    await handle.close();
  }
  const start = performance.now();
  const result = await claude.listSessions({ ...fixture, page: 1, pageSize: 25, sort: "updated" });
  assert.equal(result.total, 3);
  assert.ok(performance.now() - start < 1000);
});
