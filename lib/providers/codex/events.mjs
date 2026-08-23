import {
  createSessionEvent,
  createSessionEventComposition,
  createSessionEventCoverage,
  createSessionEventHeader,
  createSessionEventSummary,
  createSessionEventsResult,
  finalizeSessionEventComposition,
  SESSION_EVENT_KIND,
  SESSION_EVENT_READ_MODE,
  SESSION_EVENT_REASON,
} from "../../session-events.mjs";
import {
  createSessionEventReadState,
  createUnmappedSessionEventTracker,
  isInjectedSessionAsk,
} from "../../session-event-reader.mjs";
import { visitJsonlSnapshotEntries } from "../../storage/jsonl.mjs";
import { getSessionRecord, loadSessionStore } from "./store.mjs";
import { createSessionTokenScan } from "./tokens.mjs";

const PROVIDER_ID = "codex";
const RECORD_CLASSIFICATION = Object.freeze({
  RECOGNIZED: "recognized",
  SKIPPED: "skipped",
  UNMAPPED: "unmapped",
  UNPARSEABLE: "unparseable",
});
const SKIPPED_PAYLOAD_TYPES = new Set([
  "agent_reasoning",
  "reasoning",
  "sub_agent_activity",
  "task_started",
  "token_count",
  "tool_search_call",
  "tool_search_output",
]);
const SKIPPED_RECORD_TYPES = new Set([
  "inter_agent_communication_metadata",
  "world_state",
]);
const DUPLICATE_TEXT_WINDOW = 8;
const DUPLICATE_TEXT_TRACKED = 64;

function createDuplicateTextTracker() {
  const seen = new Map();

  return {
    isDuplicate(kind, text, sequence) {
      const key = `${kind}\u0000${text.replace(/\s+/gu, " ").trim().slice(0, 400)}`;
      const previous = seen.get(key);
      seen.set(key, sequence);
      if (seen.size > DUPLICATE_TEXT_TRACKED) {
        seen.delete(seen.keys().next().value);
      }
      return previous !== undefined && sequence - previous <= DUPLICATE_TEXT_WINDOW;
    },
  };
}

const COMPOSITION_TOOL_OUTPUT = new Set([
  "custom_tool_call_output",
  "exec_command_end",
  "function_call_output",
  "mcp_tool_call_end",
  "web_search_end",
]);
const COMPOSITION_MESSAGES = new Set(["agent_message", "message", "user_message"]);
const COMPOSITION_EDITS = new Set(["patch_apply_begin", "patch_apply_end"]);
const COMPOSITION_REASONING = new Set(["agent_reasoning", "reasoning"]);

function compositionSegment(parsed) {
  const type = typeof parsed?.type === "string" ? parsed.type : "";
  const payloadType = typeof parsed?.payload?.type === "string" ? parsed.payload.type : type;
  if (type === "compacted" || payloadType === "compacted" || payloadType === "context_compacted") {
    return "compaction";
  }
  if (COMPOSITION_TOOL_OUTPUT.has(payloadType)) return "toolOutput";
  if (COMPOSITION_EDITS.has(payloadType)) return "edits";
  if (COMPOSITION_REASONING.has(payloadType)) return "reasoning";
  if (COMPOSITION_MESSAGES.has(payloadType)) return "messages";
  return "other";
}

function asTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function contentText(value) {
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value
      .map((part) => contentText(part))
      .filter((part) => part !== "")
      .join("\n");
  }

  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return contentText(value.content);
  }
  if (typeof value.message === "string" || Array.isArray(value.message)) {
    return contentText(value.message);
  }
  if (typeof value.summary === "string") return value.summary;
  return "";
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJavaScriptString(source, start) {
  const quote = source[start];
  if (!['"', "'", "`"].includes(quote)) return null;
  let result = "";

  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];

    if (character === quote) return result;

    if (character !== "\\") {
      result += character;
      continue;
    }

    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    result += {
      n: "\n",
      r: "\r",
      t: "\t",
    }[escaped] ?? escaped;
  }

  return null;
}

