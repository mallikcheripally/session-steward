import { constants as fsConstants, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  backupDatabase,
  batches,
  executeTransaction,
  placeholders,
  queryRows,
} from "../../storage/sqlite.mjs";

function expandHome(value) {
  if (!value || value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function normalizeDisplayName(value) {
  return normalizeText(value);
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

async function findTranscriptFiles(rootDirectory) {
  const results = [];

  async function walk(currentDirectory) {
    let entries = [];

    try {
      entries = await fs.readdir(currentDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      const resolvedPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(resolvedPath);
        continue;
      }

      if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) {
        results.push(resolvedPath);
      }
    }
  }

  await walk(rootDirectory);

  return results.sort();
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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

async function readJsonlFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/u).filter((line) => line.length > 0);

    return lines.map((line, index) => {
      try {
        return {
          index,
          parsed: JSON.parse(line),
          raw: line,
        };
      } catch {
        return {
          index,
          parsed: null,
          raw: line,
        };
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function buildSessionIndexMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry.parsed?.id) {
      continue;
    }

    const id = String(entry.parsed.id);
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

function buildHistoryMap(entries) {
  const map = new Map();

  for (const entry of entries) {
    if (!entry.parsed?.session_id) {
      continue;
    }

    const sessionId = String(entry.parsed.session_id);
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
      value: sessionIndexEntry.threadName,
    };
  }

  if (
    transcriptFallback?.latestThreadName &&
    (!sqliteTitle || sqliteTitleLooksPrompt)
  ) {
    return {
      source: "transcript_thread_name",
      value: transcriptFallback.latestThreadName,
    };
  }

  if (sqliteTitle) {
    return {
      source: "sqlite_title",
      value: sqliteTitle,
    };
  }

  if (sqliteFirstUserMessage) {
    return {
      source: "sqlite_first_user_message",
      value: sqliteFirstUserMessage,
    };
  }

  const historyEntry = historyMap.get(sessionRecord.id);

  if (historyEntry?.text) {
    return {
      source: "history_first_user_message",
      value: historyEntry.text,
    };
  }

  if (transcriptFallback?.firstUserMessage) {
    return {
      source: "transcript_first_user_message",
      value: transcriptFallback.firstUserMessage,
    };
  }

  return {
    source: "fallback",
    value: `Untitled ${sessionRecord.id.slice(0, 8)}`,
  };
}

function getCodexPaths(codexHomeInput) {
  const codexHome = path.resolve(expandHome(codexHomeInput || "~/.codex"));

  return {
    codexHome,
    desktopStateBackupPath: path.join(codexHome, ".codex-global-state.json.bak"),
    desktopStatePath: path.join(codexHome, ".codex-global-state.json"),
    goalsDatabasePath: path.join(codexHome, "goals_1.sqlite"),
    historyPath: path.join(codexHome, "history.jsonl"),
    logsDatabasePath: path.join(codexHome, "logs_2.sqlite"),
    memoryDatabasePath: path.join(codexHome, "memories_1.sqlite"),
    sessionIndexPath: path.join(codexHome, "session_index.jsonl"),
    sessionsDirectory: path.join(codexHome, "sessions"),
    stateDatabasePath: path.join(codexHome, "state_5.sqlite"),
  };
}

const DESKTOP_THREAD_MAP_KEYS = [
  "thread-project-assignments",
  "thread-projectless-output-directories",
  "thread-writable-roots",
  "thread-workspace-root-hints",
];

const DESKTOP_THREAD_ARRAY_KEYS = ["projectless-thread-ids"];

const COMPATIBILITY_PROFILE = {
  id: "local-store-2026-07",
  builtFor: {
    chatgptDesktop: ["26.727.40816"],
    codexCli: ["0.144.1"],
  },
};

const SCHEMA_REQUIREMENTS = [
  {
    database: "state_5.sqlite",
    required: true,
    tables: [
      { name: "threads", columns: ["id", "rollout_path", "cwd", "title", "first_user_message", "agent_nickname", "agent_role", "archived", "is_pinned"] },
      { name: "thread_spawn_edges", columns: ["parent_thread_id", "child_thread_id", "status"] },
    ],
  },
  { database: "logs_2.sqlite", required: false, tables: [{ name: "logs", columns: ["thread_id"] }] },
  { database: "memories_1.sqlite", required: false, tables: [{ name: "stage1_outputs", columns: ["thread_id"] }] },
  { database: "goals_1.sqlite", required: false, tables: [{ name: "thread_goals", columns: ["thread_id"] }, { name: "thread_goal_continuation_deferrals", columns: ["thread_id"] }] },
];

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
  const threadRows = queryRows(
    paths.stateDatabasePath,
    `
      select
        id,
        rollout_path,
        cwd,
        title,
        first_user_message,
        agent_nickname,
        agent_role,
        archived,
        is_pinned,
        coalesce(created_at_ms, created_at * 1000) as created_at_ms,
        coalesce(updated_at_ms, updated_at * 1000) as updated_at_ms
      from threads
      order by updated_at_ms desc, updated_at desc
    `,
  );
  const spawnEdges = queryRows(
    paths.stateDatabasePath,
    `
      select
        parent_thread_id,
        child_thread_id,
        status
      from thread_spawn_edges
    `,
  );
  const transcriptFiles = await findTranscriptFiles(paths.sessionsDirectory);
  const transcriptHeaders = new Map();

  for (const transcriptFile of transcriptFiles) {
    try {
      const header = await parseTranscriptHeader(transcriptFile);

      if (header?.id) {
        transcriptHeaders.set(header.id, header);
      }
    } catch {
      continue;
    }
  }

  const sessionIndexEntries = await readJsonlFile(paths.sessionIndexPath);
  const historyEntries = await readJsonlFile(paths.historyPath);
  const sessionIndexMap = buildSessionIndexMap(sessionIndexEntries);
  const historyMap = buildHistoryMap(historyEntries);
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
      createdAtMs: toTimestampMs(threadRow.created_at_ms),
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
      updatedAtMs: toTimestampMs(threadRow.updated_at_ms),
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
      archived: false,
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
    historyEntries,
    logsDatabasePath: paths.logsDatabasePath,
    memoryDatabasePath: paths.memoryDatabasePath,
    records,
    recordsById: new Map(records.map((record) => [record.id, record])),
    sessionIndexEntries,
    sessionIndexPath: paths.sessionIndexPath,
    spawnEdges,
    stateDatabasePath: paths.stateDatabasePath,
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
  const paths = getCodexPaths(codexHome);
  const recognizedDatabases = new Set(SCHEMA_REQUIREMENTS.map((requirement) => requirement.database));
  const missing = [];
  const changed = [];
  const available = [];

  for (const requirement of SCHEMA_REQUIREMENTS) {
    const databasePath = path.join(paths.codexHome, requirement.database);

    if (!(await pathExists(databasePath))) {
      if (requirement.required) {
        missing.push(`Required session database is missing: ${requirement.database}`);
      } else {
        available.push(`Not present: ${requirement.database}`);
      }
      continue;
    }

    let databaseChanged = false;

    for (const table of requirement.tables) {
      const inspection = inspectSqliteTable(databasePath, table.name);

      if (inspection.error) {
        changed.push(`Could not read ${requirement.database}.`);
        databaseChanged = true;
        continue;
      }

      if (!inspection.exists) {
        changed.push(`Expected table is missing in ${requirement.database}: ${table.name}.`);
        databaseChanged = true;
        continue;
      }

      const missingColumns = table.columns.filter((column) => !inspection.columns.includes(column));

      if (missingColumns.length > 0) {
        changed.push(`Expected fields changed in ${requirement.database}: ${table.name}.`);
        databaseChanged = true;
      }
    }

    if (!databaseChanged) {
      available.push(`Supported: ${requirement.database}`);
    }
  }

  let entries = [];
  try {
    entries = await fs.readdir(paths.codexHome, { withFileTypes: true });
  } catch {
    missing.push("The local Codex folder could not be read.");
  }

  const newlyDiscovered = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite") && !recognizedDatabases.has(entry.name))
    .map((entry) => `Other local database found: ${entry.name}`)
    .sort();
  const status = missing.length > 0 || changed.length > 0
    ? "update-needed"
    : newlyDiscovered.length > 0
      ? "newer-version"
      : "ready";

  return {
    available,
    builtFor: COMPATIBILITY_PROFILE.builtFor,
    changed,
    missing,
    newlyDiscovered,
    profileId: COMPATIBILITY_PROFILE.id,
    status,
  };
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const SUPPORTING_THREAD_PREFIX = "The following is the Codex agent history whose request action you are assessing";

function getSessionOrder(sort) {
  const updated = "coalesce(t.updated_at_ms, t.updated_at * 1000, 0)";
  const created = "coalesce(t.created_at_ms, t.created_at * 1000, 0)";
  const name = "lower(coalesce(nullif(trim(t.title), ''), nullif(trim(t.first_user_message), ''), t.id))";

  return {
    created: `${created} desc, t.id asc`,
    cwd: `lower(coalesce(t.cwd, '')) asc, ${updated} desc, t.id asc`,
    name: `${name} asc, ${updated} desc, t.id asc`,
    updated: `${updated} desc, t.id asc`,
  }[sort] ?? `${updated} desc, t.id asc`;
}

function getSessionConditions({ includeInternals, includeSupporting, search }) {
  const conditions = [];
  const parameters = [];

  if (!includeInternals) {
    conditions.push(`not exists (
      select 1 from thread_spawn_edges edge where edge.child_thread_id = t.id
    )`);
  }

  if (!includeSupporting) {
    conditions.push("coalesce(nullif(trim(t.title), ''), nullif(trim(t.first_user_message), ''), '') not like ?");
    parameters.push(`${SUPPORTING_THREAD_PREFIX}%`);
  }

  const normalizedSearch = normalizeText(search).toLowerCase();

  if (normalizedSearch) {
    conditions.push(`(
      instr(lower(t.id), ?) > 0
      or instr(lower(coalesce(t.title, '')), ?) > 0
      or instr(lower(coalesce(t.first_user_message, '')), ?) > 0
      or instr(lower(coalesce(t.cwd, '')), ?) > 0
      or instr(lower(coalesce(t.rollout_path, '')), ?) > 0
    )`);
    parameters.push(...Array(5).fill(normalizedSearch));
  }

  return {
    parameters,
    sql: conditions.length > 0 ? `where ${conditions.join(" and ")}` : "",
  };
}

const SESSION_COLUMNS = `
  t.id,
  t.rollout_path,
  t.cwd,
  t.title,
  t.first_user_message,
  t.agent_nickname,
  t.agent_role,
  t.archived,
  t.is_pinned,
  coalesce(t.created_at_ms, t.created_at * 1000, 0) as created_at_ms,
  coalesce(t.updated_at_ms, t.updated_at * 1000, 0) as updated_at_ms,
  (
    select edge.parent_thread_id
    from thread_spawn_edges edge
    where edge.child_thread_id = t.id
    limit 1
  ) as parent_thread_id
`;

async function formatPagedThreadRows(stateDatabasePath, threadRows) {
  const childIdsByParentId = new Map();

  if (threadRows.length > 0) {
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
    const title = normalizeDisplayName(threadRow.title ?? "");
    const firstUserMessage = getMeaningfulUserText(threadRow.first_user_message ?? "");
    const displayName = title || firstUserMessage || `Untitled ${String(threadRow.id).slice(0, 8)}`;
    const rolloutPath = threadRow.rollout_path ?? "";
    let transcriptHeader = null;

    if (rolloutPath) {
      try {
        transcriptHeader = await parseTranscriptHeader(rolloutPath);
      } catch {
        transcriptHeader = null;
      }
    }

    const parentThreadId = threadRow.parent_thread_id ?? transcriptHeader?.parentThreadId ?? null;

    records.push({
      agentNickname: threadRow.agent_nickname ?? transcriptHeader?.agentNickname ?? null,
      agentRole: threadRow.agent_role ?? transcriptHeader?.agentRole ?? null,
      archived: Boolean(threadRow.archived),
      childThreadIds: [...(childIdsByParentId.get(threadRow.id) ?? [])].sort(),
      createdAtMs: toTimestampMs(threadRow.created_at_ms),
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
      updatedAtMs: toTimestampMs(threadRow.updated_at_ms),
    });
  }

  return records;
}

export async function listSessions({
  codexHome,
  includeInternals = false,
  includeSupporting = false,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  search = "",
  sort = "updated",
}) {
  const paths = getCodexPaths(codexHome);
  const boundedPageSize = Number.isFinite(pageSize)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)))
    : DEFAULT_PAGE_SIZE;
  const requestedPage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  const conditions = getSessionConditions({ includeInternals, includeSupporting, search });
  const countRow = queryRows(
    paths.stateDatabasePath,
    `select count(*) as count from threads t ${conditions.sql}`,
    conditions.parameters,
  )[0];
  const total = Number(countRow?.count ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / boundedPageSize));
  const currentPage = Math.min(requestedPage, pageCount);
  const threadRows = queryRows(
    paths.stateDatabasePath,
    `select ${SESSION_COLUMNS}
     from threads t
     ${conditions.sql}
     order by ${getSessionOrder(sort)}
     limit ? offset ?`,
    [...conditions.parameters, boundedPageSize, (currentPage - 1) * boundedPageSize],
  );

  return {
    page: currentPage,
    pageCount,
    pageSize: boundedPageSize,
    records: await formatPagedThreadRows(paths.stateDatabasePath, threadRows),
    total,
  };
}

