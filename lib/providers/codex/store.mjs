import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { measurePath } from "../../storage/files.mjs";
import {
  inspectJsonlMatches,
  readJsonlEntries,
  rewriteJsonlFile,
} from "../../storage/jsonl.mjs";
import {
  backupDatabase,
  batches,
  executeTransaction,
  placeholders,
  queryRows,
} from "../../storage/sqlite.mjs";
import {
  allValidDatabases,
  CODEX_DATABASE_PROFILE,
  databaseFamilySummary,
  invalidateCodexDatabaseResolution,
  resolveCodexDatabases,
} from "./database-families.mjs";
import { expandHomePath } from "../../platform.mjs";

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeDisplayName(value) {
  return normalizeText(value);
}

function cleanDerivedTitle(value) {
  const original = normalizeDisplayName(value);

  if (!original) {
    return "";
  }

  let cleaned = original.replace(/^\[\d+\]\s+(?:user|assistant):\s*/u, "");
  const nextRoleMarker = cleaned.search(/\s\[\d+\]\s+(?:user|assistant):\s*/u);

  if (nextRoleMarker >= 0) {
    cleaned = cleaned.slice(0, nextRoleMarker);
  }

  cleaned = normalizeDisplayName(
    cleaned.replace(/\[([^\[\]]+?)\]\([^()]*?\)/gu, "$1"),
  );

  return cleaned && /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : original;
}

function toTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsedNumber = Number(value);

    if (Number.isFinite(parsedNumber)) {
      return parsedNumber;
    }

    const parsedDate = Date.parse(value);

    return Number.isFinite(parsedDate) ? parsedDate : 0;
  }

  return 0;
}

function getMeaningfulUserText(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "";
  }

  if (
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<subagent_notification>") ||
    normalized.startsWith("The following is the Codex agent history")
  ) {
    return "";
  }

  return normalized;
}

function extractUserTextFromTranscriptEntry(entry) {
  if (
    entry?.type !== "response_item" ||
    entry?.payload?.type !== "message" ||
    entry?.payload?.role !== "user"
  ) {
    return "";
  }

  const parts = Array.isArray(entry.payload.content) ? entry.payload.content : [];
  const text = parts
    .map((item) => {
      if (item?.type === "input_text" || item?.type === "output_text") {
        return item.text ?? "";
      }

      return "";
    })
    .join(" ");

  return getMeaningfulUserText(text);
}

async function* findTranscriptFiles(rootDirectory) {
  let directory;

  try {
    directory = await fs.opendir(rootDirectory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for await (const entry of directory) {
    const resolvedPath = path.join(rootDirectory, entry.name);

    if (entry.isDirectory()) {
      yield* findTranscriptFiles(resolvedPath);
      continue;
    }

    if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
      yield resolvedPath;
    }
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isContainedPath(rootDirectory, candidatePath) {
  if (!candidatePath) return false;
  const relativePath = path.relative(path.resolve(rootDirectory), path.resolve(candidatePath));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function readFirstLine(filePath) {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
  });
  const interfaceHandle = readline.createInterface({
    crlfDelay: Infinity,
    input: stream,
  });

  try {
    for await (const line of interfaceHandle) {
      return line;
    }
  } finally {
    interfaceHandle.close();
    stream.destroy();
  }

  return "";
}

async function parseTranscriptHeader(filePath) {
  const firstLine = await readFirstLine(filePath);

  if (!firstLine) {
    return null;
  }

  const parsed = JSON.parse(firstLine);

  if (parsed?.type !== "session_meta" || !parsed?.payload?.id) {
    return null;
  }

  const payload = parsed.payload;
  const subagentParentId =
    payload?.source?.subagent?.thread_spawn?.parent_thread_id ?? null;

  return {
    agentNickname: payload.agent_nickname ?? null,
    agentRole: payload.agent_role ?? null,
    cwd: payload.cwd ?? "",
    filePath,
    forkedFromId: payload.forked_from_id ?? null,
    id: payload.id,
    parentThreadId: subagentParentId,
    timestampMs: toTimestampMs(payload.timestamp),
  };
}

async function parseTranscriptFallback(filePath) {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
  });
  const interfaceHandle = readline.createInterface({
    crlfDelay: Infinity,
    input: stream,
  });
  let firstUserMessage = "";
  let latestThreadName = "";

  try {
    for await (const line of interfaceHandle) {
      if (!line.trim()) {
        continue;
      }

      let parsedLine = null;

      try {
        parsedLine = JSON.parse(line);
      } catch {
        continue;
      }

      if (
        parsedLine?.type === "event_msg" &&
        parsedLine?.payload?.type === "thread_name_updated"
      ) {
        const threadName = normalizeDisplayName(parsedLine.payload.thread_name ?? "");

        if (threadName) {
          latestThreadName = threadName;
        }

        continue;
      }

      if (!firstUserMessage) {
        const userText = extractUserTextFromTranscriptEntry(parsedLine);

        if (userText) {
          firstUserMessage = userText;
        }
      }
    }
  } finally {
    interfaceHandle.close();
    stream.destroy();
  }

  return {
    firstUserMessage,
    latestThreadName,
  };
}

async function readSessionIndexMap(filePath, sessionIds) {
  const map = new Map();

  if (sessionIds.size === 0) {
    return map;
  }

  for await (const entry of readJsonlEntries(filePath)) {
    if (!entry.parsed?.id) {
      continue;
    }

    const id = String(entry.parsed.id);

    if (!sessionIds.has(id)) {
      continue;
    }

    const threadName = normalizeDisplayName(entry.parsed.thread_name ?? "");
    const updatedAt = toTimestampMs(entry.parsed.updated_at);
    const current = map.get(id);

    if (!current || updatedAt >= current.updatedAt) {
      map.set(id, {
        threadName,
        updatedAt,
      });
    }
  }

  return map;
}

async function readHistoryMap(filePath, sessionIds) {
  const map = new Map();

  if (sessionIds.size === 0) {
    return map;
  }

  for await (const entry of readJsonlEntries(filePath)) {
    if (!entry.parsed?.session_id) {
      continue;
    }

    const sessionId = String(entry.parsed.session_id);

    if (!sessionIds.has(sessionId)) {
      continue;
    }

    const text = getMeaningfulUserText(entry.parsed.text ?? "");

    if (!text) {
      continue;
    }

    const timestamp = toTimestampMs(entry.parsed.ts);
    const current = map.get(sessionId);

    if (!current || timestamp < current.timestamp) {
      map.set(sessionId, {
        text,
        timestamp,
      });
    }
  }

  return map;
}

function getHistoryCandidateIds(threadRows, transcriptHeaders, sessionIndexMap) {
  const threadIds = new Set();
  const sessionIds = new Set();

  for (const threadRow of threadRows) {
    const id = String(threadRow.id);
    threadIds.add(id);

    if (
      !normalizeDisplayName(threadRow.title ?? "") &&
      !getMeaningfulUserText(threadRow.first_user_message ?? "") &&
      !sessionIndexMap.get(id)?.threadName
    ) {
      sessionIds.add(id);
    }
  }

  for (const transcriptId of transcriptHeaders.keys()) {
    if (!threadIds.has(transcriptId) && !sessionIndexMap.get(transcriptId)?.threadName) {
      sessionIds.add(transcriptId);
    }
  }

  return sessionIds;
}

function deriveDisplayName({
  historyMap,
  sessionIndexMap,
  sessionRecord,
  transcriptFallback,
}) {
  const sqliteTitle = normalizeDisplayName(sessionRecord.title ?? "");
  const sqliteFirstUserMessage = getMeaningfulUserText(
    sessionRecord.firstUserMessage ?? "",
  );
  const sessionIndexEntry = sessionIndexMap.get(sessionRecord.id);
  const sqliteTitleLooksPrompt =
    Boolean(sqliteTitle) &&
    Boolean(sqliteFirstUserMessage) &&
    sqliteTitle === sqliteFirstUserMessage;

  if (sessionIndexEntry?.threadName && (!sqliteTitle || sqliteTitleLooksPrompt)) {
    return {
      source: "session_index",
      value: cleanDerivedTitle(sessionIndexEntry.threadName),
    };
  }

  if (
    transcriptFallback?.latestThreadName &&
    (!sqliteTitle || sqliteTitleLooksPrompt)
  ) {
    return {
      source: "transcript_thread_name",
      value: cleanDerivedTitle(transcriptFallback.latestThreadName),
    };
  }

  if (sqliteTitle) {
    return {
      source: "sqlite_title",
      value: cleanDerivedTitle(sqliteTitle),
    };
  }

  if (sqliteFirstUserMessage) {
    return {
      source: "sqlite_first_user_message",
      value: cleanDerivedTitle(sqliteFirstUserMessage),
    };
  }

  const historyEntry = historyMap.get(sessionRecord.id);

  if (historyEntry?.text) {
    return {
      source: "history_first_user_message",
      value: cleanDerivedTitle(historyEntry.text),
    };
  }

  if (transcriptFallback?.firstUserMessage) {
    return {
      source: "transcript_first_user_message",
      value: cleanDerivedTitle(transcriptFallback.firstUserMessage),
    };
  }

  return {
    source: "fallback",
    value: `Untitled ${sessionRecord.id.slice(0, 8)}`,
  };
}

export function getCodexPaths(codexHomeInput, { refresh = false } = {}) {
  const codexHome = path.resolve(expandHomePath(codexHomeInput || "~/.codex"));
  const archivedSessionsDirectory = path.join(codexHome, "archived_sessions");
  const sessionsDirectory = path.join(codexHome, "sessions");
  const resolution = resolveCodexDatabases(codexHome, { refresh });
  const { goals, logs, memories, state } = resolution.families;
  const stateDatabasePath = state.primary?.path ?? path.join(codexHome, "state_5.sqlite");
  const logsDatabasePath = logs.primary?.path ?? path.join(codexHome, "logs_2.sqlite");
  const memoryDatabasePath = memories.primary?.path ?? path.join(codexHome, "memories_1.sqlite");
  const goalsDatabasePath = goals.primary?.path ?? path.join(codexHome, "goals_1.sqlite");

  return {
    archivedSessionsDirectory,
    attachmentsDirectory: path.join(codexHome, "attachments"),
    codexHome,
    desktopStateBackupPath: path.join(codexHome, ".codex-global-state.json.bak"),
    desktopStatePath: path.join(codexHome, ".codex-global-state.json"),
    databaseFamilies: resolution.families,
    goalsDatabasePath,
    goalsDatabasePaths: allValidDatabases(goals).map((database) => database.path),
    historyPath: path.join(codexHome, "history.jsonl"),
    logsDatabasePath,
    logsDatabasePaths: allValidDatabases(logs).map((database) => database.path),
    memoryDatabasePath,
    memoryDatabasePaths: allValidDatabases(memories).map((database) => database.path),
    resolvedDatabases: databaseFamilySummary(resolution),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
    sessionsDirectory,
    stateDatabasePath,
    stateDatabases: allValidDatabases(state),
    stateDatabasePaths: allValidDatabases(state).map((database) => database.path),
    threadWriterLocksDirectory: path.join(codexHome, "thread-writer-locks"),
    transcriptDirectories: [sessionsDirectory, archivedSessionsDirectory],
  };
}

const DESKTOP_THREAD_MAP_KEYS = [
  "thread-project-assignments",
  "thread-projectless-output-directories",
  "thread-writable-roots",
  "thread-workspace-root-hints",
];

const DESKTOP_THREAD_ARRAY_KEYS = ["projectless-thread-ids"];


