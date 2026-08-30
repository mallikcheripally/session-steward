import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getProvider } from "./providers/index.mjs";
import { runSessionCleanup } from "./session-cleanup.mjs";
import { getDefaultConfigDirectory } from "./settings.mjs";

const STATE_VERSION = 1;
const MAX_SCHEDULES = 100;
const MAX_SESSIONS_PER_RUN = 100;
const RUN_CLAIM_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_DAY_COUNT = 3_650;
const LEGACY_FREQUENCY_DAYS = Object.freeze({ daily: 1, weekly: 7 });
const PROVIDERS = new Set(["codex", "claude-code"]);
const ARCHIVE_STATUSES = new Set(["all", "active", "archived"]);
const CLEANUP_MODES = new Set(["standard", "thorough"]);
const SELECTION_ORDERS = new Set(["oldest", "largest"]);

function emptyState() {
  return { schedules: [], version: STATE_VERSION };
}

function requiredChoice(value, values, label) {
  if (!values.has(value)) throw new Error(`${label} is not supported.`);
  return value;
}

function optionalText(value, label, maximumLength) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.includes("\0") || value.length > maximumLength) {
    throw new Error(`${label} is not valid.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

function requiredDayCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DAY_COUNT) {
    throw new Error(`${label} must be a whole number between 1 and ${MAX_DAY_COUNT}.`);
  }
  return value;
}

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== "object") {
    throw new Error("Enter cleanup schedule settings.");
  }
  const name = optionalText(definition.name, "Schedule name", 100);
  if (!name) throw new Error("Enter a schedule name.");
  const provider = requiredChoice(definition.provider, PROVIDERS, "Provider");
  const inactiveDays = requiredDayCount(definition.inactiveDays, "Inactivity period in days");
  const runEveryDays = requiredDayCount(
    definition.runEveryDays ?? LEGACY_FREQUENCY_DAYS[definition.frequency],
    "Run interval in days",
  );
  const cleanupMode = requiredChoice(
    definition.cleanupMode ?? "thorough",
    CLEANUP_MODES,
    "Cleanup mode",
  );
  const archiveStatus = requiredChoice(
    definition.archiveStatus ?? "all",
    ARCHIVE_STATUSES,
    "Archive status",
  );
  const selectionOrder = requiredChoice(
    definition.selectionOrder ?? "oldest",
    SELECTION_ORDERS,
    "Selection order",
  );
  const minimumTranscriptBytes = definition.minimumTranscriptBytes ?? null;
  if (
    minimumTranscriptBytes !== null
    && (!Number.isSafeInteger(minimumTranscriptBytes) || minimumTranscriptBytes <= 0)
  ) {
    throw new Error("Minimum transcript bytes must be a positive whole number.");
  }
  const maxSessions = definition.maxSessions ?? 25;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS_PER_RUN) {
    throw new Error(`Maximum sessions per run must be between 1 and ${MAX_SESSIONS_PER_RUN}.`);
  }
  const providerHomeOverride = definition.providerHomeOverride ?? null;
  if (
    providerHomeOverride !== null
    && (
      typeof providerHomeOverride !== "string"
      || providerHomeOverride.includes("\0")
      || !path.isAbsolute(providerHomeOverride)
    )
  ) {
    throw new Error("Provider folder override is not valid.");
  }

  return {
    archiveStatus,
    cleanupMode,
    enabled: definition.enabled !== false,
    inactiveDays,
    includeInternals: Boolean(definition.includeInternals),
    includeSupporting: Boolean(definition.includeSupporting),
    maxSessions,
    minimumTranscriptBytes,
    name,
    provider,
    providerHomeOverride,
    runEveryDays,
    selectionOrder,
    workspace: optionalText(definition.workspace, "Workspace", 4_096),
  };
}

function nextRunAt(schedule, now) {
  return schedule.enabled ? now + schedule.runEveryDays * DAY_MS : null;
}

function normalizeStoredSchedule(schedule) {
  if (Number.isSafeInteger(schedule?.runEveryDays)) return schedule;
  const runEveryDays = LEGACY_FREQUENCY_DAYS[schedule?.frequency];
  if (!runEveryDays) return schedule;
  const { frequency: _frequency, ...rest } = schedule;
  return { ...rest, runEveryDays };
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.schedules)) return emptyState();
    return {
      ...parsed,
      schedules: parsed.schedules.map(normalizeStoredSchedule),
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return emptyState();
    throw new Error("Session Steward could not read cleanup schedules.", { cause: error });
  }
}

async function writeState(statePath, state) {
  const directory = path.dirname(statePath);
  const temporaryPath = path.join(
    directory,
    `.cleanup-schedules-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
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
    throw new Error("Session Steward could not save cleanup schedules.", { cause: error });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(lockPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      await fs.mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
      return await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await delay(25);
    }
  }
  throw new Error("Cleanup schedules are busy. Try again shortly.");
}

