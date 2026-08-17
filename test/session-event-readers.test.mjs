import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { getProvider } from "../lib/providers/index.mjs";
import {
  SESSION_EVENT_READ_MODE,
  SESSION_EVENT_REASON,
  sessionEventCoveragePercent,
} from "../lib/session-events.mjs";
import { visitJsonlSnapshotEntries } from "../lib/storage/jsonl.mjs";
import {
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "./fixtures/claude-home.mjs";

const claude = getProvider("claude-code");
const codex = getProvider("codex");

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function assertCoverageInvariant(coverage) {
  assert.equal(
    coverage.recognized
      + coverage.skipped
      + coverage.unmapped
      + coverage.unparseable
      + coverage.oversized,
    coverage.total,
  );
}

function codexRecord(payload, sequence) {
  return {
    payload,
    timestamp: new Date(Date.UTC(2026, 7, 1, 10, 0, sequence)).toISOString(),
    type: payload.type === "compacted" || payload.type === "patch_apply_end"
      ? "event_msg"
      : "response_item",
  };
}

async function directoryState(root) {
  const entries = (await fs.readdir(root, { recursive: true })).sort();
  const files = {};

  for (const relativePath of entries) {
    const target = path.join(root, relativePath);
    const stats = await fs.stat(target);
    if (stats.isFile()) {
      files[relativePath] = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      };
    }
  }

  return { entries, files };
}

test("Codex translates a transcript into the shared event vocabulary", async (context) => {
  const fixture = await createCodexHomeFixture({ includeEventTranscript: true });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const before = await directoryState(fixture.codexHome);

  const result = await codex.readSessionEvents({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.parent,
    limit: 100,
    maxLineBytes: fixture.eventFixture.maxLineBytes,
  });

  assert.deepEqual(result.events.map(({ kind }) => kind), [
    "ask",
    "ask",
    "said",
    "edit",
    "edit",
    "ran",
    "ran",
    "decided",
    "plan",
    "summary",
    "edit",
    "ran",
  ]);
  assert.equal(result.events[0].injected, true);
  assert.equal(result.events[1].injected, false);
  assert.deepEqual(result.events[3], {
    added: 1,
    applied: true,
    atMs: Date.parse(fixture.eventFixture.records[5].timestamp),
    files: ["lib/example.mjs"],
    kind: "edit",
    removed: 1,
    sequence: 5,
  });
  assert.equal(result.events[4].applied, false);
  assert.equal(result.events[5].command, "sed -n '1,240p' /path && rg -n \"pattern\" file");
  assert.equal(result.events[5].workdir, "/Users/admin/dev/x");
  assert.equal(result.events[5].failed, true);
  assert.match(result.events[5].error, /A test failed/u);
  assert.equal(result.events[6].command, "npm run build");
  assert.equal(result.events[6].failed, false);
  assert.equal(result.events[7].answer, "Fix now");
  assert.deepEqual(result.events[10].files, ["/workspace/demo/generated.mjs"]);
  assert.equal(result.events[11].command, "mcp__future__javascript");
  assert.equal(result.events[11].unclassified, true);
  assert.deepEqual(result.coverage, {
    duplicates: 0,
    oversized: 1,
    recognized: 17,
    skipped: 3,
    total: 23,
    unmapped: 0,
    unmappedTypes: [],
    unparseable: 2,
  });
  assert.deepEqual(result.summary, {
    asks: 1,
    commands: 3,
    edits: 3,
  });
  assertCoverageInvariant(result.coverage);
  assert.deepEqual(result.header, {
    cwd: fixture.workspace,
    git: {
      branch: "main",
      commit: "abc123",
      repository: "https://github.com/mallikcheripally/session-steward",
    },
    model: "gpt-5",
    origin: "codex-cli",
    provider: "codex",
    version: "0.146.0",
  });
  assert.equal(result.reason, null);
  assert.deepEqual(result.window, {
    complete: true,
    end: "newest",
    outcomesMayBeUnresolved: false,
  });
  assert.deepEqual(await directoryState(fixture.codexHome), before);

  const recent = await codex.readSessionEvents({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.parent,
    limit: 3,
    maxLineBytes: fixture.eventFixture.maxLineBytes,
  });
  assert.deepEqual(recent.events.map(({ kind }) => kind), ["summary", "edit", "ran"]);
  assert.equal(recent.events[0].text, "Prior context was compacted.");
  assert.equal(recent.events[2].command, "mcp__future__javascript");
  assert.deepEqual(recent.coverage, result.coverage);
  assert.deepEqual(recent.summary, result.summary);

  const preview = await codex.readSessionEvents({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.parent,
    limit: 4,
    maxLineBytes: fixture.eventFixture.maxLineBytes,
    mode: SESSION_EVENT_READ_MODE.PREVIEW,
  });
  assert.deepEqual(preview.events.map(({ kind }) => kind), ["ask", "ask", "said", "edit"]);
  assert.equal(preview.events[0].text, "<environment_context>Generated context</environment_context>");
  assert.equal(preview.events[3].applied, null);
  assert.deepEqual(preview.coverage, {
    duplicates: 0,
    oversized: 0,
    recognized: 4,
    skipped: 2,
    total: 6,
    unmapped: 0,
    unmappedTypes: [],
    unparseable: 0,
  });
  assertCoverageInvariant(preview.coverage);
  assert.deepEqual(preview.window, {
    complete: false,
    end: "oldest",
    outcomesMayBeUnresolved: true,
  });
});

