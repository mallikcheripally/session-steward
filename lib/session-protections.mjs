import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getDefaultConfigDirectory } from "./settings.mjs";

export const SESSION_PROTECTION_BUSY = "SESSION_PROTECTION_BUSY";

const STATE_VERSION = 1;
const MAX_PROTECTIONS = 10_000;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const LOCK_TIMEOUT_MS = 5_000;
const INCOMPLETE_LOCK_MS = 60_000;
const PROVIDERS = new Set(["codex", "claude-code"]);

function emptyState() {
  return { revision: 0, sessions: [], version: STATE_VERSION, workspaces: [] };
}

function pathsFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparisonPath(value, platform) {
  const normalized = pathsFor(platform).normalize(value);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function normalizeProvider(providerId) {
  if (!PROVIDERS.has(providerId)) throw new Error("That session provider is not available.");
  return providerId;
}

function normalizeSessionId(sessionId) {
  if (
    typeof sessionId !== "string"
    || sessionId.length === 0
    || sessionId.length > MAX_ID_LENGTH
    || sessionId.trim() !== sessionId
    || sessionId.includes("\0")
  ) {
    throw new Error("Enter a valid session ID.");
  }
  return sessionId;
}

function normalizeAbsolutePath(value, label, platform) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_LENGTH
    || value.includes("\0")
  ) {
    throw new Error(`Enter a valid ${label}.`);
  }
  const trimmed = value.trim();
  const paths = pathsFor(platform);
  if (!paths.isAbsolute(trimmed)) throw new Error(`Enter a full ${label}.`);
  return paths.normalize(trimmed);
}

export function normalizeWorkspacePath(value, { platform = process.platform } = {}) {
  return normalizeAbsolutePath(value, "workspace path", platform);
}

export function sessionProviderHomeKey(providerHome, { platform = process.platform } = {}) {
  const normalized = normalizeAbsolutePath(providerHome, "provider folder path", platform);
  return createHash("sha256")
    .update(comparisonPath(normalized, platform))
    .digest("hex");
}

function createProtectionMatcher({
  platform = process.platform,
  providerHome,
  providerId,
  snapshot,
}) {
  const normalizedProvider = normalizeProvider(providerId);
  const homeKey = sessionProviderHomeKey(providerHome, { platform });
  const sessionIds = new Set(snapshot.sessions
    .filter((item) => item.providerId === normalizedProvider && item.providerHomeKey === homeKey)
    .map((item) => item.sessionId));
  const workspacePaths = new Map(snapshot.workspaces.map((item) => [
    comparisonPath(item.path, platform),
    item.path,
  ]));
  const paths = pathsFor(platform);

  return (record) => {
    const sessionId = normalizeSessionId(record?.id);
    const session = sessionIds.has(sessionId);
    let workspacePath = null;
    if (typeof record?.cwd === "string" && record.cwd.length > 0) {
      try {
        let candidate = normalizeWorkspacePath(record.cwd, { platform });
        while (true) {
          workspacePath = workspacePaths.get(comparisonPath(candidate, platform)) ?? null;
          if (workspacePath) break;
          const parent = paths.dirname(candidate);
          if (parent === candidate) break;
          candidate = parent;
        }
      } catch {
        workspacePath = null;
      }
    }
    return {
      kept: session || Boolean(workspacePath),
      reasons: [session ? "session" : null, workspacePath ? "workspace" : null].filter(Boolean),
      session,
      workspace: Boolean(workspacePath),
      workspacePath,
    };
  };
}

export function compileSessionProtectionMatcher(args) {
  return createProtectionMatcher(args);
}