function javascriptProperty(source, property) {
  if (typeof source !== "string") return null;
  const match = new RegExp(`\\b${property}\\s*:\\s*`, "u").exec(source);
  if (!match) return null;
  return readJavaScriptString(source, match.index + match[0].length);
}

function embeddedJsonProperty(source, property) {
  if (typeof source !== "string") return null;
  const match = new RegExp(`"${property}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(source);
  if (!match) return null;

  try {
    const value = JSON.parse(`"${match[1]}"`);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function toolArguments(payload) {
  const parsed = parseArguments(payload.arguments ?? payload.input);
  if (parsed) return parsed;

  return {
    cmd: embeddedJsonProperty(payload.input, "cmd")
      ?? javascriptProperty(payload.input, "cmd"),
    workdir: embeddedJsonProperty(payload.input, "workdir")
      ?? javascriptProperty(payload.input, "workdir"),
  };
}

function nestedToolName(source) {
  if (typeof source !== "string") return null;
  const direct = /\btools\.([A-Za-z][\w]*)\s*\(/u.exec(source)?.[1];
  if (direct) return direct;
  return /\bx\.name\s*===\s*"([A-Za-z][\w]*)"/u.exec(source)?.[1] ?? null;
}

function nestedToolLabel(name) {
  if (!name) return null;
  if (name === "exec_command") return null;
  if (name.startsWith("mcp__")) {
    const [server, ...toolParts] = name.slice(5).split("__");
    return `mcp: ${server}/${toolParts.join("/") || "unknown tool"}`;
  }
  if (name.includes("__")) return `tool: ${name.replaceAll("__", "/")}`;
  return `tool: ${name}`;
}

function changePaths(changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.keys(changes).filter(Boolean);
}

function patchResultFiles(payload) {
  const fromChanges = changePaths(payload.changes);
  if (fromChanges.length > 0) return fromChanges;
  if (typeof payload.stdout !== "string") return [];
  return [...payload.stdout.matchAll(/^[MAD]\s+(.+)$/gmu)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function patchResultDetails(payload) {
  return {
    added: null,
    applied: typeof payload.success === "boolean"
      ? payload.success
      : typeof payload.stdout === "string"
        ? payload.stdout.startsWith("Success.")
        : null,
    files: patchResultFiles(payload),
    removed: null,
  };
}

function patchDetails(input) {
  if (typeof input !== "string") {
    return { added: null, files: [], removed: null };
  }

  const files = [];
  const seen = new Set();
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu;
  let match;

  while ((match = pattern.exec(input))) {
    const file = match[1].trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }

  return {
    added: (input.match(/^\+/gmu) ?? []).length,
    files,
    removed: (input.match(/^-/gmu) ?? []).length,
  };
}

function commandFailure(payload) {
  if (typeof payload.is_error === "boolean") return payload.is_error;
  if (Number.isInteger(payload.exit_code)) return payload.exit_code !== 0;
  const output = contentText(payload.output ?? payload.content ?? payload.stdout);
  if (/^Script completed(?:\n|$)/u.test(output)) return false;
  if (/^Script failed(?:\n|$)/u.test(output)) return true;
  const match = /(?:Process exited with code|exit[_ ]code["']?\s*[:=]?|Exit code)\s*(-?\d+)/iu.exec(output);
  return match ? Number(match[1]) !== 0 : null;
}

function mcpOutcome(payload) {
  const result = payload.result?.Ok ?? payload.result?.Err ?? payload.result;
  const failed = payload.result?.Err !== undefined
    ? true
    : typeof result?.isError === "boolean"
      ? result.isError
      : typeof result?.is_error === "boolean"
        ? result.is_error
        : null;
  return {
    error: failed === true
      ? contentText(result?.content ?? result?.error ?? result).trim() || "Tool failed."
      : null,
    failed,
  };
}

function mcpToolEvent(payload, atMs, sequence) {
  const invocation = payload.invocation && typeof payload.invocation === "object"
    ? payload.invocation
    : {};
  const input = invocation.arguments && typeof invocation.arguments === "object"
    ? invocation.arguments
    : {};
  const server = typeof invocation.server === "string" ? invocation.server : "unknown server";
  const tool = typeof invocation.tool === "string" ? invocation.tool : "unknown tool";
  const outcome = mcpOutcome(payload);
  const filePath = typeof input.file_path === "string" ? input.file_path : null;

  if (filePath) {
    return createSessionEvent({
      applied: outcome.failed === null ? null : !outcome.failed,
      atMs,
      files: [filePath],
      kind: SESSION_EVENT_KIND.EDIT,
      sequence,
    });
  }

  return createSessionEvent({
    atMs,
    command: typeof input.command === "string"
      ? input.command
      : `mcp: ${server}/${tool}`,
    error: outcome.error,
    failed: outcome.failed,
    kind: SESSION_EVENT_KIND.RAN,
    sequence,
    unclassified: false,
    workdir: typeof input.workdir === "string" ? input.workdir : null,
  });
}

function unmappedRecordType(recordValue) {
  const outerType = typeof recordValue.type === "string" ? recordValue.type : "missing record type";
  const payloadType = typeof recordValue.payload?.type === "string"
    ? recordValue.payload.type
    : "missing payload type";
  return `${outerType}:${payloadType}`;
}

function outputText(payload) {
  return contentText(payload.output ?? payload.content ?? payload.stderr ?? payload.stdout).trim() || null;
}

function emptyResult({ counted = false, cwd = null, origin = null, reason }) {
  return createSessionEventsResult({
    coverage: createSessionEventCoverage(),
    events: [],
    header: createSessionEventHeader({ cwd, origin, provider: PROVIDER_ID }),
    reason,
    // The reason the timeline is empty is the same reason there is no count:
    // no transcript to read. Saying so beats leaving the field to guess.
    tokens: counted ? { available: false, reason } : null,
    window: {
      complete: true,
      end: null,
      outcomesMayBeUnresolved: false,
    },
  });
}

async function findSessionRecord({ codexHome, id }) {
  const record = await getSessionRecord({ codexHome, id });
  if (record) return record;
  return (await loadSessionStore({ codexHome })).recordsById.get(id) ?? null;
}

export async function readSessionEvents({
  codexHome,
  id,
  limit,
  maxLineBytes,
  mode,
  signal,
  tokens = false,
}) {
  const record = await findSessionRecord({ codexHome, id });
  if (!record) return null;

  const origin = record.recordSource ?? null;
  if (!record.rolloutPath) {
    return emptyResult({
      counted: tokens,
      cwd: record.cwd || null,
      origin,
      reason: SESSION_EVENT_REASON.NO_TRANSCRIPT_PATH,
    });
  }

  // A preview stops as soon as it has enough events, so a count taken from it
  // would be of part of the file while reading as the whole.
  const tokenScan = tokens && mode !== SESSION_EVENT_READ_MODE.PREVIEW
    ? await createSessionTokenScan({ codexHome, maxLineBytes, record, signal })
    : null;

  const coverage = createSessionEventCoverage();
  const summary = createSessionEventSummary();
  const composition = createSessionEventComposition();
  const readState = createSessionEventReadState({ limit, mode });
  const unmappedTypes = createUnmappedSessionEventTracker();
  const duplicateTexts = createDuplicateTextTracker();
  let acceptingInjectedAsks = true;
  let header = createSessionEventHeader({
    cwd: record.cwd || null,
    origin,
    provider: PROVIDER_ID,
  });

  function addEvent(event, pendingId = null) {
    if (event.kind === SESSION_EVENT_KIND.ASK && !event.injected) summary.asks += 1;
    if (event.kind === SESSION_EVENT_KIND.EDIT) summary.edits += 1;
    if (event.kind === SESSION_EVENT_KIND.RAN) summary.commands += 1;
    return readState.add(event, { pendingId });
  }

  function toolEvent(payload, atMs, sequence) {
    const callId = payload.call_id ?? payload.id ?? null;
    const name = typeof payload.name === "string" ? payload.name : "unknown tool";

    if (name === "apply_patch") {
      const details = patchDetails(payload.input);
      return {
        event: createSessionEvent({
          ...details,
          atMs,
          kind: SESSION_EVENT_KIND.EDIT,
          sequence,
        }),
        pendingId: callId,
      };
    }

    const argumentsValue = toolArguments(payload);

    if (name === "request_user_input") {
      const question = Array.isArray(argumentsValue?.questions)
        ? argumentsValue.questions
          .map((item) => item?.question)
          .filter((item) => typeof item === "string")
          .join("\n")
        : "";
      return {
        event: createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.DECIDED,
          question: question || "Question",
          sequence,
        }),
        pendingId: callId,
      };
    }

    if (name === "update_plan") {
      const steps = Array.isArray(argumentsValue?.plan)
        ? argumentsValue.plan
          .filter((step) => typeof step?.step === "string" && typeof step?.status === "string")
          .map((step) => ({ status: step.status, text: step.step }))
        : [];
      return {
        event: createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.PLAN,
          sequence,
          steps,
        }),
        pendingId: null,
      };
    }

    const filePath = typeof argumentsValue?.file_path === "string"
      ? argumentsValue.file_path
      : null;
    if (filePath) {
      return {
        event: createSessionEvent({
          atMs,
          files: [filePath],
          kind: SESSION_EVENT_KIND.EDIT,
          sequence,
        }),
        pendingId: callId,
      };
    }

    const command = typeof argumentsValue?.cmd === "string"
      ? argumentsValue.cmd
      : typeof argumentsValue?.command === "string"
        ? argumentsValue.command
        : null;
    const execTool = name === "exec" || name === "exec_command";
    const nestedLabel = execTool ? nestedToolLabel(nestedToolName(payload.input)) : null;
    return {
      event: createSessionEvent({
        atMs,
        command: command ?? nestedLabel ?? (execTool ? null : name),
        kind: SESSION_EVENT_KIND.RAN,
        sequence,
        unclassified: command === null && (nestedLabel !== null || !execTool),
        unextracted: execTool && command === null && nestedLabel === null,
        workdir: typeof argumentsValue?.workdir === "string" ? argumentsValue.workdir : null,
      }),
      pendingId: callId,
    };
  }

  function handleRecord(recordValue, sequence) {
    const payload = recordValue.payload;
    const atMs = asTimestamp(recordValue.timestamp ?? payload?.timestamp);

    if (recordValue.type === "session_meta" && payload?.id) {
      const git = payload.git && typeof payload.git === "object" ? {
        branch: payload.git.branch ?? null,
        commit: payload.git.commit ?? payload.git.commit_hash ?? null,
        repository: payload.git.repository ?? payload.git.repository_url ?? null,
      } : null;
      header = createSessionEventHeader({
        cwd: payload.cwd ?? header.cwd,
        git,
        model: payload.model ?? header.model,
        origin: payload.originator ?? header.origin,
        provider: PROVIDER_ID,
        version: payload.cli_version ?? payload.version ?? null,
      });
      return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
    }

    if (recordValue.type === "turn_context") {
      header = createSessionEventHeader({
        cwd: payload?.cwd ?? header.cwd,
        git: header.git,
        model: payload?.model ?? header.model,
        origin: header.origin,
        provider: PROVIDER_ID,
        version: header.version,
      });
      return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
    }

    if (payload?.type === "message") {
      const text = contentText(payload.content);
      if (!["assistant", "user"].includes(payload.role)) {
        return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
      }
      if (!text) {
        return { classification: RECORD_CLASSIFICATION.UNPARSEABLE, stop: false };
      }

      const injected = payload.role === "user"
        && acceptingInjectedAsks
        && isInjectedSessionAsk(text);
      if (payload.role === "assistant" || !injected) acceptingInjectedAsks = false;

      const kind = payload.role === "user" ? SESSION_EVENT_KIND.ASK : SESSION_EVENT_KIND.SAID;
      if (duplicateTexts.isDuplicate(kind, text, sequence)) {
        return { classification: RECORD_CLASSIFICATION.SKIPPED, duplicate: true, stop: false };
      }

      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({ atMs, injected, kind, sequence, text })),
      };
    }

    if (payload?.type === "thread_settings_applied") {
      header = createSessionEventHeader({
        cwd: header.cwd,
        git: header.git,
        model: payload.thread_settings?.model ?? header.model,
        origin: header.origin,
        provider: PROVIDER_ID,
        version: header.version,
      });
      return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
    }

    if (payload?.type === "web_search_end") {
      const query = typeof payload.query === "string" ? payload.query : null;
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({
          atMs,
          command: query ? `web search: ${query}` : "web search",
          kind: SESSION_EVENT_KIND.RAN,
          sequence,
        })),
      };
    }

    if (payload?.type === "task_complete" || payload?.type === "agent_message" || payload?.type === "user_message") {
      const text = contentText(
        payload.last_agent_message ?? payload.message ?? payload.text ?? payload.content,
      );
      if (!text) {
        return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
      }

      const kind = payload.type === "user_message"
        ? SESSION_EVENT_KIND.ASK
        : SESSION_EVENT_KIND.SAID;
      if (duplicateTexts.isDuplicate(kind, text, sequence)) {
        return { classification: RECORD_CLASSIFICATION.SKIPPED, duplicate: true, stop: false };
      }

      const injected = kind === SESSION_EVENT_KIND.ASK
        && acceptingInjectedAsks
        && isInjectedSessionAsk(text);
      if (kind === SESSION_EVENT_KIND.SAID || !injected) acceptingInjectedAsks = false;

      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({ atMs, injected, kind, sequence, text })),
      };
    }

    if (recordValue.type === "compacted" || payload?.type === "compacted") {
      acceptingInjectedAsks = false;
      const text = contentText(
        payload.content
          ?? payload.message
          ?? payload.summary
          ?? payload.replacement_history,
      );
      if (!text) {
        return { classification: RECORD_CLASSIFICATION.UNPARSEABLE, stop: false };
      }
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.SUMMARY,
          sequence,
          text,
        })),
      };
    }

    if (payload?.type === "context_compacted") {
      acceptingInjectedAsks = false;
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.SUMMARY,
          sequence,
          text: "Earlier context was compacted.",
        })),
      };
    }

    if (payload?.type === "thread_rolled_back") {
      const turns = Number(payload.num_turns);
      const turnLabel = turns === 1 ? "turn" : "turns";
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.SUMMARY,
          sequence,
          text: Number.isFinite(turns) && turns > 0
            ? `Conversation rewound by ${turns} ${turnLabel}.`
            : "Conversation was rewound.",
        })),
      };
    }

    if (payload?.type === "turn_aborted") {
      const reason = typeof payload.reason === "string"
        ? payload.reason.replaceAll("_", " ").trim()
        : "";
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.SUMMARY,
          sequence,
          text: reason ? `Turn stopped: ${reason}.` : "Turn stopped before completion.",
        })),
      };
    }

    if (payload?.type === "custom_tool_call" || payload?.type === "function_call") {
      acceptingInjectedAsks = false;
      const nestedName = ["exec", "exec_command"].includes(payload.name)
        ? nestedToolName(payload.input)
        : null;
      if (nestedName === "apply_patch" && toolArguments(payload).cmd === null) {
        return { classification: RECORD_CLASSIFICATION.RECOGNIZED, stop: false };
      }
      const { event, pendingId } = toolEvent(payload, atMs, sequence);
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(event, pendingId),
      };
    }

    if (payload?.type === "patch_apply_begin") {
      acceptingInjectedAsks = false;
      const files = changePaths(payload.changes);
      const resolved = readState.resolve(payload.call_id, (event) => {
        if (event.kind === SESSION_EVENT_KIND.EDIT && files.length > 0) {
          event.files = files;
        }
      }, { consume: false });

      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: resolved
          ? false
          : addEvent(createSessionEvent({
            added: null,
            applied: null,
            atMs,
            files,
            kind: SESSION_EVENT_KIND.EDIT,
            removed: null,
            sequence,
          }), payload.call_id),
      };
    }

    if (payload?.type === "patch_apply_end") {
      acceptingInjectedAsks = false;
      const details = patchResultDetails(payload);
      const resolved = readState.resolve(payload.call_id, (event) => {
        if (event.kind !== SESSION_EVENT_KIND.EDIT) return;
        event.applied = details.applied;
        if (details.files.length > 0) event.files = details.files;
      });
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: resolved
          ? false
          : addEvent(createSessionEvent({
            ...details,
            atMs,
            kind: SESSION_EVENT_KIND.EDIT,
            sequence,
          })),
      };
    }

    if (payload?.type === "mcp_tool_call_end") {
      acceptingInjectedAsks = false;
      return {
        classification: RECORD_CLASSIFICATION.RECOGNIZED,
        stop: addEvent(mcpToolEvent(payload, atMs, sequence)),
      };
    }

    if (
      payload?.type === "custom_tool_call_output"
      || payload?.type === "function_call_output"
    ) {
      const failed = commandFailure(payload);
      const error = failed ? outputText(payload) : null;
      readState.resolve(payload.call_id, (event) => {
        if (event.kind === SESSION_EVENT_KIND.DECIDED) {
          event.answer = outputText(payload);
        } else if (event.kind === SESSION_EVENT_KIND.EDIT && failed !== null) {
          event.applied = !failed;
        } else if (event.kind === SESSION_EVENT_KIND.RAN && failed !== null) {
          event.error = error;
          event.failed = failed;
        }
      });
      return { classification: RECORD_CLASSIFICATION.RECOGNIZED, stop: false };
    }

    if (
      SKIPPED_RECORD_TYPES.has(recordValue.type)
      || SKIPPED_PAYLOAD_TYPES.has(payload?.type)
    ) {
      return { classification: RECORD_CLASSIFICATION.SKIPPED, stop: false };
    }

    if (typeof recordValue.type !== "string" && typeof payload?.type !== "string") {
      return { classification: RECORD_CLASSIFICATION.UNPARSEABLE, stop: false };
    }

    return {
      classification: RECORD_CLASSIFICATION.UNMAPPED,
      stop: false,
      unmappedType: unmappedRecordType(recordValue),
    };
  }

  let read;

  try {
    read = await visitJsonlSnapshotEntries(
      record.rolloutPath,
      (entry) => {
        if (signal?.aborted) return false;
        coverage.total += 1;

        if (entry.oversized) {
          coverage.oversized += 1;
          composition.largeRecords += entry.bytes;
          return true;
        }

        if (!entry.parsed || typeof entry.parsed !== "object") {
          coverage.unparseable += 1;
          composition.other += entry.bytes;
          return true;
        }

        composition[compositionSegment(entry.parsed)] += entry.bytes;
        tokenScan?.record(entry.parsed);
        const result = handleRecord(entry.parsed, entry.index);
        coverage[result.classification] += 1;
        if (result.duplicate) coverage.duplicates += 1;
        if (result.classification === RECORD_CLASSIFICATION.UNMAPPED) {
          unmappedTypes.add(result.unmappedType);
        }
        return !result.stop;
      },
      { maxLineBytes },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyResult({
        counted: tokens,
        cwd: record.cwd || null,
        origin,
        reason: SESSION_EVENT_REASON.TRANSCRIPT_MISSING,
      });
    }

    throw error;
  }

  const events = readState.values();
  coverage.unmappedTypes = unmappedTypes.values();
  return createSessionEventsResult({
    coverage,
    events,
    header,
    reason: events.length === 0 && read.complete
      ? SESSION_EVENT_REASON.NO_RECOGNIZED_EVENTS
      : null,
    composition: finalizeSessionEventComposition(composition, read.snapshotBytes),
    summary,
    tokens: tokenScan ? tokenScan.summarize(read) : null,
    window: readState.window(read),
  });
}