function getMatchingDesktopStateEntryCount(state, deletedIdSet) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return 0;
  }

  let count = 0;

  for (const key of DESKTOP_THREAD_MAP_KEYS) {
    const value = state[key];

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    for (const id of deletedIdSet) {
      if (Object.hasOwn(value, id)) {
        count += 1;
      }
    }
  }

  for (const key of DESKTOP_THREAD_ARRAY_KEYS) {
    const value = state[key];

    if (!Array.isArray(value)) {
      continue;
    }

    count += value.filter((id) => deletedIdSet.has(String(id))).length;
  }

  return count;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function removeDesktopStateEntries(state, deletedIdSet) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Codex desktop state is not a JSON object.");
  }

  const updatedState = { ...state };

  for (const key of DESKTOP_THREAD_MAP_KEYS) {
    const value = updatedState[key];

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const updatedValue = { ...value };

    for (const id of deletedIdSet) {
      delete updatedValue[id];
    }

    updatedState[key] = updatedValue;
  }

  for (const key of DESKTOP_THREAD_ARRAY_KEYS) {
    const value = updatedState[key];

    if (Array.isArray(value)) {
      updatedState[key] = value.filter((id) => !deletedIdSet.has(String(id)));
    }
  }

  return updatedState;
}

export async function loadSessionStore({ codexHome }) {
  const paths = getCodexPaths(codexHome);
  const [
    hasDesktopState,
    hasDesktopStateBackup,
    hasGoalsDatabase,
    hasLogsDatabase,
    hasMemoryDatabase,
  ] = await Promise.all([
    pathExists(paths.desktopStatePath),
    pathExists(paths.desktopStateBackupPath),
    pathExists(paths.goalsDatabasePath),
    pathExists(paths.logsDatabasePath),
    pathExists(paths.memoryDatabasePath),
  ]);
  const threadRowsById = new Map();
  const spawnEdgesByKey = new Map();
  for (const database of paths.stateDatabases) {
    for (const row of queryRows(database.path, `select ${sessionColumns(database)} from threads t`)) {
      const id = String(row.id);
      if (!threadRowsById.has(id)) threadRowsById.set(id, { ...row, _stateDatabasePath: database.path });
    }
    if (stateSchema(database).hasSpawnEdges) {
      for (const edge of queryRows(database.path, "select parent_thread_id, child_thread_id, status from thread_spawn_edges")) {
        const key = `${edge.parent_thread_id}\0${edge.child_thread_id}`;
        if (!spawnEdgesByKey.has(key)) spawnEdgesByKey.set(key, edge);
      }
    }
  }
  const threadRows = [...threadRowsById.values()];
  const spawnEdges = [...spawnEdgesByKey.values()];
  const transcriptHeaders = await indexTranscriptHeaders(paths.transcriptDirectories);

  const discoveryIds = new Set(threadRows.map((threadRow) => String(threadRow.id)));

  for (const transcriptId of transcriptHeaders.keys()) {
    discoveryIds.add(transcriptId);
  }

  const sessionIndexMap = await readSessionIndexMap(paths.sessionIndexPath, discoveryIds);
  const historyMap = await readHistoryMap(
    paths.historyPath,
    getHistoryCandidateIds(threadRows, transcriptHeaders, sessionIndexMap),
  );
  const childIdsByParentId = new Map();
  const parentIdsByChildId = new Map();

  for (const edge of spawnEdges) {
    const parentId = edge.parent_thread_id;
    const childId = edge.child_thread_id;

    if (!childIdsByParentId.has(parentId)) {
      childIdsByParentId.set(parentId, []);
    }

    childIdsByParentId.get(parentId).push(childId);
    parentIdsByChildId.set(childId, parentId);
  }

  for (const [childId, transcriptHeader] of transcriptHeaders.entries()) {
    const parentId = transcriptHeader.parentThreadId;

    if (!parentId || parentIdsByChildId.has(childId)) {
      continue;
    }

    const childIds = childIdsByParentId.get(parentId) ?? [];
    childIds.push(childId);
    childIdsByParentId.set(parentId, childIds);
    parentIdsByChildId.set(childId, parentId);
  }

  const recordsById = new Map();
  const fallbackIds = new Set();

  for (const threadRow of threadRows) {
    const transcriptHeader = transcriptHeaders.get(threadRow.id) ?? null;
    const parentThreadId =
      parentIdsByChildId.get(threadRow.id) ??
      transcriptHeader?.parentThreadId ??
      null;
    const rolloutPath = threadRow.rollout_path ?? transcriptHeader?.filePath ?? "";
    const record = {
      agentNickname:
        threadRow.agent_nickname ?? transcriptHeader?.agentNickname ?? null,
      agentRole: threadRow.agent_role ?? transcriptHeader?.agentRole ?? null,
      archived: Boolean(threadRow.archived),
      childThreadIds: childIdsByParentId.get(threadRow.id) ?? [],
      createdAtMs: toTimestampMs(threadRow.created_at_ms_resolved ?? threadRow.created_at_ms),
      cwd: threadRow.cwd ?? transcriptHeader?.cwd ?? "",
      displayName: "",
      firstUserMessage: threadRow.first_user_message ?? "",
      forkedFromId: transcriptHeader?.forkedFromId ?? null,
      id: threadRow.id,
      isFork: Boolean(transcriptHeader?.forkedFromId),
      isPinned: Boolean(threadRow.is_pinned),
      isSubagent: Boolean(parentThreadId),
      parentThreadId,
      recordSource: "sqlite",
      providerId: "codex",
      rolloutMissing: rolloutPath
        ? !transcriptHeaders.has(threadRow.id)
        : true,
      rolloutPath,
      title: threadRow.title ?? "",
      titleSource: "",
      updatedAtMs: toTimestampMs(threadRow.updated_at_ms_resolved ?? threadRow.updated_at_ms),
      _stateDatabasePath: threadRow._stateDatabasePath,
    };

    if (
      !normalizeDisplayName(record.title) &&
      !getMeaningfulUserText(record.firstUserMessage) &&
      !sessionIndexMap.get(record.id)?.threadName &&
      !historyMap.get(record.id)?.text
    ) {
      fallbackIds.add(record.id);
    }

    recordsById.set(record.id, record);
  }

  for (const [transcriptId, transcriptHeader] of transcriptHeaders.entries()) {
    if (recordsById.has(transcriptId)) {
      continue;
    }

    const parentThreadId =
      parentIdsByChildId.get(transcriptId) ?? transcriptHeader.parentThreadId ?? null;
    const record = {
      agentNickname: transcriptHeader.agentNickname,
      agentRole: transcriptHeader.agentRole,
      archived: isContainedPath(paths.archivedSessionsDirectory, transcriptHeader.filePath),
      childThreadIds: childIdsByParentId.get(transcriptId) ?? [],
      createdAtMs: transcriptHeader.timestampMs,
      cwd: transcriptHeader.cwd,
      displayName: "",
      firstUserMessage: "",
      forkedFromId: transcriptHeader.forkedFromId,
      id: transcriptId,
      isFork: Boolean(transcriptHeader.forkedFromId),
      isPinned: false,
      isSubagent: Boolean(parentThreadId),
      parentThreadId,
      recordSource: "transcript",
      providerId: "codex",
      rolloutMissing: false,
      rolloutPath: transcriptHeader.filePath,
      title: "",
      titleSource: "",
      updatedAtMs: 0,
    };

    fallbackIds.add(transcriptId);
    recordsById.set(transcriptId, record);
  }

  const transcriptFallbackById = new Map();

  for (const sessionId of fallbackIds) {
    const record = recordsById.get(sessionId);

    if (!record?.rolloutPath) {
      continue;
    }

    try {
      transcriptFallbackById.set(
        sessionId,
        await parseTranscriptFallback(record.rolloutPath),
      );
    } catch {
      continue;
    }
  }

  const records = [...recordsById.values()].map((record) => {
    const derivedDisplayName = deriveDisplayName({
      historyMap,
      sessionIndexMap,
      sessionRecord: record,
      transcriptFallback: transcriptFallbackById.get(record.id),
    });

    return {
      ...record,
      childThreadIds: [...record.childThreadIds].sort(),
      displayName: derivedDisplayName.value,
      titleSource: derivedDisplayName.source,
      updatedAtMs:
        record.updatedAtMs ||
        sessionIndexMap.get(record.id)?.updatedAt ||
        record.createdAtMs,
    };
  });

  return {
    attachmentsDirectory: paths.attachmentsDirectory,
    childIdsByParentId,
    codexHome: paths.codexHome,
    desktopStateBackupPath: paths.desktopStateBackupPath,
    desktopStatePath: paths.desktopStatePath,
    hasDesktopState,
    hasDesktopStateBackup,
    hasGoalsDatabase,
    hasLogsDatabase,
    hasMemoryDatabase,
    goalsDatabasePath: paths.goalsDatabasePath,
    logsDatabasePath: paths.logsDatabasePath,
    memoryDatabasePath: paths.memoryDatabasePath,
    records,
    recordsById: new Map(records.map((record) => [record.id, record])),
    sessionIndexPath: paths.sessionIndexPath,
    spawnEdges,
    stateDatabasePath: paths.stateDatabasePath,
    stateDatabasePaths: paths.stateDatabasePaths,
    stateDatabases: paths.stateDatabases,
    threadWriterLocksDirectory: paths.threadWriterLocksDirectory,
    resolvedDatabases: paths.resolvedDatabases,
    logsDatabasePaths: paths.logsDatabasePaths,
    memoryDatabasePaths: paths.memoryDatabasePaths,
    goalsDatabasePaths: paths.goalsDatabasePaths,
    transcriptHeaders,
    historyPath: paths.historyPath,
  };
}

function inspectSqliteTable(databasePath, tableName) {
  try {
    const tables = queryRows(
      databasePath,
      "select name from sqlite_master where type = 'table' and name = ?",
      [tableName],
    );

    if (tables.length === 0) {
      return { exists: false, columns: [] };
    }

    const columns = queryRows(databasePath, "select name from pragma_table_info(?)", [tableName])
      .map((column) => String(column.name));
    return { exists: true, columns };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to inspect database." };
  }
}

export async function diagnoseStorageCompatibility({ codexHome }) {
  const paths = getCodexPaths(codexHome, { refresh: true });
  const missing = [];
  const changed = [];
  const available = [];
  for (const [familyName, family] of Object.entries(paths.databaseFamilies)) {
    if (!family.primary && family.required) {
      missing.push(`A supported ${familyName} session database was not found.`);
    } else if (!family.primary) {
      available.push(`Not present: ${familyName} database`);
    }
    for (const database of allValidDatabases(family)) {
      available.push(`Supported: ${database.filename}`);
    }
    for (const database of family.invalid) {
      changed.push(`Could not use ${database.filename}: ${database.reason}`);
    }
  }

  let entries = [];
  try {
    entries = await fs.readdir(paths.codexHome, { withFileTypes: true });
  } catch {
    missing.push("The local Codex folder could not be read.");
  }

  const recognizedDatabases = new Set(Object.values(paths.databaseFamilies).flatMap((family) => [
    ...allValidDatabases(family),
    ...family.invalid,
  ]).map((database) => database.filename));
  const newlyDiscovered = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && !recognizedDatabases.has(entry.name))
    .map((entry) => `Other local database found: ${entry.name}`)
    .sort();
  try {
    const attachmentEntries = await fs.readdir(paths.attachmentsDirectory, { withFileTypes: true });
    if (attachmentEntries.some((entry) => entry.name !== ".DS_Store")) {
      newlyDiscovered.push("Session attachments are kept because their ownership cannot be verified safely.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      newlyDiscovered.push("The session attachments folder could not be examined.");
    }
  }
  const status = missing.length > 0 || changed.length > 0
    ? "unsupported"
    : newlyDiscovered.length > 0
      ? "partial"
      : "ready";

  return {
    available,
    builtFor: CODEX_DATABASE_PROFILE.builtFor,
    changed,
    missing,
    newlyDiscovered,
    profileId: CODEX_DATABASE_PROFILE.id,
    resolvedDatabases: paths.resolvedDatabases,
    status,
  };
}

