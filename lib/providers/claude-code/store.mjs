import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { readJsonlEntries, rewriteJsonlFile } from "../../storage/jsonl.mjs";

const PROVIDER_ID = "claude-code";
const SUPPORTED_ENTRYPOINTS = new Set(["cli", "claude-desktop"]);
const KNOWN_TOP_LEVEL = new Set([
  ".DS_Store", ".last-cleanup", ".last-update-result.json", "agents", "backups", "cache", "commands", "debug", "downloads", "file-history", "history.jsonl",
  "ide", "paste-cache", "plans", "plugins", "projects", "session-env", "sessions", "settings.json",
  "settings.local.json", "shell-snapshots", "skills", "stats-cache.json", "tasks", "telemetry",
  "todos", "uploads", "usage-data", "mcp-needs-auth-cache.json", "session-steward-backups",
]);
const MAX_TITLE_LENGTH = 180;
const DISCOVERY_CACHE_TTL_MS = 15 * 1000;
const discoveryCache = new Map();

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value?.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function getPaths(claudeHomeInput, desktopDataHomeInput) {
  const claudeHome = path.resolve(expandHome(claudeHomeInput || process.env.CLAUDE_CONFIG_DIR || "~/.claude"));
  const desktopDataHome = desktopDataHomeInput
    ? path.resolve(expandHome(desktopDataHomeInput))
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Claude")
      : null;
  return {
    backupRoot: path.join(claudeHome, "session-steward-backups"),
    claudeHome,
    debugDirectory: path.join(claudeHome, "debug"),
    desktopDataHome,
    desktopSessionsDirectory: desktopDataHome ? path.join(desktopDataHome, "claude-code-sessions") : null,
    fileHistoryDirectory: path.join(claudeHome, "file-history"),
    historyPath: path.join(claudeHome, "history.jsonl"),
    projectsDirectory: path.join(claudeHome, "projects"),
    sessionEnvDirectory: path.join(claudeHome, "session-env"),
    sessionsDirectory: path.join(claudeHome, "sessions"),
    tasksDirectory: path.join(claudeHome, "tasks"),
  };
}

async function exists(targetPath) {
  if (!targetPath) return false;
  try { await fs.access(targetPath); return true; } catch { return false; }
}

function asTimestamp(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

function messageText(message) {
  const raw = typeof message === "string"
    ? message
    : typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.find((part) => part?.type === "text" && typeof part.text === "string")?.text || ""
        : "";
  const normalized = raw.trimStart();
  if (/^<(local-command-caveat|local-command-stdout|command-name|system-reminder)>/u.test(normalized)) return "";
  return cleanTitle(raw);
}

async function readTranscriptSummary(filePath, fallbackId) {
  let id = fallbackId;
  let entrypoint = null;
  let cwd = "";
  let createdAtMs = 0;
  let title = "";
  let titleSource = "";
  let malformed = false;
  let recordCount = 0;

  for await (const { parsed } of readJsonlEntries(filePath)) {
    recordCount += 1;
    if (!parsed || typeof parsed !== "object") { malformed = true; continue; }
    const recordId = parsed.sessionId ?? parsed.session_id;
    if (typeof recordId === "string") id = recordId;
    if (typeof parsed.entrypoint === "string") {
      if (entrypoint && entrypoint !== parsed.entrypoint) entrypoint = "mixed";
      else entrypoint = parsed.entrypoint;
    }
    if (!cwd && typeof parsed.cwd === "string") cwd = parsed.cwd;
    const timestamp = asTimestamp(parsed.timestamp ?? parsed.createdAt);
    if (timestamp && (!createdAtMs || timestamp < createdAtMs)) createdAtMs = timestamp;
    if (parsed.type === "custom-title" && cleanTitle(parsed.customTitle)) {
      title = cleanTitle(parsed.customTitle); titleSource = "custom title";
    } else if (!title && parsed.type === "summary" && cleanTitle(parsed.summary)) {
      title = cleanTitle(parsed.summary); titleSource = "generated title";
    } else if (!title && parsed.type === "user") {
      const candidate = messageText(parsed.message);
      if (candidate) { title = candidate; titleSource = "first message"; }
    }
    if ((id && entrypoint && cwd && title) || recordCount >= 200) break;
  }
  const stats = await fs.stat(filePath);
  return {
    createdAtMs: createdAtMs || stats.birthtimeMs || stats.mtimeMs,
    cwd,
    entrypoint,
    id,
    malformed,
    recordCount,
    title,
    titleSource,
    transcriptBytes: stats.size,
    transcriptPath: filePath,
    updatedAtMs: stats.mtimeMs,
  };
}

async function listDesktopStates(directory) {
  const byCliSessionId = new Map();
  const unlinked = [];
  if (!directory || !(await exists(directory))) return { byCliSessionId, unlinked };
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { pending.push(target); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const state = JSON.parse(await fs.readFile(target, "utf8"));
        if (typeof state?.cliSessionId !== "string" || typeof state?.sessionId !== "string") {
          unlinked.push(target); continue;
        }
        const item = { archived: Boolean(state.isArchived), path: target, state };
        const values = byCliSessionId.get(state.cliSessionId) ?? [];
        values.push(item); byCliSessionId.set(state.cliSessionId, values);
      } catch { unlinked.push(target); }
    }
  }
  return { byCliSessionId, unlinked };
}

