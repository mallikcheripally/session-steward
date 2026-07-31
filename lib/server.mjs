import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider } from "./providers/index.mjs";
import { createProviderSettings } from "./settings.mjs";
import { classifyInstalledVersion } from "./version-support.mjs";

const {
  assertDeepCleanupSupported,
  formatSessionForJson,
  executeSessionDeletion,
  fingerprintSessionDeletion,
  diagnoseStorageCompatibility,
  getSessionRecord,
  listSessions,
  loadDeletionStore,
  planSessionDeletion,
  preflightSessionDeletion,
  restoreSessionDeletionBackup,
  verifySessionDeletion,
} = getProvider("codex");

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_SCOPES = new Set(["core", "deep"]);
const PLAN_TTL_MS = 10 * 60 * 1000;
const OPERATION_TTL_MS = 60 * 60 * 1000;
const MAX_SAVED_PLANS = 20;
const MAX_SAVED_OPERATIONS = 50;
const PLAN_RECORD_SAMPLE_LIMIT = 20;
const PLAN_REVIEW_REQUIRED = "DELETION_PLAN_REVIEW_REQUIRED";
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const staticAssets = new Map([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
]);

function readCommandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

async function getInstalledProductVersions() {
  const versions = { chatgptDesktop: null, codexCli: readCommandVersion("codex", ["--version"]) };

  if (process.platform !== "darwin") {
    return versions;
  }

  const chatGptInfoPath = "/Applications/ChatGPT.app/Contents/Info.plist";
  try {
    await fs.access(chatGptInfoPath);
    versions.chatgptDesktop = readCommandVersion("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", chatGptInfoPath]);
  } catch {
  }

  return versions;
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

function summarizePlan(plan, preflight) {
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
    recordSamples: plan.records.slice(0, PLAN_RECORD_SAMPLE_LIMIT).map((record) => ({
      displayName: record.displayName,
      id: record.id,
    })),
    sessionIndexMatchCount: plan.sessionIndexMatchCount,
    sessionCount: plan.ids.length,
    spawnEdgeCount: plan.spawnEdgeCount,
    transcriptCount: plan.transcriptPaths.length,
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
    backupDirectory: result.backupDirectory,
    deletedSessionCount: result.deletedIds.length,
    deletedTranscriptCount: result.deletedTranscriptPaths.length,
    skippedTranscriptCount: result.skippedTranscriptPaths.length,
  };
}

