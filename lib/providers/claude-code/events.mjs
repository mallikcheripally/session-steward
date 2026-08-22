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
import { getSessionRecord } from "./store.mjs";
import { createSessionTokenScan } from "./tokens.mjs";

const MAX_PENDING_DECISIONS = 2_048;
const PROVIDER_ID = "claude-code";
const READ_ONLY_TOOLS = new Set(["Glob", "Grep", "Read", "WebFetch", "WebSearch"]);
const RECORD_CLASSIFICATION = Object.freeze({
  RECOGNIZED: "recognized",
  SKIPPED: "skipped",
  UNMAPPED: "unmapped",
  UNPARSEABLE: "unparseable",
});
const SKIPPED_CONTENT_TYPES = new Set(["attachment", "image", "thinking"]);
const SKIPPED_RECORD_TYPES = new Set([
  "attachment",
  "custom-title",
  "file-history-snapshot",
  "frame-link",
  "last-prompt",
  "mode",
  "queue-operation",
  "summary",
  "system",
]);

const COMPOSITION_EDIT_TOOLS = new Set(["Edit", "NotebookEdit", "Write"]);

function compositionSegment(parsed) {
  const type = typeof parsed?.type === "string" ? parsed.type : "";
  if (type === "attachment") return "attachments";
  if (type !== "assistant" && type !== "user") return "other";

  const content = parsed.message?.content;
  if (typeof content === "string") return "messages";
  if (!Array.isArray(content)) return "other";

  let hasEdit = false;
  let hasImage = false;
  let hasText = false;
  let hasThinking = false;
  let hasToolResult = false;
  let hasToolUse = false;

  for (const part of content) {
    if (part?.type === "tool_result") hasToolResult = true;
    else if (part?.type === "image") hasImage = true;
    else if (part?.type === "thinking") hasThinking = true;
    else if (part?.type === "text") hasText = true;
    else if (part?.type === "tool_use") {
      hasToolUse = true;
      if (COMPOSITION_EDIT_TOOLS.has(part.name)) hasEdit = true;
    }
  }

  if (hasToolResult) return "toolOutput";
  if (hasImage) return "attachments";
  if (hasThinking) return "reasoning";
  if (hasToolUse) return hasEdit ? "edits" : "toolOutput";
  return hasText ? "messages" : "other";
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
  return "";
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

function messageParts(record) {
  const content = record.message?.content;
  if (typeof content === "string") return [{ text: content, type: "text" }];
  return Array.isArray(content) ? content : [];
}

function planSteps(input) {
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return todos
    .filter((todo) => typeof todo?.status === "string")
    .map((todo) => ({
      status: todo.status,
      text: typeof todo.content === "string"
        ? todo.content
        : typeof todo.activeForm === "string"
          ? todo.activeForm
          : "Untitled task",
    }));
}

function questionText(input) {
  if (typeof input?.question === "string") return input.question;
  if (!Array.isArray(input?.questions)) return "Question";
  return input.questions
    .map((question) => question?.question)
    .filter((question) => typeof question === "string")
    .join("\n") || "Question";
}

export async function readSessionEvents({
  claudeHome,
  desktopDataHome,
  id,
  limit,
  maxLineBytes,
  mode,
  signal,
  tokens = false,
}) {
  const record = await getSessionRecord({ claudeHome, desktopDataHome, id });
  if (!record) return null;

  const origin = record.surface ?? record.recordSource ?? null;
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
    ? await createSessionTokenScan({ record, signal })
    : null;

  const coverage = createSessionEventCoverage();
  const summary = createSessionEventSummary();
  const composition = createSessionEventComposition();
  const pendingDecisionIds = [];
  const readState = createSessionEventReadState({ limit, mode });
  const unmappedTypes = createUnmappedSessionEventTracker();
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

  function rememberDecision(pendingId) {
    if (!pendingId) return;
    pendingDecisionIds.push(pendingId);
    if (pendingDecisionIds.length > MAX_PENDING_DECISIONS) pendingDecisionIds.shift();
  }

  function resolveDecision(answer) {
    while (pendingDecisionIds.length > 0) {
      const pendingId = pendingDecisionIds.shift();
      if (readState.resolve(pendingId, (event) => {
        if (event.kind === SESSION_EVENT_KIND.DECIDED) event.answer = answer;
      })) return true;
    }

    return false;
  }

  function toolEvent(part, atMs, sequence) {
    const input = part.input && typeof part.input === "object" ? part.input : {};
    const name = typeof part.name === "string" ? part.name : "unknown tool";
    const pendingId = typeof part.id === "string" ? part.id : null;

    if (name === "Edit" || name === "Write") {
      return {
        event: createSessionEvent({
          atMs,
          files: typeof input.file_path === "string" ? [input.file_path] : [],
          kind: SESSION_EVENT_KIND.EDIT,
          sequence,
        }),
        pendingId,
      };
    }

    if (name === "Bash") {
      return {
        event: createSessionEvent({
          atMs,
          command: typeof input.command === "string" ? input.command : null,
          kind: SESSION_EVENT_KIND.RAN,
          sequence,
          workdir: typeof input.workdir === "string" ? input.workdir : record.cwd || null,
        }),
        pendingId,
      };
    }

    if (name === "AskUserQuestion") {
      return {
        decision: true,
        event: createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.DECIDED,
          question: questionText(input),
          sequence,
        }),
        pendingId,
      };
    }

    if (name === "TodoWrite") {
      return {
        event: createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.PLAN,
          sequence,
          steps: planSteps(input),
        }),
        pendingId: null,
      };
    }

    if (!READ_ONLY_TOOLS.has(name) && typeof input.file_path === "string") {
      return {
        event: createSessionEvent({
          atMs,
          files: [input.file_path],
          kind: SESSION_EVENT_KIND.EDIT,
          sequence,
        }),
        pendingId,
      };
    }

    if (typeof input.command === "string") {
      return {
        event: createSessionEvent({
          atMs,
          command: input.command,
          kind: SESSION_EVENT_KIND.RAN,
          sequence,
          workdir: typeof input.workdir === "string" ? input.workdir : record.cwd || null,
        }),
        pendingId,
      };
    }

    return {
      event: createSessionEvent({
        atMs,
        command: name,
        kind: SESSION_EVENT_KIND.RAN,
        sequence,
        unclassified: true,
        workdir: record.cwd || null,
      }),
      pendingId,
    };
  }

  function resolveToolResult(part) {
    const pendingId = part.tool_use_id;
    const answer = contentText(part.content).trim();
    const failed = part.is_error === true;
    return readState.resolve(pendingId, (event) => {
      if (event.kind === SESSION_EVENT_KIND.DECIDED) {
        event.answer = answer || null;
      } else if (event.kind === SESSION_EVENT_KIND.EDIT) {
        event.applied = !failed;
      } else if (event.kind === SESSION_EVENT_KIND.RAN) {
        event.error = failed ? answer || "Tool failed." : null;
        event.failed = failed;
      }
    });
  }

  function updateHeader(recordValue) {
    const branch = recordValue.gitBranch ?? recordValue.git?.branch ?? header.git?.branch ?? null;
    const commit = recordValue.git?.commit ?? recordValue.git?.commit_hash ?? header.git?.commit ?? null;
    const repository = recordValue.git?.repository
      ?? recordValue.git?.repository_url
      ?? header.git?.repository
      ?? null;
    const hasGit = branch !== null || commit !== null || repository !== null;
    header = createSessionEventHeader({
      cwd: recordValue.cwd ?? header.cwd,
      git: hasGit ? { branch, commit, repository } : null,
      model: recordValue.message?.model ?? recordValue.model ?? header.model,
      origin: recordValue.entrypoint ?? header.origin,
      provider: PROVIDER_ID,
      version: recordValue.version ?? header.version,
    });
  }

  function handleRecord(recordValue, sequence) {
    updateHeader(recordValue);
    const atMs = asTimestamp(recordValue.timestamp ?? recordValue.createdAt);
    const parts = messageParts(recordValue);

    if (recordValue.type === "user") {
      if (recordValue.isCompactSummary === true) {
        acceptingInjectedAsks = false;
        const text = contentText(recordValue.message?.content);
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

      let recognized = false;
      let resolvedDecision = false;
      let unparseable = parts.length === 0;
      let unmappedType = null;

      for (const part of parts) {
        if (typeof part?.type !== "string") {
          unparseable = true;
          continue;
        }
        if (part?.type === "text" && typeof part.text === "string") continue;
        if (part?.type !== "tool_result") {
          if (!SKIPPED_CONTENT_TYPES.has(part?.type)) {
            unmappedType = `user:${part?.type ?? "missing content type"}`;
          }
          continue;
        }
        const resolved = resolveToolResult(part);
        if (part.is_error === true) recognized = true;
        if (part.is_error === true && !resolved) unparseable = true;
      }

      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");

      if (text) {
        resolvedDecision = resolveDecision(text);
        recognized = true;
        if (resolvedDecision) acceptingInjectedAsks = false;
        if (!resolvedDecision) {
          const injected = acceptingInjectedAsks && isInjectedSessionAsk(text);
          if (!injected) acceptingInjectedAsks = false;
          return {
            classification: unmappedType
              ? RECORD_CLASSIFICATION.UNMAPPED
              : unparseable
                ? RECORD_CLASSIFICATION.UNPARSEABLE
                : RECORD_CLASSIFICATION.RECOGNIZED,
            stop: addEvent(createSessionEvent({
              atMs,
              injected,
              kind: SESSION_EVENT_KIND.ASK,
              sequence,
              text,
            })),
            unmappedType,
          };
        }
      }

      return {
        classification: unmappedType
          ? RECORD_CLASSIFICATION.UNMAPPED
          : unparseable
            ? RECORD_CLASSIFICATION.UNPARSEABLE
            : recognized
              ? RECORD_CLASSIFICATION.RECOGNIZED
              : RECORD_CLASSIFICATION.SKIPPED,
        stop: false,
        unmappedType,
      };
    }

    if (recordValue.type === "assistant") {
      acceptingInjectedAsks = false;
      let recognized = false;
      let stop = false;
      const unparseable = parts.length === 0 || parts.some((part) => (
        typeof part?.type !== "string"
          || (part.type === "text" && typeof part.text !== "string")
      ));
      const unmappedPart = parts.find((part) => (
        typeof part?.type === "string"
          && part.type !== "text"
          && part?.type !== "tool_use"
          && !SKIPPED_CONTENT_TYPES.has(part?.type)
      ));
      const unmappedType = unmappedPart
        ? `assistant:${unmappedPart?.type ?? "missing content type"}`
        : null;
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");

      if (text) {
        recognized = true;
        stop = addEvent(createSessionEvent({
          atMs,
          kind: SESSION_EVENT_KIND.SAID,
          sequence,
          text,
        }));
      }

      if (!stop) {
        for (const part of parts) {
          if (part?.type === "text" && typeof part.text === "string") continue;
          if (part?.type !== "tool_use") {
            continue;
          }
          const result = toolEvent(part, atMs, sequence);
          recognized = true;
          stop = addEvent(result.event, result.pendingId);
          if (result.decision) rememberDecision(result.pendingId);
          if (stop) break;
        }
      }

      return {
        classification: unmappedType
          ? RECORD_CLASSIFICATION.UNMAPPED
          : unparseable
            ? RECORD_CLASSIFICATION.UNPARSEABLE
            : recognized
              ? RECORD_CLASSIFICATION.RECOGNIZED
              : RECORD_CLASSIFICATION.SKIPPED,
        stop,
        unmappedType,
      };
    }

    if (typeof recordValue.type !== "string") {
      return { classification: RECORD_CLASSIFICATION.UNPARSEABLE, stop: false };
    }

    return {
      classification: SKIPPED_RECORD_TYPES.has(recordValue.type)
        ? RECORD_CLASSIFICATION.SKIPPED
        : RECORD_CLASSIFICATION.UNMAPPED,
      stop: false,
      unmappedType: `claude:${recordValue.type ?? "missing record type"}`,
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