async function discover(claudeHome, desktopDataHome) {
  const paths = getPaths(claudeHome, desktopDataHome);
  const desktop = await listDesktopStates(paths.desktopSessionsDirectory);
  const summariesById = new Map();
  const unknown = [];
  let projectDirectories = [];
  try { projectDirectories = await fs.readdir(paths.projectsDirectory, { withFileTypes: true }); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const projectEntry of projectDirectories) {
    if (!projectEntry.isDirectory()) continue;
    const projectDirectory = path.join(paths.projectsDirectory, projectEntry.name);
    let files;
    try { files = await fs.readdir(projectDirectory, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const fallbackId = file.name.slice(0, -6);
      const summary = await readTranscriptSummary(path.join(projectDirectory, file.name), fallbackId);
      if (!SUPPORTED_ENTRYPOINTS.has(summary.entrypoint)) { unknown.push(summary.transcriptPath); continue; }
      const copies = summariesById.get(summary.id) ?? [];
      copies.push(summary); summariesById.set(summary.id, copies);
    }
  }
  const records = [];
  for (const [id, copies] of summariesById) {
    const entrypoints = new Set(copies.map((item) => item.entrypoint));
    if (entrypoints.size !== 1) { unknown.push(...copies.map((item) => item.transcriptPath)); continue; }
    const entrypoint = copies[0].entrypoint;
    const desktopStates = desktop.byCliSessionId.get(id) ?? [];
    if (entrypoint === "claude-desktop" && desktopStates.length === 0) {
      unknown.push(...copies.map((item) => item.transcriptPath)); continue;
    }
    const newest = copies.reduce((left, right) => left.updatedAtMs >= right.updatedAtMs ? left : right);
    const earliest = Math.min(...copies.map((item) => item.createdAtMs || Infinity));
    const state = desktopStates[0]?.state;
    records.push({
      agentNickname: null,
      agentRole: null,
      archived: entrypoint === "claude-desktop" && desktopStates.every((item) => item.archived),
      childThreadIds: [],
      createdAtMs: Number.isFinite(earliest) ? earliest : newest.createdAtMs,
      cwd: state?.originCwd || state?.cwd || newest.cwd,
      desktopStatePaths: desktopStates.map((item) => item.path),
      displayName: cleanTitle(state?.title) || copies.find((item) => item.title)?.title || `Session ${id.slice(0, 8)}`,
      entrypoint,
      forkedFromId: null,
      id,
      isFork: false,
      isPinned: false,
      isSubagent: false,
      providerId: PROVIDER_ID,
      recordSource: entrypoint === "claude-desktop" ? "desktop" : "transcript",
      rolloutMissing: false,
      rolloutPath: newest.transcriptPath,
      surface: entrypoint === "claude-desktop" ? "desktop" : "cli",
      titleSource: state?.title ? "Desktop title" : (copies.find((item) => item.titleSource)?.titleSource || "session ID"),
      transcriptBytes: copies.reduce((sum, item) => sum + item.transcriptBytes, 0),
      transcriptPaths: copies.map((item) => item.transcriptPath),
      updatedAtMs: Math.max(newest.updatedAtMs, asTimestamp(state?.lastActivityAt)),
    });
  }
  return { desktop, paths, records, recordsById: new Map(records.map((record) => [record.id, record])), unknown };
}

async function discoverCached(claudeHome, desktopDataHome, { refresh = false } = {}) {
  const paths = getPaths(claudeHome, desktopDataHome);
  const key = `${paths.claudeHome}\0${paths.desktopDataHome || ""}`;
  const cached = discoveryCache.get(key);
  if (!refresh && cached?.expiresAtMs > Date.now()) return cached.promise;
  const promise = discover(paths.claudeHome, paths.desktopDataHome).catch((error) => {
    if (discoveryCache.get(key)?.promise === promise) discoveryCache.delete(key);
    throw error;
  });
  discoveryCache.set(key, { expiresAtMs: Date.now() + DISCOVERY_CACHE_TTL_MS, promise });
  return promise;
}

export function invalidateSessionCache({ claudeHome, desktopDataHome }) {
  const paths = getPaths(claudeHome, desktopDataHome);
  discoveryCache.delete(`${paths.claudeHome}\0${paths.desktopDataHome || ""}`);
}

function filterRecords(records, options) {
  const search = String(options.search || "").trim().toLowerCase();
  return records.filter((record) => {
    if (options.archiveStatus === "active" && record.archived) return false;
    if (options.archiveStatus === "archived" && !record.archived) return false;
    if (options.inactiveBeforeMs && (!record.updatedAtMs || record.updatedAtMs >= options.inactiveBeforeMs)) return false;
    if (options.workspace !== undefined && record.cwd !== options.workspace) return false;
    if (search && !`${record.displayName} ${record.id} ${record.cwd} ${record.surface}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

function sortRecords(records, sort) {
  const compare = {
    created: (a, b) => b.createdAtMs - a.createdAtMs,
    cwd: (a, b) => a.cwd.localeCompare(b.cwd) || b.updatedAtMs - a.updatedAtMs,
    name: (a, b) => a.displayName.localeCompare(b.displayName),
    updated: (a, b) => b.updatedAtMs - a.updatedAtMs,
  }[sort] || ((a, b) => b.updatedAtMs - a.updatedAtMs);
  return [...records].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}

export function filterAndSortSessions({ records, ...options }) {
  return sortRecords(filterRecords(records, options), options.sort);
}

export async function loadSessionStore({ claudeHome, desktopDataHome }) {
  return discover(claudeHome, desktopDataHome);
}

export async function listSessions({ claudeHome, desktopDataHome, page = 1, pageSize = 25, refresh = false, ...options }) {
  const store = await discoverCached(claudeHome, desktopDataHome, { refresh });
  const filtered = sortRecords(filterRecords(store.records, options), options.sort);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const resolvedPage = Math.min(page, pageCount);
  return { page: resolvedPage, pageCount, records: filtered.slice((resolvedPage - 1) * pageSize, resolvedPage * pageSize), total: filtered.length };
}

export async function getSessionRecord({ claudeHome, desktopDataHome, id }) {
  return (await discoverCached(claudeHome, desktopDataHome)).recordsById.get(id) ?? null;
}

export async function getSessionOverview({ claudeHome, desktopDataHome, refresh = false }) {
  const store = await discoverCached(claudeHome, desktopDataHome, { refresh });
  const workspaces = new Map();
  const storageTargets = new Set();
  for (const record of store.records) {
    const current = workspaces.get(record.cwd) ?? { lastActivityAtMs: 0, path: record.cwd, sessionCount: 0 };
    current.sessionCount += 1;
    current.lastActivityAtMs = Math.max(current.lastActivityAtMs, record.updatedAtMs);
    workspaces.set(record.cwd, current);
    record.transcriptPaths.forEach((target) => {
      storageTargets.add(target);
      storageTargets.add(path.join(path.dirname(target), record.id));
    });
    record.desktopStatePaths.forEach((target) => storageTargets.add(target));
    storageTargets.add(path.join(store.paths.sessionEnvDirectory, record.id));
    storageTargets.add(path.join(store.paths.tasksDirectory, record.id));
    storageTargets.add(path.join(store.paths.debugDirectory, `${record.id}.txt`));
  }
  let transcriptBytes = 0;
  let transcriptFileCount = 0;
  for (const target of storageTargets) {
    const measured = await measureTarget(target);
    transcriptBytes += measured.bytes;
    transcriptFileCount += measured.count;
  }
  const history = await matchingHistoryStats(store.paths.historyPath, new Set(store.records.map((record) => record.id)));
  transcriptBytes += history.bytes;
  transcriptFileCount += history.count > 0 ? 1 : 0;
  return {
    activeSessionCount: store.records.filter((record) => !record.archived).length,
    archivedSessionCount: store.records.filter((record) => record.archived).length,
    calculatedAtMs: Date.now(),
    cliSessionCount: store.records.filter((record) => record.surface === "cli").length,
    desktopSessionCount: store.records.filter((record) => record.surface === "desktop").length,
    primarySessionCount: store.records.length,
    sessionCount: store.records.length,
    subagentCount: 0,
    supportingCount: 0,
    transcriptBytes,
    transcriptFileCount,
    unknownActivityCount: store.records.filter((record) => !record.updatedAtMs).length,
    unreadableFileCount: store.unknown.length,
    workspaces: [...workspaces.values()].sort((a, b) => b.lastActivityAtMs - a.lastActivityAtMs),
  };
}

async function topLevelEntries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function diagnoseStorageCompatibility({ claudeHome, desktopDataHome }) {
  const store = await discoverCached(claudeHome, desktopDataHome);
  const newlyDiscovered = [];
  for (const entry of await topLevelEntries(store.paths.claudeHome)) {
    if (!KNOWN_TOP_LEVEL.has(entry.name)) newlyDiscovered.push(`Unrecognized Claude data: ${entry.name}`);
  }
  if (store.unknown.length) newlyDiscovered.push(`${store.unknown.length} session file${store.unknown.length === 1 ? "" : "s"} could not be classified safely.`);
  if (store.desktop.unlinked.length) newlyDiscovered.push(`${store.desktop.unlinked.length} Desktop session record${store.desktop.unlinked.length === 1 ? "" : "s"} could not be linked safely.`);
  return {
    builtFor: { claudeCli: ["2.1.199"], claudeDesktop: ["1.24012.9"] },
    changed: [],
    missing: (await exists(store.paths.projectsDirectory)) ? [] : ["Claude project sessions folder was not found."],
    newlyDiscovered,
    status: newlyDiscovered.length ? "newer-version" : "ready",
  };
}

export async function assertDeepCleanupSupported(options) {
  const diagnostic = await diagnoseStorageCompatibility(options);
  if (diagnostic.status !== "ready") throw new Error("Thorough cleanup is paused because some Claude session data is not recognized yet. Standard cleanup is still available.");
}

async function matchingHistoryStats(historyPath, ids) {
  let count = 0;
  let bytes = 0;
  for await (const entry of readJsonlEntries(historyPath)) {
    if (entry.parsed && ids.has(entry.parsed.sessionId ?? entry.parsed.session_id)) {
      count += 1;
      bytes += Buffer.byteLength(entry.raw) + 1;
    }
  }
  return { bytes, count };
}

async function collectFiles(targetPath, output) {
  let stats;
  try { stats = await fs.lstat(targetPath); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (stats.isSymbolicLink()) throw new Error("Cleanup stopped because a linked file was found in selected session data.");
  if (stats.isDirectory()) {
    for (const entry of await fs.readdir(targetPath)) await collectFiles(path.join(targetPath, entry), output);
  } else if (stats.isFile()) output.push({ path: targetPath, size: stats.size });
}

async function measureTarget(targetPath) {
  let bytes = 0;
  let count = 0;
  const pending = [targetPath];
  while (pending.length) {
    const current = pending.pop();
    let stats;
    try { stats = await fs.lstat(current); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      for (const entry of await fs.readdir(current)) pending.push(path.join(current, entry));
    } else if (stats.isFile()) {
      bytes += stats.size;
      count += 1;
    }
  }
  return { bytes, count };
}

export async function loadDeletionStore({ claudeHome, desktopDataHome, recordIds }) {
  const store = await discover(claudeHome, desktopDataHome);
  if (recordIds.some((id) => !store.recordsById.has(id))) throw new Error("One or more selected sessions are no longer available.");
  return store;
}

export async function planSessionDeletion({ recordIds, store }) {
  const ids = [...new Set(recordIds)];
  const records = ids.map((id) => store.recordsById.get(id)).filter(Boolean);
  const selectedPaths = new Set();
  for (const record of records) {
    record.transcriptPaths.forEach((item) => selectedPaths.add(item));
    record.desktopStatePaths.forEach((item) => selectedPaths.add(item));
    for (const candidate of [
      path.join(store.paths.sessionEnvDirectory, record.id),
      path.join(store.paths.tasksDirectory, record.id),
      path.join(store.paths.debugDirectory, `${record.id}.txt`),
    ]) if (await exists(candidate)) selectedPaths.add(candidate);
    for (const transcriptPath of record.transcriptPaths) {
      const nested = path.join(path.dirname(transcriptPath), record.id);
      if (await exists(nested)) selectedPaths.add(nested);
    }
  }
  const files = [];
  for (const selectedPath of selectedPaths) await collectFiles(selectedPath, files);
  const deepPaths = [];
  const deepFiles = [];
  for (const id of ids) {
    const checkpoint = path.join(store.paths.fileHistoryDirectory, id);
    if (await exists(checkpoint)) {
      deepPaths.push(checkpoint);
      await collectFiles(checkpoint, deepFiles);
    }
  }
  const idSet = new Set(ids);
  const history = await matchingHistoryStats(store.paths.historyPath, idSet);
  const newestLinkedActivityAtMs = Math.max(0, ...records.map((record) => record.updatedAtMs));
  return {
    childCount: 0,
    desktopStateMatchCount: records.reduce((sum, record) => sum + record.desktopStatePaths.length, 0),
    deepFiles,
    deepPaths,
    files,
    goalRowCount: 0,
    historyMatchBytes: history.bytes,
    historyMatchCount: history.count,
    ids,
    logRowCount: 0,
    memoryRowCount: 0,
    missingTranscriptPaths: [],
    newestLinkedActivityAtMs,
    records,
    sessionIndexMatchCount: 0,
    spawnEdgeCount: 0,
    transcriptBytes: files.reduce((sum, file) => sum + file.size, 0),
    transcriptFileCount: files.length,
    transcriptPaths: [...selectedPaths],
  };
}

async function activeSessionIds(paths) {
  const active = new Set();
  if (!(await exists(paths.sessionsDirectory))) return { active, detection: "unavailable" };
  const pending = [paths.sessionsDirectory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) { pending.push(target); continue; }
      const match = /([0-9a-f]{8}-[0-9a-f-]{27,})/iu.exec(entry.name);
      if (match) active.add(match[1]);
      if (!entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(target, "utf8"));
        const id = parsed.sessionId ?? parsed.session_id;
        if (typeof id === "string" && !["stopped", "completed", "failed"].includes(parsed.status ?? parsed.state)) active.add(id);
      } catch {}
    }
  }
  return { active, detection: "available" };
}

export async function preflightSessionDeletion({ availableDiskBytes, plan, scope, store }) {
  const active = await activeSessionIds(store.paths);
  const selectedActive = plan.ids.filter((id) => active.active.has(id));
  if (selectedActive.length) throw new Error("Close the selected Claude sessions before cleanup.");
  const deepBytes = scope === "deep" ? plan.deepFiles.reduce((sum, file) => sum + file.size, 0) : 0;
  const estimatedBackupBytes = plan.transcriptBytes + deepBytes + plan.historyMatchBytes + 4096;
  let diskBytes = availableDiskBytes;
  if (diskBytes === undefined) {
    try { const stats = await fs.statfs(store.paths.claudeHome); diskBytes = stats.bavail * stats.bsize; } catch { diskBytes = null; }
  }
  if (Number.isFinite(diskBytes) && diskBytes < estimatedBackupBytes) throw new Error("There is not enough free space to create the recovery backup.");
  return {
    activeThreadDetection: plan.records.some((record) => record.surface === "desktop") ? "unavailable" : active.detection,
    availableDiskBytes: diskBytes,
    desktopStateMatchCount: plan.desktopStateMatchCount,
    desktopStateSupport: store.paths.desktopSessionsDirectory ? "available" : "unavailable",
    estimatedBackupBytes,
    transcriptBytes: plan.transcriptBytes + deepBytes + plan.historyMatchBytes,
    transcriptFileCount: plan.transcriptFileCount + (scope === "deep" ? plan.deepFiles.length : 0),
  };
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
}

function backupLocation(store, sourcePath) {
  const claudeRelative = contained(store.paths.claudeHome, sourcePath);
  if (claudeRelative) return { relative: claudeRelative, root: "claude" };
  const desktopRelative = store.paths.desktopDataHome && contained(store.paths.desktopDataHome, sourcePath);
  if (desktopRelative) return { relative: desktopRelative, root: "desktop" };
  throw new Error("Cleanup stopped because a selected file is outside Claude storage.");
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function fingerprintSessionDeletion({ plan, scope, store }) {
  const hash = createHash("sha256");
  hash.update(`${store.paths.claudeHome}\0${scope}\0${plan.ids.join("\0")}`);
  const files = scope === "deep" ? [...plan.files, ...plan.deepFiles] : plan.files;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const stats = await fs.stat(file.path);
    hash.update(`${file.path}\0${stats.size}\0${stats.mtimeMs}\0`);
  }
  if (plan.historyMatchCount) {
    for await (const entry of readJsonlEntries(store.paths.historyPath)) {
      if (entry.parsed && plan.ids.includes(entry.parsed.sessionId ?? entry.parsed.session_id)) hash.update(`${entry.raw}\n`);
    }
  }
  return hash.digest("hex");
}

async function copyTarget(source, destination) {
  const stats = await fs.lstat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (stats.isDirectory()) await fs.cp(source, destination, { errorOnExist: true, recursive: true });
  else await fs.copyFile(source, destination);
}

async function verifyCopy(source, destination) {
  const sourceStats = await fs.stat(source);
  if (sourceStats.isFile()) {
    const destinationStats = await fs.stat(destination);
    if (sourceStats.size !== destinationStats.size || await hashFile(source) !== await hashFile(destination)) {
      throw new Error("The recovery backup could not be verified.");
    }
    return;
  }
  const sourceFiles = [];
  const destinationFiles = [];
  await collectFiles(source, sourceFiles);
  await collectFiles(destination, destinationFiles);
  const sourceMap = new Map(sourceFiles.map((item) => [path.relative(source, item.path), item]));
  const destinationMap = new Map(destinationFiles.map((item) => [path.relative(destination, item.path), item]));
  if (sourceMap.size !== destinationMap.size) throw new Error("The recovery backup could not be verified.");
  for (const [relative, item] of sourceMap) {
    const copied = destinationMap.get(relative);
    if (!copied || copied.size !== item.size || await hashFile(item.path) !== await hashFile(copied.path)) {
      throw new Error("The recovery backup could not be verified.");
    }
  }
}

async function backupHistoryRows(historyPath, destination, ids) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const output = createWriteStream(destination, { encoding: "utf8", mode: 0o600 });
  try {
    for await (const entry of readJsonlEntries(historyPath)) {
      if (!entry.parsed || !ids.has(entry.parsed.sessionId ?? entry.parsed.session_id)) continue;
      if (!output.write(`${entry.raw}\n`)) await once(output, "drain");
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function createBackup(plan, store, scope) {
  const backupDirectory = path.join(store.paths.backupRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(6).toString("hex")}`);
  const entries = [];
  await fs.mkdir(backupDirectory, { mode: 0o700, recursive: true });
  try {
    const sources = [...new Set(plan.transcriptPaths)];
    if (scope === "deep") {
      sources.push(...plan.deepPaths);
    }
    for (const source of sources) {
      const location = backupLocation(store, source);
      const destination = path.join(backupDirectory, "data", location.root, location.relative);
      await copyTarget(source, destination);
      await verifyCopy(source, destination);
      entries.push({ ...location, sha256: (await fs.stat(source)).isFile() ? await hashFile(source) : null });
    }
    const sharedJsonl = [];
    if (plan.historyMatchCount) {
      const backupRelative = path.join("shared", "history.jsonl");
      const destination = path.join(backupDirectory, backupRelative);
      await backupHistoryRows(store.paths.historyPath, destination, new Set(plan.ids));
      sharedJsonl.push({ backupRelative, relative: "history.jsonl", root: "claude" });
    }
    const manifest = { createdAt: new Date().toISOString(), entries, providerId: PROVIDER_ID, scope, sharedJsonl, version: 1 };
    await fs.writeFile(path.join(backupDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return backupDirectory;
  } catch (error) {
    error.backupDirectory = backupDirectory;
    throw error;
  }
}

export async function executeSessionDeletion({ onProgress = () => {}, plan, scope, shouldCancel = () => false, store }) {
  onProgress({ canCancel: true, message: "Creating recovery backup", phase: "backup", progress: 8 });
  const backupDirectory = await createBackup(plan, store, scope);
  try {
    if (shouldCancel()) { const error = new Error("Cleanup cancelled."); error.cancelled = true; error.backupDirectory = backupDirectory; throw error; }
    onProgress({ canCancel: false, message: "Removing selected session data", phase: "cleanup", progress: 55 });
    if (plan.historyMatchCount && await exists(store.paths.historyPath)) {
      const ids = new Set(plan.ids);
      await rewriteJsonlFile(store.paths.historyPath, (entry) => !entry.parsed || !ids.has(entry.parsed.sessionId ?? entry.parsed.session_id));
    }
    const targets = [...plan.transcriptPaths];
    if (scope === "deep") targets.push(...plan.deepPaths);
    for (const target of [...new Set(targets)].sort((a, b) => b.length - a.length)) await fs.rm(target, { force: true, recursive: true });
    onProgress({ canCancel: false, message: "Checking cleanup", phase: "verification", progress: 90 });
    return { backupDirectory, deletedIds: plan.ids, deletedTranscriptPaths: plan.transcriptPaths, skippedTranscriptPaths: [] };
  } catch (error) {
    error.backupDirectory = backupDirectory;
    throw error;
  }
}

export async function verifySessionDeletion({ plan, scope, store }) {
  const remainingTranscriptPaths = [];
  for (const target of plan.transcriptPaths) if (await exists(target)) remainingTranscriptPaths.push(target);
  if (scope === "deep") for (const target of plan.deepPaths) if (await exists(target)) remainingTranscriptPaths.push(target);
  const remainingHistoryEntryCount = (await matchingHistoryStats(store.paths.historyPath, new Set(plan.ids))).count;
  return {
    complete: remainingTranscriptPaths.length === 0 && remainingHistoryEntryCount === 0,
    remainingDesktopStateReferences: [], remainingGoalRecords: [], remainingHistoryEntryCount,
    remainingLogRecords: [], remainingMemoryRecords: [], remainingSessionIndexEntryCount: 0,
    remainingThreads: [], remainingTranscriptPaths,
  };
}

export async function deleteSessionDeletionBackup({ backupDirectory, claudeHome }) {
  const root = path.join(path.resolve(claudeHome), "session-steward-backups");
  if (!contained(root, path.resolve(backupDirectory))) throw new Error("That recovery backup is outside the Claude backup folder.");
  await fs.rm(backupDirectory, { force: true, recursive: true });
}

export async function restoreSessionDeletionBackup({ backupDirectory, claudeHome, desktopDataHome, onProgress = () => {} }) {
  const store = { paths: getPaths(claudeHome, desktopDataHome) };
  if (!contained(store.paths.backupRoot, path.resolve(backupDirectory))) {
    throw new Error("That recovery backup is outside the Claude backup folder.");
  }
  const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, "manifest.json"), "utf8"));
  if (manifest?.providerId !== PROVIDER_ID || !Array.isArray(manifest.entries)) throw new Error("This recovery backup is not valid for Claude Code.");
  const safetyBackupDirectory = path.join(store.paths.backupRoot, `restore-safety-${Date.now()}-${randomBytes(4).toString("hex")}`);
  await fs.mkdir(safetyBackupDirectory, { mode: 0o700, recursive: true });
  try {
    onProgress({ message: "Restoring session data", progress: 35 });
    for (const entry of manifest.entries) {
      const root = entry.root === "claude" ? store.paths.claudeHome : entry.root === "desktop" ? store.paths.desktopDataHome : null;
      if (!root) throw new Error("The recovery backup contains an unsupported storage location.");
      const source = path.resolve(backupDirectory, "data", entry.root, entry.relative);
      const destination = path.resolve(root, entry.relative);
      if (!contained(backupDirectory, source) || !contained(root, destination)) throw new Error("The recovery backup contains an unsafe path.");
      if (await exists(destination)) {
        const safety = path.join(safetyBackupDirectory, entry.root, entry.relative);
        await copyTarget(destination, safety);
        await fs.rm(destination, { force: true, recursive: true });
      }
      await copyTarget(source, destination);
    }
    for (const entry of manifest.sharedJsonl ?? []) {
      const root = entry.root === "claude" ? store.paths.claudeHome : null;
      if (!root) throw new Error("The recovery backup contains an unsupported shared record.");
      const destination = path.resolve(root, entry.relative);
      if (!contained(root, destination)) throw new Error("The recovery backup contains an unsafe path.");
      const source = path.resolve(backupDirectory, entry.backupRelative);
      if (!contained(backupDirectory, source)) throw new Error("The recovery backup contains an unsafe path.");
      const selectedIds = new Set();
      for await (const row of readJsonlEntries(source)) {
        const id = row.parsed?.sessionId ?? row.parsed?.session_id;
        if (typeof id === "string") selectedIds.add(id);
      }
      if (await exists(destination)) {
        const safety = path.join(safetyBackupDirectory, entry.root, entry.relative);
        await copyTarget(destination, safety);
        await rewriteJsonlFile(destination, (row) => !row.parsed || !selectedIds.has(row.parsed.sessionId ?? row.parsed.session_id));
      } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
      }
      await pipeline(createReadStream(source), createWriteStream(destination, { flags: "a", mode: 0o600 }));
    }
    onProgress({ message: "Checking restored sessions", progress: 92 });
    return { recoveryBackupsDeleted: false, restoredEntryCount: manifest.entries.length + (manifest.sharedJsonl?.length ?? 0), safetyBackupDirectory };
  } catch (error) {
    error.safetyBackupDirectory = safetyBackupDirectory;
    throw error;
  }
}

export function formatSessionForJson(record) {
  return {
    archived: record.archived, childThreadIds: record.childThreadIds, createdAtMs: record.createdAtMs,
    cwd: record.cwd, displayName: record.displayName, forkedFromId: null, id: record.id,
    isFork: false, isPinned: false, isSubagent: false, parentThreadId: null,
    providerId: PROVIDER_ID, recordSource: record.recordSource, rolloutMissing: false,
    rolloutPath: record.rolloutPath, surface: record.surface, titleSource: record.titleSource,
    updatedAtMs: record.updatedAtMs,
  };
}
