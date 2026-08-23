import { once } from "node:events";
import path from "node:path";
import readline from "node:readline/promises";
import process, {
  stderr as errorOutput,
  stdin as input,
  stdout as output,
} from "node:process";

import { getProvider } from "./providers/index.mjs";
import {
  SESSION_EVENT_KIND,
  SESSION_EVENT_REASON,
  sessionEventCoveragePercent,
} from "./session-events.mjs";

function providerOptions(providerId, home) {
  return providerId === "codex" ? { codexHome: home } : { claudeHome: home };
}

const PAGE_SIZE = 20;
const ALLOWED_INACTIVE_DAYS = new Set([30, 60, 90]);
const ALLOWED_ARCHIVE_STATUSES = new Set(["all", "active", "archived"]);
const ALLOWED_CLEANUP_MODES = new Set(["standard", "thorough"]);
const HELP_TEXT = `
Commands
  search <text>                 Set the active search filter
  search                        Clear the active search filter
  workspace <path>              Show one exact workspace
  workspace                     Clear the workspace filter
  inactive <30|60|90>           Show sessions last active that many days ago
  inactive                      Clear the inactivity filter
  archive <all|active|archived> Filter sessions by archive status
  archive                       Clear the archive filter
  sort <updated|created|name|cwd|size>
                                Change sort order
  inspect <index|id-prefix>     Show session details
  tokens                        Toggle token usage in session details
  delete <selector> [...]       Delete one or more sessions
  page <number>                 Jump to a page
  next                          Next page
  prev                          Previous page
  internals                     Toggle subagent visibility
  supporting                    Toggle supporting-session visibility
  cleanup <standard|thorough>   Choose the cleanup level
  overview                      Show storage and workspace totals
  backups                       Show retained recovery backups
  restore <index|backup-id>     Restore a recovery backup
  delete-backup <index|id>      Permanently remove a recovery backup
  refresh                       Reload sessions from sqlite and disk
  help                          Show this help
  quit                          Exit

Selectors
  3                             Single row by current page index
  2-5                           Inclusive range by current page index
  019dd279                      Session id prefix
  delete 1 4-6 019dd26c
`.trim();

const CLI_HELP_TEXT = `
Usage: session-steward-cli [options]

Options
  --provider <codex|claude-code> Choose the session provider
  --codex-home <path>            Use another Codex session folder for this run
  --claude-home <path>           Use another Claude session folder for this run
  --json                         Print sessions as JSON
  --include-internals            Include subagent sessions
  --include-supporting           Include supporting sessions
  --cleanup <standard|thorough>  Choose the interactive cleanup level
  --overview                     Print storage and workspace totals
  --backups                      Print retained recovery backups
  --search <text>                Search names, workspaces, and session IDs
  --workspace <path>             Show one exact workspace
  --inactive-days <30|60|90>     Show sessions last active at least this long ago
  --archive-status <status>      Show all, active, or archived sessions
  --sort <updated|created|name|cwd|size>
                                 Choose the session order
  --events                       Include the distilled session timeline
  --events-limit <number>        Limit timeline events (default 100)
  --tokens                       Include token usage per session
  --limit <number>               Limit JSON results
  -h, --help                     Show this help
`.trim();

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function pad(value, width) {
  return value.padEnd(width, " ");
}

function relativeTime(timestampMs) {
  if (!timestampMs) {
    return "-";
  }

  const elapsedMs = Date.now() - timestampMs;
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60000));

  if (elapsedMinutes < 1) {
    return "now";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);

  if (elapsedDays < 30) {
    return `${elapsedDays}d`;
  }

  const elapsedMonths = Math.floor(elapsedDays / 30);

  if (elapsedMonths < 12) {
    return `${elapsedMonths}mo`;
  }

  return `${Math.floor(elapsedMonths / 12)}y`;
}