function validateState(parsed, platform) {
  if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION) {
    throw new Error("Session Steward cannot use this Keep data version. Cleanup was paused.");
  }
  if (
    !Number.isSafeInteger(parsed.revision)
    || parsed.revision < 0
    || !Array.isArray(parsed.sessions)
    || !Array.isArray(parsed.workspaces)
    || parsed.sessions.length + parsed.workspaces.length > MAX_PROTECTIONS
  ) {
    throw new Error("Session Steward Keep data is invalid. Cleanup was paused.");
  }
  for (const item of parsed.sessions) {
    if (
      !item || typeof item !== "object"
      || !PROVIDERS.has(item.providerId)
      || typeof item.providerHomeKey !== "string"
      || !/^[a-f0-9]{64}$/u.test(item.providerHomeKey)
      || typeof item.sessionId !== "string"
      || item.sessionId.length === 0
      || item.sessionId.length > MAX_ID_LENGTH
      || item.sessionId.trim() !== item.sessionId
      || item.sessionId.includes("\0")
      || !Number.isFinite(item.createdAtMs)
    ) {
      throw new Error("Session Steward Keep data is invalid. Cleanup was paused.");
    }
  }
  for (const item of parsed.workspaces) {
    if (
      !item || typeof item !== "object"
      || typeof item.path !== "string"
      || item.path.length === 0
      || item.path.length > MAX_PATH_LENGTH
      || !Number.isFinite(item.createdAtMs)
    ) {
      throw new Error("Session Steward Keep data is invalid. Cleanup was paused.");
    }
    try {
      if (normalizeWorkspacePath(item.path, { platform }) !== item.path) {
        throw new Error("not normalized");
      }
    } catch {
      throw new Error("Session Steward Keep data is invalid. Cleanup was paused.");
    }
  }
  return structuredClone(parsed);
}

async function readState(statePath, platform) {
  let source;
  try {
    source = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error("Session Steward could not read Keep data. Cleanup was paused.", { cause: error });
  }
  try {
    return validateState(JSON.parse(source), platform);
  } catch (error) {
    if (error?.message?.includes("Cleanup was paused")) throw error;
    throw new Error("Session Steward Keep data is invalid. Cleanup was paused.", { cause: error });
  }
}