test("Codex preserves end-only edits, MCP work, and unextracted commands", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const records = [
    {
      payload: { cwd: fixture.workspace, id: fixtureSessionIds.parent },
      type: "session_meta",
    },
    codexRecord({
      call_id: "patch-with-begin",
      changes: { "/workspace/old.mjs": { type: "update" } },
      type: "patch_apply_begin",
    }, 1),
    codexRecord({
      call_id: "patch-with-begin",
      changes: { "/workspace/better.mjs": { type: "update" } },
      success: true,
      type: "patch_apply_end",
    }, 2),
    codexRecord({
      call_id: "end-with-changes",
      changes: {
        "/workspace/added.mjs": { type: "add" },
        "/workspace/deleted.mjs": { type: "delete" },
      },
      success: true,
      type: "patch_apply_end",
    }, 3),
    codexRecord({
      call_id: "end-with-stdout",
      stdout: [
        "Success. Updated the following files:",
        "M /workspace/updated.mjs",
        "A /workspace/created.mjs",
        "D /workspace/removed.mjs",
      ].join("\n"),
      type: "patch_apply_end",
    }, 4),
    codexRecord({
      call_id: "mcp-command",
      invocation: {
        arguments: { command: "select 1", workdir: "/workspace" },
        server: "database",
        tool: "query",
      },
      result: { Ok: { content: [{ text: "done", type: "text" }], isError: false } },
      type: "mcp_tool_call_end",
    }, 5),
    codexRecord({
      call_id: "mcp-file",
      invocation: {
        arguments: { file_path: "/workspace/broken.mjs" },
        server: "files",
        tool: "write",
      },
      result: { Ok: { content: [{ text: "write failed", type: "text" }], isError: true } },
      type: "mcp_tool_call_end",
    }, 6),
    codexRecord({
      call_id: "mcp-generic",
      invocation: { arguments: {}, server: "browser", tool: "click" },
      result: { Ok: { content: [], isError: false } },
      type: "mcp_tool_call_end",
    }, 7),
    codexRecord({
      call_id: "unextracted",
      input: "const value = await tools.exec_command(dynamicOptions);",
      name: "exec",
      type: "custom_tool_call",
    }, 8),
    codexRecord({
      call_id: "unextracted",
      output: [{ text: "Script completed", type: "input_text" }],
      type: "custom_tool_call_output",
    }, 9),
    codexRecord({ type: "future_record_kind" }, 10),
  ];
  await fs.writeFile(fixture.transcripts.parent, records.map(jsonLine).join(""));

  const result = await codex.readSessionEvents({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.parent,
  });

  assert.deepEqual(result.events.map(({ kind }) => kind), [
    "edit",
    "edit",
    "edit",
    "ran",
    "edit",
    "ran",
    "ran",
  ]);
  assert.deepEqual(result.events[0].files, ["/workspace/better.mjs"]);
  assert.equal(result.events[0].applied, true);
  assert.deepEqual(result.events[1].files, [
    "/workspace/added.mjs",
    "/workspace/deleted.mjs",
  ]);
  assert.equal(result.events[1].added, null);
  assert.equal(result.events[1].removed, null);
  assert.deepEqual(result.events[2].files, [
    "/workspace/updated.mjs",
    "/workspace/created.mjs",
    "/workspace/removed.mjs",
  ]);
  assert.equal(result.events[3].command, "select 1");
  assert.equal(result.events[3].failed, false);
  assert.equal(result.events[4].applied, false);
  assert.equal(result.events[5].command, "mcp: browser/click");
  assert.equal(result.events[5].unclassified, false);
  assert.equal(result.events[6].command, null);
  assert.equal(result.events[6].failed, false);
  assert.equal(result.events[6].unextracted, true);
  assert.deepEqual(result.coverage.unmappedTypes, [
    { count: 1, type: "response_item:future_record_kind" },
  ]);
  assert.equal(sessionEventCoveragePercent(result.coverage), 90);
  assertCoverageInvariant(result.coverage);
});