function publicSchedule(schedule) {
  const { providerHomeOverride: _providerHomeOverride, ...safe } = schedule;
  return structuredClone(safe);
}

function privateSchedule(schedule) {
  return structuredClone(schedule);
}

export function createCleanupScheduleStore({
  configDirectory = getDefaultConfigDirectory(),
  createId = randomUUID,
  now = Date.now,
} = {}) {
  const statePath = path.join(configDirectory, "cleanup-schedules.json");
  const lockPath = path.join(configDirectory, "cleanup-schedules.lock");

  async function mutate(mutator) {
    const lock = await acquireLock(lockPath);
    try {
      const state = await readState(statePath);
      const value = await mutator(state);
      await writeState(statePath, state);
      return value;
    } finally {
      await lock.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  return {
    async claim(id, { force = false } = {}) {
      return mutate((state) => {
        const schedule = state.schedules.find((item) => item.id === id);
        if (!schedule) throw new Error("That cleanup schedule does not exist.");
        const currentTime = now();
        if (!schedule.enabled && !force) return null;
        if (!force && schedule.nextRunAtMs > currentTime) return null;
        if (
          Number.isFinite(schedule.runningSinceMs)
          && currentTime - schedule.runningSinceMs < RUN_CLAIM_TIMEOUT_MS
        ) {
          return null;
        }
        schedule.runningSinceMs = currentTime;
        schedule.nextRunAtMs = nextRunAt(schedule, currentTime);
        schedule.updatedAtMs = currentTime;
        return privateSchedule(schedule);
      });
    },

    async complete(id, run) {
      return mutate((state) => {
        const schedule = state.schedules.find((item) => item.id === id);
        if (!schedule) return null;
        schedule.lastRun = run;
        schedule.runningSinceMs = null;
        schedule.updatedAtMs = now();
        return publicSchedule(schedule);
      });
    },

    async list() {
      const state = await readState(statePath);
      return state.schedules.map(publicSchedule);
    },

    async remove(id) {
      return mutate((state) => {
        const index = state.schedules.findIndex((item) => item.id === id);
        if (index < 0) throw new Error("That cleanup schedule does not exist.");
        const [removed] = state.schedules.splice(index, 1);
        return publicSchedule(removed);
      });
    },

    async save(definition, { id } = {}) {
      const normalized = normalizeDefinition(definition);
      return mutate((state) => {
        const currentTime = now();
        if (id === undefined) {
          if (state.schedules.length >= MAX_SCHEDULES) {
            throw new Error(`Session Steward supports up to ${MAX_SCHEDULES} cleanup schedules.`);
          }
          const schedule = {
            ...normalized,
            createdAtMs: currentTime,
            id: createId(),
            lastRun: null,
            nextRunAtMs: nextRunAt(normalized, currentTime),
            runningSinceMs: null,
            updatedAtMs: currentTime,
          };
          state.schedules.push(schedule);
          return publicSchedule(schedule);
        }

        const index = state.schedules.findIndex((item) => item.id === id);
        if (index < 0) throw new Error("That cleanup schedule does not exist.");
        const existing = state.schedules[index];
        const timingChanged = existing.runEveryDays !== normalized.runEveryDays
          || existing.enabled !== normalized.enabled;
        const schedule = {
          ...existing,
          ...normalized,
          nextRunAtMs: timingChanged
            ? nextRunAt(normalized, currentTime)
            : existing.nextRunAtMs,
          updatedAtMs: currentTime,
        };
        state.schedules[index] = schedule;
        return publicSchedule(schedule);
      });
    },
  };
}

function scheduleProviderOptions(schedule, settings) {
  const home = schedule.providerHomeOverride ?? settings.getHome(schedule.provider);
  if (schedule.provider === "codex") return { codexHome: home };
  const options = { claudeHome: home };
  if (typeof settings.getClaudeDesktopDataHome === "function") {
    options.desktopDataHome = settings.getClaudeDesktopDataHome();
  }
  return options;
}

function listingOptions(schedule, settings, now) {
  return {
    archiveStatus: schedule.archiveStatus,
    includeInternals: schedule.includeInternals,
    includeSupporting: schedule.includeSupporting,
    inactiveBeforeMs: now() - schedule.inactiveDays * DAY_MS,
    minimumTranscriptBytes: schedule.minimumTranscriptBytes ?? undefined,
    pageSize: schedule.maxSessions,
    search: "",
    sort: schedule.selectionOrder === "largest" ? "size" : "updated",
    workspace: schedule.workspace ?? undefined,
    ...scheduleProviderOptions(schedule, settings),
  };
}

async function findCandidates(schedule, provider, settings, now) {
  const options = listingOptions(schedule, settings, now);
  if (options.sort === "size") {
    const result = await provider.listSessions({ ...options, page: 1 });
    return result.records.slice(0, schedule.maxSessions);
  }

  const first = await provider.listSessions({ ...options, page: 1 });
  if (first.pageCount === 1) return [...first.records].reverse();
  const oldest = await provider.listSessions({ ...options, page: first.pageCount });
  const records = [...oldest.records].reverse();
  if (records.length < schedule.maxSessions && first.pageCount > 1) {
    const previous = await provider.listSessions({ ...options, page: first.pageCount - 1 });
    records.push(...[...previous.records].reverse());
  }
  return records.slice(0, schedule.maxSessions);
}

function safeRunResult(result, candidateCount, atMs) {
  return {
    affectedSessionCount: result.affectedSessionCount,
    atMs,
    candidateCount,
    cleanupFallback: result.cleanupFallback,
    cleanupMode: result.cleanupMode,
    deletedSessionCount: result.deletedSessionCount,
    requestedCleanupMode: result.requestedCleanupMode,
    status: result.status,
    transcriptBytes: result.transcriptBytes,
  };
}

export async function runCleanupSchedule({
  cleanup = runSessionCleanup,
  force = false,
  id,
  now = Date.now,
  resolveProvider = getProvider,
  scheduleStore,
  settings,
  signal,
} = {}) {
  const schedule = await scheduleStore.claim(id, { force });
  if (!schedule) return { id, status: "not-due" };
  const atMs = now();
  let candidateCount = 0;
  let run;
  try {
    const provider = resolveProvider(schedule.provider);
    const candidates = await findCandidates(schedule, provider, settings, now);
    candidateCount = candidates.length;
    if (candidates.length === 0) {
      run = {
        affectedSessionCount: 0,
        atMs,
        candidateCount: 0,
        deletedSessionCount: 0,
        status: "no-matches",
        transcriptBytes: 0,
      };
    } else {
      const result = await cleanup({
        options: scheduleProviderOptions(schedule, settings),
        provider,
        recordIds: candidates.map((record) => record.id),
        scope: schedule.cleanupMode === "thorough" ? "deep" : "core",
        signal,
      });
      run = safeRunResult(result, candidates.length, atMs);
    }
  } catch {
    run = {
      affectedSessionCount: 0,
      atMs,
      candidateCount,
      deletedSessionCount: null,
      status: "failed",
      transcriptBytes: 0,
    };
  }
  await scheduleStore.complete(schedule.id, run);
  return { id: schedule.id, provider: schedule.provider, ...run };
}

export async function runDueCleanupSchedules({
  cleanup = runSessionCleanup,
  now = Date.now,
  resolveProvider = getProvider,
  scheduleStore,
  settings,
} = {}) {
  const schedules = await scheduleStore.list();
  const results = [];
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.nextRunAtMs > now()) continue;
    results.push(await runCleanupSchedule({
      cleanup,
      id: schedule.id,
      now,
      resolveProvider,
      scheduleStore,
      settings,
    }));
  }
  return results;
}