function absoluteTime(timestampMs) {
  if (!timestampMs) {
    return "-";
  }

  return new Date(timestampMs).toLocaleString();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";

  for (const nextUnit of units) {
    value /= 1024;
    unit = nextUnit;
    if (value < 1024) break;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function cleanupScope(cleanupMode) {
  return cleanupMode === "thorough" ? "deep" : "core";
}

function cleanupLabel(scope) {
  return scope === "deep" ? "Thorough" : scope === "core" ? "Standard" : "Unknown";
}

function getCwdDisplay(record) {
  if (!record.cwd) {
    return "-";
  }

  return path.basename(record.cwd) || record.cwd;
}

function getMarkerText(record) {
  const markers = [];

  if (record.recordSource === "transcript") {
    markers.push("orphan");
  }

  if (record.rolloutMissing) {
    markers.push("missing-file");
  }

  if (record.isFork && !record.isSubagent) {
    markers.push("fork");
  }

  if (record.isSubagent) {
    const subagentLabel = record.agentNickname || record.agentRole || "subagent";
    markers.push(`sub:${subagentLabel}`);
  } else if (record.childThreadIds.length > 0) {
    markers.push(`subagents:${record.childThreadIds.length}`);
  }

  if (record.archived) {
    markers.push("archived");
  }

  return markers.join(", ");
}

function printScreen({ archiveStatus, cleanupMode, inactiveDays, providerHome, providerName, result, search, showInternals, showSupporting, showTokens, sort, workspace }) {
  if (output.isTTY) {
    output.write("\x1Bc");
  }

  output.write("Session Steward\n");
  output.write(
    `${providerName} home: ${providerHome} | Sessions: ${result.total} | Page: ${result.page}/${result.pageCount}\n`,
  );
  output.write(
    `Sort: ${sort} | Search: ${search || "-"} | Cleanup: ${cleanupLabel(cleanupScope(cleanupMode))}\n`,
  );
  output.write(
    `Subagents: ${showInternals ? "shown" : "hidden"} | Supporting: ${showSupporting ? "shown" : "hidden"} | Tokens: ${showTokens ? "shown" : "hidden"}\n`,
  );
  output.write(
    `Last active: ${inactiveDays ? `${inactiveDays}+ days ago` : "any time"} | Workspace: ${workspace || "all"} | Status: ${archiveStatus}\n`,
  );
  output.write(
    "Commands: search | workspace | inactive | archive | sort | inspect | delete | overview | backups | help | quit\n\n",
  );

  output.write(
    `${pad("#", 4)} ${pad("Name", 52)} ${pad("Updated", 8)} ${pad("Size", 10)} ${pad("Cwd", 18)} Markers\n`,
  );
  output.write(`${"-".repeat(4)} ${"-".repeat(52)} ${"-".repeat(8)} ${"-".repeat(10)} ${"-".repeat(18)} ${"-".repeat(20)}\n`);

  if (result.records.length === 0) {
    output.write("No sessions match the current view.\n");
    return;
  }

  result.records.forEach((record, index) => {
    const rowNumber = index + 1;
    output.write(
      `${pad(String(rowNumber), 4)} ${pad(truncate(record.displayName, 52), 52)} ${pad(relativeTime(record.updatedAtMs), 8)} ${pad(formatBytes(record.transcriptBytes), 10)} ${pad(truncate(getCwdDisplay(record), 18), 18)} ${truncate(getMarkerText(record), 20)}\n`,
    );
  });
}

function parseCommand(inputValue) {
  const trimmed = inputValue.trim();

  if (!trimmed) {
    return {
      args: [],
      name: "",
    };
  }

  const [name, ...args] = trimmed.split(/\s+/u);

  return {
    args,
    name: name.toLowerCase(),
  };
}

function parseSelectors(selectors, records) {
  const resolvedIds = new Set();
  const flatSelectors = selectors
    .flatMap((selector) => selector.split(","))
    .map((selector) => selector.trim())
    .filter(Boolean);

  for (const selector of flatSelectors) {
    if (/^\d+$/u.test(selector)) {
      const rowIndex = Number.parseInt(selector, 10) - 1;
      const record = records[rowIndex];

      if (record) {
        resolvedIds.add(record.id);
        continue;
      }
    }

    if (/^\d+-\d+$/u.test(selector)) {
      const [startText, endText] = selector.split("-");
      const start = Number.parseInt(startText, 10);
      const end = Number.parseInt(endText, 10);

      if (startText.length <= 4 && endText.length <= 4) {
        if (start > end) {
          throw new Error(`Invalid range: ${selector}.`);
        }

        for (let index = start; index <= end; index += 1) {
          const record = records[index - 1];
          if (!record) throw new Error(`No session exists at row ${index}.`);
          resolvedIds.add(record.id);
        }

        continue;
      }
    }

    const matches = records.filter((record) => record.id.startsWith(selector));

    if (matches.length === 0) {
      throw new Error(`No session id starts with "${selector}".`);
    }

    if (matches.length > 1) {
      throw new Error(`Session id prefix "${selector}" is ambiguous.`);
    }

    resolvedIds.add(matches[0].id);
  }

  return [...resolvedIds];
}

function printInspect(record, deletionPlan) {
  output.write("\n");
  output.write(`${record.displayName}\n`);
  output.write(`${"-".repeat(record.displayName.length)}\n`);
  output.write(`Id: ${record.id}\n`);
  output.write(`Updated: ${absoluteTime(record.updatedAtMs)}\n`);
  output.write(`Created: ${absoluteTime(record.createdAtMs)}\n`);
  output.write(`Cwd: ${record.cwd || "-"}\n`);
  output.write(`Transcript: ${record.rolloutPath || "-"}\n`);
  output.write(`Transcript size: ${formatBytes(record.transcriptBytes)}\n`);
  output.write(`Title source: ${record.titleSource}\n`);
  output.write(`Parent: ${record.parentThreadId || "-"}\n`);
  output.write(`Children: ${record.childThreadIds.length}\n`);
  output.write(`Forked from: ${record.forkedFromId || "-"}\n`);
  output.write(`Agent nickname: ${record.agentNickname || "-"}\n`);
  output.write(`Agent role: ${record.agentRole || "-"}\n`);
  output.write(`Markers: ${getMarkerText(record) || "-"}\n`);
  output.write(`Delete sessions: ${deletionPlan.ids.length}\n`);
  output.write(`Delete transcripts: ${deletionPlan.transcriptPaths.length}\n`);
  output.write(`Delete session index rows: ${deletionPlan.sessionIndexMatchCount}\n`);
  output.write(`Delete history rows: ${deletionPlan.historyMatchCount}\n`);
  output.write(`Delete spawn edges: ${deletionPlan.spawnEdgeCount}\n`);
  output.write(`Delete log rows: ${deletionPlan.logRowCount}\n`);
}

function eventTime(atMs) {
  if (!Number.isFinite(atMs)) return "--:--";
  return new Date(atMs).toLocaleTimeString([], {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  });
}

function eventText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function planSummary(steps) {
  const counts = new Map();
  for (const step of steps) {
    const status = step.status.replaceAll("_", " ");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts]
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ") || "No steps recorded";
}

function sessionEventDescription(event) {
  if (event.kind === SESSION_EVENT_KIND.ASK) {
    return `${event.injected ? "[injected context] " : ""}${eventText(event.text)}`;
  }
  if (event.kind === SESSION_EVENT_KIND.SAID || event.kind === SESSION_EVENT_KIND.SUMMARY) {
    return eventText(event.text);
  }
  if (event.kind === SESSION_EVENT_KIND.EDIT) {
    const files = event.files.length > 0 ? event.files.join(", ") : "File not recorded";
    const changes = Number.isInteger(event.added) && Number.isInteger(event.removed)
      ? `  +${event.added}/-${event.removed}`
      : "";
    const outcome = event.applied === true
      ? "  applied"
      : event.applied === false
        ? "  NOT APPLIED"
        : "";
    return `${files}${changes}${outcome}`;
  }
  if (event.kind === SESSION_EVENT_KIND.RAN) {
    const command = eventText(event.command) || "Command not recorded";
    const outcome = event.failed === true ? "  FAILED" : "";
    const error = event.failed === true && event.error ? `  ${eventText(event.error)}` : "";
    return `${command}${outcome}${error}`;
  }
  if (event.kind === SESSION_EVENT_KIND.DECIDED) {
    const answer = event.answer ? ` → ${eventText(event.answer)}` : "";
    return `${eventText(event.question)}${answer}`;
  }
  if (event.kind === SESSION_EVENT_KIND.PLAN) return planSummary(event.steps);
  return "Event details unavailable";
}

function sessionEventReason(reason) {
  return {
    [SESSION_EVENT_REASON.NO_RECOGNIZED_EVENTS]: "No recognized session events were found.",
    [SESSION_EVENT_REASON.NO_TRANSCRIPT_PATH]: "No transcript path was recorded for this session.",
    [SESSION_EVENT_REASON.TRANSCRIPT_MISSING]: "The transcript file is missing.",
  }[reason] ?? null;
}

function printSessionEventCoverage(coverage) {
  const details = [
    `recognized ${sessionEventCoveragePercent(coverage)}%`,
    `${coverage.skipped} skipped`,
  ];
  if (coverage.unmapped > 0) details.push(`${coverage.unmapped} unmapped`);
  if (coverage.unparseable > 0) details.push(`${coverage.unparseable} unparseable`);
  if (coverage.oversized > 0) details.push(`${coverage.oversized} oversized`);
  errorOutput.write(`${details.join(" · ")}\n`);
  if (coverage.unmappedTypes.length > 0) {
    errorOutput.write(`unmapped types: ${coverage.unmappedTypes.map(({ count, type }) => `${type} (${count})`).join(", ")}\n`);
  }
}

function printSessionEventSummary(summary) {
  if (summary.asks === 0 && summary.commands === 0 && summary.edits === 0) {
    errorOutput.write("No recorded activity\n");
    return;
  }
  const countLabel = (count, label) => `${count.toLocaleString()} ${label}${count === 1 ? "" : "s"}`;
  errorOutput.write(`${[
    countLabel(summary.asks, "ask"),
    countLabel(summary.edits, "edit"),
    countLabel(summary.commands, "command"),
  ].join(" · ")}\n`);
}

// Counts run to the hundreds of millions, where digit groups stop being
// readable. The exact figure stays available in --json.
function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return "-";
  if (tokens < 1000) return String(tokens);

  const units = [["B", 1e9], ["M", 1e6], ["K", 1e3]];
  const [suffix, size] = units.find(([, value]) => tokens >= value);
  const scaled = tokens / size;

  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(scaled >= 10 ? 1 : 2)}${suffix}`;
}

function formatPercent(share) {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

const TOKEN_UNAVAILABLE = {
  "no-transcript-path": "No transcript location recorded, so tokens cannot be counted.",
  "transcript-missing": "The transcript is no longer on disk, so tokens cannot be counted.",
};

const TOKEN_NOTES = {
  "cache-write-underflow": "Cache-write reporting looked inconsistent, so fresh input is approximate.",
  "fork-parent-missing": "Forked from a session that is no longer on disk, so inherited tokens cannot be separated out.",
  "incomplete-scan": "The transcript could not be read all the way through, so this is a partial count.",
};

function printSessionTokens(tokens) {
  output.write("\nToken usage\n");
  output.write("-----------\n");

  if (!tokens?.available) {
    output.write(`${TOKEN_UNAVAILABLE[tokens?.reason] ?? "No token usage recorded for this session."}\n`);
    return;
  }

  const segment = (key) => tokens.segments.find((entry) => entry.key === key);
  // A fork's rollout replays its parent's turns, so the two halves are named
  // before the breakdown, which covers own work only.
  if (tokens.inherited) {
    output.write(`Own work: ${formatTokens(tokens.total)}\n`);
    output.write(`Inherited from parent: ${formatTokens(tokens.inherited.tokens)} across ${tokens.inherited.turns.toLocaleString()} ${tokens.inherited.turns === 1 ? "turn" : "turns"}\n`);
  } else {
    output.write(`Total: ${formatTokens(tokens.total)}\n`);
  }

  for (const key of ["freshInput", "cachedInput", "cacheWrites", "output"]) {
    const label = { cachedInput: "Cached input", cacheWrites: "Cache writes", freshInput: "Fresh input", output: "Output" }[key];
    const entry = segment(key);
    output.write(`${label}: ${formatTokens(entry.tokens)} (${formatPercent(entry.share)})\n`);
  }

  // Reasoning is part of output, so it is stated against output rather than as
  // a line of its own in the breakdown.
  if (tokens.reasoning) {
    output.write(`Reasoning: ${formatTokens(tokens.reasoning.tokens)} (${formatPercent(tokens.reasoning.share)} of output)\n`);
  }
  if (tokens.cacheHitRate !== null) {
    output.write(`Cache hits: ${formatPercent(tokens.cacheHitRate)} of input\n`);
  }
  if (tokens.byModel.length > 0) {
    output.write(`Models: ${tokens.byModel.map(({ model, share }) => `${model} ${formatPercent(share)}`).join(" · ")}\n`);
  }
  if (tokens.compactions > 0) {
    output.write(`Compactions: ${tokens.compactions.toLocaleString()} (each one re-sends the conversation, so the totals include that cost)\n`);
  }
  for (const warning of tokens.warnings) {
    errorOutput.write(`${TOKEN_NOTES[warning] ?? warning}\n`);
  }
}

function printSessionEvents(result) {
  output.write("\nSession timeline\n");
  output.write("----------------\n");
  const reason = sessionEventReason(result.reason);

  if (reason) {
    output.write(`${reason}\n`);
  } else {
    const width = output.isTTY && Number.isInteger(output.columns) ? output.columns : 120;
    for (const event of [...result.events].reverse()) {
      const kind = event.kind.toUpperCase().padEnd(8, " ");
      output.write(`${truncate(`${eventTime(event.atMs)}  ${kind} ${sessionEventDescription(event)}`, width)}\n`);
    }
  }

  if (!result.reason && result.window.complete) printSessionEventSummary(result.summary);
  printSessionEventCoverage(result.coverage);
}

function printDeletionPreview(plan, preflight, scope) {
  const fileCount = preflight.transcriptFileCount ?? plan.transcriptFileCount;
  const sessionBytes = preflight.transcriptBytes ?? plan.transcriptBytes;
  output.write("\nDelete preview\n");
  output.write("--------------\n");
  output.write(`Sessions: ${plan.ids.length}\n`);
  output.write(`Cascaded subagents: ${plan.childCount}\n`);
  output.write(`Transcripts: ${plan.transcriptPaths.length}\n`);
  output.write(`Session index rows: ${plan.sessionIndexMatchCount}\n`);
  output.write(`History rows: ${plan.historyMatchCount}\n`);
  output.write(`Spawn edges: ${plan.spawnEdgeCount}\n`);
  output.write(`Log rows: ${plan.logRowCount}\n`);
  output.write(`Cleanup: ${cleanupLabel(scope)}\n`);
  output.write(`Files: ${fileCount}\n`);
  output.write(`Session data: ${formatBytes(sessionBytes)}\n`);
  output.write(`Temporary backup space needed: ${formatBytes(preflight.estimatedBackupBytes)}\n`);

  for (const record of plan.records.slice(0, 20)) {
    output.write(`- ${record.displayName} (${record.id})\n`);
  }

  if (plan.records.length > 20) {
    output.write(`- and ${plan.records.length - 20} more\n`);
  }
}

async function pause(rl) {
  await rl.question("\nPress Enter to continue...");
}

function printHelp() {
  output.write(`\n${HELP_TEXT}\n`);
}

function validateSort(value) {
  return ["updated", "created", "name", "cwd", "size"].includes(value)
    ? value
    : "updated";
}

function validateInactiveDays(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const days = Number(value);

  if (!ALLOWED_INACTIVE_DAYS.has(days)) {
    throw new Error("Inactive days must be 30, 60, or 90.");
  }

  return days;
}

function validateArchiveStatus(value) {
  const status = value || "all";

  if (!ALLOWED_ARCHIVE_STATUSES.has(status)) {
    throw new Error("Archive status must be all, active, or archived.");
  }

  return status;
}

function validateCleanupMode(value) {
  const cleanupMode = value || "standard";

  if (!ALLOWED_CLEANUP_MODES.has(cleanupMode)) {
    throw new Error("Cleanup must be standard or thorough.");
  }

  return cleanupMode;
}

async function writeJsonValue(value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (!output.write(content)) await once(output, "drain");
}

async function loadOverview(state) {
  return state.provider.getSessionOverview({
    ...providerOptions(state.provider.id, state.providerHome),
    refresh: true,
  });
}

function printOverview(overview, providerName) {
  output.write(`\n${providerName} overview\n`);
  output.write(`${"-".repeat(providerName.length + 9)}\n`);
  output.write(`On disk: ${formatBytes(overview.transcriptBytes)} in ${overview.transcriptFileCount} files\n`);
  output.write(`All sessions: ${overview.sessionCount}\n`);
  output.write(`Primary sessions: ${overview.primarySessionCount}\n`);
  output.write(`Subagent sessions: ${overview.subagentCount}\n`);
  output.write(`Supporting sessions: ${overview.supportingCount}\n`);

  if (Number.isFinite(overview.cliSessionCount)) {
    output.write(`CLI sessions: ${overview.cliSessionCount}\n`);
  }

  if (Number.isFinite(overview.desktopSessionCount)) {
    output.write(`Desktop sessions: ${overview.desktopSessionCount}\n`);
  }

  if (overview.workspaces.length === 0) return;
  output.write("\nWorkspaces\n");
  output.write(`${pad("Sessions", 10)} ${pad("Size", 10)} Workspace\n`);

  for (const workspace of overview.workspaces) {
    output.write(
      `${pad(String(workspace.sessionCount), 10)} ${pad(formatBytes(workspace.transcriptBytes), 10)} ${workspace.path || "Unknown workspace"}\n`,
    );
  }
}

async function loadBackups(state) {
  return state.provider.listSessionDeletionBackups(
    providerOptions(state.provider.id, state.providerHome),
  );
}

function printBackups(backups) {
  output.write("\nRecovery backups\n");
  output.write("----------------\n");

  if (backups.length === 0) {
    output.write("No recovery backups are stored.\n");
    return;
  }

  output.write(`${pad("#", 4)} ${pad("Created", 22)} ${pad("Cleanup", 10)} ${pad("Size", 10)} ${pad("Files", 7)} Status\n`);

  backups.forEach((backup, index) => {
    output.write(
      `${pad(String(index + 1), 4)} ${pad(truncate(absoluteTime(backup.createdAtMs), 22), 22)} ${pad(cleanupLabel(backup.scope), 10)} ${pad(formatBytes(backup.bytes), 10)} ${pad(String(backup.fileCount), 7)} ${backup.restorable ? "Ready to restore" : "Manual recovery only"}\n`,
    );
    output.write(`     ${backup.id}\n`);
  });
}

function resolveBackupSelector(selector, backups) {
  if (!selector) throw new Error("Choose a recovery backup by number or backup id.");

  if (/^\d+$/u.test(selector)) {
    const backup = backups[Number.parseInt(selector, 10) - 1];
    if (!backup) throw new Error(`No recovery backup exists at row ${selector}.`);
    return backup;
  }

  const exactMatch = backups.find((backup) => backup.id === selector);
  if (exactMatch) return exactMatch;
  const prefixMatches = backups.filter((backup) => backup.id.startsWith(selector));
  if (prefixMatches.length === 0) throw new Error(`No recovery backup id starts with "${selector}".`);
  if (prefixMatches.length > 1) throw new Error(`Recovery backup id prefix "${selector}" is ambiguous.`);
  return prefixMatches[0];
}

function getInactiveBeforeMs(days) {
  return days === null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
}

async function refreshPage(state) {
  state.result = await state.provider.listSessions({
    archiveStatus: state.archiveStatus,
    ...providerOptions(state.provider.id, state.providerHome),
    inactiveBeforeMs: getInactiveBeforeMs(state.inactiveDays),
    includeInternals: state.showInternals,
    includeSupporting: state.showSupporting,
    page: state.page,
    pageSize: PAGE_SIZE,
    refresh: state.forceRefresh,
    search: state.search,
    sort: state.sort,
    workspace: state.workspace,
  });
  state.forceRefresh = false;
  state.page = state.result.page;
}

async function printJson(options) {
  const writeChunk = async (chunk) => {
    if (!output.write(chunk)) await once(output, "drain");
  };
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : Infinity;
  const inactiveBeforeMs = getInactiveBeforeMs(validateInactiveDays(options.inactiveDays));
  const archiveStatus = validateArchiveStatus(options.archiveStatus);
  let page = 1;
  let written = 0;
  let first = true;
  await writeChunk("[\n");

  while (written < limit) {
    const result = await options.provider.listSessions({
      archiveStatus,
      ...providerOptions(options.provider.id, options.providerHome),
      inactiveBeforeMs,
      includeInternals: Boolean(options.includeInternals),
      includeSupporting: Boolean(options.includeSupporting),
      page,
      pageSize: Math.min(100, limit - written),
      search: options.search || "",
      sort: validateSort(options.sort || "updated"),
      workspace: options.workspace,
    });

    for (const record of result.records) {
      if (written >= limit) break;
      let serializedRecord = options.provider.formatSessionForJson(record);
      if (options.events) {
        const eventResult = await options.provider.readSessionEvents({
          ...providerOptions(options.provider.id, options.providerHome),
          id: record.id,
          limit: options.eventsLimit,
        });
        serializedRecord = {
          ...serializedRecord,
          coverage: eventResult.coverage,
          events: eventResult.events,
          header: eventResult.header,
          ...(!eventResult.reason && eventResult.window.complete
            ? { summary: eventResult.summary }
            : {}),
        };
      }
      if (options.tokens) {
        serializedRecord = {
          ...serializedRecord,
          tokens: await options.provider.readSessionTokens({
            ...providerOptions(options.provider.id, options.providerHome),
            id: record.id,
          }),
        };
      }
      await writeChunk(`${first ? "" : ",\n"}${JSON.stringify(serializedRecord, null, 2)}`);
      first = false;
      written += 1;
    }

    if (page >= result.pageCount || result.records.length === 0) break;
    page += 1;
  }

  await writeChunk("\n]\n");
}

async function runInteractive(state) {
  const rl = readline.createInterface({
    input,
    output,
  });

  try {
    while (true) {
      await refreshPage(state);
      printScreen({
        archiveStatus: state.archiveStatus,
        cleanupMode: state.cleanupMode,
        inactiveDays: state.inactiveDays,
        providerHome: state.providerHome,
        providerName: state.provider.displayName,
        result: state.result,
        search: state.search,
        showInternals: state.showInternals,
        showSupporting: state.showSupporting,
        showTokens: state.showTokens,
        sort: state.sort,
        workspace: state.workspace,
      });

      const commandInput = await rl.question("\nsession-steward> ");
      const command = parseCommand(commandInput);

      if (!command.name) {
        continue;
      }

      if (["q", "quit", "exit"].includes(command.name)) {
        break;
      }

      if (["help", "h", "?"].includes(command.name)) {
        printHelp();
        await pause(rl);
        continue;
      }

      if (["refresh", "r"].includes(command.name)) {
        state.forceRefresh = true;
        state.page = 1;
        continue;
      }

      if (["internals", "toggle-internals"].includes(command.name)) {
        state.showInternals = !state.showInternals;
        state.page = 1;
        continue;
      }

      if (["supporting", "toggle-supporting"].includes(command.name)) {
        state.showSupporting = !state.showSupporting;
        state.page = 1;
        continue;
      }

      if (command.name === "tokens") {
        state.showTokens = !state.showTokens;
        output.write(`\nToken usage in session details is ${state.showTokens ? "on" : "off"}.\n`);
        await pause(rl);
        continue;
      }

      if (command.name === "cleanup") {
        try {
          state.cleanupMode = validateCleanupMode(command.args[0]);
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
          await pause(rl);
        }
        continue;
      }

      if (command.name === "overview") {
        try {
          printOverview(await loadOverview(state), state.provider.displayName);
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }
        await pause(rl);
        continue;
      }

      if (command.name === "backups") {
        try {
          printBackups(await loadBackups(state));
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }
        await pause(rl);
        continue;
      }

      if (command.name === "restore") {
        try {
          const backups = await loadBackups(state);
          const backup = resolveBackupSelector(command.args[0], backups);

          if (!backup.restorable) {
            throw new Error("This backup cannot be restored automatically. Its files are still available for manual recovery.");
          }

          output.write(`\nRestore backup from ${absoluteTime(backup.createdAtMs)} (${formatBytes(backup.bytes)}).\n`);
          output.write("Current files are saved before the restore begins.\n");
          const response = await rl.question('\nType "RESTORE" to confirm: ');

          if (response.trim() !== "RESTORE") {
            output.write("Restore cancelled.\n");
            await pause(rl);
            continue;
          }

          const restoreResult = await state.provider.restoreSessionDeletionBackup({
            backupDirectory: backup.backupDirectory,
            ...providerOptions(state.provider.id, state.providerHome),
            onProgress: ({ message }) => {
              if (message) output.write(`${message}...\n`);
            },
          });
          const cleanupDirectories = [
            restoreResult.safetyBackupDirectory,
            backup.backupDirectory,
          ].filter(Boolean);
          const retainedDirectories = [];

          for (const backupDirectory of cleanupDirectories) {
            try {
              await state.provider.deleteSessionDeletionBackup({
                backupDirectory,
                ...providerOptions(state.provider.id, state.providerHome),
              });
            } catch {
              retainedDirectories.push(backupDirectory);
            }
          }

          state.provider.invalidateSessionCache?.(providerOptions(state.provider.id, state.providerHome));
          const restoredCount = restoreResult.restoredFileCount ?? restoreResult.restoredEntryCount ?? 0;
          output.write(`Restored and verified ${restoredCount} session data files.\n`);
          if (retainedDirectories.length > 0) {
            output.write(`Restore completed, but recovery files remain at ${retainedDirectories.join(", ")}.\n`);
          }
          state.page = 1;
          state.forceRefresh = true;
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }
        await pause(rl);
        continue;
      }

      if (command.name === "delete-backup") {
        try {
          const backups = await loadBackups(state);
          const backup = resolveBackupSelector(command.args[0], backups);
          output.write(`\nDelete recovery backup from ${absoluteTime(backup.createdAtMs)} (${formatBytes(backup.bytes)}).\n`);
          output.write("You will no longer be able to restore from it.\n");
          const response = await rl.question('\nType "DELETE BACKUP" to confirm: ');

          if (response.trim() !== "DELETE BACKUP") {
            output.write("Backup deletion cancelled.\n");
            await pause(rl);
            continue;
          }

          await state.provider.deleteSessionDeletionBackup({
            backupDirectory: backup.backupDirectory,
            ...providerOptions(state.provider.id, state.providerHome),
          });
          output.write(`Deleted recovery backup ${backup.id}.\n`);
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }
        await pause(rl);
        continue;
      }

      if (["search", "s"].includes(command.name)) {
        state.search = command.args.join(" ");
        state.page = 1;
        continue;
      }

      if (["workspace", "cwd"].includes(command.name)) {
        state.workspace = command.args.length > 0 ? command.args.join(" ") : undefined;
        state.page = 1;
        continue;
      }

      if (["inactive", "inactive-days"].includes(command.name)) {
        try {
          state.inactiveDays = validateInactiveDays(command.args[0]);
          state.page = 1;
          state.forceRefresh = true;
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
          await pause(rl);
        }
        continue;
      }

      if (["archive", "archive-status"].includes(command.name)) {
        try {
          state.archiveStatus = validateArchiveStatus(command.args[0]);
          state.page = 1;
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
          await pause(rl);
        }
        continue;
      }

      if (command.name === "sort") {
        state.sort = validateSort(command.args[0] ?? "updated");
        state.page = 1;
        continue;
      }

      if (["next", "n"].includes(command.name)) {
        state.page += 1;
        continue;
      }

      if (["prev", "p"].includes(command.name)) {
        state.page = Math.max(1, state.page - 1);
        continue;
      }

      if (command.name === "page") {
        const requestedPage = Number.parseInt(command.args[0] ?? "1", 10);
        state.page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
        continue;
      }

      if (command.name === "inspect") {
        try {
          const sessionIds = parseSelectors(command.args, state.result.records);

          if (sessionIds.length !== 1) {
            throw new Error("`inspect` accepts exactly one selector.");
          }

          const record = await state.provider.getSessionRecord({ ...providerOptions(state.provider.id, state.providerHome), id: sessionIds[0] });
          const deletionStore = await state.provider.loadDeletionStore({
            ...providerOptions(state.provider.id, state.providerHome),
            recordIds: sessionIds,
          });
          const deletionPlan = await state.provider.planSessionDeletion({
            recordIds: sessionIds,
            store: deletionStore,
          });

          printInspect(record, deletionPlan);
          if (state.showTokens) {
            printSessionTokens(await state.provider.readSessionTokens({
              ...providerOptions(state.provider.id, state.providerHome),
              id: record.id,
            }));
          }
          if (state.showEvents) {
            const eventResult = await state.provider.readSessionEvents({
              ...providerOptions(state.provider.id, state.providerHome),
              id: record.id,
              limit: state.eventsLimit,
            });
            printSessionEvents(eventResult);
          }
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }

        await pause(rl);
        continue;
      }

      if (command.name === "delete") {
        try {
          const sessionIds = parseSelectors(command.args, state.result.records);
          if (sessionIds.length === 0) throw new Error("Choose at least one session to delete.");
          const scope = cleanupScope(state.cleanupMode);
          if (scope === "deep") {
            await state.provider.assertDeepCleanupSupported(
              providerOptions(state.provider.id, state.providerHome),
            );
          }
          const deletionStore = await state.provider.loadDeletionStore({
            ...providerOptions(state.provider.id, state.providerHome),
            recordIds: sessionIds,
          });
          const deletionPlan = await state.provider.planSessionDeletion({
            recordIds: sessionIds,
            store: deletionStore,
          });
          const preflight = await state.provider.preflightSessionDeletion({
            plan: deletionPlan,
            scope,
            store: deletionStore,
          });

          printDeletionPreview(deletionPlan, preflight, scope);
          output.write(
            `\nClose the selected ${state.provider.displayName} sessions before continuing.\n`,
          );

          const confirmationToken =
            deletionPlan.ids.length > 1 || deletionPlan.childCount > 0
              ? `DELETE ${deletionPlan.ids.length}`
              : "DELETE";
          const response = await rl.question(
            `\nType "${confirmationToken}" to confirm: `,
          );

          if (response.trim() !== confirmationToken) {
            output.write("Delete cancelled.\n");
            await pause(rl);
            continue;
          }

          let cancelRequested = false;
          let canCancel = true;
          let lastMessage = "";
          const handleInterrupt = () => {
            if (canCancel) {
              cancelRequested = true;
              output.write("\nCancellation requested. Finishing the current safe step.\n");
            } else {
              output.write("\nCleanup is already applying changes and will finish safely.\n");
            }
          };
          process.on("SIGINT", handleInterrupt);
          let result;

          try {
            result = await state.provider.executeSessionDeletion({
              onProgress: ({ canCancel: nextCanCancel, message }) => {
                canCancel = nextCanCancel;
                if (message !== lastMessage) {
                  output.write(`${message}...\n`);
                  lastMessage = message;
                }
              },
              plan: deletionPlan,
              scope,
              shouldCancel: () => cancelRequested,
              store: deletionStore,
            });
          } finally {
            process.off("SIGINT", handleInterrupt);
          }
          const verification = await state.provider.verifySessionDeletion({
            plan: deletionPlan,
            scope,
            store: deletionStore,
          });

          if (verification.complete) {
            try {
              await state.provider.deleteSessionDeletionBackup({
                backupDirectory: result.backupDirectory,
                ...providerOptions(state.provider.id, state.providerHome),
              });
            } catch {
              output.write(`Cleanup completed, but its recovery backup remains at ${result.backupDirectory}.\n`);
            }
            output.write(
              `Deleted and verified ${result.deletedIds.length} sessions and ${result.deletedTranscriptPaths.length} session paths.\n`,
            );
          } else {
            output.write(
              `Cleanup finished, but some selected artifacts remain. Backup: ${result.backupDirectory}\n`,
            );
          }

          if (result.skippedTranscriptPaths.length > 0) {
            output.write(
              `Skipped ${result.skippedTranscriptPaths.length} missing transcript paths.\n`,
            );
          }
          if (result.unrecognizedLocationCount > 0) {
            output.write(
              `${result.unrecognizedLocationCount} ${result.unrecognizedLocationCount === 1 ? "location" : "locations"} in your Claude folder ${result.unrecognizedLocationCount === 1 ? "was" : "were"} not recognized and ${result.unrecognizedLocationCount === 1 ? "was" : "were"} not examined.\n`,
            );
          }

          state.provider.invalidateSessionCache?.(
            providerOptions(state.provider.id, state.providerHome),
          );
          state.page = 1;
          state.forceRefresh = true;
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
          await pause(rl);
        }

        continue;
      }

      output.write(`\nUnknown command: ${command.name}\n`);
      await pause(rl);
    }
  } finally {
    rl.close();
  }
}

export async function runCli(options) {
  if (options.help) {
    output.write(`${CLI_HELP_TEXT}\n`);
    return;
  }

  const provider = options.provider ?? getProvider(options.providerId || "codex");
  const providerHome = path.resolve(options.providerHome);

  if (options.overview && options.backups) {
    throw new Error("Choose either overview or backups.");
  }

  if (options.overview) {
    const overview = await loadOverview({ provider, providerHome });
    if (options.json) await writeJsonValue(overview);
    else printOverview(overview, provider.displayName);
    return;
  }

  if (options.backups) {
    const backups = await loadBackups({ provider, providerHome });
    if (options.json) await writeJsonValue(backups);
    else printBackups(backups);
    return;
  }

  if (options.json) {
    await printJson({ ...options, provider, providerHome });
    return;
  }

  const state = {
    archiveStatus: validateArchiveStatus(options.archiveStatus),
    cleanupMode: validateCleanupMode(options.cleanup),
    eventsLimit: options.eventsLimit,
    provider,
    providerHome,
    inactiveDays: validateInactiveDays(options.inactiveDays),
    forceRefresh: false,
    page: 1,
    result: null,
    search: options.search || "",
    showInternals: Boolean(options.includeInternals),
    showEvents: Boolean(options.events),
    showTokens: Boolean(options.tokens),
    showSupporting: Boolean(options.includeSupporting),
    sort: validateSort(options.sort || "updated"),
    workspace: options.workspace,
  };

  await runInteractive(state);
}