test("Claude Code translates events, outcomes, decisions, and unknown tools", async (context) => {
  const fixture = await createClaudeHomeFixture({ includeEventTranscript: true });
  context.after(() => removeClaudeHomeFixture(fixture));
  claude.invalidateSessionCache(fixture);
  const before = {
    claude: await directoryState(fixture.claudeHome),
    desktop: await directoryState(fixture.desktopDataHome),
  };

  const result = await claude.readSessionEvents({
    ...fixture,
    id: fixture.cliId,
    limit: 100,
    maxLineBytes: fixture.eventFixture.maxLineBytes,
  });

  assert.deepEqual(result.events.map(({ kind }) => kind), [
    "ask",
    "ask",
    "said",
    "edit",
    "edit",
    "ran",
    "ran",
    "edit",
    "ran",
    "decided",
    "plan",
    "summary",
    "ran",
  ]);
  assert.equal(result.events[0].injected, true);
  assert.equal(result.events[1].injected, false);
  assert.equal(result.events[3].applied, true);
  assert.equal(result.events[4].applied, false);
  assert.equal(result.events[5].failed, false);
  assert.equal(result.events[6].failed, true);
  assert.equal(result.events[6].error, "Exit code 2");
  assert.deepEqual(result.events[7].files, ["/workspace/demo/generated.mjs"]);
  assert.equal(result.events[7].applied, true);
  assert.equal(result.events[8].command, "git status");
  assert.equal(result.events[8].failed, true);
  assert.equal(result.events[9].answer, "Fix now");
  assert.equal(result.events[12].command, "mcp__future__javascript");
  assert.equal(result.events[12].unclassified, true);
  assert.deepEqual(result.coverage, {
    duplicates: 0,
    oversized: 1,
    recognized: 17,
    skipped: 5,
    total: 25,
    unmapped: 0,
    unmappedTypes: [],
    unparseable: 2,
  });
  assert.deepEqual(result.summary, {
    asks: 1,
    commands: 4,
    edits: 3,
  });
  assertCoverageInvariant(result.coverage);
  assert.deepEqual(result.header, {
    cwd: "/workspace/demo",
    git: {
      branch: "main",
      commit: null,
      repository: null,
    },
    model: "claude-opus-4-1",
    origin: "cli",
    provider: "claude-code",
    version: "2.1.220",
  });
  assert.deepEqual({
    claude: await directoryState(fixture.claudeHome),
    desktop: await directoryState(fixture.desktopDataHome),
  }, before);
});

