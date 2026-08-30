import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider, listProviders } from "./providers/index.mjs";
import { getInstalledProductVersions } from "./installed-products.mjs";
import {
  DEFAULT_SESSION_EVENT_LIMIT,
  MAX_SESSION_EVENT_LIMIT,
} from "./session-event-reader.mjs";
import { createProviderSettings } from "./settings.mjs";
import { classifyInstalledVersion } from "./version-support.mjs";
import {
  acquireSessionMutationLock,
  executePreparedSessionCleanup,
  prepareSessionCleanup,
  SESSION_CLEANUP_REVIEW_REQUIRED,
} from "./session-cleanup.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_SCOPES = new Set(["core", "deep"]);
const PLAN_TTL_MS = 10 * 60 * 1000;
const OPERATION_TTL_MS = 60 * 60 * 1000;
const MAX_SAVED_PLANS = 20;
const MAX_SAVED_OPERATIONS = 50;
const PLAN_RECORD_SAMPLE_LIMIT = 20;
const PLAN_REVIEW_REQUIRED = SESSION_CLEANUP_REVIEW_REQUIRED;
const SESSION_OVERVIEW_TTL_MS = 45 * 1000;
const MAX_INACTIVE_DAYS = 3_650;
const ALLOWED_ARCHIVE_STATUSES = new Set(["all", "active", "archived"]);
const ALLOWED_SORTS = new Set(["created", "cwd", "name", "size", "updated"]);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const staticAssets = new Map([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
]);

function providerOptions(providerId, home) {
  return providerId === "codex" ? { codexHome: home } : { claudeHome: home };
}

function resolveProviderId(value) {
  const providerId = value || "codex";
  getProvider(providerId);
  return providerId;
}

function getStaticAsset(requestPath) {
  const knownAsset = staticAssets.get(requestPath);

  if (knownAsset) {
    return knownAsset;
  }

  if (!requestPath.startsWith("/assets/") || requestPath.includes("..")) {
    return null;
  }

  const fileName = requestPath.slice(1);
  const extension = path.extname(fileName);
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  };
  const contentType = contentTypes[extension];

  return contentType ? { fileName, contentType } : null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function sendStaticAsset(response, asset) {
  const content = await fs.readFile(path.join(publicDirectory, asset.fileName));
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": asset.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function normalizeIds(value) {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string")) {
    throw new Error("ids must be a non-empty array of session IDs.");
  }

  return [...new Set(value)];
}

function getScope(value) {
  if (!ALLOWED_SCOPES.has(value)) {
    throw new Error("scope must be either core or deep.");
  }

  return value;
}

function getPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

function getSessionEventLimit(value) {
  if (value === null) return DEFAULT_SESSION_EVENT_LIMIT;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`limit must be between 1 and ${MAX_SESSION_EVENT_LIMIT}.`);
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_EVENT_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_SESSION_EVENT_LIMIT}.`);
  }

  return limit;
}

function getSessionId(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || value.includes("\0")
    || /[\\/]/u.test(value)
  ) {
    throw new Error("Enter a valid session ID.");
  }

  return value;
}

function getInactiveBeforeMs(value) {
  if (value === null || value === "") {
    return null;
  }

  const days = Number(value);

  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_INACTIVE_DAYS) {
    throw new Error(`Last activity must be a whole number between 1 and ${MAX_INACTIVE_DAYS} days.`);
  }

  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function getArchiveStatus(value) {
  const status = value || "all";

  if (!ALLOWED_ARCHIVE_STATUSES.has(status)) {
    throw new Error("Session status must be all, active, or archived.");
  }

  return status;
}

function getSort(value) {
  const sort = value || "updated";

  if (!ALLOWED_SORTS.has(sort)) {
    throw new Error("Session order is not available.");
  }

  return sort;
}

function getLocalRequestOrigin({ hostHeader, server }) {
  if (typeof hostHeader !== "string") {
    return null;
  }

  const address = server.address();

  if (!address || typeof address === "string") {
    return null;
  }

  let expectedHost = null;

  if (address.address === "127.0.0.1") {
    expectedHost = `127.0.0.1:${address.port}`;
  } else if (address.address === "::1") {
    expectedHost = `[::1]:${address.port}`;
  }

  return hostHeader === expectedHost ? `http://${expectedHost}` : null;
}

