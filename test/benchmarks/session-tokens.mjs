import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { collectClaudeSessionTokens, createClaudeTokenCollector } from "../../lib/providers/claude-code/tokens.mjs";
import { collectCodexSessionTokens, createCodexTokenCollector } from "../../lib/providers/codex/tokens.mjs";
import { visitJsonlSnapshotEntries } from "../../lib/storage/jsonl.mjs";

// Deliberately a worst case: nearly every line here is a token event, where a
// real transcript is mostly message content. Throughput therefore reads lower
// than a scan of real sessions — this measures the parse path under load, not a
// typical rate.
const CODEX_SESSIONS = 2_000;
const CLAUDE_SESSIONS = 500;
const TURNS_PER_SESSION = 40;
// Every response is written once per content block, which is the duplication the
// Claude collector exists to undo.
const RECORDS_PER_REQUEST = 3;
// The many-small-sessions corpus above says nothing about one enormous session,
// which is where per-entry retention actually shows up: Codex holds a signature
// per turn to split a fork, Claude holds a map entry per request to dedupe. Both
// grow with the transcript, so both get a ceiling here rather than a promise.
const LONG_SESSION_TURNS = 200_000;
// Measured at 4.0 MB and 59.2 MB. The ceilings sit close enough that a change
// in what either collector retains fails here instead of shipping.
const LONG_SESSION_CODEX_HEAP_MB = 8;
const LONG_SESSION_CLAUDE_HEAP_MB = 72;

function usage(turn) {
  const input = 20_000 + turn * 900;
  return {
    cache_write_input_tokens: 0,
    cached_input_tokens: Math.floor(input * 0.94),
    input_tokens: input,
    output_tokens: 400 + turn,
    reasoning_output_tokens: 120 + turn,
    total_tokens: input + 400 + turn,
  };
}

function codexTranscript(id, { turns = TURNS_PER_SESSION, forkedFromId = null } = {}) {
  const lines = [JSON.stringify({
    payload: {
      cli_version: "0.116.0",
      cwd: "/workspace",
      forked_from_id: forkedFromId,
      id,
      model: "gpt-5.6-sol",
      originator: "codex_cli_rs",
    },
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "session_meta",
  })];

  let running = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const last = usage(turn);
    running += last.total_tokens;
    const total = { ...last, total_tokens: running };
    const event = (info) => JSON.stringify({
      payload: { info, type: "token_count" },
      timestamp: "2026-08-01T00:00:00.000Z",
      type: "event_msg",
    });

    lines.push(event({ last_token_usage: last, model_context_window: 258_400, total_token_usage: total }));
    // The shapes a real corpus is full of: a re-emitted event, a zeroed
    // telemetry event on the same total, and an event carrying no info at all.
    lines.push(event({ last_token_usage: last, model_context_window: 258_400, total_token_usage: total }));
    lines.push(event({
      last_token_usage: { ...usage(0), input_tokens: 0, output_tokens: 0, total_tokens: 22_045 },
      model_context_window: 258_400,
      total_token_usage: total,
    }));
    if (turn % 8 === 0) lines.push(event(null));
    // Exceeding the context window advances the running total while reporting a
    // turn with no components. Unlike the zeroed telemetry above, this one does
    // move the total, so only the components check keeps it out of the count.
    if (turn % 10 === 0) {
      running += 1_000;
      lines.push(event({
        last_token_usage: { ...usage(0), cached_input_tokens: 0, input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1_000 },
        model_context_window: 258_400,
        total_token_usage: { ...total, total_tokens: running },
      }));
    }
    if (turn % 5 === 0) lines.push(JSON.stringify({ payload: { model: "codex-auto-review" }, type: "turn_context" }));
  }

  return `${lines.join("\n")}\n`;
}

function claudeTranscript(id, { turns = TURNS_PER_SESSION } = {}) {
  const lines = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const spend = usage(turn);
    for (let copy = 0; copy < RECORDS_PER_REQUEST; copy += 1) {
      lines.push(JSON.stringify({
        message: {
          content: [{ type: ["thinking", "text", "tool_use"][copy] }],
          id: `msg_${id}_${turn}`,
          model: "claude-opus-5",
          usage: {
            cache_creation_input_tokens: 4_000,
            cache_read_input_tokens: spend.cached_input_tokens,
            input_tokens: 12,
            output_tokens: spend.output_tokens,
          },
        },
        // Real ids look like `req_011CcgrJHYwxp2mW3Uagmmfw`. Length matters:
        // the key set is most of what the dedupe map costs.
        requestId: `req_011${String(turn).padStart(21, "Ccgr0JHYwxp2mW3Uagmmfw")}`,
        sessionId: id,
        type: "assistant",
      }));
    }
    if (turn % 20 === 0) lines.push(JSON.stringify({ isCompactSummary: true, subtype: "compact_boundary", type: "system" }));
  }
  return `${lines.join("\n")}\n`;
}

