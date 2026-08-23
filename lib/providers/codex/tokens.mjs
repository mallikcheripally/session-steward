import { addTokenTotals, createTokenTotals, summarizeSessionTokens } from "../../session-tokens.mjs";
import { readCachedTokens, readFileStamp, signatureBytes, writeCachedTokens } from "../../session-token-cache.mjs";
import { visitJsonlSnapshotEntries } from "../../storage/jsonl.mjs";
import { getSessionRecord, loadSessionStore } from "./store.mjs";

const PAYLOAD_TYPE = "token_count";

// Codex reports a running total plus the cost of the turn that produced it. The
// running total is not a session total: subagents inherit the parent thread's
// counter, resume restarts it, and the same figures are re-emitted when nothing
// advanced. Only `last_token_usage` on an event whose running total *moved* is a
// turn that belongs to this session.
function readCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Codex counts cached tokens inside `input_tokens`; whether cache writes are
// also inside it is unconfirmed, because the field is zero everywhere we can
// observe. Subtracting assumes they are. The clamp keeps a wrong assumption from
// reaching the UI as a negative slice, and reports itself so it can be fixed
// from evidence rather than replaced with a second guess.
function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;

  const input = readCount(value.input_tokens);
  const cachedInput = readCount(value.cached_input_tokens);
  const cacheWrites = readCount(value.cache_write_input_tokens);
  const output = readCount(value.output_tokens);
  const underflows = input - cachedInput - cacheWrites < 0;
  const freshInput = Math.max(0, underflows ? input - cachedInput : input - cachedInput - cacheWrites);
  // The bar is drawn from these four segments, so the total has to be their sum
  // or the slices add up to more than the whole. Codex's own `total_tokens`
  // agrees on every billable event in the corpus (53,685 of 53,685), but it
  // cannot agree once the clamp above has moved a token, and the clamp exists
  // precisely because that case is unobserved rather than impossible.
  const total = freshInput + cachedInput + cacheWrites + output;

  return {
    // A turn with no input and no output has nothing to bill, whatever its
    // reported total says.
    billable: total > 0,
    cachedInput,
    cacheWrites,
    freshInput,
    output,
    // Reasoning is part of output, never alongside it.
    reasoning: Math.min(output, readCount(value.reasoning_output_tokens)),
    // Codex advances its running counter by its own arithmetic, past events that
    // report no components at all. Whether the counter moved is a question about
    // its figure, so that figure is kept rather than recomputed.
    reportedTotal: readCount(value.total_tokens),
    total,
    underflows,
  };
}

function readModel(recordValue, payload) {
  if (recordValue.type === "session_meta") return payload?.model ?? null;
  if (recordValue.type === "turn_context") return payload?.model ?? recordValue.model ?? null;
  if (payload?.type === "thread_settings_applied") return payload.thread_settings?.model ?? null;
  return null;
}

function isSubagentSource(source) {
  return Boolean(source) && typeof source === "object" && "subagent" in source;
}