function publicOperation(operation) {
  return {
    backupDirectory: operation.backupDirectory ?? null,
    canCancel: Boolean(operation.canCancel),
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

export async function startLocalServer({ codexHome, configDirectory, port = 0 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer between 0 and 65535.");
  }

  const settings = await createProviderSettings({
    configDirectory,
    providerHomeOverrides: codexHome === undefined ? {} : { codex: codexHome },
  });
  const mutationToken = randomBytes(32).toString("base64url");
  let mutationInProgress = false;
  let activeOperationId = null;
  const deletionPlans = new Map();
  const operations = new Map();
  const activeTasks = new Set();

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

    if (savedPlan.codexHome !== settings.getHome("codex")) {
      deletionPlans.delete(planId);
      throw codedError(
        "The Codex session folder changed. Review the selection again.",
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

    try {
      let currentStore;

      try {
        currentStore = await loadDeletionStore({
          codexHome: savedPlan.codexHome,
          recordIds: savedPlan.requestedIds,
        });
      } catch (error) {
        if (error?.message === "One or more selected sessions are no longer available.") {
          throw codedError(
            "The selected sessions changed after this preview. Review the selection again.",
            PLAN_REVIEW_REQUIRED,
          );
        }
        throw error;
      }

      const currentPlan = await planSessionDeletion({
        recordIds: savedPlan.requestedIds,
        store: currentStore,
      });
      const currentFingerprint = await fingerprintSessionDeletion({
        plan: currentPlan,
        scope: savedPlan.scope,
        store: currentStore,
      });

      if (currentFingerprint !== savedPlan.fingerprint) {
        throw codedError(
          "Session data changed after this preview. Review the selection again.",
          PLAN_REVIEW_REQUIRED,
        );
      }

      if (savedPlan.scope === "deep") {
        await assertDeepCleanupSupported({ codexHome: savedPlan.codexHome });
      }

      const result = await executeSessionDeletion({
        onProgress: (update) => Object.assign(operation, update),
        plan: currentPlan,
        scope: savedPlan.scope,
        shouldCancel: () => operation.cancelRequested,
        store: currentStore,
      });
      operation.backupDirectory = result.backupDirectory;
      operation.result = summarizeDeletionResult(result);
      operation.canCancel = false;
      operation.message = "Checking that cleanup completed";
      operation.phase = "verification";
      operation.progress = 94;
      const verification = await verifySessionDeletion({
        plan: currentPlan,
        scope: savedPlan.scope,
        store: currentStore,
      });
      operation.verification = summarizeVerification(verification);
      operation.progress = 100;

      if (verification.complete) {
        operation.message = "Cleanup completed";
        operation.status = "completed";
      } else {
        operation.canRestore = true;
        operation.error = "Cleanup finished, but some selected items remain. You can restore the recovery backup.";
        operation.message = "Cleanup needs attention";
        operation.status = "needs-attention";
      }
    } catch (error) {
      operation.backupDirectory = error?.backupDirectory ?? null;
      operation.canCancel = false;
      operation.errorCode = error?.code ?? null;
      operation.progress = error?.cancelled ? operation.progress : 100;

      if (error?.cancelled) {
        operation.error = null;
        operation.message = "Cleanup cancelled before session data changed";
        operation.status = "cancelled";
      } else {
        operation.canRestore = Boolean(operation.backupDirectory);
        operation.error = error instanceof Error ? error.message : "Cleanup could not be completed.";
        operation.message = "Cleanup could not be completed";
        operation.status = "failed";
      }
    } finally {
      savedPlan.consumed = true;
      deletionPlans.delete(savedPlan.id);
      operation.finishedAtMs = Date.now();
      if (activeOperationId === operation.id) activeOperationId = null;
    }
  }

  function startDeletionOperation(savedPlan) {
    removeExpiredEntries(operations, OPERATION_TTL_MS, MAX_SAVED_OPERATIONS);
    const id = randomBytes(18).toString("base64url");
    const operation = {
      backupDirectory: null,
      canCancel: true,
      canRestore: false,
      cancelRequested: false,
      codexHome: savedPlan.codexHome,
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
    operation.canRestore = false;
    operation.error = null;
    operation.errorCode = null;
    operation.message = "Restore queued";
    operation.phase = "restore";
    operation.progress = 0;
    operation.status = "restoring";
    activeOperationId = operation.id;
    const task = (async () => {
      try {
        operation.restoreResult = await restoreSessionDeletionBackup({
          backupDirectory: operation.backupDirectory,
          codexHome: operation.codexHome,
          onProgress: (update) => Object.assign(operation, update),
        });
        operation.message = "Recovery backup restored";
        operation.progress = 100;
        operation.status = "restored";
      } catch (error) {
        operation.canRestore = true;
        operation.error = error instanceof Error ? error.message : "The recovery backup could not be restored.";
        operation.message = "Restore could not be completed";
        operation.status = "restore-failed";
      } finally {
        operation.finishedAtMs = Date.now();
        if (activeOperationId === operation.id) activeOperationId = null;
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
        sendJson(response, 200, { mutationToken, providers: settings.getAll() });
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
          sendJson(response, 200, { provider });
        } finally {
          mutationInProgress = false;
        }

        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/compatibility") {
        const diagnostic = await diagnoseStorageCompatibility({ codexHome: settings.getHome("codex") });
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
        sendJson(response, 200, { ...diagnostic, currentVersions, versionSupport });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/sessions") {
        const result = await listSessions({
          codexHome: settings.getHome("codex"),
          includeInternals: requestUrl.searchParams.get("includeInternals") === "true",
          includeSupporting: requestUrl.searchParams.get("includeSupporting") === "true",
          page: getPositiveInteger(requestUrl.searchParams.get("page"), 1),
          pageSize: getPositiveInteger(requestUrl.searchParams.get("pageSize"), 25, 100),
          search: requestUrl.searchParams.get("search"),
          sort: requestUrl.searchParams.get("sort"),
        });
        sendJson(response, 200, {
          ...result,
          records: result.records.map(formatSessionForJson),
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(requestUrl.pathname.slice("/api/sessions/".length));
        const record = await getSessionRecord({ codexHome: settings.getHome("codex"), id });

        if (!record) {
          sendJson(response, 404, { error: "Session not found." });
          return;
        }

        sendJson(response, 200, { record: formatSessionForJson(record) });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/deletion-plans") {
        const body = await readJsonBody(request);
        const ids = normalizeIds(body.ids);
        const scope = getScope(body.scope);
        const activeCodexHome = settings.getHome("codex");

        if (scope === "deep") {
          await assertDeepCleanupSupported({ codexHome: activeCodexHome });
        }

        const store = await loadDeletionStore({
          codexHome: activeCodexHome,
          recordIds: ids,
        });
        const plan = await planSessionDeletion({ recordIds: ids, store });
        const preflight = await preflightSessionDeletion({ plan, store });
        const id = randomBytes(18).toString("base64url");
        const expiresAtMs = Date.now() + PLAN_TTL_MS;
        const savedPlan = {
          codexHome: activeCodexHome,
          consumed: false,
          expiresAtMs,
          fingerprint: await fingerprintSessionDeletion({ plan, scope, store }),
          id,
          requestedIds: ids,
          scope,
        };
        removeExpiredEntries(deletionPlans, PLAN_TTL_MS, MAX_SAVED_PLANS);
        while (deletionPlans.size >= MAX_SAVED_PLANS) {
          deletionPlans.delete(deletionPlans.keys().next().value);
        }
        deletionPlans.set(id, savedPlan);
        sendJson(response, 200, {
          plan: {
            ...summarizePlan(plan, preflight),
            expiresAtMs,
            id,
          },
          scope,
          warnings: preflight.activeThreadDetection === "unavailable"
            ? ["The current Codex runtime cannot identify an active session. Confirm it is safe to delete the selected sessions."]
            : [],
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

      const operationRoute = /^\/api\/deletions\/([^/]+)(\/restore)?$/u.exec(requestUrl.pathname);

      if (operationRoute) {
        const operation = getOperation(decodeURIComponent(operationRoute[1]));
        const restoreRoute = Boolean(operationRoute[2]);

        if (request.method === "GET" && !restoreRoute) {
          sendJson(response, 200, { operation: publicOperation(operation) });
          return;
        }

        if (request.method === "DELETE" && !restoreRoute) {
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
