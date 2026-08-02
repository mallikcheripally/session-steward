import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProvider, listProviders } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");

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
