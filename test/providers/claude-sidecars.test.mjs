import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { prepareSessionCleanup, executePreparedSessionCleanup, runSessionCleanup } from "../../lib/session-cleanup.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");
const suffixes = [".precompact.json", ".ccr-tip.json", ".desktop-released.json", ".dir-sync.json", "-1788864000000.cast", "-1788864000001.cast"];

async function writeSidecars(transcriptPath, id) {
  const entries = [];
  for (const suffix of suffixes) {
    const target = path.join(path.dirname(transcriptPath), `${id}${suffix}`);
    const bytes = Buffer.from(`session-owned data: ${id}${suffix}\n`);
    await fs.writeFile(target, bytes);
    entries.push({ path: target, bytes });
  }
  return entries;
}

for (const scope of ["core", "deep"]) {
  for (const surface of ["cli", "desktop"]) {
    test(`Claude ${surface} ${scope} cleanup backs up, counts, removes, and restores exact sidecars`, async (context) => {
      const fixture = await createClaudeHomeFixture();
      context.after(() => removeClaudeHomeFixture(fixture));
      const id = surface === "cli" ? fixture.cliId : fixture.desktopId;
      const transcript = surface === "cli" ? fixture.cliTranscript : fixture.desktopTranscript;
      const before = await claude.getSessionOverview({ ...fixture, refresh: true });
      const baselineStore = await claude.loadDeletionStore({ ...fixture, recordIds: [id] });
      const baseline = await claude.planSessionDeletion({ recordIds: [id], store: baselineStore });
      const entries = await writeSidecars(transcript, id);
      const extraBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
      const overview = await claude.getSessionOverview({ ...fixture, refresh: true });
      assert.equal(overview.transcriptBytes - before.transcriptBytes, extraBytes);
      assert.equal(overview.transcriptFileCount - before.transcriptFileCount, entries.length);
      // Transcript-only list sizes do not change meaning.
      assert.equal((await claude.getSessionRecord({ ...fixture, id })).transcriptBytes, baselineStore.recordsById.get(id).transcriptBytes);
      const unrelated = await writeSidecars(fixture.unrelatedTranscript, fixture.unrelatedId);
      const unknown = [".unknown.json", ".cast", "-not-a-timestamp.cast", "-12345678901234567.cast", ".precompact.json.bak", "-different.precompact.json"];
      for (const suffix of unknown) {
        const target = path.join(path.dirname(transcript), `${id}${suffix}`);
        const bytes = Buffer.from("keep this unknown file\n");
        await fs.writeFile(target, bytes);
        unrelated.push({ path: target, bytes });
      }
      const store = await claude.loadDeletionStore({ ...fixture, recordIds: [id] });
      const plan = await claude.planSessionDeletion({ recordIds: [id], store });
      assert.equal(plan.transcriptBytes - baseline.transcriptBytes, extraBytes);
      assert.equal(plan.transcriptFileCount - baseline.transcriptFileCount, entries.length);
      for (const entry of entries) assert.ok(plan.transcriptPaths.includes(entry.path));
      for (const entry of unrelated) assert.equal(plan.transcriptPaths.includes(entry.path), false);
      const deletion = await claude.executeSessionDeletion({ plan, scope, store });
      assert.equal((await claude.verifySessionDeletion({ plan, scope, store })).complete, true);
      const manifest = JSON.parse(await fs.readFile(path.join(deletion.backupDirectory, "manifest.json"), "utf8"));
      for (const entry of entries) {
        await assert.rejects(fs.lstat(entry.path), { code: "ENOENT" });
        const relative = path.relative(fixture.claudeHome, entry.path);
        assert.ok(manifest.entries.some((item) => item.root === "claude" && item.relative === relative && item.sha256));
        assert.deepEqual(await fs.readFile(path.join(deletion.backupDirectory, "data", "claude", relative)), entry.bytes);
      }
      await claude.restoreSessionDeletionBackup({ ...fixture, backupDirectory: deletion.backupDirectory });
      for (const entry of [...entries, ...unrelated]) assert.deepEqual(await fs.readFile(entry.path), entry.bytes);
    });
  }
}

