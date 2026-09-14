import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SESSION_CLEANUP_REVIEW_REQUIRED = "DELETION_PLAN_REVIEW_REQUIRED";
export const SESSION_MUTATION_BUSY = "SESSION_MUTATION_BUSY";

const CLEANUP_SCOPES = new Set(["core", "deep"]);
const MUTATION_LOCK_INCOMPLETE_MS = 60_000;

function providerHome({ options, provider }) {
  const home = provider?.id === "codex"
    ? options?.codexHome
    : provider?.id === "claude-code" ? options?.claudeHome : null;
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new Error("Session Steward could not identify the provider folder for this change.");
  }
  return path.resolve(home);
}

async function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function mutationLockIsStale(lockPath, now) {
  let stats;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  const age = now() - stats.mtimeMs;
  try {
    const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const running = await processIsRunning(metadata?.pid);
    return running === null ? age >= MUTATION_LOCK_INCOMPLETE_MS : !running;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return age >= MUTATION_LOCK_INCOMPLETE_MS;
  }
}

export async function acquireSessionMutationLock({
  now = Date.now,
  options,
  provider,
} = {}) {
  const home = providerHome({ options, provider });
  const lockDirectory = path.join(home, "session-steward-backups");
  const lockPath = path.join(lockDirectory, ".mutation.lock");
  const token = randomBytes(18).toString("base64url");
  await fs.mkdir(lockDirectory, { mode: 0o700, recursive: true });

  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && await mutationLockIsStale(lockPath, now)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      const busy = new Error(
        `Another Session Steward cleanup or restore is already using this ${provider.displayName} folder.`,
      );
      busy.code = SESSION_MUTATION_BUSY;
      throw busy;
    }
  }

  if (!handle) throw new Error("Session Steward could not lock the provider folder.");
  try {
    await handle.writeFile(`${JSON.stringify({
      createdAtMs: now(),
      pid: process.pid,
      providerId: provider.id,
      token,
      version: 1,
    })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }

  let released = false;
  return async function releaseSessionMutationLock() {
    if (released) return;
    released = true;
    await handle.close().catch(() => {});
    try {
      const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
      if (metadata?.token === token) await fs.rm(lockPath, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  };
}

export async function withSessionMutationLock({ options, provider }, operation) {
  const release = await acquireSessionMutationLock({ options, provider });
  try {
    return await operation();
  } finally {
    await release();
  }
}

function cleanupReviewError(message) {
  const error = new Error(message);
  error.code = SESSION_CLEANUP_REVIEW_REQUIRED;
  return error;
}

function normalizeRecordIds(recordIds) {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new Error("Choose at least one session to clean.");
  }

  const ids = [...new Set(recordIds)];
  if (!ids.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("Every selected session must have a valid ID.");
  }
  return ids;
}

function validateScope(scope) {
  if (!CLEANUP_SCOPES.has(scope)) {
    throw new Error("Cleanup scope must be core or deep.");
  }
  return scope;
}

function emptyDeletionPlan(plan) {
  return {
    ...plan,
    childCount: 0,
    deepFiles: [],
    deepPaths: [],
    desktopStateMatchCount: 0,
    dynamicToolRowCount: 0,
    goalRowCount: 0,
    historyMatchBytes: 0,
    historyMatchCount: 0,
    ids: [],
    logRowCount: 0,
    memoryJobRowCount: 0,
    memoryOutputRowCount: 0,
    memoryRowCount: 0,
    memoryConsolidations: [],
    missingTranscriptPaths: [],
    newestLinkedActivityAtMs: 0,
    queueRevisionRowCount: 0,
    queueRowCount: 0,
    records: [],
    sessionIndexMatchCount: 0,
    spawnEdgeCount: 0,
    stateTargets: [],
    threadHistoryRowCount: 0,
    transcriptBytes: 0,
    transcriptFileCount: 0,
    transcriptPaths: [],
  };
}

function emptyPreflight() {
  return {
    desktopStateMatchCount: 0,
    estimatedBackupBytes: 0,
    transcriptBytes: 0,
    transcriptFileCount: 0,
  };
}

async function applySessionProtections({ options, plan, protectionStore, provider, recordIds, store }) {
  if (!protectionStore) {
    return { plan, protectionRevision: null, skippedProtections: [] };
  }
  const snapshot = await protectionStore.list();
  const home = providerHome({ options, provider });
  const classifications = new Map(plan.records.map((record) => [
    record.id,
    protectionStore.classify({ providerHome: home, providerId: provider.id, record, snapshot }),
  ]));
  const requested = new Set(recordIds);
  const skippedById = new Map();

  for (const id of recordIds) {
    const protection = classifications.get(id);
    if (protection?.kept) {
      skippedById.set(id, { id, keep: protection, reason: "kept-session" });
    }
  }

  const recordsById = new Map(plan.records.map((record) => [record.id, record]));
  for (const [protectedId, protection] of classifications) {
    if (!protection.kept || requested.has(protectedId)) continue;
    let current = recordsById.get(protectedId);
    const visited = new Set();
    let assignedToRequestedRoot = false;
    while (current?.parentThreadId && !visited.has(current.id)) {
      visited.add(current.id);
      const parentId = current.parentThreadId;
      if (requested.has(parentId)) {
        if (!skippedById.has(parentId)) {
          skippedById.set(parentId, {
            id: parentId,
            keep: protection,
            linkedSessionId: protectedId,
            reason: "kept-linked-session",
          });
        }
        assignedToRequestedRoot = true;
        break;
      }
      current = recordsById.get(parentId);
    }
    if (!assignedToRequestedRoot) {
      throw cleanupReviewError("A linked session is marked Keep. Review the selection again before cleanup.");
    }
  }

  const effectiveIds = recordIds.filter((id) => !skippedById.has(id));
  if (effectiveIds.length === recordIds.length) {
    return { plan, protectionRevision: snapshot.revision, skippedProtections: [] };
  }
  if (effectiveIds.length === 0) {
    return {
      plan: emptyDeletionPlan(plan),
      protectionRevision: snapshot.revision,
      skippedProtections: [...skippedById.values()],
    };
  }
  const effectivePlan = await provider.planSessionDeletion({ recordIds: effectiveIds, store });
  for (const record of effectivePlan.records) {
    if (protectionStore.classify({
      providerHome: home,
      providerId: provider.id,
      record,
      snapshot,
    }).kept) {
      throw cleanupReviewError("A linked session is marked Keep. Review the selection again before cleanup.");
    }
  }
  return {
    plan: effectivePlan,
    protectionRevision: snapshot.revision,
    skippedProtections: [...skippedById.values()],
  };
}

export async function resolveSessionCleanupScope({ options, provider, scope }) {
  const requestedScope = validateScope(scope);
  if (requestedScope !== "deep") {
    return { fallback: false, requestedScope, scope: requestedScope };
  }

  const compatibility = await provider.diagnoseStorageCompatibility(options);
  const fallback = compatibility.status === "unsupported";
  return {
    compatibility,
    fallback,
    requestedScope,
    scope: fallback ? "core" : requestedScope,
  };
}

function summarizeVerification(verification) {
  return {
    complete: Boolean(verification.complete),
    remainingDesktopStateReferenceCount: verification.remainingDesktopStateReferences.length,
    remainingGoalRecordCount: verification.remainingGoalRecords.length,
    remainingHistoryEntryCount: verification.remainingHistoryEntryCount,
    remainingLogRecordCount: verification.remainingLogRecords.length,
    remainingMemoryRecordCount: verification.remainingMemoryRecords.length,
    remainingSessionIndexEntryCount: verification.remainingSessionIndexEntryCount,
    remainingThreadCount: verification.remainingThreads.length,
    remainingTranscriptCount: verification.remainingTranscriptPaths.length,
  };
}

async function loadCurrentCleanup({ expectedFingerprint, options, protectionStore, provider, recordIds, scope }) {
  if (scope === "deep") await provider.assertDeepCleanupSupported(options);

  let store;
  try {
    store = await provider.loadDeletionStore({ ...options, recordIds });
  } catch (error) {
    if (error?.message === "One or more selected sessions are no longer available.") {
      throw cleanupReviewError("The selected sessions changed after this preview. Review the selection again.");
    }
    throw error;
  }

  const requestedPlan = await provider.planSessionDeletion({ recordIds, store });
  const protectedPlan = await applySessionProtections({
    options,
    plan: requestedPlan,
    protectionStore,
    provider,
    recordIds,
    store,
  });
  const plan = protectedPlan.plan;
  const providerFingerprint = plan.ids.length > 0
    ? await provider.fingerprintSessionDeletion({ plan, scope, store })
    : "no-unprotected-sessions";
  const fingerprint = JSON.stringify({
    protectionRevision: protectedPlan.protectionRevision,
    providerFingerprint,
  });
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw cleanupReviewError("Session data changed after this preview. Review the selection again.");
  }

  const preflight = plan.ids.length > 0
    ? await provider.preflightSessionDeletion({ plan, scope, store })
    : emptyPreflight();
  return {
    fingerprint,
    plan,
    preflight,
    skippedProtections: protectedPlan.skippedProtections,
    store,
  };
}

export async function prepareSessionCleanup({ options, protectionStore, provider, recordIds, scope }) {
  const requestedIds = normalizeRecordIds(recordIds);
  const resolvedScope = validateScope(scope);
  const current = await loadCurrentCleanup({
    options,
    protectionStore,
    provider,
    recordIds: requestedIds,
    scope: resolvedScope,
  });
  return {
    fingerprint: current.fingerprint,
    plan: current.plan,
    preflight: current.preflight,
    requestedIds,
    skippedProtections: current.skippedProtections,
    scope: resolvedScope,
  };
}

export async function revalidateSessionCleanup({ expectedFingerprint, options, protectionStore, provider, recordIds, scope }) {
  return loadCurrentCleanup({
    expectedFingerprint,
    options,
    protectionStore,
    provider,
    recordIds: normalizeRecordIds(recordIds),
    scope: validateScope(scope),
  });
}

export async function executePreparedSessionCleanup({
  expectedFingerprint,
  onProgress = () => {},
  options,
  protectionStore,
  provider,
  recordIds,
  scope,
  shouldCancel = () => false,
}) {
  const releaseProtectionLease = await protectionStore?.acquireLease();
  try {
    const current = await revalidateSessionCleanup({
      expectedFingerprint,
      options,
      protectionStore,
      provider,
      recordIds,
      scope,
    });
    if (current.plan.ids.length === 0) {
      return {
        deletion: null,
        plan: current.plan,
        preflight: current.preflight,
        skippedProtections: current.skippedProtections,
        verification: null,
      };
    }
    let deletion;
    try {
      deletion = await provider.executeSessionDeletion({
        onProgress,
        plan: current.plan,
        scope,
        shouldCancel,
        store: current.store,
      });
    } catch (error) {
      if (error && typeof error === "object") error.cleanupPlan ??= current.plan;
      throw error;
    }
    onProgress({
      canCancel: false,
      message: "Checking that cleanup completed",
      phase: "verification",
      progress: 94,
    });
    let verification;
    try {
      verification = await provider.verifySessionDeletion({
        plan: current.plan,
        scope,
        store: current.store,
      });
    } catch (error) {
      if (error && typeof error === "object") {
        error.backupDirectory ??= deletion.backupDirectory;
        error.cleanupPlan ??= current.plan;
        error.deletionResult ??= deletion;
        error.mutationStarted ??= true;
      }
      throw error;
    }
    return {
      deletion,
      plan: current.plan,
      preflight: current.preflight,
      skippedProtections: current.skippedProtections,
      verification,
    };
  } finally {
    await releaseProtectionLease?.();
  }
}

async function deleteBackups(provider, options, backupDirectories) {
  const retained = [];
  for (const backupDirectory of [...new Set(backupDirectories.filter(Boolean))]
    .sort((left, right) => right.length - left.length)) {
    try {
      await provider.deleteSessionDeletionBackup({ ...options, backupDirectory });
    } catch {
      retained.push(backupDirectory);
    }
  }
  return retained;
}

async function restoreAndCheck({ backupDirectory, options, plan, provider, onProgress }) {
  const backupDirectories = [backupDirectory];
  try {
    const restoreResult = await provider.restoreSessionDeletionBackup({
      ...options,
      backupDirectory,
      onProgress,
    });
    if (restoreResult?.safetyBackupDirectory) {
      backupDirectories.push(restoreResult.safetyBackupDirectory);
    }
    provider.invalidateSessionCache?.(options);
    const restoredRecords = await Promise.all(
      plan.ids.map((id) => provider.getSessionRecord({ ...options, id })),
    );
    if (restoredRecords.some((record) => !record)) {
      throw new Error("One or more sessions were not restored.");
    }
    const retained = await deleteBackups(provider, options, backupDirectories);
    return {
      backupRetained: retained.length > 0,
      completed: true,
    };
  } catch (error) {
    if (error?.safetyBackupDirectory) backupDirectories.push(error.safetyBackupDirectory);
    return {
      backupRetained: true,
      completed: false,
    };
  }
}

function baseResult({ plan, preflight, requestedIds, scope, skippedProtections = [] }) {
  return {
    affectedSessionCount: plan.ids.length,
    childSessionCount: plan.childCount ?? Math.max(0, plan.ids.length - requestedIds.length),
    cleanupMode: scope === "deep" ? "thorough" : "standard",
    requestedSessionCount: requestedIds.length,
    skippedProtectionCount: skippedProtections.length,
    skippedProtections,
    transcriptBytes: preflight.transcriptBytes ?? plan.transcriptBytes ?? 0,
    transcriptFileCount: preflight.transcriptFileCount ?? plan.transcriptFileCount ?? 0,
  };
}

function safeCleanupError(error, backupRetained) {
  const cause = error?.cause instanceof Error ? error.cause : error;
  const detail = cause instanceof Error && cause.message
    ? cause.message
    : "Cleanup could not be started.";
  return new Error(
    backupRetained
      ? `${detail} The temporary recovery backup could not be removed; open Session Steward's browser UI or terminal CLI to review it.`
      : detail,
  );
}

