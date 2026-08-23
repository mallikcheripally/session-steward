import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSessionEvents } from "../lib/providers/codex/events.mjs";
import { readSessionTokens } from "../lib/providers/codex/tokens.mjs";
import {
  clearSessionTokenCache,
  readCachedTokens,
  sessionTokenCacheStats,
  writeCachedTokens,
} from "../lib/session-token-cache.mjs";

function tokenCount(running, turn) {
  return JSON.stringify({
    payload: {
      info: {
        last_token_usage: turn,
        model_context_window: 258_400,
        total_token_usage: running,
      },
      type: "token_count",
    },
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "event_msg",
  });
}

function usage({ cached = 0, input = 0, output = 0 } = {}) {
  return {
    cache_write_input_tokens: 0,
    cached_input_tokens: cached,
    input_tokens: input,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  };
}

async function writeSession(directory, { id, lines }) {
  const rolloutPath = path.join(directory, `rollout-${id}.jsonl`);
  await fs.writeFile(rolloutPath, `${lines.join("\n")}\n`, "utf8");
  return rolloutPath;
}

function meta(id, extra = {}) {
  return JSON.stringify({
    payload: { cwd: "/tmp", id, timestamp: "2026-08-01T00:00:00.000Z", ...extra },
    timestamp: "2026-08-01T00:00:00.000Z",
    type: "session_meta",
  });
}

async function codexHomeWith(sessions) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "steward-token-cache-"));
  const directory = path.join(home, "sessions", "2026", "08", "01");
  await fs.mkdir(directory, { recursive: true });
  const paths = {};
  for (const session of sessions) paths[session.id] = await writeSession(directory, session);
  return { home, paths };
}

const turn = usage({ input: 900, output: 100 });

test("the timeline read returns the count from its own pass", async (context) => {
  clearSessionTokenCache();
  const { home } = await codexHomeWith([{
    id: "session-1",
    lines: [
      meta("session-1"),
      tokenCount(usage({ input: 900, output: 100 }), turn),
      tokenCount(usage({ input: 1800, output: 200 }), turn),
    ],
  }]);
  context.after(() => fs.rm(home, { force: true, recursive: true }));

  const shared = await readSessionEvents({ codexHome: home, id: "session-1", limit: 100, tokens: true });
  assert.equal(shared.tokens.available, true);
  assert.equal(shared.tokens.total, 2000);

  // The dedicated reader is the reference: one read must produce what two did.
  clearSessionTokenCache();
  const standalone = await readSessionTokens({ codexHome: home, id: "session-1" });
  assert.deepEqual(shared.tokens, standalone);

  // Nothing is counted unless the caller asks, so other readers pay nothing.
  const plain = await readSessionEvents({ codexHome: home, id: "session-1", limit: 100 });
  assert.equal(plain.tokens, null);
});

test("an unchanged transcript is not read twice, and a changed one is", async (context) => {
  clearSessionTokenCache();
  const { home, paths } = await codexHomeWith([{
    id: "session-1",
    lines: [meta("session-1"), tokenCount(usage({ input: 900, output: 100 }), turn)],
  }]);
  context.after(() => fs.rm(home, { force: true, recursive: true }));

  const first = await readSessionTokens({ codexHome: home, id: "session-1" });
  assert.equal(first.total, 1000);
  // The cached summary is the same object, not an equal one.
  assert.equal(await readSessionTokens({ codexHome: home, id: "session-1" }), first);

  await fs.appendFile(paths["session-1"], `${tokenCount(usage({ input: 1800, output: 200 }), turn)}\n`, "utf8");
  const second = await readSessionTokens({ codexHome: home, id: "session-1" });
  assert.notEqual(second, first);
  assert.equal(second.total, 2000);
});