test("Claude includes sidecars for every recognized copy without duplicate targets", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const copy = path.join(fixture.claudeHome, "projects", "-another-workspace", `${fixture.cliId}.jsonl`);
  await fs.mkdir(path.dirname(copy));
  await fs.copyFile(fixture.cliTranscript, copy);
  const entries = [...await writeSidecars(fixture.cliTranscript, fixture.cliId), ...await writeSidecars(copy, fixture.cliId)];
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId, fixture.cliId], store });
  assert.equal(new Set(plan.transcriptPaths).size, plan.transcriptPaths.length);
  for (const entry of entries) assert.ok(plan.transcriptPaths.includes(entry.path));
  await claude.executeSessionDeletion({ plan, store, scope: "core" });
  for (const entry of entries) await assert.rejects(fs.access(entry.path), { code: "ENOENT" });
});

test("Claude verifies sidecars recreated or newly created after planning", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const existing = path.join(path.dirname(fixture.cliTranscript), `${fixture.cliId}.precompact.json`);
  await fs.writeFile(existing, "backup me\n");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  await claude.executeSessionDeletion({ plan, store, scope: "core" });
  const entries = await writeSidecars(fixture.cliTranscript, fixture.cliId);
  const verified = await claude.verifySessionDeletion({ plan, store, scope: "core" });
  assert.equal(verified.complete, false);
  assert.equal(new Set(verified.remainingTranscriptPaths).size, verified.remainingTranscriptPaths.length);
  for (const entry of entries) assert.ok(verified.remainingTranscriptPaths.includes(entry.path));
});

test("a newly discovered Claude sidecar invalidates an earlier cleanup preview", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const request = { options: fixture, provider: claude, recordIds: [fixture.cliId], scope: "core" };
  const prepared = await prepareSessionCleanup(request);
  const entries = await writeSidecars(fixture.cliTranscript, fixture.cliId);
  await assert.rejects(executePreparedSessionCleanup({ ...request, expectedFingerprint: prepared.fingerprint }), /changed/u);
  await fs.access(fixture.cliTranscript);
  for (const entry of entries) assert.deepEqual(await fs.readFile(entry.path), entry.bytes);
});

test("automatic recovery restores Claude sidecars when cleanup verification fails", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const entries = await writeSidecars(fixture.cliTranscript, fixture.cliId);
  const provider = {
    ...claude,
    verifySessionDeletion: async (args) => ({ ...await claude.verifySessionDeletion(args), complete: false }),
  };
  const result = await runSessionCleanup({ provider, options: fixture, recordIds: [fixture.cliId], scope: "deep" });
  assert.equal(result.status, "restored");
  assert.equal(result.recovery.completed, true);
  await fs.access(fixture.cliTranscript);
  for (const entry of entries) assert.deepEqual(await fs.readFile(entry.path), entry.bytes);
});

test("Claude leaves sidecars alone when transcript filename and session ID disagree", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const renamed = path.join(path.dirname(fixture.cliTranscript), "different-name.jsonl");
  await fs.rename(fixture.cliTranscript, renamed);
  const originalNames = await writeSidecars(renamed, fixture.cliId);
  const renamedFiles = await writeSidecars(renamed, "different-name");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ recordIds: [fixture.cliId], store });
  for (const entry of [...originalNames, ...renamedFiles]) assert.equal(plan.transcriptPaths.includes(entry.path), false);
});

test("Claude refuses directory-shaped sidecars instead of recursively deleting them", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const directory = path.join(path.dirname(fixture.cliTranscript), `${fixture.cliId}.precompact.json`);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "keep.txt"), "unrecognized layout");
  const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  await assert.rejects(claude.planSessionDeletion({ recordIds: [fixture.cliId], store }), /sidecar is not a regular file/u);
  assert.equal(await fs.readFile(path.join(directory, "keep.txt"), "utf8"), "unrecognized layout");
});

test("Claude refuses symlink sidecars, including dangling links", { skip: process.platform === "win32" }, async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const link = path.join(path.dirname(fixture.cliTranscript), `${fixture.cliId}.ccr-tip.json`);
  for (const destination of [fixture.unrelatedTranscript, path.join(fixture.root, "missing")]) {
    await fs.symlink(destination, link);
    const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
    await assert.rejects(claude.planSessionDeletion({ recordIds: [fixture.cliId], store }), /sidecar is not a regular file/u);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    await fs.unlink(link);
  }
  await fs.access(fixture.unrelatedTranscript);
});