async function runSessionCleanupUnlocked({ onProgress, options, protectionStore, provider, recordIds, scope, signal }) {
  let prepared;
  try {
    prepared = await prepareSessionCleanup({ options, protectionStore, provider, recordIds, scope });
  } catch (error) {
    if (error?.code === SESSION_CLEANUP_REVIEW_REQUIRED) {
      throw cleanupReviewError("The selected session data changed before cleanup. Find matching sessions again and retry.");
    }
    throw error;
  }
  const base = baseResult({
    plan: prepared.plan,
    preflight: prepared.preflight,
    requestedIds: prepared.requestedIds,
    scope: prepared.scope,
    skippedProtections: prepared.skippedProtections,
  });
  if (prepared.plan.ids.length === 0) {
    return {
      ...base,
      deletedSessionCount: 0,
      deletedTranscriptCount: 0,
      recovery: { attempted: false, backupRetained: false, completed: false },
      skippedTranscriptCount: 0,
      status: "protected",
      unrecognizedLocationCount: 0,
      verification: null,
    };
  }
  let backupDirectory = null;
  let deletionResult = null;
  let execution = null;

  try {
    execution = await executePreparedSessionCleanup({
      expectedFingerprint: prepared.fingerprint,
      onProgress,
      options,
      protectionStore,
      provider,
      recordIds: prepared.requestedIds,
      scope: prepared.scope,
      shouldCancel: () => Boolean(signal?.aborted),
    });
    deletionResult = execution.deletion;
    backupDirectory = deletionResult.backupDirectory;
    const { verification } = execution;

    if (verification.complete) {
      const retained = await deleteBackups(provider, options, [backupDirectory]);
      return {
        ...base,
        deletedSessionCount: deletionResult.deletedIds.length,
        deletedTranscriptCount: deletionResult.deletedTranscriptPaths.length,
        recovery: {
          attempted: false,
          backupRetained: retained.length > 0,
          completed: false,
        },
        skippedTranscriptCount: deletionResult.skippedTranscriptPaths.length,
        status: "completed",
        unrecognizedLocationCount: deletionResult.unrecognizedLocationCount ?? 0,
        verification: summarizeVerification(verification),
      };
    }

    const recovery = await restoreAndCheck({
      backupDirectory,
      onProgress,
      options,
      plan: execution.plan,
      provider,
    });
    return {
      ...base,
      deletedSessionCount: recovery.completed ? 0 : null,
      deletedTranscriptCount: recovery.completed ? 0 : null,
      recovery: { attempted: true, ...recovery },
      skippedTranscriptCount: deletionResult.skippedTranscriptPaths.length,
      status: recovery.completed ? "restored" : "recovery-failed",
      unrecognizedLocationCount: deletionResult.unrecognizedLocationCount ?? 0,
      verification: summarizeVerification(verification),
    };
  } catch (error) {
    backupDirectory = error?.backupDirectory ?? backupDirectory;
    deletionResult = error?.deletionResult ?? deletionResult;
    if (error?.cancelled) {
      const retained = await deleteBackups(provider, options, [backupDirectory]);
      return {
        ...base,
        deletedSessionCount: 0,
        deletedTranscriptCount: 0,
        recovery: {
          attempted: false,
          backupRetained: retained.length > 0,
          completed: false,
        },
        skippedTranscriptCount: 0,
        status: "cancelled",
        unrecognizedLocationCount: 0,
        verification: null,
      };
    }
    if (backupDirectory && error?.mutationStarted === false) {
      const retained = await deleteBackups(provider, options, [backupDirectory]);
      throw safeCleanupError(error, retained.length > 0);
    }
    if (error?.code === SESSION_CLEANUP_REVIEW_REQUIRED) {
      throw cleanupReviewError("The selected session data changed before cleanup. Find matching sessions again and retry.");
    }
    if (!backupDirectory) throw error;
    const recovery = await restoreAndCheck({
      backupDirectory,
      onProgress,
      options,
      plan: error?.cleanupPlan ?? execution?.plan ?? prepared.plan,
      provider,
    });
    return {
      ...base,
      deletedSessionCount: recovery.completed ? 0 : null,
      deletedTranscriptCount: recovery.completed ? 0 : null,
      recovery: { attempted: true, ...recovery },
      skippedTranscriptCount: deletionResult?.skippedTranscriptPaths?.length ?? 0,
      status: recovery.completed ? "restored" : "recovery-failed",
      unrecognizedLocationCount: deletionResult?.unrecognizedLocationCount ?? 0,
      verification: null,
    };
  } finally {
    provider.invalidateSessionCache?.(options);
  }
}

