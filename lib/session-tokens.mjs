// The shape both providers report in, and the derived figures the UI renders.
//
// Codex counts cached tokens inside its input figure and Anthropic counts them
// beside it, so the providers cannot share a formula. They share this shape
// instead: each collector resolves its own cache math and hands back the same
// four buckets, which always sum to the total.
export const TOKEN_SEGMENT_KEYS = Object.freeze(["freshInput", "cachedInput", "cacheWrites", "output"]);

export function createTokenTotals() {
  return { cachedInput: 0, cacheWrites: 0, freshInput: 0, output: 0, reasoning: 0, total: 0 };
}

export function addTokenTotals(target, usage) {
  target.cachedInput += usage.cachedInput;
  target.cacheWrites += usage.cacheWrites;
  target.freshInput += usage.freshInput;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.total += usage.total;
  return target;
}

function share(part, whole) {
  return whole > 0 ? part / whole : 0;
}

function inputTokens(totals) {
  return totals.freshInput + totals.cachedInput + totals.cacheWrites;
}

// A fork's rollout replays its parent's turns before its own. The bar describes
// what this session actually spent, so the inherited half is reported alongside
// it rather than folded into it.
export function summarizeSessionTokens(collected, { fork = null, forkParentMissing = false } = {}) {
  if (!collected || collected.available !== true) {
    return { available: false, reason: collected?.complete === false ? "incomplete" : "absent" };
  }

  const totals = fork ? fork.own : collected.totals;
  const byModel = fork ? fork.ownByModel : collected.byModel;
  const warnings = [];
  if (collected.cacheWriteUnderflow) warnings.push("cache-write-underflow");
  if (collected.complete === false) warnings.push("incomplete-scan");
  // A fork whose parent is gone cannot be split, so the total still carries the
  // inherited turns. Say so rather than presenting it as this session's spend.
  if (forkParentMissing) warnings.push("fork-parent-missing");

  return {
    available: true,
    byModel: (byModel ?? []).map(({ model, totals: modelTotals }) => ({
      model,
      share: share(modelTotals.total, totals.total),
      tokens: modelTotals.total,
    })),
    // "N% of input was served from cache" — output is not part of the question.
    cacheHitRate: inputTokens(totals) > 0 ? share(totals.cachedInput, inputTokens(totals)) : null,
    compactions: collected.compactions ?? 0,
    inherited: fork ? { tokens: fork.inherited.total, turns: fork.inheritedTurns } : null,
    // Reasoning is part of output, so it is reported against output rather than
    // as a segment of its own.
    reasoning: totals.reasoning > 0
      ? { share: share(totals.reasoning, totals.output), tokens: totals.reasoning }
      : null,
    segments: TOKEN_SEGMENT_KEYS.map((key) => ({
      key,
      share: share(totals[key], totals.total),
      tokens: totals[key],
    })),
    total: totals.total,
    totals,
    warnings,
  };
}