async function writeCorpus(directory) {
  const codexDirectory = path.join(directory, "codex");
  const claudeDirectory = path.join(directory, "claude");
  await fs.mkdir(codexDirectory, { recursive: true });
  await fs.mkdir(claudeDirectory, { recursive: true });

  const codexPaths = [];
  const claudePaths = [];
  const batch = 100;

  for (let start = 0; start < CODEX_SESSIONS; start += batch) {
    const writes = [];
    for (let index = start; index < Math.min(CODEX_SESSIONS, start + batch); index += 1) {
      const id = `codex-${String(index).padStart(6, "0")}`;
      const filePath = path.join(codexDirectory, `rollout-${id}.jsonl`);
      codexPaths.push(filePath);
      writes.push(fs.writeFile(filePath, codexTranscript(id)));
    }
    await Promise.all(writes);
  }

  for (let start = 0; start < CLAUDE_SESSIONS; start += batch) {
    const writes = [];
    for (let index = start; index < Math.min(CLAUDE_SESSIONS, start + batch); index += 1) {
      const id = `claude-${String(index).padStart(6, "0")}`;
      const filePath = path.join(claudeDirectory, `${id}.jsonl`);
      claudePaths.push(filePath);
      writes.push(fs.writeFile(filePath, claudeTranscript(id)));
    }
    await Promise.all(writes);
  }

  // A fork and the parent it replays, for the one path that reads two files.
  const parentPath = path.join(codexDirectory, "rollout-fork-parent.jsonl");
  const forkPath = path.join(codexDirectory, "rollout-fork-child.jsonl");
  await fs.writeFile(parentPath, codexTranscript("fork-parent", { turns: 400 }));
  await fs.writeFile(forkPath, codexTranscript("fork-child", { forkedFromId: "fork-parent", turns: 500 }));

  return { claudePaths, codexPaths, forkPath, parentPath };
}

// One session, two orders of magnitude past anything real, measured on its own
// so the reading is retention and not the corpus scan's garbage.
async function measureLongSession(directory) {
  const codexPath = path.join(directory, "long-codex.jsonl");
  const claudePath = path.join(directory, "long-claude.jsonl");
  await fs.writeFile(codexPath, codexTranscript("long-codex", { turns: LONG_SESSION_TURNS }));
  await fs.writeFile(claudePath, claudeTranscript("long-claude", { turns: LONG_SESSION_TURNS }));
  const codexBytes = (await fs.stat(codexPath)).size;
  const claudeBytes = (await fs.stat(claudePath)).size;

  // Measured with the collector still referenced. Reading the heap after
  // `collect*` returns measures nothing: the summary it hands back does not hold
  // the dedupe map or the signature arrays, so they are already collectable and
  // the figure comes back negative however large they were.
  async function retention(filePath, collector) {
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const { complete } = await visitJsonlSnapshotEntries(filePath, ({ parsed }) => {
      if (parsed && typeof parsed === "object") collector.record(parsed);
      return true;
    }, {});
    global.gc?.();
    const heapMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    // Touch the collector after the reading so it cannot be collected before it.
    return { heapMb, result: collector.result(), complete };
  }

  // Signatures on, which is what splitting a fork costs on the parent side.
  const codexRead = await retention(codexPath, createCodexTokenCollector({ signatures: true }));
  const codex = codexRead.result;
  const codexHeapMb = codexRead.heapMb;

  const claudeRead = await retention(claudePath, createClaudeTokenCollector());
  const claude = claudeRead.result;
  const claudeHeapMb = claudeRead.heapMb;

  if (codex.countedTurns !== LONG_SESSION_TURNS) {
    throw new Error(`Long Codex session counted ${codex.countedTurns} turns, expected ${LONG_SESSION_TURNS}.`);
  }
  if (claude.countedRequests !== LONG_SESSION_TURNS) {
    throw new Error(`Long Claude session counted ${claude.countedRequests} requests, expected ${LONG_SESSION_TURNS}.`);
  }
  if (codexHeapMb > LONG_SESSION_CODEX_HEAP_MB) {
    throw new Error(`Codex retained ${codexHeapMb.toFixed(1)} MB for ${LONG_SESSION_TURNS} turns, ceiling is ${LONG_SESSION_CODEX_HEAP_MB} MB.`);
  }
  if (claudeHeapMb > LONG_SESSION_CLAUDE_HEAP_MB) {
    throw new Error(`Claude retained ${claudeHeapMb.toFixed(1)} MB for ${LONG_SESSION_TURNS} requests, ceiling is ${LONG_SESSION_CLAUDE_HEAP_MB} MB.`);
  }

  const perEntry = (mb, entries) => Math.round((mb * 1024 * 1024) / entries);
  return {
    claude: {
      bytesPerRequest: perEntry(claudeHeapMb, LONG_SESSION_TURNS),
      heapMb: Number(claudeHeapMb.toFixed(2)),
      megabytes: Number((claudeBytes / 1024 / 1024).toFixed(1)),
      requests: claude.countedRequests,
    },
    codex: {
      bytesPerTurn: perEntry(codexHeapMb, LONG_SESSION_TURNS),
      heapMb: Number(codexHeapMb.toFixed(2)),
      megabytes: Number((codexBytes / 1024 / 1024).toFixed(1)),
      turns: codex.countedTurns,
    },
    turns: LONG_SESSION_TURNS,
  };
}