test("Claude Desktop reads the transcript selected by existing linkage", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));

  const result = await claude.readSessionEvents({
    ...fixture,
    id: fixture.desktopId,
    limit: 10,
  });

  assert.equal(result.header.origin, "claude-desktop");
  assert.equal(result.events[0].kind, "ask");
  assert.equal(result.events[0].text, "Polish the release dashboard");
});

test("provider readers preserve and mark only leading injected asks", async (context) => {
  await context.test("Codex", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));
    const records = [
      {
        payload: {
          cwd: fixture.workspace,
          id: fixtureSessionIds.parent,
        },
        type: "session_meta",
      },
      codexRecord({
        content: [{ text: "<future_context>Generated context</future_context>" }],
        role: "user",
        type: "message",
      }, 1),
      codexRecord({
        content: [{ text: "# Workspace instructions\nKeep changes focused." }],
        role: "user",
        type: "message",
      }, 2),
      codexRecord({
        content: [{ text: "Implement the reader." }],
        role: "user",
        type: "message",
      }, 3),
      codexRecord({
        content: [{ text: "<future_context>This is a literal example.</future_context>" }],
        role: "user",
        type: "message",
      }, 4),
    ];
    await fs.writeFile(fixture.transcripts.parent, records.map(jsonLine).join(""));

    const result = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
    });

    assert.deepEqual(result.events.map(({ injected }) => injected), [true, true, false, false]);
    assert.deepEqual(result.events.map(({ text }) => text), [
      "<future_context>Generated context</future_context>",
      "# Workspace instructions\nKeep changes focused.",
      "Implement the reader.",
      "<future_context>This is a literal example.</future_context>",
    ]);
    assert.equal(result.summary.asks, 2);
  });

  await context.test("Claude Code", async (subcontext) => {
    const fixture = await createClaudeHomeFixture();
    subcontext.after(() => removeClaudeHomeFixture(fixture));
    const records = [
      {
        cwd: "/workspace/demo",
        entrypoint: "cli",
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:00.000Z",
        type: "system",
      },
      {
        entrypoint: "cli",
        message: { content: [{ text: "<future_context>Generated context</future_context>", type: "text" }] },
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "user",
      },
      {
        entrypoint: "cli",
        message: { content: [{ text: "Implement the reader.", type: "text" }] },
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "user",
      },
      {
        entrypoint: "cli",
        message: { content: [{ text: "<future_context>This is a literal example.</future_context>", type: "text" }] },
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "user",
      },
    ];
    await fs.writeFile(fixture.cliTranscript, records.map(jsonLine).join(""));
    claude.invalidateSessionCache(fixture);

    const result = await claude.readSessionEvents({
      ...fixture,
      id: fixture.cliId,
    });

    assert.deepEqual(result.events.map(({ injected }) => injected), [true, false, false]);
    assert.equal(result.summary.asks, 2);
  });
});

