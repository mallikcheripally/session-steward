import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTokenCollector } from "../lib/providers/claude-code/tokens.mjs";
import { createCodexTokenCollector } from "../lib/providers/codex/tokens.mjs";
import { createTokenTotals, summarizeSessionTokens, TOKEN_SEGMENT_KEYS } from "../lib/session-tokens.mjs";

function totals({ cachedInput = 0, cacheWrites = 0, freshInput = 0, output = 0, reasoning = 0 }) {
  return {
    ...createTokenTotals(),
    cachedInput,
    cacheWrites,
    freshInput,
    output,
    reasoning,
    total: cachedInput + cacheWrites + freshInput + output,
  };
}

function collected(overrides = {}) {
  return {
    available: true,
    byModel: [],
    cacheWriteUnderflow: false,
    compactions: 0,
    complete: true,
    totals: totals({ cachedInput: 1_553_152, freshInput: 88_370, output: 16_967, reasoning: 7737 }),
    ...overrides,
  };
}

test("a session without token data reports why rather than reporting zero", () => {
  assert.deepEqual(summarizeSessionTokens(null), { available: false, reason: "absent" });
  assert.deepEqual(summarizeSessionTokens({ available: false }), { available: false, reason: "absent" });
  assert.deepEqual(
    summarizeSessionTokens({ available: false, complete: false }),
    { available: false, reason: "incomplete" },
  );
});

test("segments cover the total exactly and their shares sum to one", () => {
  const summary = summarizeSessionTokens(collected());

  assert.deepEqual(summary.segments.map(({ key }) => key), [...TOKEN_SEGMENT_KEYS]);
  assert.equal(summary.segments.reduce((sum, { tokens }) => sum + tokens, 0), summary.total);
  assert.equal(Math.abs(summary.segments.reduce((sum, { share }) => sum + share, 0) - 1) < 1e-12, true);
});

test("the cache hit rate is measured against input, not against the total", () => {
  const summary = summarizeSessionTokens(collected());
  const { cachedInput, cacheWrites, freshInput } = summary.totals;

  assert.equal(summary.cacheHitRate, cachedInput / (freshInput + cachedInput + cacheWrites));
  // Folding output into the denominator is what would understate it.
  assert.notEqual(summary.cacheHitRate, cachedInput / summary.total);
  assert.equal(summary.cacheHitRate > 0.94, true);
});

test("reasoning is reported against output and omitted when absent", () => {
  const withReasoning = summarizeSessionTokens(collected());
  assert.equal(withReasoning.reasoning.tokens, 7737);
  assert.equal(withReasoning.reasoning.share, 7737 / 16_967);
  // A share of output, never a fifth segment.
  assert.equal(withReasoning.segments.some(({ key }) => key === "reasoning"), false);

  const none = summarizeSessionTokens(collected({ totals: totals({ freshInput: 100, output: 50 }) }));
  assert.equal(none.reasoning, null);
});

test("a fork reports its own work as the total and its inherited half beside it", () => {
  const own = { cachedInput: 0, cacheWrites: 0, freshInput: 900, output: 100, reasoning: 0, total: 1000 };
  const inherited = { cachedInput: 0, cacheWrites: 0, freshInput: 1800, output: 200, reasoning: 0, total: 2000 };
  const fork = {
    inherited,
    inheritedTurns: 2,
    own,
    ownByModel: [{ model: "gpt-5.6-sol", totals: own }],
    ownTurns: 1,
    parentAvailable: true,
  };
  const summary = summarizeSessionTokens(
    collected({ totals: totals({ freshInput: 2700, output: 300 }) }),
    { fork },
  );

  assert.equal(summary.total, 1000, "the bar describes own work only");
  assert.equal(summary.inherited.tokens, 2000);
  assert.equal(summary.inherited.turns, 2);
  assert.equal(summary.segments.reduce((sum, { tokens }) => sum + tokens, 0), summary.total);
});

test("a fork whose parent is missing is flagged rather than silently split", () => {
  const summary = summarizeSessionTokens(collected(), { forkParentMissing: true });

  assert.equal(summary.warnings.includes("fork-parent-missing"), true);
  // Without the parent the inherited turns cannot be separated, so the total
  // still carries them and must not claim an own-work split.
  assert.equal(summary.inherited, null);
  assert.equal(summary.total, collected().totals.total);
});

test("an underflowing cache-write assumption and a truncated scan both surface", () => {
  const summary = summarizeSessionTokens(collected({ cacheWriteUnderflow: true, complete: false }));

  assert.deepEqual(summary.warnings, ["cache-write-underflow", "incomplete-scan"]);
});

test("model rows carry their share of the session", () => {
  const summary = summarizeSessionTokens(collected({
    byModel: [
      { model: "gpt-5.6-sol", totals: totals({ freshInput: 1_500_000 }) },
      { model: "codex-auto-review", totals: totals({ freshInput: 158_489 }) },
    ],
    totals: totals({ freshInput: 1_658_489 }),
  }));

  assert.deepEqual(summary.byModel.map(({ model }) => model), ["gpt-5.6-sol", "codex-auto-review"]);
  assert.equal(Math.abs(summary.byModel.reduce((sum, { share }) => sum + share, 0) - 1) < 1e-12, true);
});

test("both providers summarize into the same shape", () => {
  const codex = createCodexTokenCollector();
  codex.record({ payload: { id: "s1", model: "gpt-5.6-sol" }, type: "session_meta" });
  codex.record({
    payload: {
      info: {
        // Codex counts cached tokens inside its input figure.
        last_token_usage: { cached_input_tokens: 600, input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
        total_token_usage: { cached_input_tokens: 600, input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
      },
      type: "token_count",
    },
    type: "event_msg",
  });

  const claude = createClaudeTokenCollector();
  claude.record({
    message: {
      id: "m1",
      model: "claude-opus-5",
      // Anthropic counts them beside it; the same 1000 tokens either way.
      usage: { cache_read_input_tokens: 600, input_tokens: 300, output_tokens: 100 },
    },
    requestId: "r1",
    type: "assistant",
  });

  const left = summarizeSessionTokens(codex.result());
  const right = summarizeSessionTokens(claude.result());

  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  assert.equal(left.total, right.total);
  assert.equal(left.totals.freshInput, right.totals.freshInput);
  assert.equal(left.totals.cachedInput, right.totals.cachedInput);
  assert.equal(left.cacheHitRate, right.cacheHitRate);
});