export async function assertDeepCleanupSupported({ codexHome }) {
  const diagnostic = await diagnoseStorageCompatibility({ codexHome });

  if (diagnostic.status === "unsupported") {
    throw new Error("Deep cleanup is paused because this Codex storage layout is not supported.");
  }

  return diagnostic;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const OVERVIEW_STAT_BATCH_SIZE = 24;
const SESSION_SIZE_CACHE_TTL_MS = 45 * 1000;
const SESSION_SIZE_STAT_CONCURRENCY = 64;
const SUPPORTING_THREAD_PREFIX = "The following is the Codex agent history whose request action you are assessing";
const SESSION_CREATED_SQL = "coalesce(nullif(t.created_at_ms, 0), nullif(t.created_at, 0) * 1000, 0)";
const SESSION_UPDATED_SQL = "coalesce(nullif(t.updated_at_ms, 0), nullif(t.updated_at, 0) * 1000, 0)";
const SESSION_ACTIVITY_SQL = `coalesce(nullif(${SESSION_UPDATED_SQL}, 0), nullif(${SESSION_CREATED_SQL}, 0), 0)`;
const SESSION_SORTS = new Set(["created", "cwd", "name", "size", "updated"]);
const sessionSizeCache = new Map();
const stateSchemaCache = new WeakMap();

const OPTIONAL_THREAD_COLUMNS = [
  "agent_nickname", "agent_role", "archived", "cwd", "first_user_message",
  "is_pinned", "title",
];

function stateSchema(database) {
  const known = stateSchemaCache.get(database);
  if (known) return known;
  const cached = database.tables?.threads;
  const columns = cached?.columns?.size
    ? cached.columns
    : new Set(inspectSqliteTable(database.path, "threads").columns ?? []);
  const spawn = database.tables?.thread_spawn_edges?.exists !== undefined
    ? database.tables.thread_spawn_edges
    : inspectSqliteTable(database.path, "thread_spawn_edges");
  const dynamicTools = database.tables?.thread_dynamic_tools?.exists !== undefined
    ? database.tables.thread_dynamic_tools
    : inspectSqliteTable(database.path, "thread_dynamic_tools");
  const schema = {
    columns,
    hasDynamicTools: Boolean(dynamicTools?.exists),
    hasSpawnEdges: Boolean(spawn?.exists),
  };
  stateSchemaCache.set(database, schema);
  return schema;
}

function columnExpression(columns, column, fallback = "null") {
  return columns.has(column) ? `t.${column}` : fallback;
}

function timestampExpression(columns, prefix) {
  const expressions = [];
  if (columns.has(`${prefix}_at_ms`)) expressions.push(`nullif(t.${prefix}_at_ms, 0)`);
  if (columns.has(`${prefix}_at`)) expressions.push(`nullif(t.${prefix}_at, 0) * 1000`);
  return expressions.length ? `coalesce(${expressions.join(", ")}, 0)` : "0";
}

function stateExpressions(database) {
  const schema = stateSchema(database);
  const created = timestampExpression(schema.columns, "created");
  const updated = timestampExpression(schema.columns, "updated");
  return { ...schema, activity: `coalesce(nullif(${updated}, 0), nullif(${created}, 0), 0)`, created, updated };
}

async function buildSessionSizeIndex(paths) {
  let rows;
  if (paths.stateDatabases.length === 1) {
    rows = queryRows(paths.stateDatabases[0].path, "select id, rollout_path from threads");
  } else {
    const rowsById = new Map();
    for (const database of paths.stateDatabases) {
      for (const row of queryRows(database.path, "select id, rollout_path from threads")) {
        const id = String(row.id);
        if (!rowsById.has(id)) rowsById.set(id, row);
      }
    }
    rows = [...rowsById.values()];
  }
  const sizes = new Map();
  let nextIndex = 0;

  const measureNext = async () => {
    while (nextIndex < rows.length) {
      const row = rows[nextIndex];
      nextIndex += 1;
      const id = String(row.id);

      if (!row.rollout_path) {
        sizes.set(id, null);
        continue;
      }

      try {
        const stats = await fs.stat(row.rollout_path);
        sizes.set(id, stats.isFile() ? stats.size : null);
      } catch {
        sizes.set(id, null);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(SESSION_SIZE_STAT_CONCURRENCY, rows.length) },
      measureNext,
    ),
  );
  return sizes;
}

async function getSessionSizeIndex(paths, { refresh = false } = {}) {
  const cached = sessionSizeCache.get(paths.codexHome);

  if (!refresh && cached?.expiresAtMs > Date.now()) {
    return cached.promise;
  }

  const promise = buildSessionSizeIndex(paths).catch((error) => {
    if (sessionSizeCache.get(paths.codexHome)?.promise === promise) {
      sessionSizeCache.delete(paths.codexHome);
    }
    throw error;
  });
  sessionSizeCache.set(paths.codexHome, {
    expiresAtMs: Date.now() + SESSION_SIZE_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

export function invalidateSessionCache({ codexHome }) {
  const resolvedHome = path.resolve(expandHomePath(codexHome || "~/.codex"));
  sessionSizeCache.delete(resolvedHome);
  invalidateCodexDatabaseResolution(resolvedHome);
}

function compareSessionIdsBySize(leftId, rightId, sizes) {
  const leftSize = sizes.get(leftId);
  const rightSize = sizes.get(rightId);
  const leftKnown = Number.isFinite(leftSize);
  const rightKnown = Number.isFinite(rightSize);

  if (leftKnown !== rightKnown) {
    return leftKnown ? -1 : 1;
  }

  return (rightSize ?? 0) - (leftSize ?? 0) || leftId.localeCompare(rightId);
}

function getSessionSort(sort, database) {
  const { activity, columns, created } = stateExpressions(database);
  const nameParts = ["t.title", "t.first_user_message"].filter((column) => columns.has(column.slice(2)))
    .map((column) => `nullif(trim(${column}), '')`);
  const name = `lower(coalesce(${[...nameParts, "t.id"].join(", ")}))`;
  const cwd = columns.has("cwd") ? "lower(coalesce(t.cwd, ''))" : "''";

  return {
    created: {
      compare: (left, right) => Number(right.sort_number) - Number(left.sort_number),
      order: `${created} desc, t.id asc`,
      selection: `${created} as sort_number`,
    },
    cwd: {
      compare: (left, right) => String(left.sort_text).localeCompare(String(right.sort_text))
        || Number(right.sort_activity) - Number(left.sort_activity),
      order: `${cwd} asc, ${activity} desc, t.id asc`,
      selection: `${cwd} as sort_text, ${activity} as sort_activity`,
    },
    name: {
      compare: (left, right) => String(left.sort_text).localeCompare(String(right.sort_text))
        || Number(right.sort_activity) - Number(left.sort_activity),
      order: `${name} asc, ${activity} desc, t.id asc`,
      selection: `${name} as sort_text, ${activity} as sort_activity`,
    },
    updated: {
      compare: (left, right) => Number(right.sort_number) - Number(left.sort_number),
      order: `${activity} desc, t.id asc`,
      selection: `${activity} as sort_number`,
    },
  }[sort] ?? {
    compare: (left, right) => Number(right.sort_number) - Number(left.sort_number),
    order: `${activity} desc, t.id asc`,
    selection: `${activity} as sort_number`,
  };
}

function getSessionOrder(sort, database) {
  return getSessionSort(sort, database).order;
}

function getSessionConditions(database, {
  archiveStatus,
  inactiveBeforeMs,
  includeInternals,
  includeSupporting,
  search,
  workspace,
}) {
  const { activity, columns, hasSpawnEdges } = stateExpressions(database);
  const conditions = [];
  const parameters = [];

  if (archiveStatus === "active" && columns.has("archived")) {
    conditions.push("coalesce(t.archived, 0) = 0");
  } else if (archiveStatus === "archived") {
    conditions.push(columns.has("archived") ? "coalesce(t.archived, 0) <> 0" : "0 = 1");
  }

  if (!includeInternals && hasSpawnEdges) {
    conditions.push(`not exists (
      select 1 from thread_spawn_edges edge where edge.child_thread_id = t.id
    )`);
  }

  const supportingColumns = ["title", "first_user_message"].filter((column) => columns.has(column));
  if (!includeSupporting && supportingColumns.length > 0) {
    conditions.push(`coalesce(${supportingColumns.map((column) => `nullif(trim(t.${column}), '')`).join(", ")}, '') not like ?`);
    parameters.push(`${SUPPORTING_THREAD_PREFIX}%`);
  }

  if (Number.isFinite(inactiveBeforeMs) && inactiveBeforeMs > 0) {
    conditions.push(`${activity} > 0 and ${activity} <= ?`);
    parameters.push(Math.trunc(inactiveBeforeMs));
  }

  if (typeof workspace === "string" && columns.has("cwd")) {
    conditions.push("coalesce(t.cwd, '') = ?");
    parameters.push(workspace);
  }

  const normalizedSearch = normalizeText(search).toLowerCase();

  if (normalizedSearch) {
    const searchColumns = ["id", "title", "first_user_message", "cwd", "rollout_path"]
      .filter((column) => column === "id" || columns.has(column));
    conditions.push(`(${searchColumns.map((column) => `instr(lower(coalesce(t.${column}, '')), ?) > 0`).join(" or ")})`);
    parameters.push(...Array(searchColumns.length).fill(normalizedSearch));
  }

  return {
    parameters,
    sql: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
  };
}

function sessionColumns(database) {
  const { activity, columns, created, hasSpawnEdges } = stateExpressions(database);
  const optional = OPTIONAL_THREAD_COLUMNS.map((column) =>
    `${columnExpression(columns, column)} as ${column}`,
  );
  const parent = hasSpawnEdges
    ? `(select edge.parent_thread_id from thread_spawn_edges edge where edge.child_thread_id = t.id limit 1)`
    : "null";
  return `t.id, t.rollout_path, ${optional.join(", ")}, ${created} as created_at_ms_resolved, ${activity} as updated_at_ms_resolved, ${parent} as parent_thread_id`;
}

async function formatPagedThreadRows(stateDatabase, threadRows) {
  const stateDatabasePath = typeof stateDatabase === "string" ? stateDatabase : stateDatabase.path;
  const hasSpawnEdges = typeof stateDatabase === "string"
    ? inspectSqliteTable(stateDatabasePath, "thread_spawn_edges").exists
    : stateSchema(stateDatabase).hasSpawnEdges;
  const childIdsByParentId = new Map();

  if (threadRows.length > 0 && hasSpawnEdges) {
    const ids = threadRows.map((row) => String(row.id));

    for (const idBatch of batches(ids)) {
      const edges = queryRows(
        stateDatabasePath,
        `select parent_thread_id, child_thread_id
         from thread_spawn_edges
         where parent_thread_id in (${placeholders(idBatch)})`,
        idBatch,
      );

      for (const edge of edges) {
        const childIds = childIdsByParentId.get(edge.parent_thread_id) ?? [];
        childIds.push(edge.child_thread_id);
        childIdsByParentId.set(edge.parent_thread_id, childIds);
      }
    }
  }

  const records = [];

  for (const threadRow of threadRows) {
    const title = cleanDerivedTitle(threadRow.title ?? "");
    const firstUserMessage = cleanDerivedTitle(
      getMeaningfulUserText(threadRow.first_user_message ?? ""),
    );
    const displayName = title || firstUserMessage || `Untitled ${String(threadRow.id).slice(0, 8)}`;
    const rolloutPath = threadRow.rollout_path ?? "";
    let transcriptHeader = null;
    let transcriptBytes = null;

    if (rolloutPath) {
      const [header, stats] = await Promise.all([
        parseTranscriptHeader(rolloutPath).catch(() => null),
        fs.stat(rolloutPath).catch(() => null),
      ]);
      transcriptHeader = header;
      transcriptBytes = stats?.isFile() ? stats.size : null;
    }

    const parentThreadId = threadRow.parent_thread_id ?? transcriptHeader?.parentThreadId ?? null;

    records.push({
      agentNickname: threadRow.agent_nickname ?? transcriptHeader?.agentNickname ?? null,
      agentRole: threadRow.agent_role ?? transcriptHeader?.agentRole ?? null,
      archived: Boolean(threadRow.archived),
      childThreadIds: [...(childIdsByParentId.get(threadRow.id) ?? [])].sort(),
      createdAtMs: toTimestampMs(threadRow.created_at_ms_resolved ?? threadRow.created_at_ms),
      cwd: threadRow.cwd ?? "",
      displayName,
      firstUserMessage: threadRow.first_user_message ?? "",
      forkedFromId: transcriptHeader?.forkedFromId ?? null,
      id: String(threadRow.id),
      isFork: Boolean(transcriptHeader?.forkedFromId),
      isPinned: Boolean(threadRow.is_pinned),
      isSubagent: Boolean(parentThreadId),
      parentThreadId,
      providerId: "codex",
      recordSource: "sqlite",
      rolloutMissing: rolloutPath ? !transcriptHeader : true,
      rolloutPath,
      title: threadRow.title ?? "",
      titleSource: title ? "sqlite_title" : firstUserMessage ? "sqlite_first_user_message" : "fallback",
      transcriptBytes,
      updatedAtMs: toTimestampMs(threadRow.updated_at_ms_resolved ?? threadRow.updated_at_ms),
      _stateDatabasePath: stateDatabasePath,
    });
  }

  return records;
}

async function getStoreAvailability(paths) {
  const [
    hasDesktopState,
    hasDesktopStateBackup,
    hasGoalsDatabase,
    hasLogsDatabase,
    hasMemoryDatabase,
  ] = await Promise.all([
    pathExists(paths.desktopStatePath),
    pathExists(paths.desktopStateBackupPath),
    Promise.resolve(paths.goalsDatabasePaths.length > 0),
    Promise.resolve(paths.logsDatabasePaths.length > 0),
    Promise.resolve(paths.memoryDatabasePaths.length > 0),
  ]);

  return {
    hasDesktopState,
    hasDesktopStateBackup,
    hasGoalsDatabase,
    hasLogsDatabase,
    hasMemoryDatabase,
  };
}

async function indexTranscriptHeaders(transcriptDirectories) {
  const headersById = new Map();

  for (const transcriptDirectory of transcriptDirectories) {
    for await (const transcriptFile of findTranscriptFiles(transcriptDirectory)) {
      try {
        const header = await parseTranscriptHeader(transcriptFile);
        const current = header?.id ? headersById.get(String(header.id)) : null;

        if (header?.id && (!current || header.filePath > current.filePath)) {
          headersById.set(String(header.id), { ...header, id: String(header.id) });
        }
      } catch {
        continue;
      }
    }
  }

  return headersById;
}

function getTranscriptChildrenByParentId(transcriptHeaders) {
  const childIdsByParentId = new Map();

  for (const [childId, header] of transcriptHeaders.entries()) {
    if (!header.parentThreadId) continue;
    const parentId = String(header.parentThreadId);
    const childIds = childIdsByParentId.get(parentId) ?? [];
    childIds.push(childId);
    childIdsByParentId.set(parentId, childIds);
  }

  return childIdsByParentId;
}

function queryRelatedSpawnEdges(stateDatabasePath, ids) {
  const edgesByKey = new Map();

  for (const idBatch of batches(ids)) {
    const idPlaceholders = placeholders(idBatch);
    const rows = queryRows(
      stateDatabasePath,
      `select parent_thread_id, child_thread_id, status
       from thread_spawn_edges
       where parent_thread_id in (${idPlaceholders})
          or child_thread_id in (${idPlaceholders})`,
      [...idBatch, ...idBatch],
    );

    for (const edge of rows) {
      edgesByKey.set(`${edge.parent_thread_id}\0${edge.child_thread_id}`, edge);
    }
  }

  return [...edgesByKey.values()];
}

export async function loadDeletionStore({ codexHome, recordIds }) {
  const paths = getCodexPaths(codexHome);
  const selectedIds = new Set(recordIds.map(String));

  if (selectedIds.size === 0) {
    throw new Error("Select at least one session.");
  }

  const [availability, transcriptHeaders] = await Promise.all([
    getStoreAvailability(paths),
    indexTranscriptHeaders(paths.transcriptDirectories),
  ]);
  const transcriptChildrenByParentId = getTranscriptChildrenByParentId(transcriptHeaders);
  const pendingIds = [...selectedIds];

  for (let offset = 0; offset < pendingIds.length; offset += 400) {
    const idBatch = pendingIds.slice(offset, offset + 400);
    const stateChildren = paths.stateDatabases.flatMap((database) => stateSchema(database).hasSpawnEdges
      ? queryRows(
        database.path,
        `select parent_thread_id, child_thread_id from thread_spawn_edges where parent_thread_id in (${placeholders(idBatch)})`,
        idBatch,
      )
      : []);

    for (const edge of stateChildren) {
      const childId = String(edge.child_thread_id);
      if (!selectedIds.has(childId)) {
        selectedIds.add(childId);
        pendingIds.push(childId);
      }
    }

    for (const parentId of idBatch) {
      for (const childId of transcriptChildrenByParentId.get(parentId) ?? []) {
        if (!selectedIds.has(childId)) {
          selectedIds.add(childId);
          pendingIds.push(childId);
        }
      }
    }
  }

  const ids = [...selectedIds];
  const threadRowsById = new Map();
  for (const database of paths.stateDatabases) {
    for (const idBatch of batches(ids)) {
      for (const row of queryRows(
        database.path,
        `select ${sessionColumns(database)} from threads t where t.id in (${placeholders(idBatch)})`,
        idBatch,
      )) {
        const id = String(row.id);
        if (!threadRowsById.has(id)) threadRowsById.set(id, { ...row, _database: database });
      }
    }
  }
  const threadRows = [...threadRowsById.values()];
  const spawnEdgesByKey = new Map();
  for (const database of paths.stateDatabases) {
    if (!stateSchema(database).hasSpawnEdges) continue;
    for (const edge of queryRelatedSpawnEdges(database.path, ids)) {
      const key = `${edge.parent_thread_id}\0${edge.child_thread_id}`;
      if (!spawnEdgesByKey.has(key)) spawnEdgesByKey.set(key, edge);
    }
  }
  const spawnEdges = [...spawnEdgesByKey.values()];
  const childIdsByParentId = new Map();
  const parentIdsByChildId = new Map();

  for (const edge of spawnEdges) {
    const parentId = String(edge.parent_thread_id);
    const childId = String(edge.child_thread_id);
    if (selectedIds.has(parentId) && selectedIds.has(childId)) {
      const childIds = childIdsByParentId.get(parentId) ?? [];
      childIds.push(childId);
      childIdsByParentId.set(parentId, childIds);
    }
    parentIdsByChildId.set(childId, parentId);
  }

  for (const parentId of ids) {
    for (const childId of transcriptChildrenByParentId.get(parentId) ?? []) {
      if (!selectedIds.has(childId)) continue;
      const childIds = childIdsByParentId.get(parentId) ?? [];
      if (!childIds.includes(childId)) childIds.push(childId);
      childIdsByParentId.set(parentId, childIds);
      if (!parentIdsByChildId.has(childId)) parentIdsByChildId.set(childId, parentId);
    }
  }

  const formattedRows = [];
  for (const database of paths.stateDatabases) {
    formattedRows.push(...await formatPagedThreadRows(
      database,
      threadRows.filter((row) => row._database === database),
    ));
  }
  const recordsById = new Map();

  for (const record of formattedRows) {
    const transcriptHeader = transcriptHeaders.get(record.id);
    recordsById.set(record.id, {
      ...record,
      childThreadIds: [...(childIdsByParentId.get(record.id) ?? [])].sort(),
      parentThreadId: parentIdsByChildId.get(record.id) ?? record.parentThreadId,
      rolloutMissing: record.rolloutPath ? !transcriptHeader : true,
    });
  }

  for (const id of ids) {
    if (recordsById.has(id)) continue;
    const header = transcriptHeaders.get(id);
    if (!header) continue;
    const parentThreadId = parentIdsByChildId.get(id) ?? header.parentThreadId ?? null;
    recordsById.set(id, {
      agentNickname: header.agentNickname,
      agentRole: header.agentRole,
      archived: isContainedPath(paths.archivedSessionsDirectory, header.filePath),
      childThreadIds: [...(childIdsByParentId.get(id) ?? [])].sort(),
      createdAtMs: header.timestampMs,
      cwd: header.cwd,
      displayName: "",
      firstUserMessage: "",
      forkedFromId: header.forkedFromId,
      id,
      isFork: Boolean(header.forkedFromId),
      isPinned: false,
      isSubagent: Boolean(parentThreadId),
      parentThreadId,
      providerId: "codex",
      recordSource: "transcript",
      rolloutMissing: false,
      rolloutPath: header.filePath,
      title: "",
      titleSource: "",
      updatedAtMs: header.timestampMs,
    });
  }

  for (const requestedId of recordIds.map(String)) {
    if (!recordsById.has(requestedId)) {
      throw new Error("One or more selected sessions are no longer available.");
    }
  }

  const relevantIds = new Set(recordsById.keys());
  const sessionIndexMap = await readSessionIndexMap(paths.sessionIndexPath, relevantIds);
  const historyMap = await readHistoryMap(paths.historyPath, relevantIds);
  const transcriptFallbackById = new Map();

  for (const record of recordsById.values()) {
    if (
      normalizeDisplayName(record.title) ||
      getMeaningfulUserText(record.firstUserMessage) ||
      sessionIndexMap.get(record.id)?.threadName ||
      historyMap.get(record.id)?.text ||
      !record.rolloutPath
    ) {
      continue;
    }

    try {
      transcriptFallbackById.set(record.id, await parseTranscriptFallback(record.rolloutPath));
    } catch {
      continue;
    }
  }

  const records = [...recordsById.values()].map((record) => {
    const display = deriveDisplayName({
      historyMap,
      sessionIndexMap,
      sessionRecord: record,
      transcriptFallback: transcriptFallbackById.get(record.id),
    });
    return {
      ...record,
      displayName: display.value,
      titleSource: display.source,
      updatedAtMs: record.updatedAtMs || sessionIndexMap.get(record.id)?.updatedAt || record.createdAtMs,
    };
  });

  return {
    ...availability,
    childIdsByParentId,
    codexHome: paths.codexHome,
    desktopStateBackupPath: paths.desktopStateBackupPath,
    desktopStatePath: paths.desktopStatePath,
    goalsDatabasePath: paths.goalsDatabasePath,
    historyPath: paths.historyPath,
    logsDatabasePath: paths.logsDatabasePath,
    memoryDatabasePath: paths.memoryDatabasePath,
    records,
    recordsById: new Map(records.map((record) => [record.id, record])),
    sessionIndexPath: paths.sessionIndexPath,
    spawnEdges,
    stateDatabasePath: paths.stateDatabasePath,
    stateDatabasePaths: paths.stateDatabasePaths,
    stateDatabases: paths.stateDatabases,
    resolvedDatabases: paths.resolvedDatabases,
    logsDatabasePaths: paths.logsDatabasePaths,
    memoryDatabasePaths: paths.memoryDatabasePaths,
    goalsDatabasePaths: paths.goalsDatabasePaths,
    transcriptHeaders: new Map(
      [...transcriptHeaders].filter(([id]) => relevantIds.has(id)),
    ),
  };
}

export async function listSessions({
  archiveStatus = "all",
  codexHome,
  inactiveBeforeMs = null,
  includeInternals = false,
  includeSupporting = false,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  refresh = false,
  search = "",
  sort = "updated",
  workspace,
  forceUnion = false,
}) {
  const paths = getCodexPaths(codexHome, { refresh });
  const boundedPageSize = Number.isFinite(pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)))
    : DEFAULT_PAGE_SIZE;
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  const resolvedSort = SESSION_SORTS.has(sort) ? sort : "updated";
  if (paths.stateDatabases.length === 1 && resolvedSort !== "size" && !forceUnion) {
    const database = paths.stateDatabases[0];
    const conditions = getSessionConditions(database, {
      archiveStatus, inactiveBeforeMs, includeInternals, includeSupporting, search, workspace,
    });
    const countRow = queryRows(
      database.path,
      `select count(*) as count from threads t ${conditions.sql}`,
      conditions.parameters,
    )[0];
    const total = Number(countRow?.count ?? 0);
    const pageCount = Math.max(1, Math.ceil(total / boundedPageSize));
    const currentPage = Math.min(requestedPage, pageCount);
    const rows = queryRows(
      database.path,
      `select ${sessionColumns(database)}
       from threads t
       ${conditions.sql}
       order by ${getSessionOrder(resolvedSort, database)}
       limit ? offset ?`,
      [...conditions.parameters, boundedPageSize, (currentPage - 1) * boundedPageSize],
    );

    return {
      page: currentPage,
      pageCount,
      pageSize: boundedPageSize,
      records: await formatPagedThreadRows(database, rows),
      total,
    };
  }

  const ordered = [];
  const seenIds = paths.stateDatabases.length > 1 ? new Set() : null;
  const compactSizeIds = resolvedSort === "size" && paths.stateDatabases.length === 1;
  let compareSortRows = null;
  for (const database of paths.stateDatabases) {
    const conditions = getSessionConditions(database, {
      archiveStatus, inactiveBeforeMs, includeInternals, includeSupporting, search, workspace,
    });
    const sessionSort = resolvedSort === "size" ? null : getSessionSort(resolvedSort, database);
    compareSortRows ??= sessionSort?.compare ?? null;
    const rows = queryRows(
      database.path,
      `select t.id${sessionSort ? `, ${sessionSort.selection}` : ""} from threads t ${conditions.sql}`,
      conditions.parameters,
    );
    for (const row of rows) {
      const id = String(row.id);
      if (seenIds?.has(id)) continue;
      seenIds?.add(id);
      if (compactSizeIds) {
        ordered.push(id);
        continue;
      }
      row.database = database;
      row.id = id;
      ordered.push(row);
    }
  }
  if (resolvedSort === "size") {
    const sizes = await getSessionSizeIndex(paths, { refresh });
    ordered.sort((left, right) => compareSessionIdsBySize(
      compactSizeIds ? left : left.id,
      compactSizeIds ? right : right.id,
      sizes,
    ));
  } else {
    ordered.sort((left, right) => compareSortRows(left, right) || left.id.localeCompare(right.id));
  }
  const total = ordered.length;
  const pageCount = Math.max(1, Math.ceil(total / boundedPageSize));
  const currentPage = Math.min(requestedPage, pageCount);
  const pageItems = ordered.slice((currentPage - 1) * boundedPageSize, currentPage * boundedPageSize);
  const recordsById = new Map();
  const itemsByDatabase = new Map();
  if (compactSizeIds) {
    itemsByDatabase.set(paths.stateDatabases[0], pageItems);
  } else {
    for (const item of pageItems) {
      const values = itemsByDatabase.get(item.database) ?? [];
      values.push(item.id);
      itemsByDatabase.set(item.database, values);
    }
  }
  for (const [database, ids] of itemsByDatabase) {
    const rows = queryRows(database.path, `select ${sessionColumns(database)} from threads t where t.id in (${placeholders(ids)})`, ids);
    for (const record of await formatPagedThreadRows(database, rows)) recordsById.set(record.id, record);
  }

  return {
    page: currentPage,
    pageCount,
    pageSize: boundedPageSize,
    records: pageItems.map((item) => recordsById.get(compactSizeIds ? item : item.id)).filter(Boolean),
    total,
  };
}

async function measureTranscriptStorage(transcriptDirectories) {
  let transcriptBytes = 0;
  let transcriptFileCount = 0;
  let unreadableFileCount = 0;
  let pendingPaths = [];

  const measurePendingPaths = async () => {
    const pathsToMeasure = pendingPaths;
    pendingPaths = [];
    const results = await Promise.all(pathsToMeasure.map(async (filePath) => {
      try {
        return await fs.stat(filePath);
      } catch {
        return null;
      }
    }));

    for (const stats of results) {
      if (!stats?.isFile()) {
        unreadableFileCount += 1;
        continue;
      }

      transcriptBytes += stats.size;
      transcriptFileCount += 1;
    }
  };

  for (const transcriptDirectory of transcriptDirectories) {
    for await (const transcriptPath of findTranscriptFiles(transcriptDirectory)) {
      pendingPaths.push(transcriptPath);

      if (pendingPaths.length >= OVERVIEW_STAT_BATCH_SIZE) {
        await measurePendingPaths();
      }
    }
  }

  if (pendingPaths.length > 0) {
    await measurePendingPaths();
  }

  return {
    transcriptBytes,
    transcriptFileCount,
    unreadableFileCount,
  };
}

export async function getSessionOverview({ codexHome, refresh = false }) {
  const paths = getCodexPaths(codexHome, { refresh });
  const sessions = new Map();
  for (const database of paths.stateDatabases) {
    const { activity, columns, hasSpawnEdges } = stateExpressions(database);
    const projection = [
      "t.id",
      `${columns.has("cwd") ? "coalesce(t.cwd, '')" : "''"} as path`,
      `${columns.has("archived") ? "coalesce(t.archived, 0)" : "0"} as archived`,
      `${columns.has("title") ? "coalesce(t.title, '')" : "''"} as title`,
      `${columns.has("first_user_message") ? "coalesce(t.first_user_message, '')" : "''"} as first_user_message`,
      `${activity} as last_activity_at_ms`,
      `${hasSpawnEdges ? "exists(select 1 from thread_spawn_edges edge where edge.child_thread_id = t.id)" : "0"} as is_subagent`,
    ].join(", ");
    for (const row of queryRows(database.path, `select ${projection} from threads t`)) {
      const id = String(row.id);
      if (!sessions.has(id)) sessions.set(id, row);
    }
  }
  const workspaceSessionRows = [...sessions.values()];
  const [sizes, storage] = await Promise.all([
    getSessionSizeIndex(paths, { refresh }),
    measureTranscriptStorage(paths.transcriptDirectories),
  ]);
  const workspaces = new Map();
  let archivedSessionCount = 0;
  let subagentCount = 0;
  let supportingCount = 0;
  let unknownActivityCount = 0;

  for (const row of workspaceSessionRows) {
    const supporting = `${row.title || row.first_user_message || ""}`.startsWith(SUPPORTING_THREAD_PREFIX);
    archivedSessionCount += row.archived ? 1 : 0;
    subagentCount += row.is_subagent ? 1 : 0;
    supportingCount += supporting ? 1 : 0;
    unknownActivityCount += Number(row.last_activity_at_ms) ? 0 : 1;
    const workspacePath = row.path ?? "";
    const current = workspaces.get(workspacePath) ?? {
      lastActivityAtMs: 0,
      path: workspacePath,
      sessionCount: 0,
      transcriptBytes: 0,
    };
    current.lastActivityAtMs = Math.max(
      current.lastActivityAtMs,
      toTimestampMs(row.last_activity_at_ms),
    );
    current.sessionCount += 1;
    const transcriptBytes = sizes.get(String(row.id));
    if (Number.isFinite(transcriptBytes)) current.transcriptBytes += transcriptBytes;
    workspaces.set(workspacePath, current);
  }

  return {
    activeSessionCount: sessions.size - archivedSessionCount,
    archivedSessionCount,
    calculatedAtMs: Date.now(),
    primarySessionCount: sessions.size - subagentCount - supportingCount,
    sessionCount: sessions.size,
    subagentCount,
    supportingCount,
    unknownActivityCount,
    workspaces: [...workspaces.values()].sort((left, right) =>
      Number(!left.path) - Number(!right.path)
      || right.lastActivityAtMs - left.lastActivityAtMs
      || left.path.localeCompare(right.path)),
    ...storage,
  };
}

export async function getSessionRecord({ codexHome, id }) {
  const paths = getCodexPaths(codexHome);
  for (const database of paths.stateDatabases) {
    const rows = queryRows(database.path, `select ${sessionColumns(database)} from threads t where t.id = ? limit 1`, [id]);
    if (rows.length) return (await formatPagedThreadRows(database, rows))[0] ?? null;
  }
  return null;
}

export function filterAndSortSessions({
  archiveStatus = "all",
  includeInternals,
  records,
  search,
  sort,
}) {
  const normalizedSearch = normalizeText(search).toLowerCase();
  const filteredRecords = records.filter((record) => {
    if (archiveStatus === "active" && record.archived) {
      return false;
    }

    if (archiveStatus === "archived" && !record.archived) {
      return false;
    }

    if (!includeInternals && record.isSubagent) {
      return false;
    }

    if (!normalizedSearch) {
      return true;
    }

    const haystack = [
      record.displayName,
      record.id,
      record.cwd,
      record.rolloutPath,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedSearch);
  });

  const compareBySort = {
    created: (left, right) =>
      right.createdAtMs - left.createdAtMs || left.displayName.localeCompare(right.displayName),
    cwd: (left, right) =>
      left.cwd.localeCompare(right.cwd) || right.updatedAtMs - left.updatedAtMs,
    name: (left, right) =>
      left.displayName.localeCompare(right.displayName) ||
      right.updatedAtMs - left.updatedAtMs,
    size: (left, right) => {
      const leftKnown = Number.isFinite(left.transcriptBytes);
      const rightKnown = Number.isFinite(right.transcriptBytes);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      return (right.transcriptBytes ?? 0) - (left.transcriptBytes ?? 0);
    },
    updated: (left, right) =>
      right.updatedAtMs - left.updatedAtMs || left.displayName.localeCompare(right.displayName),
  };

  const comparer = compareBySort[sort] ?? compareBySort.updated;

  return [...filteredRecords].sort(comparer);
}

function countRowsForIds(databasePath, tableName, columnName, ids) {
  let count = 0;

  for (const idBatch of batches(ids)) {
    const row = queryRows(
      databasePath,
      `select count(*) as count from ${tableName} where ${columnName} in (${placeholders(idBatch)})`,
      idBatch,
    )[0];
    count += Number(row?.count ?? 0);
  }

  return count;
}

function findRowsForIds(databasePath, tableName, columnName, ids, { limitOne = false } = {}) {
  const rows = [];

  for (const idBatch of batches(ids)) {
    const matches = queryRows(
      databasePath,
      `select ${columnName} from ${tableName} where ${columnName} in (${placeholders(idBatch)})${limitOne ? " limit 1" : ""}`,
      idBatch,
    );
    rows.push(...matches);

    if (limitOne && rows.length > 0) {
      break;
    }
  }

  return rows;
}

function fingerprintRowsForIds(hash, databasePath, tableName, columnName, ids) {
  for (const idBatch of batches(ids)) {
    const rows = queryRows(
      databasePath,
      `select * from ${tableName} where ${columnName} in (${placeholders(idBatch)})`,
      idBatch,
    );
    rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    hash.update(`${databasePath}\0${tableName}\0${JSON.stringify(rows)}\0`);
  }
}

function* deleteStatements(tableName, columnName, ids) {
  for (const idBatch of batches(ids)) {
    yield {
      parameters: idBatch,
      sql: `delete from ${tableName} where ${columnName} in (${placeholders(idBatch)})`,
    };
  }
}

export async function planSessionDeletion({ recordIds, store }) {
  const idsToDelete = new Set();
  const pendingIds = [...recordIds];

  while (pendingIds.length > 0) {
    const currentId = pendingIds.shift();

    if (idsToDelete.has(currentId)) {
      continue;
    }

    idsToDelete.add(currentId);

    for (const childId of store.childIdsByParentId.get(currentId) ?? []) {
      pendingIds.push(childId);
    }
  }

  const deletionIds = [...idsToDelete];
  const selectedRecords = deletionIds
    .map((id) => store.recordsById.get(id))
    .filter(Boolean)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const transcriptPaths = selectedRecords
    .map((record) => record.rolloutPath)
    .filter(Boolean);
  const missingTranscriptPaths = selectedRecords
    .filter((record) => record.rolloutMissing)
    .map((record) => record.rolloutPath)
    .filter(Boolean);
  const deletionIdSet = new Set(deletionIds);
  const requestedIdSet = new Set(recordIds);
  const newestLinkedActivityAtMs = selectedRecords.reduce((newest, record) => {
    if (requestedIdSet.has(record.id)) {
      return newest;
    }

    return Math.max(newest, record.updatedAtMs ?? 0);
  }, 0);
  let transcriptBytes = 0;
  let transcriptFileCount = 0;

  for (const transcriptBatch of batches([...new Set(transcriptPaths)], OVERVIEW_STAT_BATCH_SIZE)) {
    const results = await Promise.all(transcriptBatch.map(async (transcriptPath) => {
      try {
        return await fs.stat(transcriptPath);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }));

    for (const stats of results) {
      if (!stats?.isFile()) continue;
      transcriptBytes += stats.size;
      transcriptFileCount += 1;
    }
  }
  const [historyMatches, sessionIndexMatches] = await Promise.all([
    inspectJsonlMatches(
      store.historyPath,
      (entry) => entry.parsed?.session_id && deletionIdSet.has(String(entry.parsed.session_id)),
      { sampleLimit: 0 },
    ),
    inspectJsonlMatches(
      store.sessionIndexPath,
      (entry) => entry.parsed?.id && deletionIdSet.has(String(entry.parsed.id)),
      { sampleLimit: 0 },
    ),
  ]);
  const spawnEdgeCount = store.spawnEdges.reduce((count, edge) => {
    if (
      deletionIdSet.has(edge.parent_thread_id) ||
      deletionIdSet.has(edge.child_thread_id)
    ) {
      return count + 1;
    }

    return count;
  }, 0);
  const dynamicToolRowCount = (store.stateDatabases ?? [{ path: store.stateDatabasePath }])
    .reduce((total, database) => total + (stateSchema(database).hasDynamicTools
      ? countRowsForIds(database.path, "thread_dynamic_tools", "thread_id", deletionIds)
      : 0), 0);
  const logRowCount = (store.logsDatabasePaths ?? [store.logsDatabasePath].filter(Boolean))
    .reduce((total, databasePath) => total + countRowsForIds(databasePath, "logs", "thread_id", deletionIds), 0);
  const memoryRowCount = (store.memoryDatabasePaths ?? [store.memoryDatabasePath].filter(Boolean))
    .reduce((total, databasePath) => total + countRowsForIds(databasePath, "stage1_outputs", "thread_id", deletionIds), 0);
  const goalRowCount = (store.goalsDatabasePaths ?? [store.goalsDatabasePath].filter(Boolean))
    .reduce((total, databasePath) => total + countRowsForIds(databasePath, "thread_goals", "thread_id", deletionIds), 0);
  const stateTargets = (store.stateDatabases ?? [{ path: store.stateDatabasePath }]).map((database) => ({
    database,
    ids: findRowsForIds(database.path, "threads", "id", deletionIds).map((row) => String(row.id)),
  }));

  return {
    childCount: Math.max(0, deletionIds.length - recordIds.length),
    desktopStateMatchCount: 0,
    desktopStateSupport: {
      backup: store.hasDesktopStateBackup ? "pending" : "absent",
      current: store.hasDesktopState ? "pending" : "absent",
    },
    dynamicToolRowCount,
    goalRowCount,
    historyMatchCount: historyMatches.count,
    ids: deletionIds,
    logRowCount,
    memoryRowCount,
    missingTranscriptPaths,
    newestLinkedActivityAtMs,
    records: selectedRecords,
    sessionIndexMatchCount: sessionIndexMatches.count,
    spawnEdgeCount,
    stateTargets,
    transcriptBytes,
    transcriptFileCount,
    transcriptPaths,
  };
}

const BACKUP_MINIMUM_RESERVE_BYTES = 1024 * 1024;
const BACKUP_RESERVE_RATIO = 0.05;

function getBackupSourcePaths({ plan, scope, store }) {
  const databasePaths = [
    ...(store.stateDatabasePaths ?? [store.stateDatabasePath]),
    ...(store.logsDatabasePaths ?? [store.logsDatabasePath].filter(Boolean)),
    ...(scope === "deep" ? (store.memoryDatabasePaths ?? [store.memoryDatabasePath].filter(Boolean)) : []),
    ...(scope === "deep" ? (store.goalsDatabasePaths ?? [store.goalsDatabasePath].filter(Boolean)) : []),
  ].filter(Boolean);

  return [
    store.historyPath,
    store.sessionIndexPath,
    scope === "deep" && store.hasDesktopState ? store.desktopStatePath : null,
    scope === "deep" && store.hasDesktopStateBackup ? store.desktopStateBackupPath : null,
    ...plan.transcriptPaths,
    ...databasePaths.flatMap((databasePath) => [
      databasePath,
      `${databasePath}-journal`,
      `${databasePath}-wal`,
    ]),
  ].filter(Boolean);
}

async function getPathFingerprint(filePath) {
  try {
    const stats = await fs.stat(filePath, { bigint: true });
    return [
      filePath,
      stats.dev.toString(),
      stats.ino.toString(),
      stats.size.toString(),
      stats.mtimeNs.toString(),
    ].join("\0");
  } catch (error) {
    if (error?.code === "ENOENT") return `${filePath}\0missing`;
    throw error;
  }
}

export async function fingerprintSessionDeletion({ plan, scope, store }) {
  const hash = createHash("sha256");
  hash.update(`${store.codexHome}\0${scope}\0`);

  const counts = [
    plan.dynamicToolRowCount,
    plan.historyMatchCount,
    plan.logRowCount,
    plan.sessionIndexMatchCount,
    plan.spawnEdgeCount,
    ...(scope === "deep" ? [plan.goalRowCount, plan.memoryRowCount] : []),
  ];
  hash.update(`counts\0${counts.join("\0")}\0`);
  hash.update(`stores\0${[
    store.hasLogsDatabase,
    ...(scope === "deep" ? [
      store.hasDesktopState,
      store.hasDesktopStateBackup,
      store.hasGoalsDatabase,
      store.hasMemoryDatabase,
    ] : []),
  ].map(Number).join("\0")}\0`);
  hash.update(`resolved-databases\0${JSON.stringify(store.resolvedDatabases ?? {})}\0`);

  for (const record of [...plan.records].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update([
      "record",
      record.id,
      record.parentThreadId ?? "",
      record.rolloutPath ?? "",
      String(record.rolloutMissing),
      String(record.updatedAtMs ?? ""),
      [...record.childThreadIds].sort().join("\0"),
    ].join("\0"));
    hash.update("\0");
  }

  for (const id of [...plan.ids].sort()) {
    hash.update(`id\0${id}\0`);
  }

  for (const database of store.stateDatabases ?? [{ path: store.stateDatabasePath }]) {
    fingerprintRowsForIds(hash, database.path, "threads", "id", plan.ids);
    if (stateSchema(database).hasDynamicTools) {
      fingerprintRowsForIds(hash, database.path, "thread_dynamic_tools", "thread_id", plan.ids);
    }
    if (stateSchema(database).hasSpawnEdges) {
      fingerprintRowsForIds(hash, database.path, "thread_spawn_edges", "parent_thread_id", plan.ids);
      fingerprintRowsForIds(hash, database.path, "thread_spawn_edges", "child_thread_id", plan.ids);
    }
  }
  for (const databasePath of store.logsDatabasePaths ?? [store.logsDatabasePath].filter(Boolean)) {
    fingerprintRowsForIds(hash, databasePath, "logs", "thread_id", plan.ids);
  }
  if (scope === "deep") {
    for (const databasePath of store.memoryDatabasePaths ?? [store.memoryDatabasePath].filter(Boolean)) {
      fingerprintRowsForIds(hash, databasePath, "stage1_outputs", "thread_id", plan.ids);
    }
    for (const databasePath of store.goalsDatabasePaths ?? [store.goalsDatabasePath].filter(Boolean)) {
      fingerprintRowsForIds(hash, databasePath, "thread_goals", "thread_id", plan.ids);
      fingerprintRowsForIds(hash, databasePath, "thread_goal_continuation_deferrals", "thread_id", plan.ids);
    }
  }

  for (const filePath of [...plan.missingTranscriptPaths].sort()) {
    hash.update(`missing-transcript\0${filePath}\0`);
  }

  for (const filePath of [...plan.transcriptPaths].sort()) {
    hash.update(`${await getPathFingerprint(filePath)}\0`);
  }

  if (scope === "deep") {
    const deletedIdSet = new Set(plan.ids);
    const [desktopState, desktopStateBackup] = await Promise.all([
      store.hasDesktopState ? readJsonFile(store.desktopStatePath) : null,
      store.hasDesktopStateBackup ? readJsonFile(store.desktopStateBackupPath) : null,
    ]);
    hash.update(`desktop\0${getMatchingDesktopStateEntryCount(desktopState, deletedIdSet)}\0`);
    hash.update(`desktop-backup\0${getMatchingDesktopStateEntryCount(desktopStateBackup, deletedIdSet)}\0`);
  }

  return hash.digest("hex");
}

async function estimateBackupBytes({ plan, scope, store }) {
  let sourceBytes = 0;
  const uniquePaths = new Set(getBackupSourcePaths({ plan, scope, store }));

  for (const sourcePath of uniquePaths) {
    try {
      const stats = await fs.stat(sourcePath);

      if (stats.isFile()) {
        sourceBytes += stats.size;
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  const reserveBytes = Math.max(
    BACKUP_MINIMUM_RESERVE_BYTES,
    Math.ceil(sourceBytes * BACKUP_RESERVE_RATIO),
  );

  return {
    estimatedBackupBytes: sourceBytes + reserveBytes,
    estimatedBackupSourceBytes: sourceBytes,
    reserveBytes,
  };
}

async function getAvailableDiskBytes(directoryPath) {
  const stats = await fs.statfs(directoryPath);
  return stats.bavail * stats.bsize;
}

async function findActiveThreadIds(store, ids) {
  if (!store.threadWriterLocksDirectory) return { available: false, ids: [] };

  let entries;
  try {
    entries = await fs.readdir(store.threadWriterLocksDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { available: false, ids: [] };
    throw error;
  }

  const lockedIds = new Set(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lock"))
    .map((entry) => entry.name.slice(0, -5)));
  return {
    available: true,
    ids: ids.filter((id) => lockedIds.has(id)),
  };
}

function activeThreadError(ids) {
  const error = new Error(
    ids.length === 1
      ? "Close the selected Codex session before cleanup."
      : `Close the ${ids.length} selected Codex sessions that are still open before cleanup.`,
  );
  error.activeThreadIds = ids;
  return error;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "bytes";

  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;

    if (value < 1024) {
      break;
    }
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

export async function preflightSessionDeletion({ availableDiskBytes, plan, scope = "deep", store }) {
  const requiredPaths = [store.stateDatabasePath, store.sessionIndexPath, store.historyPath];
  const missingRequiredPaths = [];

  for (const filePath of requiredPaths) {
    if (!(await pathExists(filePath))) {
      missingRequiredPaths.push(filePath);
    }
  }

  if (missingRequiredPaths.length > 0) {
    throw new Error("The selected Codex home is missing a required session store.");
  }

  const activeThreads = await findActiveThreadIds(store, plan.ids);
  if (activeThreads.ids.length > 0) throw activeThreadError(activeThreads.ids);

  const deletedIdSet = new Set(plan.ids);
  const desktopStates = await Promise.all([
    store.hasDesktopState ? readJsonFile(store.desktopStatePath) : null,
    store.hasDesktopStateBackup ? readJsonFile(store.desktopStateBackupPath) : null,
  ]);
  const [desktopState, desktopStateBackup] = desktopStates;
  const backupEstimate = await estimateBackupBytes({ plan, scope, store });
  const diskCapacityBytes = availableDiskBytes ?? await getAvailableDiskBytes(store.codexHome);

  if (diskCapacityBytes < backupEstimate.estimatedBackupBytes) {
    const error = new Error(
      `Not enough disk space to create a backup. About ${formatBytes(backupEstimate.estimatedBackupBytes)} is needed; ${formatBytes(diskCapacityBytes)} is available.`,
    );
    error.availableDiskBytes = diskCapacityBytes;
    error.estimatedBackupBytes = backupEstimate.estimatedBackupBytes;
    throw error;
  }

  return {
    ...backupEstimate,
    availableDiskBytes: diskCapacityBytes,
    desktopStateMatchCount:
      getMatchingDesktopStateEntryCount(desktopState, deletedIdSet) +
      getMatchingDesktopStateEntryCount(desktopStateBackup, deletedIdSet),
    desktopStateSupport: {
      backup: store.hasDesktopStateBackup ? "supported" : "absent",
      current: store.hasDesktopState ? "supported" : "absent",
    },
    activeThreadDetection: activeThreads.available ? "writer-locks" : "unavailable",
    missingRequiredPaths,
  };
}

async function atomicWriteFile(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function reportProgress(onProgress, update) {
  if (onProgress) await onProgress(update);
}

function cancellationRequested(shouldCancel) {
  return Boolean(shouldCancel?.());
}

function cleanupCancelled(backupDirectory = null) {
  const error = new Error("Cleanup was cancelled before session data changed.");
  error.cancelled = true;
  error.backupDirectory = backupDirectory;
  return error;
}

async function createOperationBackup({ onProgress, plan, scope, store }) {
  const backupDirectory = path.join(
    store.codexHome,
    "session-steward-backups",
    `${Date.now()}-${process.pid}`,
  );
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupFiles = [
    [store.historyPath, "history.jsonl", true],
    [store.sessionIndexPath, "session_index.jsonl", true],
    [store.desktopStatePath, ".codex-global-state.json", scope === "deep"],
    [store.desktopStateBackupPath, ".codex-global-state.json.bak", scope === "deep"],
  ];
  const copiedFiles = [];
  const files = [];
  const transcriptNameCounts = new Map();
  for (const transcriptPath of plan.transcriptPaths) {
    const name = path.basename(transcriptPath);
    transcriptNameCounts.set(name, (transcriptNameCounts.get(name) ?? 0) + 1);
  }
  const snapshotCandidates = [
    ...(store.stateDatabasePaths ?? [store.stateDatabasePath]).map((databasePath) => [databasePath, path.basename(databasePath), true]),
    ...(store.logsDatabasePaths ?? [store.logsDatabasePath].filter(Boolean)).map((databasePath) => [databasePath, path.basename(databasePath), true]),
    ...(scope === "deep" ? (store.memoryDatabasePaths ?? [store.memoryDatabasePath].filter(Boolean)) : []).map((databasePath) => [databasePath, path.basename(databasePath), true]),
    ...(scope === "deep" ? (store.goalsDatabasePaths ?? [store.goalsDatabasePath].filter(Boolean)) : []).map((databasePath) => [databasePath, path.basename(databasePath), true]),
  ];
  const totalItems = backupFiles.length + plan.transcriptPaths.length + snapshotCandidates.length;
  let completedItems = 0;

  const itemComplete = async () => {
    completedItems += 1;
    await reportProgress(onProgress, {
      canCancel: true,
      message: "Creating a recovery backup",
      phase: "backup",
      progress: Math.min(45, 10 + Math.round((completedItems / Math.max(1, totalItems)) * 35)),
    });
  };

  for (const [sourcePath, destinationName, restoreOnFailure] of backupFiles) {
    if (!(await pathExists(sourcePath))) {
      await itemComplete();
      continue;
    }

    const destinationPath = path.join(backupDirectory, destinationName);
    await fs.copyFile(sourcePath, destinationPath);
    copiedFiles.push(sourcePath);
    if (restoreOnFailure) files.push({ backupPath: destinationName, originalPath: sourcePath });
    await itemComplete();
  }

  const transcriptDirectory = path.join(backupDirectory, "transcripts");
  await fs.mkdir(transcriptDirectory, { recursive: true });

  for (const transcriptPath of plan.transcriptPaths) {
    if (!(await pathExists(transcriptPath))) {
      await itemComplete();
      continue;
    }

    const originalName = path.basename(transcriptPath);
    const backupName = transcriptNameCounts.get(originalName) === 1
      ? originalName
      : `${createHash("sha256").update(transcriptPath).digest("hex").slice(0, 16)}-${originalName}`;
    const relativeBackupPath = path.join("transcripts", backupName);
    await fs.copyFile(
      transcriptPath,
      path.join(backupDirectory, relativeBackupPath),
      fsConstants.COPYFILE_FICLONE,
    );
    copiedFiles.push(transcriptPath);
    files.push({ backupPath: relativeBackupPath, originalPath: transcriptPath });
    await itemComplete();
  }

  const databaseDirectory = path.join(backupDirectory, "databases");
  await fs.mkdir(databaseDirectory, { recursive: true });
  const databaseSnapshots = {};

  for (const [databasePath, backupName, restoreOnFailure] of snapshotCandidates) {
    if (!databasePath) {
      await itemComplete();
      continue;
    }

    const destinationPath = path.join(databaseDirectory, backupName);
    await backupDatabase(databasePath, destinationPath);
    const relativeBackupPath = path.join("databases", backupName);
    databaseSnapshots[backupName] = relativeBackupPath;
    copiedFiles.push(databasePath);
    if (restoreOnFailure) files.push({ backupPath: relativeBackupPath, originalPath: databasePath });
    await itemComplete();
  }

  await atomicWriteFile(
    path.join(backupDirectory, "operation.json"),
    `${JSON.stringify({
      version: 3,
      ids: plan.ids,
      scope,
      createdAtMs: Date.now(),
      copiedFiles,
      databaseSnapshots,
      files,
      profileId: CODEX_DATABASE_PROFILE.id,
      resolvedDatabases: store.resolvedDatabases ?? {},
      compatibilityStatus: (await diagnoseStorageCompatibility({ codexHome: store.codexHome })).status,
    }, null, 2)}\n`,
  );

  return backupDirectory;
}

function cleanupErrorWithBackup(error, backupDirectory) {
  const detail = error instanceof Error ? error.message : "The cleanup could not be completed.";
  const wrappedError = new Error(
    `Cleanup stopped after the backup was created. Backup: ${backupDirectory}. ${detail}`,
    { cause: error },
  );
  wrappedError.backupDirectory = backupDirectory;
  return wrappedError;
}

export async function executeSessionDeletion({
  onProgress,
  plan,
  scope = "deep",
  shouldCancel,
  store,
}) {
  if (plan.ids.length === 0) {
    return {
      deletedIds: [],
    };
  }

  if (scope !== "core" && scope !== "deep") {
    throw new Error(`Unsupported deletion scope: ${scope}`);
  }

  if (scope === "deep") {
    await assertDeepCleanupSupported({ codexHome: store.codexHome });
  }

  await reportProgress(onProgress, {
    canCancel: true,
    message: "Checking the selected sessions",
    phase: "preflight",
    progress: 5,
  });
  if (cancellationRequested(shouldCancel)) throw cleanupCancelled();
  const deletedIdSet = new Set(plan.ids);
  const preflight = await preflightSessionDeletion({ plan, scope, store });
  if (cancellationRequested(shouldCancel)) throw cleanupCancelled();
  const backupDirectory = await createOperationBackup({
    onProgress,
    plan,
    scope,
    store,
  });

  if (cancellationRequested(shouldCancel)) {
    throw cleanupCancelled(backupDirectory);
  }

  const activeThreads = await findActiveThreadIds(store, plan.ids);
  if (activeThreads.ids.length > 0) {
    throw cleanupErrorWithBackup(activeThreadError(activeThreads.ids), backupDirectory);
  }

  await reportProgress(onProgress, {
    canCancel: false,
    message: "Removing selected session data",
    phase: "cleanup",
    progress: 55,
  });

  try {
    if (scope === "deep" && store.hasMemoryDatabase) {
      for (const databasePath of store.memoryDatabasePaths ?? [store.memoryDatabasePath]) {
        executeTransaction(databasePath, deleteStatements("stage1_outputs", "thread_id", plan.ids));
      }
    }
    if (scope === "deep" && store.hasGoalsDatabase) {
      for (const databasePath of store.goalsDatabasePaths ?? [store.goalsDatabasePath]) {
        executeTransaction(databasePath, [
          ...deleteStatements("thread_goal_continuation_deferrals", "thread_id", plan.ids),
          ...deleteStatements("thread_goals", "thread_id", plan.ids),
        ]);
      }
    }

    if (store.hasLogsDatabase) {
      for (const databasePath of store.logsDatabasePaths ?? [store.logsDatabasePath]) {
        executeTransaction(databasePath, deleteStatements("logs", "thread_id", plan.ids));
      }
    }
    for (const { database, ids } of plan.stateTargets ?? (store.stateDatabases ?? [{ path: store.stateDatabasePath }]).map((database) => ({ database, ids: plan.ids }))) {
      const stateStatements = [];
      const schema = stateSchema(database);
      for (const idBatch of batches(ids)) {
        const idPlaceholders = placeholders(idBatch);
        if (schema.hasDynamicTools) stateStatements.push({
          parameters: idBatch,
          sql: `delete from thread_dynamic_tools where thread_id in (${idPlaceholders})`,
        });
        if (schema.hasSpawnEdges) stateStatements.push({
          parameters: [...idBatch, ...idBatch],
          sql: `delete from thread_spawn_edges where parent_thread_id in (${idPlaceholders}) or child_thread_id in (${idPlaceholders})`,
        });
        stateStatements.push({
          parameters: idBatch,
          sql: `delete from threads where id in (${idPlaceholders})`,
        });
      }
      executeTransaction(database.path, stateStatements);
    }
    await reportProgress(onProgress, {
      canCancel: false,
      message: "Updating session records",
      phase: "cleanup",
      progress: 70,
    });

    await Promise.all([
      rewriteJsonlFile(
        store.sessionIndexPath,
        (entry) => !entry.parsed?.id || !deletedIdSet.has(String(entry.parsed.id)),
      ),
      rewriteJsonlFile(
        store.historyPath,
        (entry) => !entry.parsed?.session_id || !deletedIdSet.has(String(entry.parsed.session_id)),
      ),
    ]);
    await reportProgress(onProgress, {
      canCancel: false,
      message: "Finishing local cleanup",
      phase: "cleanup",
      progress: 82,
    });

    if (scope === "deep") {
      const desktopStatePaths = [
        store.hasDesktopState ? store.desktopStatePath : null,
        store.hasDesktopStateBackup ? store.desktopStateBackupPath : null,
      ].filter(Boolean);

      for (const desktopStatePath of desktopStatePaths) {
        const desktopState = await readJsonFile(desktopStatePath);

        if (desktopState) {
          await atomicWriteFile(
            desktopStatePath,
            `${JSON.stringify(removeDesktopStateEntries(desktopState, deletedIdSet), null, 2)}\n`,
          );
        }
      }
    }

    const deletedTranscriptPaths = [];
    const skippedTranscriptPaths = [];

    for (const transcriptPath of plan.transcriptPaths) {
      try {
        await fs.unlink(transcriptPath);
        deletedTranscriptPaths.push(transcriptPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          skippedTranscriptPaths.push(transcriptPath);
          continue;
        }

        throw error;
      }
    }

    await reportProgress(onProgress, {
      canCancel: false,
      message: "Cleanup changes are complete",
      phase: "cleanup",
      progress: 90,
    });

    return {
      backupDirectory,
      deletedIds: plan.ids,
      deletedTranscriptPaths,
      preflight,
      scope,
      skippedTranscriptPaths,
    };
  } catch (error) {
    throw cleanupErrorWithBackup(error, backupDirectory);
  }
}

function resolveContainedPath(rootDirectory, candidatePath) {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(candidatePath);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("This backup contains a path outside the selected Codex folder.");
  }

  return resolved;
}

export async function deleteSessionDeletionBackup({ backupDirectory, codexHome }) {
  const backupRoot = path.join(codexHome, "session-steward-backups");
  const resolvedBackupDirectory = resolveContainedPath(backupRoot, backupDirectory);

  if (resolvedBackupDirectory === path.resolve(backupRoot)) {
    throw new Error("Choose one recovery backup to delete.");
  }

  await fs.rm(resolvedBackupDirectory, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 25,
  });
  return { backupDirectory: resolvedBackupDirectory };
}

export async function listSessionDeletionBackups({ codexHome }) {
  const backupRoot = path.join(path.resolve(codexHome), "session-steward-backups");
  let entries;

  try {
    entries = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const backups = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const backupDirectory = path.join(backupRoot, entry.name);
    let operation = null;

    try {
      operation = await readJsonFile(path.join(backupDirectory, "operation.json"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }

    const [stats, measured] = await Promise.all([
      fs.stat(backupDirectory),
      measurePath(backupDirectory),
    ]);
    const restorable = [2, 3].includes(operation?.version) &&
      Array.isArray(operation.files) &&
      operation.files.length > 0;

    backups.push({
      backupDirectory,
      bytes: measured.bytes,
      createdAtMs: toTimestampMs(operation?.createdAtMs) || stats.mtimeMs,
      fileCount: measured.fileCount,
      id: entry.name,
      itemCount: Array.isArray(operation?.files) ? operation.files.length : measured.fileCount,
      providerId: "codex",
      restorable,
      scope: operation?.scope === "core" || operation?.scope === "deep" ? operation.scope : null,
      sessionCount: Array.isArray(operation?.ids) ? operation.ids.length : null,
    });
  }

  return backups.sort((left, right) => right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id));
}

async function atomicCopyFile(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.session-steward-${process.pid}-${Date.now()}.tmp`;

  try {
    await fs.copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_FICLONE);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function getSqliteSidecarPaths(filePath) {
  return filePath.endsWith(".sqlite")
    ? ["-wal", "-shm", "-journal"].map((suffix) => `${filePath}${suffix}`)
    : [];
}

export async function restoreSessionDeletionBackup({
  backupDirectory,
  codexHome,
  onProgress,
}) {
  const backupRoot = path.join(path.resolve(codexHome), "session-steward-backups");
  const resolvedBackupDirectory = resolveContainedPath(backupRoot, backupDirectory);
  const operationPath = path.join(resolvedBackupDirectory, "operation.json");
  const operation = await readJsonFile(operationPath);

  if (![2, 3].includes(operation?.version) || !Array.isArray(operation.files) || operation.files.length === 0) {
    throw new Error("This backup cannot be restored automatically. Its files are still available for manual recovery.");
  }
  const currentDatabasesBeforeRestore = getCodexPaths(codexHome, { refresh: true }).resolvedDatabases;

  const files = operation.files.map((entry) => {
    if (typeof entry?.backupPath !== "string" || typeof entry?.originalPath !== "string") {
      throw new Error("This backup is missing recovery information.");
    }

    return {
      backupPath: resolveContainedPath(
        resolvedBackupDirectory,
        path.join(resolvedBackupDirectory, entry.backupPath),
      ),
      originalPath: resolveContainedPath(codexHome, entry.originalPath),
    };
  });

  for (const file of files) {
    if (!(await pathExists(file.backupPath))) {
      throw new Error("This backup is incomplete and cannot be restored automatically.");
    }
  }

  const restorePaths = new Set(files.flatMap((file) => [
    file.backupPath,
    file.originalPath,
    ...getSqliteSidecarPaths(file.originalPath),
  ]));
  let restoreSourceBytes = 0;

  for (const filePath of restorePaths) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.isFile()) restoreSourceBytes += stats.size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const restoreReserveBytes = Math.max(
    BACKUP_MINIMUM_RESERVE_BYTES,
    Math.ceil(restoreSourceBytes * BACKUP_RESERVE_RATIO),
  );
  const restoreRequiredBytes = restoreSourceBytes + restoreReserveBytes;
  const restoreAvailableBytes = await getAvailableDiskBytes(resolvedBackupDirectory);

  if (restoreAvailableBytes < restoreRequiredBytes) {
    throw new Error(
      `Not enough disk space to restore safely. About ${formatBytes(restoreRequiredBytes)} is needed; ${formatBytes(restoreAvailableBytes)} is available.`,
    );
  }

  const safetyBackupDirectory = path.join(
    resolvedBackupDirectory,
    `before-restore-${Date.now()}`,
  );
  const safetyFiles = [];
  await fs.mkdir(safetyBackupDirectory, { recursive: true });
  await reportProgress(onProgress, {
    canCancel: false,
    message: "Saving the current files before restore",
    phase: "restore",
    progress: 10,
  });

  for (const file of files) {
    for (const currentPath of [file.originalPath, ...getSqliteSidecarPaths(file.originalPath)]) {
      if (!(await pathExists(currentPath))) continue;
      const safetyName = createHash("sha256")
        .update(currentPath)
        .digest("hex");
      const safetyPath = path.join(safetyBackupDirectory, safetyName);
      await fs.copyFile(currentPath, safetyPath, fsConstants.COPYFILE_FICLONE);
      safetyFiles.push({ backupPath: safetyName, originalPath: currentPath });
    }
  }

  await atomicWriteFile(
    path.join(safetyBackupDirectory, "operation.json"),
    `${JSON.stringify({ version: 1, createdAtMs: Date.now(), files: safetyFiles }, null, 2)}\n`,
  );

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      for (const sidecarPath of getSqliteSidecarPaths(file.originalPath)) {
        await fs.rm(sidecarPath, { force: true });
      }
      await atomicCopyFile(file.backupPath, file.originalPath);
      await reportProgress(onProgress, {
        canCancel: false,
        message: "Restoring the recovery backup",
        phase: "restore",
        progress: 20 + Math.round(((index + 1) / files.length) * 75),
      });
    }

    for (const file of files) {
      const [backupStats, restoredStats] = await Promise.all([
        fs.stat(file.backupPath),
        fs.stat(file.originalPath),
      ]);
      if (backupStats.size !== restoredStats.size) {
        throw new Error("A restored file did not match its backup.");
      }
    }

    await reportProgress(onProgress, {
      canCancel: false,
      message: "Restore completed",
      phase: "restore",
      progress: 100,
    });

    const layoutChanged = operation.version === 3
      && JSON.stringify(operation.resolvedDatabases ?? {}) !== JSON.stringify(currentDatabasesBeforeRestore);
    return {
      note: layoutChanged ? "The Codex storage layout changed after this backup was created. The original files were restored to their recorded locations." : null,
      restoredFileCount: files.length,
      safetyBackupDirectory,
    };
  } catch (error) {
    const wrappedError = new Error(
      `Restore could not be completed. The files from before this restore are saved at ${safetyBackupDirectory}.`,
      { cause: error },
    );
    wrappedError.safetyBackupDirectory = safetyBackupDirectory;
    throw wrappedError;
  }
}

export async function verifySessionDeletion({ plan, scope = "deep", store }) {
  const deletedIdSet = new Set(plan.ids);
  const remainingThreads = (store.stateDatabasePaths ?? [store.stateDatabasePath])
    .flatMap((databasePath) => findRowsForIds(databasePath, "threads", "id", plan.ids));
  const remainingDynamicTools = (store.stateDatabases ?? [{ path: store.stateDatabasePath }])
    .flatMap((database) => stateSchema(database).hasDynamicTools
      ? findRowsForIds(database.path, "thread_dynamic_tools", "thread_id", plan.ids)
      : []);
  const remainingMemoryRecords = scope === "deep" && store.hasMemoryDatabase
    ? (store.memoryDatabasePaths ?? [store.memoryDatabasePath]).flatMap((databasePath) =>
      findRowsForIds(databasePath, "stage1_outputs", "thread_id", plan.ids))
    : [];
  const remainingGoalRecords = scope === "deep" && store.hasGoalsDatabase
    ? (store.goalsDatabasePaths ?? [store.goalsDatabasePath]).flatMap((databasePath) =>
      [
        ...findRowsForIds(databasePath, "thread_goals", "thread_id", plan.ids),
        ...findRowsForIds(databasePath, "thread_goal_continuation_deferrals", "thread_id", plan.ids),
      ])
    : [];
  const remainingLogRecords = store.hasLogsDatabase
    ? (store.logsDatabasePaths ?? [store.logsDatabasePath]).flatMap((databasePath) =>
      findRowsForIds(databasePath, "logs", "thread_id", plan.ids, { limitOne: true }))
    : [];
  const [sessionIndexMatches, historyMatches] = await Promise.all([
    inspectJsonlMatches(
      store.sessionIndexPath,
      (entry) => entry.parsed?.id && deletedIdSet.has(String(entry.parsed.id)),
    ),
    inspectJsonlMatches(
      store.historyPath,
      (entry) => entry.parsed?.session_id && deletedIdSet.has(String(entry.parsed.session_id)),
    ),
  ]);
  const remainingSessionIndexEntries = sessionIndexMatches.samples;
  const remainingHistoryEntries = historyMatches.samples;
  const remainingTranscriptPaths = [];

  for (const transcriptPath of plan.transcriptPaths) {
    if (await pathExists(transcriptPath)) {
      remainingTranscriptPaths.push(transcriptPath);
    }
  }

  const remainingDesktopStateReferences = [];

  for (const desktopStatePath of scope === "deep"
    ? [store.desktopStatePath, store.desktopStateBackupPath]
    : []) {
    if (!(await pathExists(desktopStatePath))) {
      continue;
    }

    const desktopState = await readJsonFile(desktopStatePath);
    const count = getMatchingDesktopStateEntryCount(desktopState, deletedIdSet);

    if (count > 0) {
      remainingDesktopStateReferences.push({ count, path: desktopStatePath });
    }
  }

  return {
    complete:
      remainingThreads.length === 0 &&
      remainingDynamicTools.length === 0 &&
      remainingMemoryRecords.length === 0 &&
      remainingGoalRecords.length === 0 &&
      remainingLogRecords.length === 0 &&
      sessionIndexMatches.count === 0 &&
      historyMatches.count === 0 &&
      remainingTranscriptPaths.length === 0 &&
      remainingDesktopStateReferences.length === 0,
    remainingDesktopStateReferences,
    remainingDynamicTools,
    remainingGoalRecords,
    remainingHistoryEntries,
    remainingHistoryEntryCount: historyMatches.count,
    remainingLogRecords,
    remainingMemoryRecords,
    remainingSessionIndexEntries,
    remainingSessionIndexEntryCount: sessionIndexMatches.count,
    remainingThreads,
    remainingTranscriptPaths,
  };
}

export function formatSessionForJson(sessionRecord) {
  return {
    agentNickname: sessionRecord.agentNickname,
    agentRole: sessionRecord.agentRole,
    archived: sessionRecord.archived,
    childThreadIds: sessionRecord.childThreadIds,
    createdAtMs: sessionRecord.createdAtMs,
    cwd: sessionRecord.cwd,
    displayName: sessionRecord.displayName,
    forkedFromId: sessionRecord.forkedFromId,
    id: sessionRecord.id,
    isFork: sessionRecord.isFork,
    isPinned: sessionRecord.isPinned,
    isSubagent: sessionRecord.isSubagent,
    parentThreadId: sessionRecord.parentThreadId,
    recordSource: sessionRecord.recordSource,
    providerId: sessionRecord.providerId,
    rolloutMissing: sessionRecord.rolloutMissing,
    rolloutPath: sessionRecord.rolloutPath,
    titleSource: sessionRecord.titleSource,
    transcriptBytes: sessionRecord.transcriptBytes,
    updatedAtMs: sessionRecord.updatedAtMs,
  };
}
