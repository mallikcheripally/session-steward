import { addTokenTotals, createTokenTotals, summarizeSessionTokens } from "../../session-tokens.mjs";
import { readCachedTokens, readFileStamp, writeCachedTokens } from "../../session-token-cache.mjs";
import { visitJsonlSnapshotEntries } from "../../storage/jsonl.mjs";
import { getSessionRecord } from "./store.mjs";

const SYNTHETIC_MODEL = "<synthetic>";

// Claude Code reports usage per request rather than as a running total, so there
// is no counter to reconcile. The catch is the opposite one: a single response is
// written as several records, one per content block, and every copy repeats the
// same usage in full. Summing records instead of requests inflates a session by
// roughly 2.3x.
function readCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Anthropic reports cached tokens *beside* the input count, where Codex reports
// them inside it. `input_tokens` is already the uncached remainder, so nothing is
// subtracted here — doing so is what would drive the fresh-input slice negative.
function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;

  const cachedInput = readCount(value.cache_read_input_tokens);
  const cacheWrites = readCount(value.cache_creation_input_tokens);
  const freshInput = readCount(value.input_tokens);
  const output = readCount(value.output_tokens);

  return {
    cachedInput,
    cacheWrites,
    freshInput,
    output,
    // Claude Code does not report a reasoning figure; thinking is billed as
    // ordinary output and cannot be separated from it.
    reasoning: 0,
    total: cachedInput + cacheWrites + freshInput + output,
  };
}

export function createClaudeTokenCollector() {
  // One entry per request, not per record. Repeats collapse onto the largest
  // copy: a retried or superseded write reports zeros, and a streaming partial
  // reports less than the finished response.
  const requests = new Map();
  let compactions = 0;
  let observedRecords = 0;
  let sessionId = null;
  let sidechainRequests = 0;
  let syntheticRecords = 0;

  return {
    record(recordValue) {
      if (!recordValue || typeof recordValue !== "object") return;

      if (recordValue.subtype === "compact_boundary") compactions += 1;
      if (sessionId === null && typeof recordValue.sessionId === "string") {
        sessionId = recordValue.sessionId;
      }

      const message = recordValue.message;
      if (!message || typeof message !== "object") return;

      const usage = normalizeUsage(message.usage);
      if (!usage) return;
      observedRecords += 1;

      // Synthetic entries stand in for locally generated messages. They carry no
      // usage and no request id, and would otherwise open a model row of zeros.
      if (message.model === SYNTHETIC_MODEL) {
        syntheticRecords += 1;
        return;
      }

      const key = recordValue.requestId ?? message.id;
      if (typeof key !== "string") return;

      const previous = requests.get(key);
      if (previous && previous.usage.total >= usage.total) return;
      if (!previous && recordValue.isSidechain) sidechainRequests += 1;

      requests.set(key, { model: message.model ?? "Unknown", sidechain: Boolean(recordValue.isSidechain), usage });
    },

    result() {
      const totals = createTokenTotals();
      const modelTotals = new Map();

      for (const { model, usage } of requests.values()) {
        addTokenTotals(totals, usage);
        if (!modelTotals.has(model)) modelTotals.set(model, createTokenTotals());
        addTokenTotals(modelTotals.get(model), usage);
      }

      return {
        available: requests.size > 0,
        byModel: [...modelTotals]
          .map(([model, modelSpend]) => ({ model, totals: modelSpend }))
          .sort((left, right) => right.totals.total - left.totals.total),
        cacheWriteUnderflow: false,
        compactions,
        countedRequests: requests.size,
        observedRecords,
        sessionId,
        sidechainRequests,
        syntheticRecords,
        totals,
      };
    },
  };
}

export async function collectClaudeSessionTokens(filePath, { maxLineBytes, signal } = {}) {
  const collector = createClaudeTokenCollector();
  const { complete, snapshotBytes } = await visitJsonlSnapshotEntries(
    filePath,
    ({ parsed }) => {
      // A closed panel should not leave a large transcript being scanned.
      if (signal?.aborted) return false;
      if (parsed && typeof parsed === "object") collector.record(parsed);
      return true;
    },
    maxLineBytes === undefined ? {} : { maxLineBytes },
  );

  return { ...collector.result(), complete, snapshotBytes };
}

// Reading the timeline already streams every record of the same file, so the
// count rides along with that pass instead of paying for a second one.
export async function createSessionTokenScan({ record, signal }) {
  if (!record?.rolloutPath) return null;
  const stamp = await readFileStamp(record.rolloutPath);
  const cached = readCachedTokens("summary", record.rolloutPath, stamp);
  if (cached !== undefined) return { cached, record() {}, summarize: () => cached };

  const collector = createClaudeTokenCollector();

  return {
    cached: null,
    record(value) {
      collector.record(value);
    },
    summarize({ complete }) {
      const summary = summarizeSessionTokens({ ...collector.result(), complete });
      if (signal?.aborted || complete === false) return summary;
      return writeCachedTokens("summary", record.rolloutPath, stamp, summary);
    },
  };
}

export async function readSessionTokens({ claudeHome, desktopDataHome, id, maxLineBytes, signal }) {
  const record = await getSessionRecord({ claudeHome, desktopDataHome, id });
  if (!record) return null;
  if (!record.rolloutPath) return { available: false, reason: "no-transcript-path" };

  const stamp = await readFileStamp(record.rolloutPath);
  const cached = readCachedTokens("summary", record.rolloutPath, stamp);
  if (cached !== undefined) return cached;

  let collected;
  try {
    collected = await collectClaudeSessionTokens(record.rolloutPath, { maxLineBytes, signal });
  } catch (error) {
    // A transcript can be deleted between the listing and the read. That is an
    // answer about the session, not a failure of the server, and the timeline
    // reader already treats it as one.
    if (error?.code === "ENOENT") return { available: false, reason: "transcript-missing" };
    throw error;
  }

  const summary = summarizeSessionTokens(collected);
  if (signal?.aborted || collected.complete === false) return summary;
  return writeCachedTokens("summary", record.rolloutPath, stamp, summary);
}
