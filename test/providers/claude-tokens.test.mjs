import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectClaudeSessionTokens,
  createClaudeTokenCollector,
} from "../../lib/providers/claude-code/tokens.mjs";

function usage({ cacheRead = 0, cacheWrite = 0, input = 0, output = 0 } = {}) {
  return {
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    input_tokens: input,
    output_tokens: output,
  };
}

function assistant({ blocks = ["text"], id = "msg_1", model = "claude-opus-5", requestId = "req_1", ...rest }) {
  return {
    message: {
      content: blocks.map((type) => ({ type })),
      id,
      model,
      usage: rest.usage ?? usage({}),
    },
    requestId,
    type: "assistant",
    ...rest,
  };
}

function collect(records) {
  const collector = createClaudeTokenCollector();
  for (const record of records) collector.record(record);
  return collector.result();
}

test("one response written as several records is billed once", () => {
  const spend = usage({ cacheRead: 20_000, cacheWrite: 5000, input: 10, output: 500 });
  const result = collect([
    assistant({ blocks: ["thinking"], usage: spend }),
    assistant({ blocks: ["text"], usage: spend }),
    assistant({ blocks: ["tool_use"], usage: spend }),
  ]);

  assert.equal(result.observedRecords, 3);
  assert.equal(result.countedRequests, 1);
  assert.equal(result.totals.total, 25_510);
});

test("a superseded copy reporting zeros does not replace the real usage", () => {
  const real = usage({ cacheRead: 211_100, cacheWrite: 6819, input: 2, output: 1024 });
  const forwards = collect([
    assistant({ usage: real }),
    assistant({ usage: usage({}) }),
  ]);
  const backwards = collect([
    assistant({ usage: usage({}) }),
    assistant({ usage: real }),
  ]);

  assert.equal(forwards.totals.total, 218_945);
  assert.equal(backwards.totals.total, 218_945, "order must not decide the answer");
});

test("cached tokens sit beside the input count, never inside it", () => {
  const result = collect([
    assistant({ usage: usage({ cacheRead: 22_042, cacheWrite: 12_384, input: 2, output: 266 }) }),
  ]);

  // Subtracting the cache here is what would drive the slice negative.
  assert.equal(result.totals.freshInput, 2);
  assert.equal(result.totals.cachedInput, 22_042);
  assert.equal(result.totals.cacheWrites, 12_384);
  assert.equal(result.totals.total, 34_694);
  assert.equal(result.totals.freshInput >= 0, true);
});

test("no reasoning figure is invented", () => {
  const result = collect([
    assistant({ blocks: ["thinking"], usage: usage({ input: 100, output: 900 }) }),
  ]);

  assert.equal(result.totals.reasoning, 0);
});

test("synthetic messages are excluded from totals and model rows", () => {
  const result = collect([
    assistant({ usage: usage({ input: 100, output: 200 }) }),
    { message: { id: "msg_2", model: "<synthetic>", usage: usage({}) }, type: "assistant" },
  ]);

  assert.equal(result.syntheticRecords, 1);
  assert.equal(result.countedRequests, 1);
  assert.deepEqual(result.byModel.map(({ model }) => model), ["claude-opus-5"]);
});

test("records without a request id fall back to the message id", () => {
  const spend = usage({ input: 100, output: 200 });
  const result = collect([
    { message: { id: "msg_9", model: "claude-opus-5", usage: spend }, type: "assistant" },
    { message: { id: "msg_9", model: "claude-opus-5", usage: spend }, type: "assistant" },
  ]);

  assert.equal(result.countedRequests, 1);
  assert.equal(result.totals.total, 300);
});

test("tokens are attributed to the model that produced each request", () => {
  const result = collect([
    assistant({ id: "msg_1", requestId: "req_1", usage: usage({ input: 100, output: 100 }) }),
    assistant({ id: "msg_2", model: "claude-haiku-4-5-20251001", requestId: "req_2", usage: usage({ input: 10, output: 10 }) }),
    assistant({ id: "msg_3", requestId: "req_3", usage: usage({ input: 100, output: 100 }) }),
  ]);

  assert.deepEqual(
    result.byModel.map(({ model, totals }) => [model, totals.total]),
    [["claude-opus-5", 400], ["claude-haiku-4-5-20251001", 20]],
  );
});

test("compaction boundaries are counted for context, not billed", () => {
  const result = collect([
    assistant({ usage: usage({ input: 100, output: 100 }) }),
    { isCompactSummary: true, subtype: "compact_boundary", type: "system" },
    { isCompactSummary: true, subtype: "compact_boundary", type: "system" },
  ]);

  assert.equal(result.compactions, 2);
  assert.equal(result.totals.total, 200);
});

test("sidechain requests are counted and reported separately", () => {
  const result = collect([
    assistant({ usage: usage({ input: 100, output: 100 }) }),
    assistant({ id: "msg_2", isSidechain: true, requestId: "req_2", usage: usage({ input: 50, output: 50 }) }),
  ]);

  assert.equal(result.sidechainRequests, 1);
  assert.equal(result.countedRequests, 2);
  assert.equal(result.totals.total, 300);
});

test("malformed and absent usage is skipped rather than throwing", () => {
  const result = collect([
    { type: "assistant" },
    { message: null, type: "assistant" },
    { message: { id: "msg_1", usage: "nonsense" }, type: "assistant" },
    { message: { id: "msg_2", usage: { input_tokens: "many", output_tokens: null } }, type: "assistant" },
    assistant({ id: "msg_3", requestId: "req_3", usage: usage({ input: 100, output: 100 }) }),
  ]);

  assert.equal(result.countedRequests, 2);
  assert.equal(result.totals.total, 200);
  for (const value of Object.values(result.totals)) assert.equal(Number.isFinite(value), true);
});

test("a session with no usage reports nothing rather than zero", () => {
  const result = collect([{ subtype: "compact_boundary", type: "system" }]);

  assert.equal(result.available, false);
  assert.equal(result.countedRequests, 0);
});

test("an aborted read stops early and reports itself as incomplete", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steward-claude-abort-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "transcript.jsonl");
  const records = [];
  for (let index = 0; index < 50; index += 1) {
    records.push(assistant({ id: `msg_${index}`, requestId: `req_${index}`, usage: usage({ input: 100, output: 100 }) }));
  }
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const controller = new AbortController();
  controller.abort();
  const aborted = await collectClaudeSessionTokens(filePath, { signal: controller.signal });

  assert.equal(aborted.complete, false);
  assert.equal(aborted.countedRequests, 0);

  const full = await collectClaudeSessionTokens(filePath);
  assert.equal(full.complete, true);
  assert.equal(full.countedRequests, 50);
});

test("collecting from a transcript file matches collecting from records", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "steward-claude-tokens-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "transcript.jsonl");
  const spend = usage({ cacheRead: 20_000, cacheWrite: 5000, input: 10, output: 500 });
  const records = [
    { ...assistant({ blocks: ["thinking"], usage: spend }), sessionId: "session-1" },
    assistant({ blocks: ["text"], usage: spend }),
    assistant({ id: "msg_2", requestId: "req_2", usage: usage({ input: 5, output: 50 }) }),
  ];
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const fromFile = await collectClaudeSessionTokens(filePath);
  assert.equal(fromFile.complete, true);
  assert.equal(fromFile.sessionId, "session-1");
  assert.equal(fromFile.countedRequests, 2);
  assert.equal(fromFile.totals.total, collect(records).totals.total);
  assert.equal(fromFile.totals.total, 25_565);
});