test("a fork reads its parent once however many times it is opened", async (context) => {
  clearSessionTokenCache();
  const { home } = await codexHomeWith([
    {
      id: "parent",
      lines: [
        meta("parent"),
        tokenCount(usage({ input: 900, output: 100 }), turn),
        tokenCount(usage({ input: 1800, output: 200 }), turn),
      ],
    },
    {
      id: "child",
      lines: [
        meta("child", { forked_from_id: "parent" }),
        // The parent's turns are replayed before the fork's own.
        tokenCount(usage({ input: 900, output: 100 }), turn),
        tokenCount(usage({ input: 1800, output: 200 }), turn),
        tokenCount(usage({ input: 3600, output: 400 }), usage({ cached: 600, input: 1800, output: 200 })),
      ],
    },
  ]);
  context.after(() => fs.rm(home, { force: true, recursive: true }));

  const split = await readSessionTokens({ codexHome: home, id: "child" });
  assert.equal(split.total, 2000, "the bar describes own work only");
  assert.equal(split.inherited.tokens, 2000);
  assert.equal(split.inherited.turns, 2);

  // Reopening resolves the same split without touching the parent again.
  await fs.rm(path.join(home, "sessions", "2026", "08", "01", "rollout-parent.jsonl"));
  assert.deepEqual(await readSessionTokens({ codexHome: home, id: "child" }), split);
});

test("an abandoned read is never cached as the answer", async (context) => {
  clearSessionTokenCache();
  const { home } = await codexHomeWith([{
    id: "session-1",
    lines: [
      meta("session-1"),
      tokenCount(usage({ input: 900, output: 100 }), turn),
      tokenCount(usage({ input: 1800, output: 200 }), turn),
    ],
  }]);
  context.after(() => fs.rm(home, { force: true, recursive: true }));

  // A closed panel aborts mid-file. Whatever that partial pass counted must not
  // become the cached answer for a file that never changed.
  const controller = new AbortController();
  controller.abort();
  const abandoned = await readSessionTokens({ codexHome: home, id: "session-1", signal: controller.signal });
  assert.equal(abandoned.available, false);

  const complete = await readSessionTokens({ codexHome: home, id: "session-1" });
  assert.equal(complete.available, true);
  assert.equal(complete.total, 2000);
});

test("the cache is bounded by bytes, not only by entry count", () => {
  clearSessionTokenCache();
  const megabyte = 1024 * 1024;
  const { maxBytes, maxEntries } = sessionTokenCacheStats();

  // Well under the entry limit, well over the byte limit: a fork parent's
  // signatures are 16 bytes a turn, so counting entries alone bounds nothing.
  const entries = Math.ceil(maxBytes / megabyte) + 4;
  assert.ok(entries < maxEntries, "the byte limit has to bite before the entry limit");
  for (let index = 0; index < entries; index += 1) {
    writeCachedTokens("signatures", `/parent-${index}.jsonl`, `stamp-${index}`, { turn: index }, megabyte);
  }

  const stats = sessionTokenCacheStats();
  assert.ok(stats.bytes <= maxBytes, `held ${stats.bytes} bytes against a ${maxBytes} limit`);
  assert.ok(stats.entries < entries, "the oldest entries were evicted");
  // The most recent write survives; the first does not.
  assert.deepEqual(readCachedTokens("signatures", `/parent-${entries - 1}.jsonl`, `stamp-${entries - 1}`), { turn: entries - 1 });
  assert.equal(readCachedTokens("signatures", "/parent-0.jsonl", "stamp-0"), undefined);
});

test("an entry too large for the budget is not cached at all", () => {
  clearSessionTokenCache();
  const { maxBytes } = sessionTokenCacheStats();
  writeCachedTokens("signatures", "/small.jsonl", "stamp", { kept: true }, 1024);
  // Caching it would evict everything else and then sit there alone.
  writeCachedTokens("signatures", "/huge.jsonl", "stamp", { kept: false }, maxBytes + 1);

  assert.equal(readCachedTokens("signatures", "/huge.jsonl", "stamp"), undefined);
  assert.deepEqual(readCachedTokens("signatures", "/small.jsonl", "stamp"), { kept: true });
});
