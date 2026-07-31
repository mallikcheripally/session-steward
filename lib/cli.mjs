import { once } from "node:events";
import path from "node:path";
import readline from "node:readline/promises";
import process, { stdin as input, stdout as output } from "node:process";

import { getProvider } from "./providers/index.mjs";

const {
  assertDeepCleanupSupported,
  executeSessionDeletion,
  formatSessionForJson,
  getSessionRecord,
  listSessions,
  loadDeletionStore,
  planSessionDeletion,
  verifySessionDeletion,
} = getProvider("codex");

const PAGE_SIZE = 20;
const HELP_TEXT = `
Commands
  search <text>                 Set the active search filter
  search                        Clear the active search filter
  sort <updated|created|name|cwd>
                                Change sort order
  inspect <index|id-prefix>     Show session details
  delete <selector> [...]       Delete one or more sessions
  page <number>                 Jump to a page
  next                          Next page
  prev                          Previous page
  internals                     Toggle subagent visibility
  refresh                       Reload sessions from sqlite and disk
  help                          Show this help
  quit                          Exit

Selectors
  3                             Single row by current page index
  2-5                           Inclusive range by current page index
  019dd279                      Session id prefix
  delete 1 4-6 019dd26c
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

function printScreen({ codexHome, result, search, showInternals, sort }) {
  if (output.isTTY) {
    output.write("\x1Bc");
  }

  output.write("Session Steward\n");
  output.write(
    `Home: ${codexHome} | Sessions: ${result.total} | Page: ${result.page}/${result.pageCount}\n`,
  );
  output.write(
    `Sort: ${sort} | Search: ${search || "-"} | Internals: ${showInternals ? "shown" : "hidden"}\n`,
  );
  output.write(
    "Commands: search | sort | inspect | delete | page | next | prev | internals | refresh | help | quit\n\n",
  );

  output.write(
    `${pad("#", 4)} ${pad("Name", 64)} ${pad("Updated", 8)} ${pad("Cwd", 20)} Markers\n`,
  );
  output.write(`${"-".repeat(4)} ${"-".repeat(64)} ${"-".repeat(8)} ${"-".repeat(20)} ${"-".repeat(24)}\n`);

  if (result.records.length === 0) {
    output.write("No sessions match the current view.\n");
    return;
  }

  result.records.forEach((record, index) => {
    const rowNumber = index + 1;
    output.write(
      `${pad(String(rowNumber), 4)} ${pad(truncate(record.displayName, 64), 64)} ${pad(relativeTime(record.updatedAtMs), 8)} ${pad(truncate(getCwdDisplay(record), 20), 20)} ${truncate(getMarkerText(record), 24)}\n`,
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

      if (!record) {
        throw new Error(`No session exists at row ${selector}.`);
      }

      resolvedIds.add(record.id);
      continue;
    }

    if (/^\d+-\d+$/u.test(selector)) {
      const [startText, endText] = selector.split("-");
      const start = Number.parseInt(startText, 10);
      const end = Number.parseInt(endText, 10);

      if (start > end) {
        throw new Error(`Invalid range: ${selector}.`);
      }

      for (let index = start; index <= end; index += 1) {
        const record = records[index - 1];

        if (!record) {
          throw new Error(`No session exists at row ${index}.`);
        }

        resolvedIds.add(record.id);
      }

      continue;
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

function printDeletionPreview(plan) {
  output.write("\nDelete preview\n");
  output.write("--------------\n");
  output.write(`Sessions: ${plan.ids.length}\n`);
  output.write(`Cascaded subagents: ${plan.childCount}\n`);
  output.write(`Transcripts: ${plan.transcriptPaths.length}\n`);
  output.write(`Session index rows: ${plan.sessionIndexMatchCount}\n`);
  output.write(`History rows: ${plan.historyMatchCount}\n`);
  output.write(`Spawn edges: ${plan.spawnEdgeCount}\n`);
  output.write(`Log rows: ${plan.logRowCount}\n`);

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
  return ["updated", "created", "name", "cwd"].includes(value)
    ? value
    : "updated";
}

async function refreshPage(state) {
  state.result = await listSessions({
    codexHome: state.codexHome,
    includeInternals: state.showInternals,
    page: state.page,
    pageSize: PAGE_SIZE,
    search: state.search,
    sort: state.sort,
  });
  state.page = state.result.page;
}

async function printJson(options) {
  const writeChunk = async (chunk) => {
    if (!output.write(chunk)) await once(output, "drain");
  };
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : Infinity;
  let page = 1;
  let written = 0;
  let first = true;
  await writeChunk("[\n");

  while (written < limit) {
    const result = await listSessions({
      codexHome: options.codexHome,
      includeInternals: Boolean(options.includeInternals),
      page,
      pageSize: Math.min(100, limit - written),
      search: options.search || "",
      sort: validateSort(options.sort || "updated"),
    });

    for (const record of result.records) {
      if (written >= limit) break;
      await writeChunk(`${first ? "" : ",\n"}${JSON.stringify(formatSessionForJson(record), null, 2)}`);
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
        codexHome: state.codexHome,
        result: state.result,
        search: state.search,
        showInternals: state.showInternals,
        sort: state.sort,
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
        state.page = 1;
        continue;
      }

      if (["internals", "toggle-internals"].includes(command.name)) {
        state.showInternals = !state.showInternals;
        state.page = 1;
        continue;
      }

      if (["search", "s"].includes(command.name)) {
        state.search = command.args.join(" ");
        state.page = 1;
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

          const record = await getSessionRecord({ codexHome: state.codexHome, id: sessionIds[0] });
          const deletionStore = await loadDeletionStore({
            codexHome: state.codexHome,
            recordIds: sessionIds,
          });
          const deletionPlan = await planSessionDeletion({
            recordIds: sessionIds,
            store: deletionStore,
          });

          printInspect(record, deletionPlan);
        } catch (error) {
          output.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
        }

        await pause(rl);
        continue;
      }

      if (command.name === "delete") {
        try {
          const sessionIds = parseSelectors(command.args, state.result.records);
          await assertDeepCleanupSupported({ codexHome: state.codexHome });
          const deletionStore = await loadDeletionStore({
            codexHome: state.codexHome,
            recordIds: sessionIds,
          });
          const deletionPlan = await planSessionDeletion({
            recordIds: sessionIds,
            store: deletionStore,
          });

          printDeletionPreview(deletionPlan);
          output.write(
            "\nClose the selected Codex sessions before continuing. Active-session detection is unavailable.\n",
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
            result = await executeSessionDeletion({
              onProgress: ({ canCancel: nextCanCancel, message }) => {
                canCancel = nextCanCancel;
                if (message !== lastMessage) {
                  output.write(`${message}...\n`);
                  lastMessage = message;
                }
              },
              plan: deletionPlan,
              shouldCancel: () => cancelRequested,
              store: deletionStore,
            });
          } finally {
            process.off("SIGINT", handleInterrupt);
          }
          const verification = await verifySessionDeletion({
            plan: deletionPlan,
            scope: "deep",
            store: deletionStore,
          });

          if (verification.complete) {
            output.write(
              `Deleted and verified ${result.deletedIds.length} sessions and ${result.deletedTranscriptPaths.length} transcripts.\n`,
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

          state.page = 1;
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
    output.write(
      "Usage: session-steward-cli [--codex-home <path>] [--json] [--include-internals] [--search <text>] [--sort <updated|created|name|cwd>] [--limit <n>]\n",
    );
    return;
  }

  if (options.json) {
    await printJson(options);
    return;
  }

  const state = {
    codexHome: path.resolve(options.codexHome),
    page: 1,
    result: null,
    search: options.search || "",
    showInternals: Boolean(options.includeInternals),
    sort: validateSort(options.sort || "updated"),
  };

  await runInteractive(state);
}