// A turn is identified by two numbers: the counter it advanced to, and what it
// cost. `signatures` records those as plain number arrays — 16 bytes a turn,
// where the turn objects they replace cost 179 — and `prefix` plays a parent's
// recording back against a fork as the fork streams, so the fork retains nothing
// at all. Neither is on by default; a plain session needs neither.
export function createCodexTokenCollector({ prefix = null, signatures = false } = {}) {
  const totals = createTokenTotals();
  const modelTotals = new Map();
  const inherited = prefix ? createTokenTotals() : null;
  const own = prefix ? createTokenTotals() : null;
  const ownModels = prefix ? new Map() : null;
  const runningTotals = signatures ? [] : null;
  const turnTotals = signatures ? [] : null;
  let cacheWriteUnderflow = false;
  let countedTurns = 0;
  let forkedFromId = null;
  let inheritedTurns = 0;
  let matchingPrefix = Boolean(prefix);
  let model = null;
  let observedEvents = 0;
  let previousRunningTotal = null;
  let sessionId = null;
  let subagent = false;

  function countTurn(usage, runningTotal) {
    countedTurns += 1;
    if (usage.underflows) cacheWriteUnderflow = true;
    addTokenTotals(totals, usage);

    const key = model ?? "Unknown";
    if (!modelTotals.has(key)) modelTotals.set(key, createTokenTotals());
    addTokenTotals(modelTotals.get(key), usage);

    if (signatures) {
      runningTotals.push(runningTotal);
      turnTotals.push(usage.total);
    }

    if (!prefix) return;

    // The replay is a leading run, so the first turn that fails to match ends
    // it. Everything from there on is this session's own work.
    if (matchingPrefix) {
      if (
        inheritedTurns < prefix.runningTotals.length
        && prefix.runningTotals[inheritedTurns] === runningTotal
        && prefix.turnTotals[inheritedTurns] === usage.total
      ) {
        inheritedTurns += 1;
        addTokenTotals(inherited, usage);
        return;
      }

      matchingPrefix = false;
    }

    addTokenTotals(own, usage);
    if (!ownModels.has(key)) ownModels.set(key, createTokenTotals());
    addTokenTotals(ownModels.get(key), usage);
  }

  return {
    record(recordValue) {
      if (!recordValue || typeof recordValue !== "object") return;
      const payload = recordValue.payload && typeof recordValue.payload === "object"
        ? recordValue.payload
        : null;

      if (recordValue.type === "session_meta" && payload && sessionId === null) {
        sessionId = payload.id ?? null;
        forkedFromId = payload.forked_from_id ?? null;
        subagent = isSubagentSource(payload.source);
      }

      const nextModel = readModel(recordValue, payload);
      if (nextModel) model = nextModel;

      if (payload?.type !== PAYLOAD_TYPE) return;
      observedEvents += 1;

      // `info` is absent on some builds; the event carries nothing to bill.
      const info = payload.info;
      if (!info || typeof info !== "object") return;

      const running = normalizeUsage(info.total_token_usage);
      const turn = normalizeUsage(info.last_token_usage);
      if (!running || !turn) return;

      // Unchanged running total means the event was re-emitted, or carries
      // context-size telemetry rather than a billed turn. Either way it is not
      // new spend. A *decrease* is a resume resetting the counter, which is.
      if (previousRunningTotal !== null && running.reportedTotal === previousRunningTotal) return;

      previousRunningTotal = running.reportedTotal;

      // Exceeding the context window makes Codex advance the running total to a
      // synthetic figure while reporting a turn with no components. The advance
      // is real bookkeeping; the turn behind it is not spend.
      if (!turn.billable) return;

      countTurn(turn, running.reportedTotal);
    },

    result() {
      return {
        available: countedTurns > 0,
        byModel: [...modelTotals]
          .map(([name, modelSpend]) => ({ model: name, totals: modelSpend }))
          .sort((left, right) => right.totals.total - left.totals.total),
        cacheWriteUnderflow,
        countedTurns,
        fork: prefix
          ? {
            inherited,
            inheritedTurns,
            own,
            ownByModel: [...ownModels]
              .map(([name, modelSpend]) => ({ model: name, totals: modelSpend }))
              .sort((left, right) => right.totals.total - left.totals.total),
            ownTurns: countedTurns - inheritedTurns,
            parentAvailable: true,
          }
          : null,
        forkedFromId,
        observedEvents,
        sessionId,
        signatures: signatures ? { runningTotals, turnTotals } : null,
        subagent,
        totals,
      };
    },
  };
}

