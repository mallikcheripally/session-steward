import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireSessionMutationLock,
  runSessionCleanup,
  SESSION_CLEANUP_REVIEW_REQUIRED,
  SESSION_MUTATION_BUSY,
} from "../lib/session-cleanup.mjs";

test("direct cleanup stops when the selected data changes during its internal recheck", async (context) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cleanup-recheck-"));
  context.after(() => fs.rm(codexHome, { force: true, recursive: true }));
  let fingerprintReadCount = 0;
  let executeCalled = false;
  const record = { id: "session-1" };
  const provider = {
    displayName: "Codex",
    id: "codex",
    assertDeepCleanupSupported: async () => {},
    fingerprintSessionDeletion: async () => {
      fingerprintReadCount += 1;
      return fingerprintReadCount === 1 ? "before" : "after";
    },
    loadDeletionStore: async () => ({ recordsById: new Map([[record.id, record]]) }),
    planSessionDeletion: async () => ({
      ids: [record.id],
      records: [record],
      transcriptBytes: 1,
      transcriptFileCount: 1,
    }),
    preflightSessionDeletion: async () => ({ transcriptBytes: 1, transcriptFileCount: 1 }),
    executeSessionDeletion: async () => {
      executeCalled = true;
    },
  };

  await assert.rejects(
    runSessionCleanup({
      options: { codexHome },
      provider,
      recordIds: [record.id],
      scope: "core",
    }),
    (error) => {
      assert.equal(error.code, SESSION_CLEANUP_REVIEW_REQUIRED);
      assert.match(error.message, /changed before cleanup/u);
      return true;
    },
  );
  assert.equal(executeCalled, false);
});

test("provider mutation locks exclude another process and recover dead ownership", async (context) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-mutation-lock-"));
  context.after(() => fs.rm(codexHome, { force: true, recursive: true }));
  const provider = { displayName: "Codex", id: "codex" };
  const options = { codexHome };
  const release = await acquireSessionMutationLock({ options, provider });

  await assert.rejects(
    acquireSessionMutationLock({ options, provider }),
    (error) => {
      assert.equal(error.code, SESSION_MUTATION_BUSY);
      assert.match(error.message, /already using this Codex folder/u);
      return true;
    },
  );

  await release();
  const recoveredRelease = await acquireSessionMutationLock({ options, provider });
  await recoveredRelease();

  const lockDirectory = path.join(codexHome, "session-steward-backups");
  const lockPath = path.join(lockDirectory, ".mutation.lock");
  await fs.mkdir(lockDirectory, { recursive: true });
  await fs.writeFile(lockPath, `${JSON.stringify({ pid: 2_147_483_647 })}\n`);
  const staleRelease = await acquireSessionMutationLock({ options, provider });
  await staleRelease();
  await assert.rejects(fs.access(lockPath), { code: "ENOENT" });
});

test("shared cleanup execution restores when verification throws after deletion", async (context) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cleanup-verify-"));
  context.after(() => fs.rm(codexHome, { force: true, recursive: true }));
  const record = { id: "session-1" };
  const backupDirectory = path.join(codexHome, "session-steward-backups", "test-backup");
  let restored = false;
  const provider = {
    deleteSessionDeletionBackup: async () => {},
    displayName: "Codex",
    executeSessionDeletion: async () => ({
      backupDirectory,
      deletedIds: [record.id],
      deletedTranscriptPaths: ["transcript"],
      skippedTranscriptPaths: [],
      unrecognizedLocationCount: 0,
    }),
    fingerprintSessionDeletion: async () => "stable",
    getSessionRecord: async () => restored ? record : null,
    id: "codex",
    invalidateSessionCache: () => {},
    loadDeletionStore: async () => ({ recordsById: new Map([[record.id, record]]) }),
    planSessionDeletion: async () => ({
      ids: [record.id],
      records: [record],
      transcriptBytes: 1,
      transcriptFileCount: 1,
    }),
    preflightSessionDeletion: async () => ({ transcriptBytes: 1, transcriptFileCount: 1 }),
    restoreSessionDeletionBackup: async () => {
      restored = true;
      return { restoredFileCount: 1 };
    },
    verifySessionDeletion: async () => {
      throw new Error("Simulated verification failure.");
    },
  };

  const result = await runSessionCleanup({
    options: { codexHome },
    provider,
    recordIds: [record.id],
    scope: "core",
  });

  assert.equal(result.status, "restored");
  assert.equal(result.deletedSessionCount, 0);
  assert.deepEqual(result.recovery, {
    attempted: true,
    backupRetained: false,
    completed: true,
  });
});