export async function getSessionRecord({ codexHome, id }) {
  const paths = getCodexPaths(codexHome);
  const rows = queryRows(
    paths.stateDatabasePath,
    `select ${SESSION_COLUMNS} from threads t where t.id = ? limit 1`,
    [id],
  );
  const records = await formatPagedThreadRows(paths.stateDatabasePath, rows);
  return records[0] ?? null;
}

export function filterAndSortSessions({
  includeInternals,
  records,
  search,
  sort,
}) {
  const normalizedSearch = normalizeText(search).toLowerCase();
  const filteredRecords = records.filter((record) => {
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

function* deleteStatements(tableName, columnName, ids) {
  for (const idBatch of batches(ids)) {
    yield {
      parameters: idBatch,
      sql: `delete from ${tableName} where ${columnName} in (${placeholders(idBatch)})`,
    };
  }
}

export function planSessionDeletion({ recordIds, store }) {
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
  const deletionIdSet = new Set(deletionIds);
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
  const historyMatchCount = store.historyEntries.reduce((count, entry) => {
    if (entry.parsed?.session_id && deletionIdSet.has(String(entry.parsed.session_id))) {
      return count + 1;
    }

    return count;
  }, 0);
  const sessionIndexMatchCount = store.sessionIndexEntries.reduce((count, entry) => {
    if (entry.parsed?.id && deletionIdSet.has(String(entry.parsed.id))) {
      return count + 1;
    }

    return count;
  }, 0);
  const spawnEdgeCount = store.spawnEdges.reduce((count, edge) => {
    if (
      deletionIdSet.has(edge.parent_thread_id) ||
      deletionIdSet.has(edge.child_thread_id)
    ) {
      return count + 1;
    }

    return count;
  }, 0);
  const logRowCount = store.hasLogsDatabase
    ? countRowsForIds(store.logsDatabasePath, "logs", "thread_id", deletionIds)
    : 0;
  const memoryRowCount = store.hasMemoryDatabase
    ? countRowsForIds(store.memoryDatabasePath, "stage1_outputs", "thread_id", deletionIds)
    : 0;
  const goalRowCount = store.hasGoalsDatabase
    ? countRowsForIds(store.goalsDatabasePath, "thread_goals", "thread_id", deletionIds)
    : 0;

  return {
    childCount: Math.max(0, deletionIds.length - recordIds.length),
    desktopStateMatchCount: 0,
    desktopStateSupport: {
      backup: store.hasDesktopStateBackup ? "pending" : "absent",
      current: store.hasDesktopState ? "pending" : "absent",
    },
    goalRowCount,
    historyMatchCount,
    ids: deletionIds,
    logRowCount,
    memoryRowCount,
    missingTranscriptPaths,
    records: selectedRecords,
    sessionIndexMatchCount,
    spawnEdgeCount,
    transcriptPaths,
  };
}

export async function preflightSessionDeletion({ plan, store }) {
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

  const deletedIdSet = new Set(plan.ids);
  const desktopStates = await Promise.all([
    store.hasDesktopState ? readJsonFile(store.desktopStatePath) : null,
    store.hasDesktopStateBackup ? readJsonFile(store.desktopStateBackupPath) : null,
  ]);
  const [desktopState, desktopStateBackup] = desktopStates;

  return {
    desktopStateMatchCount:
      getMatchingDesktopStateEntryCount(desktopState, deletedIdSet) +
      getMatchingDesktopStateEntryCount(desktopStateBackup, deletedIdSet),
    desktopStateSupport: {
      backup: store.hasDesktopStateBackup ? "supported" : "absent",
      current: store.hasDesktopState ? "supported" : "absent",
    },
    activeThreadDetection: "unavailable",
    missingRequiredPaths,
  };
}

async function atomicWriteFile(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function buildSessionIndexRewrite(entries, deletedIdSet) {
  const validEntries = entries
    .filter((entry) => entry.parsed?.id && !deletedIdSet.has(String(entry.parsed.id)))
    .map((entry) => ({
      id: String(entry.parsed.id),
      thread_name: String(entry.parsed.thread_name ?? ""),
      updated_at: String(entry.parsed.updated_at ?? ""),
    }));
  const invalidLines = entries
    .filter((entry) => !entry.parsed)
    .map((entry) => entry.raw);
  const latestById = new Map();

  for (const entry of validEntries) {
    const current = latestById.get(entry.id);
    const updatedAt = toTimestampMs(entry.updated_at);

    if (!current || updatedAt >= current.updatedAt) {
      latestById.set(entry.id, {
        entry,
        updatedAt,
      });
    }
  }

  const rewrittenEntries = [...latestById.values()]
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((value) => JSON.stringify(value.entry));

  return [...rewrittenEntries, ...invalidLines].join("\n") + (rewrittenEntries.length || invalidLines.length ? "\n" : "");
}

function buildHistoryRewrite(entries, deletedIdSet) {
  const retainedLines = entries
    .filter((entry) => {
      if (!entry.parsed) {
        return true;
      }

      if (!entry.parsed.session_id) {
        return true;
      }

      return !deletedIdSet.has(String(entry.parsed.session_id));
    })
    .map((entry) => entry.raw);

  return retainedLines.join("\n") + (retainedLines.length ? "\n" : "");
}

async function createOperationBackup({ plan, store }) {
  const backupDirectory = path.join(
    store.codexHome,
    "session-steward-backups",
    `${Date.now()}-${process.pid}`,
  );
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupFiles = [
    [store.historyPath, "history.jsonl"],
    [store.sessionIndexPath, "session_index.jsonl"],
    [store.desktopStatePath, ".codex-global-state.json"],
    [store.desktopStateBackupPath, ".codex-global-state.json.bak"],
  ];
  const copiedFiles = [];

  for (const [sourcePath, destinationName] of backupFiles) {
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    await fs.copyFile(sourcePath, path.join(backupDirectory, destinationName));
    copiedFiles.push(sourcePath);
  }

  const transcriptDirectory = path.join(backupDirectory, "transcripts");
  await fs.mkdir(transcriptDirectory, { recursive: true });

  for (const transcriptPath of plan.transcriptPaths) {
    if (!(await pathExists(transcriptPath))) {
      continue;
    }

    await fs.copyFile(
      transcriptPath,
      path.join(transcriptDirectory, path.basename(transcriptPath)),
      fsConstants.COPYFILE_FICLONE,
    );
    copiedFiles.push(transcriptPath);
  }

  const databaseDirectory = path.join(backupDirectory, "databases");
  await fs.mkdir(databaseDirectory, { recursive: true });
  const databaseSnapshots = {};
  const snapshotCandidates = [
    [store.stateDatabasePath, "state_5.sqlite"],
    [store.hasLogsDatabase ? store.logsDatabasePath : null, "logs_2.sqlite"],
    [store.hasMemoryDatabase ? store.memoryDatabasePath : null, "memories_1.sqlite"],
    [store.hasGoalsDatabase ? store.goalsDatabasePath : null, "goals_1.sqlite"],
  ];

  for (const [databasePath, backupName] of snapshotCandidates) {
    if (!databasePath) {
      continue;
    }

    const destinationPath = path.join(databaseDirectory, backupName);
    await backupDatabase(databasePath, destinationPath);
    databaseSnapshots[backupName] = path.join("databases", backupName);
    copiedFiles.push(databasePath);
  }

  await atomicWriteFile(
    path.join(backupDirectory, "operation.json"),
    `${JSON.stringify({ ids: plan.ids, createdAtMs: Date.now(), copiedFiles, databaseSnapshots }, null, 2)}\n`,
  );

  return backupDirectory;
}

export async function executeSessionDeletion({ plan, scope = "deep", store }) {
  if (plan.ids.length === 0) {
    return {
      deletedIds: [],
    };
  }

  const deletedIdSet = new Set(plan.ids);
  const preflight = await preflightSessionDeletion({ plan, store });
  const backupDirectory = await createOperationBackup({ plan, store });

  if (scope !== "core" && scope !== "deep") {
    throw new Error(`Unsupported deletion scope: ${scope}`);
  }

  if (scope === "deep" && store.hasMemoryDatabase) {
    executeTransaction(
      store.memoryDatabasePath,
      deleteStatements("stage1_outputs", "thread_id", plan.ids),
    );
  }
  if (scope === "deep" && store.hasGoalsDatabase) {
    executeTransaction(
      store.goalsDatabasePath,
      deleteStatements("thread_goals", "thread_id", plan.ids),
    );
  }

  if (store.hasLogsDatabase) {
    executeTransaction(
      store.logsDatabasePath,
      deleteStatements("logs", "thread_id", plan.ids),
    );
  }
  const stateStatements = [];

  for (const idBatch of batches(plan.ids)) {
    const idPlaceholders = placeholders(idBatch);
    stateStatements.push({
      parameters: [...idBatch, ...idBatch],
      sql: `delete from thread_spawn_edges where parent_thread_id in (${idPlaceholders}) or child_thread_id in (${idPlaceholders})`,
    });
    stateStatements.push({
      parameters: idBatch,
      sql: `delete from threads where id in (${idPlaceholders})`,
    });
  }

  executeTransaction(store.stateDatabasePath, stateStatements);

  const sessionIndexContent = buildSessionIndexRewrite(
    store.sessionIndexEntries,
    deletedIdSet,
  );
  const historyContent = buildHistoryRewrite(store.historyEntries, deletedIdSet);

  await atomicWriteFile(store.sessionIndexPath, sessionIndexContent);
  await atomicWriteFile(store.historyPath, historyContent);

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

  return {
    backupDirectory,
    deletedIds: plan.ids,
    deletedTranscriptPaths,
    preflight,
    scope,
    skippedTranscriptPaths,
  };
}

export async function verifySessionDeletion({ plan, scope = "deep", store }) {
  const deletedIdSet = new Set(plan.ids);
  const remainingThreads = findRowsForIds(
    store.stateDatabasePath, "threads", "id", plan.ids,
  );
  const remainingMemoryRecords = scope === "deep" && store.hasMemoryDatabase
    ? findRowsForIds(store.memoryDatabasePath, "stage1_outputs", "thread_id", plan.ids)
    : [];
  const remainingGoalRecords = scope === "deep" && store.hasGoalsDatabase
    ? findRowsForIds(store.goalsDatabasePath, "thread_goals", "thread_id", plan.ids)
    : [];
  const remainingLogRecords = store.hasLogsDatabase
    ? findRowsForIds(store.logsDatabasePath, "logs", "thread_id", plan.ids, { limitOne: true })
    : [];
  const currentSessionIndexEntries = await readJsonlFile(store.sessionIndexPath);
  const currentHistoryEntries = await readJsonlFile(store.historyPath);
  const remainingSessionIndexEntries = currentSessionIndexEntries.filter(
    (entry) => entry.parsed?.id && deletedIdSet.has(String(entry.parsed.id)),
  );
  const remainingHistoryEntries = currentHistoryEntries.filter(
    (entry) => entry.parsed?.session_id && deletedIdSet.has(String(entry.parsed.session_id)),
  );
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
      remainingMemoryRecords.length === 0 &&
      remainingGoalRecords.length === 0 &&
      remainingLogRecords.length === 0 &&
      remainingSessionIndexEntries.length === 0 &&
      remainingHistoryEntries.length === 0 &&
      remainingTranscriptPaths.length === 0 &&
      remainingDesktopStateReferences.length === 0,
    remainingDesktopStateReferences,
    remainingGoalRecords,
    remainingHistoryEntries,
    remainingLogRecords,
    remainingMemoryRecords,
    remainingSessionIndexEntries,
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
    updatedAtMs: sessionRecord.updatedAtMs,
  };
}