function requireMutationAuthorization({ request, requestUrl, token }) {
  if (request.headers.origin !== requestUrl.origin) {
    throw new Error("Destructive requests must originate from this local server.");
  }

  if (request.headers["x-session-steward-token"] !== token) {
    throw new Error("Destructive request authorization failed.");
  }
}

function summarizePlan(plan, preflight, scope) {
  const relatedRecordCount = plan.historyMatchCount
    + plan.sessionIndexMatchCount
    + plan.logRowCount
    + plan.spawnEdgeCount
    + (scope === "deep"
      ? plan.goalRowCount + plan.memoryRowCount + preflight.desktopStateMatchCount
      : 0);

  return {
    availableDiskBytes: preflight.availableDiskBytes,
    childCount: plan.childCount,
    desktopStateMatchCount: preflight.desktopStateMatchCount,
    desktopStateSupport: preflight.desktopStateSupport,
    estimatedBackupBytes: preflight.estimatedBackupBytes,
    goalRowCount: plan.goalRowCount,
    historyMatchCount: plan.historyMatchCount,
    logRowCount: plan.logRowCount,
    memoryRowCount: plan.memoryRowCount,
    missingTranscriptCount: plan.missingTranscriptPaths.length,
    newestLinkedActivityAtMs: plan.newestLinkedActivityAtMs,
    recordSamples: plan.records.slice(0, PLAN_RECORD_SAMPLE_LIMIT).map((record) => ({
      displayName: record.displayName,
      id: record.id,
    })),
    sessionIndexMatchCount: plan.sessionIndexMatchCount,
    sessionCount: plan.ids.length,
    spawnEdgeCount: plan.spawnEdgeCount,
    relatedRecordCount,
    transcriptBytes: preflight.transcriptBytes ?? plan.transcriptBytes,
    transcriptCount: preflight.transcriptFileCount ?? plan.transcriptFileCount,
  };
}