test("full-session summaries are independent of the retained event window", async (context) => {
  await context.test("Codex", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));
    const records = [
      {
        payload: { cwd: fixture.workspace, id: fixtureSessionIds.parent },
        type: "session_meta",
      },
      ...Array.from({ length: 3 }, (unused, index) => codexRecord({
        call_id: `old-edit-${index}`,
        changes: { [`/workspace/old-${index}.mjs`]: { type: "update" } },
        success: index !== 1,
        type: "patch_apply_end",
      }, index + 1)),
      ...Array.from({ length: 20 }, (unused, index) => codexRecord({
        message: `Recent message ${index}`,
        type: "agent_message",
      }, index + 4)),
    ];
    await fs.writeFile(fixture.transcripts.parent, records.map(jsonLine).join(""));

    const recent = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
      limit: 10,
    });
    const full = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
      limit: 1_000,
    });

    assert.deepEqual(recent.summary, { asks: 0, commands: 0, edits: 3 });
    assert.equal(recent.events.some(({ kind }) => kind === "edit"), false);
    assert.equal(full.events.some(({ kind }) => kind === "edit"), true);
    assert.notEqual(recent.events.length, full.events.length);
    assert.equal(JSON.stringify(recent.summary), JSON.stringify(full.summary));
  });

  await context.test("Claude Code", async (subcontext) => {
    const fixture = await createClaudeHomeFixture();
    subcontext.after(() => removeClaudeHomeFixture(fixture));
    const timestamp = (sequence) => new Date(Date.UTC(2026, 7, 1, 10, 0, sequence)).toISOString();
    const records = [
      {
        cwd: "/workspace/demo",
        entrypoint: "cli",
        sessionId: fixture.cliId,
        timestamp: timestamp(0),
        type: "system",
      },
      ...Array.from({ length: 3 }, (unused, index) => ({
        entrypoint: "cli",
        message: {
          content: [{
            id: `old-edit-${index}`,
            input: { file_path: `/workspace/old-${index}.mjs` },
            name: "Edit",
            type: "tool_use",
          }],
        },
        sessionId: fixture.cliId,
        timestamp: timestamp(index + 1),
        type: "assistant",
      })),
      ...Array.from({ length: 20 }, (unused, index) => ({
        entrypoint: "cli",
        message: { content: [{ text: `Recent message ${index}`, type: "text" }] },
        sessionId: fixture.cliId,
        timestamp: timestamp(index + 4),
        type: "assistant",
      })),
    ];
    await fs.writeFile(fixture.cliTranscript, records.map(jsonLine).join(""));
    claude.invalidateSessionCache(fixture);

    const recent = await claude.readSessionEvents({ ...fixture, id: fixture.cliId, limit: 10 });
    const full = await claude.readSessionEvents({ ...fixture, id: fixture.cliId, limit: 1_000 });

    assert.deepEqual(recent.summary, { asks: 0, commands: 0, edits: 3 });
    assert.equal(recent.events.some(({ kind }) => kind === "edit"), false);
    assert.equal(full.events.some(({ kind }) => kind === "edit"), true);
    assert.notEqual(recent.events.length, full.events.length);
    assert.equal(JSON.stringify(recent.summary), JSON.stringify(full.summary));
  });
});

test("Codex classifies current lifecycle and tool-discovery records", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const records = [
    { payload: { collaboration_mode_kind: "default", type: "task_started" }, type: "event_msg" },
    { payload: { agent_thread_id: "child", kind: "updated", type: "sub_agent_activity" }, type: "event_msg" },
    { payload: { type: "context_compacted" }, type: "event_msg" },
    { payload: { num_turns: 1, type: "thread_rolled_back" }, type: "event_msg" },
    { payload: { reason: "interrupted", type: "turn_aborted" }, type: "event_msg" },
    { payload: { arguments: "{}", call_id: "search", type: "tool_search_call" }, type: "response_item" },
    { payload: { call_id: "search", tools: [], type: "tool_search_output" }, type: "response_item" },
  ];
  await fs.appendFile(fixture.transcripts.parent, records.map(jsonLine).join(""));

  const result = await codex.readSessionEvents({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.parent,
  });

  assert.deepEqual(result.events.map(({ text }) => text), [
    "Earlier context was compacted.",
    "Conversation rewound by 1 turn.",
    "Turn stopped: interrupted.",
  ]);
  assert.equal(result.coverage.recognized, 3);
  assert.equal(result.coverage.skipped, 5);
  assert.equal(result.coverage.unmapped, 0);
});