async function totalBytes(paths) {
  let bytes = 0;
  for (const filePath of paths) bytes += (await fs.stat(filePath)).size;
  return bytes;
}

async function measure(paths, collect) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  let counted = 0;
  let tokens = 0;
  for (const filePath of paths) {
    const result = await collect(filePath);
    counted += result.countedTurns ?? result.countedRequests ?? 0;
    tokens += result.totals.total;
  }
  const durationMs = performance.now() - startedAt;
  global.gc?.();
  return { counted, durationMs, heapChangeMb: (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024, tokens };
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-tokens-"));

try {
  const { claudePaths, codexPaths, forkPath, parentPath } = await writeCorpus(directory);

  const codexBytes = await totalBytes(codexPaths);
  const claudeBytes = await totalBytes(claudePaths);

  const codex = await measure(codexPaths, (filePath) => collectCodexSessionTokens(filePath));
  const claude = await measure(claudePaths, (filePath) => collectClaudeSessionTokens(filePath));

  global.gc?.();
  const splitHeapBefore = process.memoryUsage().heapUsed;
  const splitStartedAt = performance.now();
  // The parent is read first so the fork can be split as it streams; what stays
  // resident is the parent's signature arrays, and nothing from the fork.
  const parent = await collectCodexSessionTokens(parentPath, { signatures: true });
  const { fork: split } = await collectCodexSessionTokens(forkPath, { prefix: parent.signatures });
  const splitDurationMs = performance.now() - splitStartedAt;
  // Collect the parse garbage so what remains is the retained signatures.
  global.gc?.();
  const splitHeapChangeMb = (process.memoryUsage().heapUsed - splitHeapBefore) / 1024 / 1024;

  // The benchmark doubles as a regression guard: duplicated events, zeroed
  // telemetry and info-less events must all stay out of the counts.
  const expectedCodexTurns = CODEX_SESSIONS * TURNS_PER_SESSION;
  if (codex.counted !== expectedCodexTurns) {
    throw new Error(`Codex counted ${codex.counted} turns, expected ${expectedCodexTurns}.`);
  }
  const expectedClaudeRequests = CLAUDE_SESSIONS * TURNS_PER_SESSION;
  if (claude.counted !== expectedClaudeRequests) {
    throw new Error(`Claude counted ${claude.counted} requests, expected ${expectedClaudeRequests}.`);
  }
  if (split.inheritedTurns !== 400 || split.ownTurns !== 100) {
    throw new Error(`Fork split found ${split.inheritedTurns} inherited and ${split.ownTurns} own turns, expected 400 and 100.`);
  }

  const longSession = await measureLongSession(directory);

  const rate = (bytes, ms) => Number(((bytes / 1024 / 1024) / (ms / 1000)).toFixed(0));

  process.stdout.write(`${JSON.stringify({
    claude: {
      countedRequests: claude.counted,
      durationMs: Number(claude.durationMs.toFixed(2)),
      heapChangeMb: Number(claude.heapChangeMb.toFixed(2)),
      megabytes: Number((claudeBytes / 1024 / 1024).toFixed(1)),
      megabytesPerSecond: rate(claudeBytes, claude.durationMs),
      recordsPerRequest: RECORDS_PER_REQUEST,
      sessions: claudePaths.length,
    },
    codex: {
      countedTurns: codex.counted,
      durationMs: Number(codex.durationMs.toFixed(2)),
      heapChangeMb: Number(codex.heapChangeMb.toFixed(2)),
      megabytes: Number((codexBytes / 1024 / 1024).toFixed(1)),
      megabytesPerSecond: rate(codexBytes, codex.durationMs),
      sessions: codexPaths.length,
    },
    forkSplit: {
      durationMs: Number(splitDurationMs.toFixed(2)),
      heapChangeMb: Number(splitHeapChangeMb.toFixed(2)),
      inheritedTurns: split.inheritedTurns,
      ownTurns: split.ownTurns,
      retainedTurns: parent.signatures.runningTotals.length,
    },
    longSession,
  }, null, 2)}\n`);
} finally {
  await fs.rm(directory, { force: true, recursive: true });
}