export async function collectCodexSessionTokens(filePath, { maxLineBytes, prefix, signatures, signal } = {}) {
  const collector = createCodexTokenCollector({ prefix, signatures });
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

// A fork's rollout replays the parent's turns before its own, so the two files
// share a leading run of identical turns. Everything after that run is this
// session's own work; the run itself was already billed to the parent and must
// not be counted twice, in a rollup or on the session's own panel.
//
// There is no marker for the boundary inside the fork file. Anchoring at the
// last `session_meta` locates it 3 times in 44; a timestamp-gap test manages 40
// in 44, failing on the subagents that matter most. Comparing against the parent
// is the only exact method — so the parent is read first, and the fork is split
// as it streams rather than buffered and diffed afterwards.
async function findSessionRecord({ codexHome, id }) {
  const record = await getSessionRecord({ codexHome, id });
  if (record) return record;
  return (await loadSessionStore({ codexHome })).recordsById.get(id) ?? null;
}

// A transcript can be deleted between the listing and the read. That is an
// answer about the session, not a failure of the server, and the timeline
// reader already treats it as one.
async function collectOrMissing(filePath, options) {
  try {
    return await collectCodexSessionTokens(filePath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// The parent is read only to locate the end of the replay, so its signatures
// are cached: a fork reopened, or several forks of one parent, read it once.
async function readParentSignatures({ codexHome, id, maxLineBytes, signal }) {
  const record = await findSessionRecord({ codexHome, id });
  if (!record?.rolloutPath) return null;

  const stamp = await readFileStamp(record.rolloutPath);
  const cached = readCachedTokens("signatures", record.rolloutPath, stamp);
  if (cached !== undefined) return cached;

  const parent = await collectOrMissing(record.rolloutPath, { maxLineBytes, signatures: true, signal });
  const signatures = parent?.signatures ?? null;
  if (signal?.aborted || parent?.complete === false) return signatures;
  return writeCachedTokens("signatures", record.rolloutPath, stamp, signatures, signatureBytes(signatures));
}

function summarizeCollected(collected) {
  return summarizeSessionTokens(collected, {
    fork: collected.fork,
    // The file itself is the authority on whether this is a fork. If it says so
    // and no parent was read, the total still carries the replay.
    forkParentMissing: Boolean(collected.forkedFromId) && !collected.fork,
  });
}

// Reading the timeline already streams every record of the same file, so the
// count rides along with that pass instead of paying for a second one. The
// parent, when there is one, still has to be read first — and is cached.
export async function createSessionTokenScan({ codexHome, maxLineBytes, record, signal }) {
  if (!record?.rolloutPath) return null;
  const stamp = await readFileStamp(record.rolloutPath);
  const cached = readCachedTokens("summary", record.rolloutPath, stamp);
  if (cached !== undefined) return { cached, record() {}, summarize: () => cached };

  const prefix = record.forkedFromId
    ? await readParentSignatures({ codexHome, id: record.forkedFromId, maxLineBytes, signal })
    : null;
  const collector = createCodexTokenCollector({ prefix });

  return {
    cached: null,
    record(value) {
      collector.record(value);
    },
    summarize({ complete }) {
      const summary = summarizeCollected({ ...collector.result(), complete });
      if (signal?.aborted || complete === false) return summary;
      return writeCachedTokens("summary", record.rolloutPath, stamp, summary);
    },
  };
}

export async function readSessionTokens({ codexHome, id, maxLineBytes, signal }) {
  const record = await findSessionRecord({ codexHome, id });
  if (!record) return null;
  if (!record.rolloutPath) return { available: false, reason: "no-transcript-path" };

  const stamp = await readFileStamp(record.rolloutPath);
  const cached = readCachedTokens("summary", record.rolloutPath, stamp);
  if (cached !== undefined) return cached;

  const prefix = record.forkedFromId
    ? await readParentSignatures({ codexHome, id: record.forkedFromId, maxLineBytes, signal })
    : null;

  const collected = await collectOrMissing(record.rolloutPath, { maxLineBytes, prefix, signal });
  if (!collected) return { available: false, reason: "transcript-missing" };

  const summary = summarizeCollected(collected);
  if (signal?.aborted || collected.complete === false) return summary;
  return writeCachedTokens("summary", record.rolloutPath, stamp, summary);
}