test("provider coverage does not hide structurally unknown records as skipped", async (context) => {
  await context.test("Codex", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));
    await fs.appendFile(fixture.transcripts.parent, jsonLine({ type: "future_record" }));

    const result = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
    });

    assert.deepEqual(result.coverage, {
      duplicates: 0,
      oversized: 0,
      recognized: 0,
      skipped: 1,
      total: 2,
      unmapped: 1,
      unmappedTypes: [{ count: 1, type: "future_record:missing payload type" }],
      unparseable: 0,
    });
    assert.equal(sessionEventCoveragePercent(result.coverage), 0);
  });

  await context.test("Claude Code", async (subcontext) => {
    const fixture = await createClaudeHomeFixture();
    subcontext.after(() => removeClaudeHomeFixture(fixture));
    const records = [
      {
        cwd: "/workspace/demo",
        entrypoint: "cli",
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:00.000Z",
        type: "system",
      },
      {
        entrypoint: "cli",
        message: { content: [{ text: "Implement the reader.", type: "text" }] },
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:01.000Z",
        type: "user",
      },
      {
        entrypoint: "cli",
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:02.000Z",
        type: "attachment",
      },
      {
        entrypoint: "cli",
        sessionId: fixture.cliId,
        timestamp: "2026-08-01T10:00:03.000Z",
        type: "future_record",
      },
    ];
    await fs.writeFile(fixture.cliTranscript, records.map(jsonLine).join(""));
    claude.invalidateSessionCache(fixture);

    const result = await claude.readSessionEvents({
      ...fixture,
      id: fixture.cliId,
    });

    assert.deepEqual(result.coverage, {
      duplicates: 0,
      oversized: 0,
      recognized: 1,
      skipped: 2,
      total: 4,
      unmapped: 1,
      unmappedTypes: [{ count: 1, type: "claude:future_record" }],
      unparseable: 0,
    });
    assert.equal(sessionEventCoveragePercent(result.coverage), 50);
  });
});

test("session event readers distinguish absent and empty transcripts", async (context) => {
  await context.test("no transcript path", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));
    const database = new DatabaseSync(fixture.stateDatabasePath);
    try {
      database.prepare("update threads set rollout_path = null where id = ?").run(fixtureSessionIds.parent);
    } finally {
      database.close();
    }

    const result = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
    });
    assert.equal(result.reason, SESSION_EVENT_REASON.NO_TRANSCRIPT_PATH);
    assert.deepEqual(result.events, []);
  });

  await context.test("transcript missing", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));
    await fs.rm(fixture.transcripts.parent);

    const result = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
    });
    assert.equal(result.reason, SESSION_EVENT_REASON.TRANSCRIPT_MISSING);
    assert.deepEqual(result.events, []);
  });

  await context.test("no recognized events", async (subcontext) => {
    const fixture = await createCodexHomeFixture();
    subcontext.after(() => removeCodexHomeFixture(fixture.codexHome));

    const result = await codex.readSessionEvents({
      codexHome: fixture.codexHome,
      id: fixtureSessionIds.parent,
    });
    assert.equal(result.reason, SESSION_EVENT_REASON.NO_RECOGNIZED_EVENTS);
    assert.deepEqual(result.coverage, {
      duplicates: 0,
      oversized: 0,
      recognized: 0,
      skipped: 1,
      total: 1,
      unmapped: 0,
      unmappedTypes: [],
      unparseable: 0,
    });
  });

  await context.test("Claude transcript disappears after discovery", async (subcontext) => {
    const fixture = await createClaudeHomeFixture();
    subcontext.after(() => removeClaudeHomeFixture(fixture));
    await claude.listSessions({ ...fixture, page: 1, pageSize: 25 });
    await fs.rm(fixture.cliTranscript);

    const result = await claude.readSessionEvents({
      ...fixture,
      id: fixture.cliId,
    });
    assert.equal(result.reason, SESSION_EVENT_REASON.TRANSCRIPT_MISSING);
  });
});