async function writeState(statePath, state) {
  const directory = path.dirname(statePath);
  const temporaryPath = path.join(
    directory,
    `.session-protections-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  await fs.mkdir(directory, { mode: 0o700, recursive: true });
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, statePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new Error("Session Steward could not save Keep data.", { cause: error });
  }
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

async function lockIsStale(lockPath, now) {
  let stats;
  try {
    stats = await fs.stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  try {
    const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const running = await processIsRunning(metadata?.pid);
    return running === null ? now() - stats.mtimeMs >= INCOMPLETE_LOCK_MS : !running;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return now() - stats.mtimeMs >= INCOMPLETE_LOCK_MS;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(lockPath, now) {
  const token = randomBytes(18).toString("base64url");
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
  let handle;
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath, now)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      await delay(25);
    }
  }
  if (!handle) {
    const error = new Error("Keep settings are busy. Try again after the current cleanup finishes.");
    error.code = SESSION_PROTECTION_BUSY;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ createdAtMs: now(), pid: process.pid, token })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
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

export function classifySessionProtection({
  platform = process.platform,
  providerHome,
  providerId,
  record,
  snapshot,
}) {
  return createProtectionMatcher({ platform, providerHome, providerId, snapshot })(record);
}

export function decorateSessionProtection(args) {
  const protection = classifySessionProtection(args);
  return { ...args.record, keep: protection };
}

export function createSessionProtectionStore({
  configDirectory = getDefaultConfigDirectory(),
  now = Date.now,
  platform = process.platform,
} = {}) {
  const statePath = path.join(configDirectory, "protections.json");
  const lockPath = path.join(configDirectory, "protections.lock");
  let matcherCache = null;

  async function mutate(mutator) {
    const release = await acquireLock(lockPath, now);
    try {
      const state = await readState(statePath, platform);
      const { changed, value } = mutator(state);
      if (changed) {
        state.revision += 1;
        await writeState(statePath, state);
      }
      return value;
    } finally {
      await release();
    }
  }

  async function keepSessions({ providerHome, providerId, sessionIds }) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new Error("Choose at least one session to keep.");
    }
    const normalizedProvider = normalizeProvider(providerId);
    const providerHomeKey = sessionProviderHomeKey(providerHome, { platform });
    const normalizedIds = [...new Set(sessionIds.map(normalizeSessionId))];
    return mutate((state) => {
      const existingIds = new Set(state.sessions
        .filter((item) => item.providerId === normalizedProvider && item.providerHomeKey === providerHomeKey)
        .map((item) => item.sessionId));
      const additions = normalizedIds
        .filter((sessionId) => !existingIds.has(sessionId))
        .map((sessionId) => ({
          createdAtMs: now(),
          providerHomeKey,
          providerId: normalizedProvider,
          sessionId,
        }));
      if (state.sessions.length + state.workspaces.length + additions.length > MAX_PROTECTIONS) {
        throw new Error(`Session Steward supports up to ${MAX_PROTECTIONS.toLocaleString()} kept items.`);
      }
      state.sessions.push(...additions);
      return {
        changed: additions.length > 0,
        value: normalizedIds.map((sessionId) => structuredClone(
          state.sessions.find((item) =>
            item.providerId === normalizedProvider
            && item.providerHomeKey === providerHomeKey
            && item.sessionId === sessionId),
        )),
      };
    });
  }

  async function removeSessions({ providerHome, providerId, sessionIds }) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new Error("Choose at least one session to stop keeping.");
    }
    const normalizedProvider = normalizeProvider(providerId);
    const providerHomeKey = sessionProviderHomeKey(providerHome, { platform });
    const normalizedIds = new Set(sessionIds.map(normalizeSessionId));
    return mutate((state) => {
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((item) => !(
        item.providerId === normalizedProvider
        && item.providerHomeKey === providerHomeKey
        && normalizedIds.has(item.sessionId)
      ));
      return { changed: state.sessions.length !== before, value: before - state.sessions.length };
    });
  }

  function matcher({ providerHome, providerId, snapshot }) {
    const cacheKey = `${snapshot.revision}\0${providerId}\0${sessionProviderHomeKey(providerHome, { platform })}`;
    if (matcherCache?.key !== cacheKey) {
      matcherCache = {
        key: cacheKey,
        value: createProtectionMatcher({ platform, providerHome, providerId, snapshot }),
      };
    }
    return matcherCache.value;
  }

  return {
    async acquireLease() {
      return acquireLock(lockPath, now);
    },

    classify({ providerHome, providerId, record, snapshot }) {
      return matcher({ providerHome, providerId, snapshot })(record);
    },

    matcher,

    homeKey(providerHome) {
      return sessionProviderHomeKey(providerHome, { platform });
    },

    async keepSession({ providerHome, providerId, sessionId }) {
      return (await keepSessions({ providerHome, providerId, sessionIds: [sessionId] }))[0];
    },

    keepSessions,

    removeSessions,

    async keepWorkspace({ workspace }) {
      const item = { createdAtMs: now(), path: normalizeWorkspacePath(workspace, { platform }) };
      const key = comparisonPath(item.path, platform);
      return mutate((state) => {
        const existing = state.workspaces.find((candidate) => comparisonPath(candidate.path, platform) === key);
        if (existing) return { changed: false, value: structuredClone(existing) };
        if (state.sessions.length + state.workspaces.length >= MAX_PROTECTIONS) {
          throw new Error(`Session Steward supports up to ${MAX_PROTECTIONS.toLocaleString()} kept items.`);
        }
        state.workspaces.push(item);
        return { changed: true, value: structuredClone(item) };
      });
    },

    async list() {
      return readState(statePath, platform);
    },

    async listWorkspaceRules({ page = 1, pageSize = 25, search = "" } = {}) {
      const state = await readState(statePath, platform);
      const boundedPageSize = Math.min(100, Math.max(1, Math.trunc(pageSize) || 25));
      const normalizedSearch = String(search ?? "").trim().toLocaleLowerCase("en-US");
      const filtered = state.workspaces
        .filter((item) => !normalizedSearch || item.path.toLocaleLowerCase("en-US").includes(normalizedSearch))
        .sort((left, right) => right.createdAtMs - left.createdAtMs || left.path.localeCompare(right.path));
      const pageCount = Math.max(1, Math.ceil(filtered.length / boundedPageSize));
      const currentPage = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
      return {
        page: currentPage,
        pageCount,
        pageSize: boundedPageSize,
        records: filtered.slice((currentPage - 1) * boundedPageSize, currentPage * boundedPageSize),
        revision: state.revision,
        total: filtered.length,
      };
    },

    async removeSession({ providerHome, providerId, sessionId }) {
      return (await removeSessions({ providerHome, providerId, sessionIds: [sessionId] })) > 0;
    },

    async removeWorkspace({ workspace }) {
      const normalized = normalizeWorkspacePath(workspace, { platform });
      const key = comparisonPath(normalized, platform);
      return mutate((state) => {
        const next = state.workspaces.filter((item) => comparisonPath(item.path, platform) !== key);
        const changed = next.length !== state.workspaces.length;
        state.workspaces = next;
        return { changed, value: changed };
      });
    },
  };
}