function summarizeVerification(verification) {
  return {
    complete: verification.complete,
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

function summarizeDeletionResult(result) {
  return {
    deletedSessionCount: result.deletedIds.length,
    deletedTranscriptCount: result.deletedTranscriptPaths.length,
    recoveryBackupDeleted: false,
    skippedTranscriptCount: result.skippedTranscriptPaths.length,
    unrecognizedLocationCount: result.unrecognizedLocationCount ?? 0,
  };
}

function publicOperation(operation) {
  return {
    backupDirectory: operation.backupDirectory ?? null,
    backupDeleteError: operation.backupDeleteError ?? null,
    canCancel: Boolean(operation.canCancel),
    canDeleteBackup: Boolean(operation.canDeleteBackup),
    canRestore: Boolean(operation.canRestore),
    cancelRequested: Boolean(operation.cancelRequested),
    error: operation.error ?? null,
    errorCode: operation.errorCode ?? null,
    id: operation.id,
    message: operation.message,
    phase: operation.phase,
    progress: operation.progress,
    result: operation.result ?? null,
    restoreResult: operation.restoreResult ?? null,
    status: operation.status,
    verification: operation.verification ?? null,
  };
}

function removeExpiredEntries(entries, ttlMs, maximum) {
  const now = Date.now();

  for (const [id, entry] of entries) {
    if (entry.finishedAtMs && now - entry.finishedAtMs > ttlMs) entries.delete(id);
    if (entry.expiresAtMs && entry.expiresAtMs <= now) entries.delete(id);
  }

  while (entries.size >= maximum) {
    const oldestFinished = [...entries].find(([, entry]) => entry.finishedAtMs);
    if (!oldestFinished) break;
    entries.delete(oldestFinished[0]);
  }
}

export async function startLocalServer({ claudeHome, codexHome, configDirectory, port = 0 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535.");
  }

  const settings = await createProviderSettings({
    configDirectory,
    providerHomeOverrides: {
      ...(codexHome === undefined ? {} : { codex: codexHome }),
      ...(claudeHome === undefined ? {} : { "claude-code": claudeHome }),
    },
  });
  const mutationToken = randomBytes(32).toString("base64url");
  let mutationInProgress = false;
  let activeOperationId = null;
  const deletionPlans = new Map();
  const operations = new Map();
  const activeTasks = new Set();
  let overviewCache = null;

  function invalidateSessionOverview() {
    overviewCache = null;
  }

  async function readSessionOverview({ providerId, refresh = false } = {}) {
    const home = settings.getHome(providerId);

    if (
      !refresh
      && overviewCache?.providerId === providerId
      && overviewCache?.home === home
      && overviewCache.expiresAtMs > Date.now()
    ) {
      return overviewCache.overview;
    }

    const overview = await getProvider(providerId).getSessionOverview({
      ...providerOptions(providerId, home),
      refresh,
    });
    overviewCache = {
      home,
      providerId,
      expiresAtMs: Date.now() + SESSION_OVERVIEW_TTL_MS,
      overview,
    };
    return overview;
  }

  async function removeOperationBackups(operation, additionalDirectories = []) {
    const provider = getProvider(operation.providerId);
    const candidates = [...new Set([
      ...(operation.backupDirectories ?? []),
      operation.backupDirectory,
      ...additionalDirectories,
    ].filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    const remaining = [];

    for (const backupDirectory of candidates) {
      try {
        await provider.deleteSessionDeletionBackup({
          backupDirectory,
          ...providerOptions(operation.providerId, operation.home),
        });
      } catch {
        remaining.push(backupDirectory);
      }
    }

    operation.backupDirectories = remaining;
    operation.backupDirectory = remaining[0] ?? null;
    operation.canDeleteBackup = remaining.length > 0;
    return remaining.length === 0;
  }

  function getDeletionPlan(planId) {
    const savedPlan = typeof planId === "string" ? deletionPlans.get(planId) : null;

    if (!savedPlan || savedPlan.expiresAtMs <= Date.now()) {
      if (savedPlan) deletionPlans.delete(planId);
      throw codedError(
        "This deletion preview has expired. Review the selection again.",
        PLAN_REVIEW_REQUIRED,
      );
    }

    if (savedPlan.consumed) {
      throw codedError(
        "This deletion preview has already been used. Review the selection again.",
        PLAN_REVIEW_REQUIRED,
      );
    }

    if (savedPlan.home !== settings.getHome(savedPlan.providerId)) {
      deletionPlans.delete(planId);
      throw codedError(
        `The ${getProvider(savedPlan.providerId).displayName} session folder changed. Review the selection again.`,
        PLAN_REVIEW_REQUIRED,
      );
    }

    return savedPlan;
  }

  function getOperation(operationId) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error("Cleanup progress is no longer available.");
    return operation;
  }

  async function runDeletionOperation(operation, savedPlan) {
    operation.status = "running";
    operation.message = "Checking the deletion preview";
    operation.phase = "preflight";
    operation.progress = 2;

    let releaseMutationLock;
    try {
      const provider = getProvider(savedPlan.providerId);
      const options = providerOptions(savedPlan.providerId, savedPlan.home);
      releaseMutationLock = await acquireSessionMutationLock({ options, provider });
      const execution = await executePreparedSessionCleanup({
        expectedFingerprint: savedPlan.fingerprint,
        onProgress: (update) => Object.assign(operation, update),
        options,
        provider,
        recordIds: savedPlan.requestedIds,
        scope: savedPlan.scope,
        shouldCancel: () => operation.cancelRequested,
      });
      const result = execution.deletion;
      operation.backupDirectory = result.backupDirectory;
      operation.backupDirectories = [result.backupDirectory];
      operation.result = summarizeDeletionResult(result);
      operation.canCancel = false;
      const verification = execution.verification;
      operation.verification = summarizeVerification(verification);
      operation.progress = 100;

      if (verification.complete) {
        operation.message = "Cleanup completed";
        if (await removeOperationBackups(operation)) {
          operation.result.recoveryBackupDeleted = true;
        } else {
          operation.backupDeleteError = "Cleanup completed, but its recovery backup could not be removed.";
        }
        operation.status = "completed";
      } else {
        operation.canDeleteBackup = true;
        operation.canRestore = true;
        operation.error = "Cleanup finished, but some selected items remain. You can restore the recovery backup.";
        operation.message = "Cleanup needs attention";
        operation.status = "needs-attention";
      }
    } catch (error) {
      operation.backupDirectory = error?.backupDirectory ?? null;
      operation.backupDirectories = operation.backupDirectory ? [operation.backupDirectory] : [];
      operation.canCancel = false;
      operation.errorCode = error?.code ?? null;
      operation.progress = error?.cancelled ? operation.progress : 100;

      if (error?.cancelled) {
        operation.error = null;
        operation.message = "Cleanup cancelled before session data changed";
        if (!(await removeOperationBackups(operation))) {
          operation.backupDeleteError = "Cleanup was cancelled, but its temporary backup could not be removed.";
        }
        operation.status = "cancelled";
      } else {
        operation.canDeleteBackup = Boolean(operation.backupDirectory);
        operation.canRestore = Boolean(operation.backupDirectory);
        operation.error = error instanceof Error ? error.message : "Cleanup could not be completed.";
        operation.message = "Cleanup could not be completed";
        operation.status = "failed";
      }
    } finally {
      const terminalStatus = operation.status;
      operation.status = "running";
      await releaseMutationLock?.().catch(() => {});
      getProvider(savedPlan.providerId).invalidateSessionCache?.(
        providerOptions(savedPlan.providerId, savedPlan.home),
      );
      invalidateSessionOverview();
      savedPlan.consumed = true;
      deletionPlans.delete(savedPlan.id);
      operation.finishedAtMs = Date.now();
      if (activeOperationId === operation.id) activeOperationId = null;
      operation.status = terminalStatus;
    }
  }

  function startDeletionOperation(savedPlan) {
    removeExpiredEntries(operations, OPERATION_TTL_MS, MAX_SAVED_OPERATIONS);
    const id = randomBytes(18).toString("base64url");
    const operation = {
      backupDirectory: null,
      backupDirectories: [],
      backupDeleteError: null,
      canCancel: true,
      canDeleteBackup: false,
      canRestore: false,
      cancelRequested: false,
      home: savedPlan.home,
      providerId: savedPlan.providerId,
      createdAtMs: Date.now(),
      error: null,
      errorCode: null,
      id,
      message: "Cleanup queued",
      phase: "queued",
      progress: 0,
      result: null,
      status: "queued",
      verification: null,
    };
    operations.set(id, operation);
    activeOperationId = id;
    savedPlan.consumed = true;
    const task = runDeletionOperation(operation, savedPlan);
    activeTasks.add(task);
    task.finally(() => activeTasks.delete(task));
    return operation;
  }

  function startRestoreOperation(operation) {
    operation.canCancel = false;
    operation.canDeleteBackup = false;
    operation.canRestore = false;
    operation.backupDeleteError = null;
    operation.error = null;
    operation.errorCode = null;
    operation.message = "Restore queued";
    operation.phase = "restore";
    operation.progress = 0;
    operation.status = "restoring";
    activeOperationId = operation.id;
    const task = (async () => {
      let releaseMutationLock;
      try {
        const provider = getProvider(operation.providerId);
        const options = providerOptions(operation.providerId, operation.home);
        releaseMutationLock = await acquireSessionMutationLock({ options, provider });
        const restoreResult = await provider.restoreSessionDeletionBackup({
          backupDirectory: operation.backupDirectory,
          ...options,
          onProgress: (update) => Object.assign(operation, update),
        });
        operation.restoreResult = restoreResult;
        operation.message = "Recovery backup restored";
        operation.progress = 100;
        if (await removeOperationBackups(operation, [restoreResult.safetyBackupDirectory])) {
          operation.restoreResult = {
            ...restoreResult,
            recoveryBackupsDeleted: true,
            safetyBackupDirectory: null,
          };
        } else {
          operation.backupDeleteError = "The sessions were restored, but temporary recovery files could not be removed.";
        }
        operation.status = "restored";
      } catch (error) {
        if (error?.safetyBackupDirectory) {
          operation.backupDirectories = [...new Set([
            ...(operation.backupDirectories ?? []),
            error.safetyBackupDirectory,
          ])];
        }
        operation.canDeleteBackup = true;
        operation.canRestore = true;
        operation.error = error instanceof Error ? error.message : "The recovery backup could not be restored.";
        operation.message = "Restore could not be completed";
        operation.status = "restore-failed";
      } finally {
        const terminalStatus = operation.status;
        operation.status = "restoring";
        await releaseMutationLock?.().catch(() => {});
        getProvider(operation.providerId).invalidateSessionCache?.(
          providerOptions(operation.providerId, operation.home),
        );
        invalidateSessionOverview();
        operation.finishedAtMs = Date.now();
        if (activeOperationId === operation.id) activeOperationId = null;
        operation.status = terminalStatus;
      }
    })();
    activeTasks.add(task);
    task.finally(() => activeTasks.delete(task));
  }
  const server = createServer(async (request, response) => {
    const localOrigin = getLocalRequestOrigin({
      hostHeader: request.headers.host,
      server,
    });

    if (!localOrigin) {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    let requestUrl;

    try {
      requestUrl = new URL(request.url || "/", localOrigin);
    } catch {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    if (requestUrl.origin !== localOrigin) {
      sendJson(response, 403, { error: "This request is not allowed." });
      return;
    }

    try {
      const staticAsset = request.method === "GET" ? getStaticAsset(requestUrl.pathname) : null;

      if (staticAsset) {
        await sendStaticAsset(response, staticAsset);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/config") {
        sendJson(response, 200, {
          activeProviderId: settings.getActiveProviderId(),
          mutationToken,
          providerOrder: listProviders().map(({ id }) => id),
          providers: settings.getAll(),
        });
        return;
      }

      if (request.method === "PUT" && requestUrl.pathname === "/api/settings/active-provider") {
        requireMutationAuthorization({ request, requestUrl, token: mutationToken });

        if (mutationInProgress || activeOperationId) {
          sendJson(response, 409, { error: "Wait for the current change to finish before switching providers." });
          return;
        }

        mutationInProgress = true;

        try {
          const activeProviderId = await settings.setActiveProviderId(
            (await readJsonBody(request)).providerId,
          );
          sendJson(response, 200, { activeProviderId });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      const providerSettingsPrefix = "/api/settings/providers/";

      if (
        (request.method === "PUT" || request.method === "DELETE")
        && requestUrl.pathname.startsWith(providerSettingsPrefix)
      ) {
        const providerId = decodeURIComponent(requestUrl.pathname.slice(providerSettingsPrefix.length));
        requireMutationAuthorization({ request, requestUrl, token: mutationToken });

        if (mutationInProgress || activeOperationId) {
          sendJson(response, 409, { error: "Wait for the current change to finish before changing folders." });
          return;
        }

        mutationInProgress = true;

        try {
          const provider = request.method === "DELETE"
            ? await settings.resetProviderHome(providerId)
            : await settings.setProviderHome(providerId, (await readJsonBody(request)).home);
          deletionPlans.clear();
          invalidateSessionOverview();
          sendJson(response, 200, { provider });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/compatibility") {
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const provider = getProvider(providerId);
        const home = settings.getHome(providerId);
        const diagnostic = await provider.diagnoseStorageCompatibility(providerOptions(providerId, home));
        const currentVersions = await getInstalledProductVersions();
        const versionSupport = Object.fromEntries(
          Object.entries(diagnostic.builtFor).map(([product, supportedVersions]) => [
            product,
            classifyInstalledVersion({
              installedVersion: currentVersions[product],
              supportedVersions,
            }),
          ]),
        );
        sendJson(response, 200, { ...diagnostic, currentVersions, providerId, versionSupport });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/session-overview") {
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const overview = await readSessionOverview({
          providerId,
          refresh: requestUrl.searchParams.get("refresh") === "true",
        });
        sendJson(response, 200, { overview });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const provider = getProvider(providerId);
        const result = await provider.listSessions({
          archiveStatus: getArchiveStatus(requestUrl.searchParams.get("archiveStatus")),
          ...providerOptions(providerId, settings.getHome(providerId)),
          inactiveBeforeMs: getInactiveBeforeMs(requestUrl.searchParams.get("inactiveDays")),
          includeInternals: requestUrl.searchParams.get("includeInternals") === "true",
          includeSupporting: requestUrl.searchParams.get("includeSupporting") === "true",
          page: getPositiveInteger(requestUrl.searchParams.get("page"), 1),
          pageSize: getPositiveInteger(requestUrl.searchParams.get("pageSize"), 25, 100),
          refresh: requestUrl.searchParams.get("refresh") === "true",
          search: requestUrl.searchParams.get("search"),
          sort: getSort(requestUrl.searchParams.get("sort")),
          workspace: requestUrl.searchParams.has("workspace")
            ? requestUrl.searchParams.get("workspace")
            : undefined,
        });
        sendJson(response, 200, {
          ...result,
          records: result.records.map(provider.formatSessionForJson),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/session-events") {
        const controller = new AbortController();
        const abortRead = () => controller.abort();
        request.once("aborted", abortRead);
        response.once("close", () => {
          if (!response.writableEnded) abortRead();
        });
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const provider = getProvider(providerId);
        const id = getSessionId(requestUrl.searchParams.get("id"));
        const result = await provider.readSessionEvents({
          ...providerOptions(providerId, settings.getHome(providerId)),
          id,
          limit: getSessionEventLimit(requestUrl.searchParams.get("limit")),
          signal: controller.signal,
          // The scan is already streaming the whole transcript, so the count
          // comes back with it rather than costing a second pass over it.
          tokens: true,
        });

        if (controller.signal.aborted) return;

        if (!result) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }

        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/session-tokens") {
        const controller = new AbortController();
        const abortRead = () => controller.abort();
        request.once("aborted", abortRead);
        response.once("close", () => {
          if (!response.writableEnded) abortRead();
        });
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const provider = getProvider(providerId);
        const id = getSessionId(requestUrl.searchParams.get("id"));
        const tokens = await provider.readSessionTokens({
          ...providerOptions(providerId, settings.getHome(providerId)),
          id,
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (!tokens) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }

        sendJson(response, 200, { tokens });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/sessions/")) {
        const providerId = resolveProviderId(requestUrl.searchParams.get("provider"));
        const provider = getProvider(providerId);
        const id = getSessionId(decodeURIComponent(requestUrl.pathname.slice("/api/sessions/".length)));
        const record = await provider.getSessionRecord({
          ...providerOptions(providerId, settings.getHome(providerId)),
          id,
        });

        if (!record) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }

        sendJson(response, 200, { record: provider.formatSessionForJson(record) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/deletion-plans") {
        const body = await readJsonBody(request);
        const providerId = resolveProviderId(body.providerId);
        const provider = getProvider(providerId);
        const ids = normalizeIds(body.ids);
        const scope = getScope(body.scope);
        const home = settings.getHome(providerId);
        const options = providerOptions(providerId, home);

        const prepared = await prepareSessionCleanup({
          options,
          provider,
          recordIds: ids,
          scope,
        });
        const { plan, preflight } = prepared;
        const id = randomBytes(18).toString("base64url");
        const expiresAtMs = Date.now() + PLAN_TTL_MS;
        const savedPlan = {
          home,
          consumed: false,
          expiresAtMs,
          fingerprint: prepared.fingerprint,
          id,
          providerId,
          requestedIds: prepared.requestedIds,
          scope,
        };
        removeExpiredEntries(deletionPlans, PLAN_TTL_MS, MAX_SAVED_PLANS);
        while (deletionPlans.size >= MAX_SAVED_PLANS) {
          deletionPlans.delete(deletionPlans.keys().next().value);
        }
        deletionPlans.set(id, savedPlan);
        const warnings = [];
        if (preflight.activeThreadDetection === "unavailable") {
          warnings.push(`The current ${provider.displayName} runtime cannot identify an active session. Confirm it is safe to delete the selected sessions.`);
        }
        if (plan.unrecognizedLocationCount > 0) {
          warnings.push(`${plan.unrecognizedLocationCount} ${plan.unrecognizedLocationCount === 1 ? "location" : "locations"} in your Claude folder ${plan.unrecognizedLocationCount === 1 ? "was" : "were"} not recognized and will not be examined.`);
        }
        sendJson(response, 200, {
          plan: {
            ...summarizePlan(plan, preflight, scope),
            expiresAtMs,
            id,
            warnings,
          },
          scope,
          warnings,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/deletions") {
        requireMutationAuthorization({ request, requestUrl, token: mutationToken });

        if (mutationInProgress || activeOperationId) {
          sendJson(response, 409, { error: "Another deletion is already in progress." });
          return;
        }

        mutationInProgress = true;

        try {
          const body = await readJsonBody(request);
          const savedPlan = getDeletionPlan(body.planId);
          const operation = startDeletionOperation(savedPlan);
          sendJson(response, 202, { operation: publicOperation(operation) });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      const operationRoute = /^\/api\/deletions\/([^/]+)(\/restore|\/backup)?$/u.exec(requestUrl.pathname);

      if (operationRoute) {
        const operation = getOperation(decodeURIComponent(operationRoute[1]));
        const operationAction = operationRoute[2] ?? "";
        const restoreRoute = operationAction === "/restore";
        const backupRoute = operationAction === "/backup";

        if (request.method === "GET" && !operationAction) {
          sendJson(response, 200, { operation: publicOperation(operation) });
          return;
        }

        if (request.method === "DELETE" && !operationAction) {
          requireMutationAuthorization({ request, requestUrl, token: mutationToken });
          const cancelAccepted = operation.status === "queued" || (
            operation.status === "running" && operation.canCancel
          );
          if (cancelAccepted) operation.cancelRequested = true;
          sendJson(response, 200, {
            cancelAccepted,
            operation: publicOperation(operation),
          });
          return;
        }

        if (request.method === "DELETE" && backupRoute) {
          requireMutationAuthorization({ request, requestUrl, token: mutationToken });

          if (!operation.canDeleteBackup || !operation.backupDirectory) {
            throw new Error("A recovery backup is not available for deletion.");
          }

          if (mutationInProgress || activeOperationId) {
            sendJson(response, 409, { error: "Wait for the current cleanup to finish before deleting its backup." });
            return;
          }

          mutationInProgress = true;
          let releaseMutationLock;
          let responsePayload;
          try {
            const provider = getProvider(operation.providerId);
            const options = providerOptions(operation.providerId, operation.home);
            releaseMutationLock = await acquireSessionMutationLock({ options, provider });
            if (!(await removeOperationBackups(operation))) {
              throw new Error("The recovery backup could not be deleted.");
            }
            operation.backupDeleteError = null;
            operation.canRestore = false;
            if (operation.result) operation.result.recoveryBackupDeleted = true;
            responsePayload = { operation: publicOperation(operation) };
          } finally {
            await releaseMutationLock?.().catch(() => {});
            mutationInProgress = false;
          }
          sendJson(response, 200, responsePayload);
          return;
        }

        if (request.method === "POST" && restoreRoute) {
          requireMutationAuthorization({ request, requestUrl, token: mutationToken });

          if (!operation.canRestore || !operation.backupDirectory) {
            throw new Error("A recovery restore is not available for this cleanup.");
          }

          if (mutationInProgress || activeOperationId) {
            sendJson(response, 409, { error: "Wait for the current cleanup to finish before restoring." });
            return;
          }

          mutationInProgress = true;
          try {
            startRestoreOperation(operation);
            sendJson(response, 202, { operation: publicOperation(operation) });
          } finally {
            mutationInProgress = false;
          }
          return;
        }
      }

      sendJson(response, 404, { error: "Route not found." });
    } catch (error) {
      const payload = {
        error: error instanceof Error ? error.message : "Request failed.",
      };
      if (error?.code) payload.code = error.code;
      sendJson(response, 400, payload);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Local server did not expose a TCP port.");
  }

  return {
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...activeTasks]);
    },
    port: address.port,
    token: mutationToken,
  };
}
