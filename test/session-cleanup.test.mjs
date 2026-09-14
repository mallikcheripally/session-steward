import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireSessionMutationLock,
  executePreparedSessionCleanup,
  prepareSessionCleanup,
  runSessionCleanup,
  SESSION_CLEANUP_REVIEW_REQUIRED,
  SESSION_MUTATION_BUSY,
} from "../lib/session-cleanup.mjs";
import { createSessionProtectionStore } from "../lib/session-protections.mjs";

function protectionAwareProvider(records, { execute } = {}) {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return {
    deleteSessionDeletionBackup: async () => {},
    displayName: "Codex",
    executeSessionDeletion: execute ?? (async ({ plan }) => ({
      backupDirectory: "/tmp/session-steward-test-backup",
      deletedIds: plan.ids,
      deletedTranscriptPaths: [],
      skippedTranscriptPaths: [],
      unrecognizedLocationCount: 0,
    })),
    fingerprintSessionDeletion: async ({ plan }) => plan.ids.join(","),
    id: "codex",
    invalidateSessionCache: () => {},
    loadDeletionStore: async () => ({ recordsById }),
    planSessionDeletion: async ({ recordIds }) => {
      const ids = new Set();
      const pending = [...recordIds];
      while (pending.length > 0) {
        const id = pending.shift();
        if (ids.has(id)) continue;
        ids.add(id);
        pending.push(...(recordsById.get(id)?.childThreadIds ?? []));
      }
      const plannedRecords = [...ids].map((id) => recordsById.get(id)).filter(Boolean);
      return {
        childCount: Math.max(0, ids.size - recordIds.length),
        ids: [...ids],
        records: plannedRecords,
        transcriptBytes: plannedRecords.length,
        transcriptFileCount: plannedRecords.length,
      };
    },
    preflightSessionDeletion: async ({ plan }) => ({
      transcriptBytes: plan.transcriptBytes,
      transcriptFileCount: plan.transcriptFileCount,
    }),
    verifySessionDeletion: async () => ({
      complete: true,
      remainingDesktopStateReferences: [], remainingGoalRecords: [], remainingHistoryEntryCount: 0,
      remainingLogRecords: [], remainingMemoryRecords: [], remainingSessionIndexEntryCount: 0,
      remainingThreads: [], remainingTranscriptPaths: [],
    }),
  };
}

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

test("cleanup skips kept requests and continues with unprotected sessions", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cleanup-kept-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const providerHome = path.join(root, "provider");
  await fs.mkdir(providerHome);
  const protectionStore = createSessionProtectionStore({ configDirectory: path.join(root, "config") });
  await protectionStore.keepSession({ providerHome, providerId: "codex", sessionId: "keep" });
  const provider = protectionAwareProvider([
    { childThreadIds: [], cwd: "/work/one", id: "keep", parentThreadId: null },
    { childThreadIds: [], cwd: "/work/two", id: "delete", parentThreadId: null },
  ]);

  const result = await runSessionCleanup({
    options: { codexHome: providerHome },
    protectionStore,
    provider,
    recordIds: ["keep", "delete"],
    scope: "core",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.deletedSessionCount, 1);
  assert.equal(result.skippedProtectionCount, 1);
  assert.equal(result.skippedProtections[0].id, "keep");
});

test("a kept linked child skips its selected parent without blocking unrelated cleanup", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cleanup-cascade-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const providerHome = path.join(root, "provider");
  await fs.mkdir(providerHome);
  const protectionStore = createSessionProtectionStore({ configDirectory: path.join(root, "config") });
  await protectionStore.keepSession({ providerHome, providerId: "codex", sessionId: "child" });
  const provider = protectionAwareProvider([
    { childThreadIds: ["child"], cwd: "/work/one", id: "parent", parentThreadId: null },
    { childThreadIds: [], cwd: "/work/one", id: "child", parentThreadId: "parent" },
    { childThreadIds: [], cwd: "/work/two", id: "unrelated", parentThreadId: null },
  ]);

  const result = await runSessionCleanup({
    options: { codexHome: providerHome },
    protectionStore,
    provider,
    recordIds: ["parent", "unrelated"],
    scope: "core",
  });

  assert.equal(result.deletedSessionCount, 1);
  assert.equal(result.skippedProtections[0].id, "parent");
  assert.equal(result.skippedProtections[0].linkedSessionId, "child");
});

test("adding Keep after preview invalidates cleanup before mutation", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-cleanup-keep-race-"));
  context.after(() => fs.rm(root, { force: true, recursive: true }));
  const providerHome = path.join(root, "provider");
  await fs.mkdir(providerHome);
  let executed = false;
  const provider = protectionAwareProvider([
    { childThreadIds: [], cwd: "/work/one", id: "session-1", parentThreadId: null },
  ], { execute: async () => { executed = true; } });
  const protectionStore = createSessionProtectionStore({ configDirectory: path.join(root, "config") });
  const prepared = await prepareSessionCleanup({
    options: { codexHome: providerHome }, protectionStore, provider, recordIds: ["session-1"], scope: "core",
  });
  await protectionStore.keepSession({ providerHome, providerId: "codex", sessionId: "session-1" });

  await assert.rejects(executePreparedSessionCleanup({
    expectedFingerprint: prepared.fingerprint,
    options: { codexHome: providerHome },
    protectionStore,
    provider,
    recordIds: prepared.requestedIds,
    scope: prepared.scope,
  }), (error) => error.code === SESSION_CLEANUP_REVIEW_REQUIRED);
  assert.equal(executed, false);
});