export async function runSessionCleanup(args) {
  const resolution = await resolveSessionCleanupScope(args);
  const result = await withSessionMutationLock(
    { options: args.options, provider: args.provider },
    () => runSessionCleanupUnlocked({ ...args, scope: resolution.scope }),
  );
  return {
    ...result,
    cleanupFallback: resolution.fallback,
    requestedCleanupMode: resolution.requestedScope === "deep" ? "thorough" : "standard",
  };
}

function normalizeBackupId(backupId) {
  if (typeof backupId !== "string" || backupId.length === 0 || backupId.length > 500) {
    throw new Error("Choose one valid recovery backup ID.");
  }
  return backupId;
}

async function runSessionRestoreUnlocked({ backupId, onProgress, options, provider }) {
  const resolvedBackupId = normalizeBackupId(backupId);
  const backups = await provider.listSessionDeletionBackups(options);
  const backup = backups.find((item) => item.id === resolvedBackupId);
  if (!backup) throw new Error("That recovery backup is no longer available.");
  if (!backup.restorable) {
    throw new Error("That recovery backup cannot be restored automatically. Its files were left unchanged for manual recovery.");
  }

  try {
    const restoreResult = await provider.restoreSessionDeletionBackup({
      ...options,
      backupDirectory: backup.backupDirectory,
      onProgress,
    });
    provider.invalidateSessionCache?.(options);
    const retained = await deleteBackups(provider, options, [
      restoreResult.safetyBackupDirectory,
      backup.backupDirectory,
    ]);
    return {
      backupId: resolvedBackupId,
      note: typeof restoreResult.note === "string" ? restoreResult.note : null,
      restoredItemCount:
        restoreResult.restoredFileCount
        ?? restoreResult.restoredEntryCount
        ?? backup.itemCount
        ?? 0,
      status: "restored",
      temporaryBackupRetained: retained.length > 0,
    };
  } catch (error) {
    provider.invalidateSessionCache?.(options);
    return {
      backupId: resolvedBackupId,
      note: null,
      restoredItemCount: null,
      status: "restore-failed",
      temporaryBackupRetained: true,
    };
  }
}

export async function runSessionRestore(args) {
  return withSessionMutationLock(
    { options: args.options, provider: args.provider },
    () => runSessionRestoreUnlocked(args),
  );
}
