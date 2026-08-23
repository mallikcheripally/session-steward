import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectCodexSessionTokens,
  createCodexTokenCollector,
} from "../../lib/providers/codex/tokens.mjs";

function usage({ cached = 0, cacheWrite = 0, input = 0, output = 0, reasoning = 0 } = {}) {
  return {
    cache_write_input_tokens: cacheWrite,
    cached_input_tokens: cached,
    input_tokens: input,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function tokenCount(total, last) {
  return {
    payload: {
      info: { last_token_usage: last, model_context_window: 258400, total_token_usage: total },
      type: "token_count",
    },
    type: "event_msg",
  };
}

function sessionMeta(payload) {
  return { payload: { id: "session-1", ...payload }, type: "session_meta" };
}

function collect(records) {
  const collector = createCodexTokenCollector();
  for (const record of records) collector.record(record);
  return collector.result();
}

test("re-emitted events that do not advance the running total are not billed twice", () => {
  const turn = usage({ input: 900, output: 100 });
  const result = collect([
    sessionMeta({}),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
  ]);

  assert.equal(result.observedEvents, 4);
  assert.equal(result.countedTurns, 2);
  assert.equal(result.totals.total, 2000);
});

test("a running total that resets mid-session still bills the turn", () => {
  const result = collect([
    sessionMeta({}),
    tokenCount(usage({ input: 9000, output: 1000 }), usage({ input: 9000, output: 1000 })),
    // Resume restarts the counter; the turn after it is real spend.
    tokenCount(usage({ input: 400, output: 100 }), usage({ input: 400, output: 100 })),
  ]);

  assert.equal(result.countedTurns, 2);
  assert.equal(result.totals.total, 10500);
});

test("a subagent inheriting the parent counter bills only its own turns", () => {
  const result = collect([
    sessionMeta({ source: { subagent: { thread_spawn: { parent_thread_id: "parent-1" } } } }),
    // The running total opens at the parent's accumulated figure.
    tokenCount(usage({ input: 104_000_000, output: 629_499 }), usage({ input: 20_000, output: 5000 })),
    tokenCount(usage({ input: 104_020_000, output: 634_499 }), usage({ input: 20_000, output: 5000 })),
  ]);

  assert.equal(result.subagent, true);
  assert.equal(result.totals.total, 50_000);
  assert.notEqual(result.totals.total, 104_629_499);
});

test("events carrying no usage info are skipped rather than throwing", () => {
  const result = collect([
    sessionMeta({}),
    { payload: { info: null, type: "token_count" }, type: "event_msg" },
    { payload: { type: "token_count" }, type: "event_msg" },
    tokenCount(usage({ input: 500, output: 100 }), usage({ input: 500, output: 100 })),
  ]);

  assert.equal(result.observedEvents, 3);
  assert.equal(result.countedTurns, 1);
  assert.equal(result.totals.total, 600);
});

test("older rollouts without cache-write fields produce finite numbers", () => {
  const legacy = {
    cached_input_tokens: 400,
    input_tokens: 1000,
    output_tokens: 200,
    reasoning_output_tokens: 50,
    total_tokens: 1200,
  };
  const result = collect([sessionMeta({}), tokenCount(legacy, legacy)]);

  assert.equal(result.totals.freshInput, 600);
  assert.equal(result.totals.cacheWrites, 0);
  assert.equal(result.totals.total, 1200);
  assert.equal(result.cacheWriteUnderflow, false);
  for (const value of Object.values(result.totals)) assert.equal(Number.isFinite(value), true);
});

test("zeroed telemetry on a stalled total is excluded", () => {
  const real = usage({ cached: 300, input: 900, output: 100 });
  const result = collect([
    sessionMeta({}),
    tokenCount(usage({ input: 900, output: 100 }), real),
    // Same running total, usage zeroed but a context size reported.
    tokenCount(usage({ input: 900, output: 100 }), { ...usage({}), total_tokens: 22045 }),
  ]);

  assert.equal(result.countedTurns, 1);
  assert.equal(result.totals.total, 1000);
});

test("a synthetic advance with no components is not billed", () => {
  const turn = usage({ input: 900, output: 100 });
  const result = collect([
    sessionMeta({}),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    // Context window exceeded: the running total jumps, the turn is a phantom.
    tokenCount(
      { ...usage({}), total_tokens: 258_400 },
      { ...usage({}), total_tokens: 257_400 },
    ),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
  ]);

  assert.equal(result.countedTurns, 2);
  assert.equal(result.totals.total, 2000);
});

test("cache writes that overshoot input are clamped and reported", () => {
  const odd = {
    cache_write_input_tokens: 900,
    cached_input_tokens: 800,
    input_tokens: 1000,
    output_tokens: 100,
    total_tokens: 1100,
  };
  const result = collect([sessionMeta({}), tokenCount(odd, odd)]);

  assert.equal(result.cacheWriteUnderflow, true);
  assert.equal(result.totals.freshInput, 200);
  assert.equal(result.totals.freshInput >= 0, true);
});

test("reasoning never exceeds output", () => {
  const wild = {
    cached_input_tokens: 0,
    input_tokens: 500,
    output_tokens: 100,
    reasoning_output_tokens: 999,
    total_tokens: 600,
  };
  const result = collect([sessionMeta({}), tokenCount(wild, wild)]);

  assert.equal(result.totals.reasoning, 100);
  assert.equal(result.totals.reasoning <= result.totals.output, true);
});

test("a mid-session model switch splits tokens across both models", () => {
  const turn = usage({ input: 900, output: 100 });
  const result = collect([
    sessionMeta({ model: "gpt-5.6-sol" }),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    { payload: { model: "codex-auto-review" }, type: "turn_context" },
    tokenCount(usage({ input: 1800, output: 200 }), turn),
    { payload: { thread_settings: { model: "gpt-5.6-sol" }, type: "thread_settings_applied" }, type: "event_msg" },
    tokenCount(usage({ input: 2700, output: 300 }), turn),
  ]);

  const byModel = Object.fromEntries(result.byModel.map(({ model, totals }) => [model, totals.total]));
  assert.deepEqual(byModel, { "codex-auto-review": 1000, "gpt-5.6-sol": 2000 });
});

test("a session with no token events reports nothing rather than zero", () => {
  const result = collect([sessionMeta({}), { payload: { type: "agent_message" }, type: "event_msg" }]);

  assert.equal(result.available, false);
  assert.equal(result.countedTurns, 0);
});

test("a fork splits inherited turns from its own work", () => {
  const turn = usage({ input: 900, output: 100 });
  const parentRecords = [
    sessionMeta({}),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
    tokenCount(usage({ input: 2700, output: 300 }), turn),
  ];
  const parent = createCodexTokenCollector({ signatures: true });
  for (const record of parentRecords) parent.record(record);

  const forkRecords = [
    sessionMeta({ forked_from_id: "session-1", id: "session-2" }),
    // The parent's turns are replayed verbatim before the fork's own.
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
    tokenCount(usage({ input: 3600, output: 400 }), usage({ cached: 600, input: 1800, output: 200 })),
  ];
  const fork = createCodexTokenCollector({ prefix: parent.result().signatures });
  for (const record of forkRecords) fork.record(record);
  const split = fork.result();

  assert.equal(collect(parentRecords).signatures, null, "a plain session retains nothing");
  assert.equal(collect(forkRecords).fork, null, "a fork with no parent to compare against is not split");
  assert.equal(split.forkedFromId, "session-1");
  assert.equal(split.totals.total, 4000, "the raw walk still includes inherited turns");

  assert.equal(split.fork.inheritedTurns, 2);
  assert.equal(split.fork.inherited.total, 2000);
  assert.equal(split.fork.ownTurns, 1);
  assert.equal(split.fork.own.total, 2000);
  assert.equal(split.fork.own.cachedInput, 600);
  assert.equal(split.fork.own.freshInput, 1200);
  assert.deepEqual(split.fork.ownByModel.map(({ model }) => model), ["Unknown"]);
});

test("a parent records turn signatures only when asked", () => {
  const turn = usage({ input: 900, output: 100 });
  const records = [sessionMeta({}), tokenCount(usage({ input: 900, output: 100 }), turn)];

  assert.equal(collect(records).signatures, null);

  const recording = createCodexTokenCollector({ signatures: true });
  for (const record of records) recording.record(record);
  const { runningTotals, turnTotals } = recording.result().signatures;
  assert.deepEqual(runningTotals, [1000]);
  assert.deepEqual(turnTotals, [1000]);
});

test("a fork stops matching the parent at the first turn that differs", () => {
  const turn = usage({ input: 900, output: 100 });
  const parent = createCodexTokenCollector({ signatures: true });
  for (const record of [
    sessionMeta({}),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
  ]) parent.record(record);

  // The second turn diverges, so the third cannot be inherited even though its
  // figures match the parent's third turn.
  const fork = createCodexTokenCollector({ prefix: parent.result().signatures });
  for (const record of [
    sessionMeta({ forked_from_id: "session-1", id: "session-2" }),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 2700, output: 300 }), usage({ input: 1800, output: 200 })),
    tokenCount(usage({ input: 3600, output: 400 }), turn),
  ]) fork.record(record);

  const { fork: split } = fork.result();
  assert.equal(split.inheritedTurns, 1);
  assert.equal(split.ownTurns, 2);
  assert.equal(split.own.total, 3000);
});