test("snapshot JSONL reading is bounded to the opened file state", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-events-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));

  await context.test("ignores bytes appended after the snapshot", async () => {
    const filePath = path.join(directory, "growing.jsonl");
    await fs.writeFile(filePath, `${jsonLine({ value: 1 })}${jsonLine({ value: 2 })}`);
    const values = [];
    const read = await visitJsonlSnapshotEntries(filePath, async (entry) => {
      values.push(entry.parsed.value);
      if (values.length === 1) await fs.appendFile(filePath, jsonLine({ value: 3 }));
    });

    assert.deepEqual(values, [1, 2]);
    assert.equal(read.complete, true);
  });

  await context.test("replaces invalid UTF-8 without throwing", async () => {
    const filePath = path.join(directory, "invalid-utf8.jsonl");
    await fs.writeFile(filePath, Buffer.concat([
      Buffer.from('{"value":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ]));
    const values = [];
    await visitJsonlSnapshotEntries(filePath, (entry) => values.push(entry.parsed.value));
    assert.deepEqual(values, ["�"]);
  });

  await context.test("returns partial entries when the snapshot shrinks", async () => {
    const filePath = path.join(directory, "shrinking.jsonl");
    const firstLine = jsonLine({ value: 1 });
    await fs.writeFile(filePath, `${firstLine}{"value":"${"x".repeat(100_000)}"}\n`);
    const entries = [];
    const read = await visitJsonlSnapshotEntries(
      filePath,
      async (entry) => {
        entries.push(entry);
        if (entries.length === 1) await fs.truncate(filePath, Buffer.byteLength(firstLine));
      },
      { maxLineBytes: 128 * 1024 },
    );

    assert.equal(read.complete, false);
    assert.equal(entries[0].parsed.value, 1);
    assert.equal(entries[1].parsed, null);
  });

  await context.test("keeps reading an opened file after it is unlinked", async () => {
    const filePath = path.join(directory, "deleted.jsonl");
    await fs.writeFile(filePath, `${jsonLine({ value: 1 })}${jsonLine({ value: 2 })}`);
    const values = [];
    const read = await visitJsonlSnapshotEntries(filePath, async (entry) => {
      values.push(entry.parsed.value);
      if (values.length === 1) await fs.rm(filePath);
    });

    assert.deepEqual(values, [1, 2]);
    assert.equal(read.complete, true);
  });
});

test("Codex collapses duplicated message envelopes without dropping unique text", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const transcriptPath = path.join(fixture.codexHome, "sessions", "duplicates.jsonl");
  const at = (seconds) => new Date(Date.parse("2026-07-01T00:00:00.000Z") + seconds * 1000).toISOString();
  const line = (timestamp, payload) => `${JSON.stringify({ payload, timestamp, type: "event_msg" })}\n`;
  await fs.writeFile(transcriptPath, [
    line(at(1), { content: [{ text: "Map the project structure", type: "input_text" }], role: "user", type: "message" }),
    line(at(1), { message: "Map the project structure", type: "user_message" }),
    line(at(2), { content: [{ text: "I will start with the entry points.", type: "output_text" }], role: "assistant", type: "message" }),
    line(at(2), { message: "I will start with the entry points.", type: "agent_message" }),
    line(at(3), { message: "Only the event envelope carries this one.", type: "agent_message" }),
    ...Array.from({ length: 12 }, (unused, index) => line(at(4 + index), { message: `filler ${index}`, type: "agent_message" })),
    line(at(30), { message: "Map the project structure", type: "user_message" }),
  ].join(""));

  const database = new DatabaseSync(fixture.stateDatabasePath);
  try {
    database.prepare("update threads set rollout_path = ? where id = ?").run(transcriptPath, fixtureSessionIds.standalone);
  } finally {
    database.close();
  }

  const result = await codex.readSessionEvents({ codexHome: fixture.codexHome, id: fixtureSessionIds.standalone, limit: 100 });
  const texts = result.events.map(({ text }) => text);

  assert.equal(result.coverage.duplicates, 2);
  assert.equal(result.summary.asks, 2);
  assert.equal(texts.filter((text) => text === "I will start with the entry points.").length, 1);
  assert.equal(texts.includes("Only the event envelope carries this one."), true);
  assert.equal(texts.filter((text) => text === "Map the project structure").length, 2);
  assert.equal(result.coverage.unmapped, 0);
  assert.equal(
    result.coverage.recognized + result.coverage.skipped + result.coverage.unmapped
      + result.coverage.unparseable + result.coverage.oversized,
    result.coverage.total,
  );
});