test("an aborted read stops early and reports itself as incomplete", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steward-tokens-abort-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "rollout.jsonl");
  const turn = usage({ input: 900, output: 100 });
  const records = [sessionMeta({})];
  for (let index = 1; index <= 50; index += 1) {
    records.push(tokenCount(usage({ input: 900 * index, output: 100 * index }), turn));
  }
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const controller = new AbortController();
  controller.abort();
  const aborted = await collectCodexSessionTokens(filePath, { signal: controller.signal });

  // Closing the panel must not leave a large transcript being scanned.
  assert.equal(aborted.complete, false);
  assert.equal(aborted.countedTurns, 0);

  const full = await collectCodexSessionTokens(filePath);
  assert.equal(full.complete, true);
  assert.equal(full.countedTurns, 50);
});

test("collecting from a rollout file matches collecting from records", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steward-tokens-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "rollout.jsonl");
  const turn = usage({ cached: 300, input: 900, output: 100, reasoning: 40 });
  const records = [
    sessionMeta({ model: "gpt-5.6-sol" }),
    tokenCount(usage({ input: 900, output: 100 }), turn),
    tokenCount(usage({ input: 1800, output: 200 }), turn),
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const fromFile = await collectCodexSessionTokens(filePath);
  assert.equal(fromFile.complete, true);
  assert.equal(fromFile.totals.total, collect(records).totals.total);
  assert.equal(fromFile.totals.cachedInput, 600);
  assert.equal(fromFile.totals.freshInput, 1200);
  assert.equal(fromFile.totals.reasoning, 80);
});

test("the rendered segments always add up to the reported total", () => {
  // Cache writes are zero in every event on record, so whether Codex counts
  // them inside `input_tokens` is unconfirmed. If they are not, the clamp keeps
  // fresh input off the floor — and the total has to follow the segments, or
  // the bar draws slices that exceed their own whole.
  const result = collect([
    sessionMeta({}),
    tokenCount(
      { cache_write_input_tokens: 900, cached_input_tokens: 900, input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
      { cache_write_input_tokens: 900, cached_input_tokens: 900, input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
    ),
  ]);

  const { cachedInput, cacheWrites, freshInput, output, total } = result.totals;
  assert.equal(result.cacheWriteUnderflow, true, "the clamp reports itself");
  assert.equal(freshInput + cachedInput + cacheWrites + output, total);
  // Codex reported 1,100 for the same turn. Taking that as the total left the
  // four segments summing to 2,000 — a legend reading 181.8%.
  assert.equal(total, 2000);
});

test("a transcript that disappears is an answer, not a thrown read", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steward-tokens-missing-"));
  await fs.rm(directory, { force: true, recursive: true });

  await assert.rejects(
    () => collectCodexSessionTokens(path.join(directory, "rollout.jsonl")),
    (error) => error.code === "ENOENT",
  );
});
