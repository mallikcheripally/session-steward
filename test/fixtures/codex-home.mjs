import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";

export const fixtureSessionIds = Object.freeze({
  child: "22222222-2222-4222-8222-222222222222",
  parent: "11111111-1111-4111-8111-111111111111",
  standalone: "33333333-3333-4333-8333-333333333333",
});

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDatabase(databasePath, sql) {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

function transcriptHeader({ cwd, id, parentThreadId = null }) {
  const source = parentThreadId
    ? { subagent: { thread_spawn: { parent_thread_id: parentThreadId } } }
    : "cli";

  return JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd,
      source,
    },
  });
}

function eventRecord(payload, sequence) {
  return {
    payload,
    timestamp: new Date(Date.UTC(2026, 7, 1, 10, 0, sequence)).toISOString(),
    type: payload.type === "compacted" || payload.type === "patch_apply_end"
      ? "event_msg"
      : "response_item",
  };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export async function writeCodexEventTranscript(fixture) {
  const records = [
    {
      payload: {
        cli_version: "0.146.0",
        cwd: fixture.workspace,
        git: {
          branch: "main",
          commit_hash: "abc123",
          repository_url: "https://github.com/mallikcheripally/session-steward",
        },
        id: fixtureSessionIds.parent,
        originator: "codex-cli",
        timestamp: "2026-08-01T10:00:00.000Z",
      },
      type: "session_meta",
    },
    {
      payload: { cwd: fixture.workspace, model: "gpt-5", type: "turn_context" },
      timestamp: "2026-08-01T10:00:01.000Z",
      type: "turn_context",
    },
    eventRecord({
      content: [{ text: "<environment_context>Generated context</environment_context>" }],
      role: "user",
      type: "message",
    }, 2),
    eventRecord({
      content: [{ text: "Implement the event reader" }],
      role: "user",
      type: "message",
    }, 3),
    eventRecord({
      content: [{ text: "I will implement it safely." }],
      role: "assistant",
      type: "message",
    }, 4),
    eventRecord({
      call_id: "patch-success",
      input: "*** Begin Patch\n*** Update File: lib/example.mjs\n-old\n+new\n*** End Patch",
      name: "apply_patch",
      type: "custom_tool_call",
    }, 5),
    eventRecord({
      call_id: "patch-success",
      stdout: "Success. Updated files.",
      type: "patch_apply_end",
    }, 6),
    eventRecord({
      call_id: "patch-failure",
      input: "*** Begin Patch\n*** Add File: lib/failed.mjs\n+value\n*** End Patch",
      name: "apply_patch",
      type: "custom_tool_call",
    }, 7),
    eventRecord({
      call_id: "patch-failure",
      stdout: "Failed to apply patch.",
      type: "patch_apply_end",
    }, 8),
    eventRecord({
      call_id: "exec-failure",
      input: "const r = await tools.exec_command({\"cmd\":\"sed -n '1,240p' /path && rg -n \\\"pattern\\\" file\",\"workdir\":\"/Users/admin/dev/x\",\"yield_time_ms\":10000}); text(r.output);\n",
      name: "exec",
      type: "custom_tool_call",
    }, 9),
    eventRecord({
      call_id: "exec-failure",
      output: [{ text: "Script failed\nA test failed", type: "input_text" }],
      type: "custom_tool_call_output",
    }, 10),
    eventRecord({
      arguments: JSON.stringify({ command: "npm run build", workdir: "/workspace/session-steward" }),
      call_id: "future-command",
      name: "mcp__future__shell",
      type: "function_call",
    }, 11),
    eventRecord({
      call_id: "future-command",
      output: [{ text: "Script completed\nBuild passed", type: "input_text" }],
      type: "function_call_output",
    }, 12),
    eventRecord({
      arguments: JSON.stringify({ questions: [{ question: "Fix now or continue?" }] }),
      call_id: "decision-1",
      name: "request_user_input",
      type: "function_call",
    }, 13),
    eventRecord({ call_id: "decision-1", output: "Fix now", type: "function_call_output" }, 14),
    eventRecord({
      arguments: JSON.stringify({ plan: [{ status: "completed", step: "Define the contract" }] }),
      call_id: "plan-1",
      name: "update_plan",
      type: "function_call",
    }, 15),
    {
      payload: { message: "Prior context was compacted." },
      timestamp: "2026-08-01T10:00:16.000Z",
      type: "compacted",
    },
    eventRecord({
      arguments: JSON.stringify({ file_path: "/workspace/demo/generated.mjs" }),
      call_id: "future-file",
      name: "mcp__future__writer",
      type: "function_call",
    }, 17),
    eventRecord({
      arguments: "{}",
      call_id: "future-unclassified",
      name: "mcp__future__javascript",
      type: "function_call",
    }, 18),
    eventRecord({ summary: [], type: "reasoning" }, 19),
  ];
  const oversized = eventRecord({
    content: [{ text: "x".repeat(2_000) }],
    role: "user",
    type: "message",
  }, 20);
  await fs.writeFile(
    fixture.transcripts.parent,
    `${records.map(jsonLine).join("")}malformed line\n${jsonLine(oversized)}{"truncated":`,
  );
  return { maxLineBytes: 1_024, records };
}

export async function createCodexHomeFixture({
  includeEventTranscript = false,
  includeUnknownDatabase = false,
  layout = "state_5",
} = {}) {
  if (!["state_5", "state_6"].includes(layout)) throw new Error(`Unknown Codex fixture layout: ${layout}`);
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-codex-"));
  const sessionsDirectory = path.join(codexHome, "sessions", "2026", "07", "01");
  const archivedSessionsDirectory = path.join(codexHome, "archived_sessions");
  const workspace = path.join(codexHome, "workspace");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.mkdir(archivedSessionsDirectory, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  const transcripts = {
    child: path.join(sessionsDirectory, `rollout-child-${fixtureSessionIds.child}.jsonl`),
    parent: path.join(sessionsDirectory, `rollout-parent-${fixtureSessionIds.parent}.jsonl`),
    standalone: path.join(archivedSessionsDirectory, `rollout-standalone-${fixtureSessionIds.standalone}.jsonl`),
  };

  await Promise.all([
    fs.writeFile(
      transcripts.parent,
      `${transcriptHeader({ cwd: workspace, id: fixtureSessionIds.parent })}\n`,
    ),
    fs.writeFile(
      transcripts.child,
      `${transcriptHeader({
        cwd: workspace,
        id: fixtureSessionIds.child,
        parentThreadId: fixtureSessionIds.parent,
      })}\n`,
    ),
    fs.writeFile(
      transcripts.standalone,
      `${transcriptHeader({ cwd: workspace, id: fixtureSessionIds.standalone })}\n`,
    ),
  ]);

  const stateDatabasePath = path.join(codexHome, `${layout}.sqlite`);
  const stateSchema = `
    create table threads (
      id text primary key,
      rollout_path text,
      cwd text,
      title text,
      first_user_message text,
      agent_nickname text,
      agent_role text,
      archived integer default 0,
      is_pinned integer default 0,
      created_at integer,
      updated_at integer,
      created_at_ms integer,
      updated_at_ms integer
    );
  `;
  const stateRows = `
    insert into threads values
      (${sqlValue(fixtureSessionIds.parent)}, ${sqlValue(transcripts.parent)}, ${sqlValue(workspace)}, 'Build a safer cleanup flow', 'Build a safer cleanup flow', null, null, 0, 1, 1751364000, 1751367600, 1751364000000, 1751367600000),
      (${sqlValue(fixtureSessionIds.child)}, ${sqlValue(transcripts.child)}, ${sqlValue(workspace)}, 'Inspect storage', 'Inspect storage', 'Scout', 'explorer', 0, 0, 1751364100, 1751367500, 1751364100000, 1751367500000),
      (${sqlValue(fixtureSessionIds.standalone)}, ${sqlValue(transcripts.standalone)}, ${sqlValue(workspace)}, '', 'Review package metadata', null, null, 1, 0, 1751364200, 1751367400, 1751364200000, 1751367400000);
  `;
  createDatabase(
    stateDatabasePath,
    `
      pragma foreign_keys = on;
      ${stateSchema}
      create table thread_spawn_edges (
        parent_thread_id text,
        child_thread_id text,
        status text
      );
      create table thread_dynamic_tools (
        thread_id text,
        position integer,
        name text,
        primary key (thread_id, position),
        foreign key (thread_id) references threads(id) on delete cascade
      );
      ${stateRows}
      insert into thread_spawn_edges values
        (${sqlValue(fixtureSessionIds.parent)}, ${sqlValue(fixtureSessionIds.child)}, 'completed');
      insert into thread_dynamic_tools values
        (${sqlValue(fixtureSessionIds.parent)}, 0, 'parent-tool'),
        (${sqlValue(fixtureSessionIds.child)}, 0, 'child-tool'),
        (${sqlValue(fixtureSessionIds.standalone)}, 0, 'standalone-tool');
    `,
  );

  createDatabase(
    path.join(codexHome, "logs_2.sqlite"),
    `
      create table logs (thread_id text, message text);
      insert into logs values
        (${sqlValue(fixtureSessionIds.parent)}, 'parent log'),
        (${sqlValue(fixtureSessionIds.child)}, 'child log'),
        (${sqlValue(fixtureSessionIds.standalone)}, 'standalone log');
    `,
  );
  createDatabase(
    path.join(codexHome, "memories_1.sqlite"),
    `
      create table stage1_outputs (thread_id text, output text);
      insert into stage1_outputs values
        (${sqlValue(fixtureSessionIds.parent)}, 'parent memory'),
        (${sqlValue(fixtureSessionIds.child)}, 'child memory');
    `,
  );
  createDatabase(
    path.join(codexHome, "goals_1.sqlite"),
    `
      pragma foreign_keys = on;
      create table thread_goals (thread_id text primary key, objective text);
      create table thread_goal_continuation_deferrals (
        thread_id text,
        reason text,
        foreign key (thread_id) references thread_goals(thread_id) on delete cascade
      );
      insert into thread_goals values
        (${sqlValue(fixtureSessionIds.parent)}, 'parent goal'),
        (${sqlValue(fixtureSessionIds.child)}, 'child goal');
      insert into thread_goal_continuation_deferrals values
        (${sqlValue(fixtureSessionIds.parent)}, 'waiting');
    `,
  );
  createDatabase(
    path.join(codexHome, "queue_1.sqlite"),
    `
      create table queued_items (
        id text primary key,
        thread_id text not null,
        payload_json text not null,
        queue_order integer not null,
        created_at_ms integer not null,
        updated_at_ms integer not null
      );
      create table queued_thread_revisions (
        revision integer primary key autoincrement,
        thread_id text not null unique
      );
      create trigger queued_items_revision_after_delete
      after delete on queued_items
      begin
        insert into queued_thread_revisions (thread_id)
        values (old.thread_id)
        on conflict(thread_id) do update
        set revision = (select coalesce(max(revision), 0) + 1 from queued_thread_revisions);
      end;
      insert into queued_items values
        ('queue-parent', ${sqlValue(fixtureSessionIds.parent)}, '{}', 1, 1751364000000, 1751364000000),
        ('queue-child', ${sqlValue(fixtureSessionIds.child)}, '{}', 2, 1751364100000, 1751364100000),
        ('queue-standalone', ${sqlValue(fixtureSessionIds.standalone)}, '{}', 3, 1751364200000, 1751364200000);
      insert into queued_thread_revisions (thread_id) values
        (${sqlValue(fixtureSessionIds.parent)}),
        (${sqlValue(fixtureSessionIds.child)}),
        (${sqlValue(fixtureSessionIds.standalone)});
    `,
  );
  createDatabase(
    path.join(codexHome, "thread_history_1.sqlite"),
    `
      create table thread_turns (
        thread_id text not null,
        turn_id text not null,
        rollout_ordinal integer not null,
        status text not null,
        primary key (thread_id, turn_id)
      );
      create table thread_items (
        thread_id text not null,
        turn_id text not null,
        item_id text not null,
        rollout_ordinal integer not null,
        created_at_ms integer not null,
        item_json text not null,
        primary key (thread_id, turn_id, item_id)
      );
      create table thread_history_projection_state (
        thread_id text primary key,
        next_rollout_byte_offset integer not null,
        next_rollout_ordinal integer not null
      );
      create table thread_realtime_items (
        thread_id text not null,
        item_id text not null,
        rollout_ordinal integer not null,
        created_at_ms integer not null,
        item_type text not null,
        item_json text not null,
        primary key (thread_id, item_id)
      );
      insert into thread_turns values
        (${sqlValue(fixtureSessionIds.parent)}, 'turn-parent', 1, 'completed'),
        (${sqlValue(fixtureSessionIds.child)}, 'turn-child', 1, 'completed'),
        (${sqlValue(fixtureSessionIds.standalone)}, 'turn-standalone', 1, 'completed');
      insert into thread_items values
        (${sqlValue(fixtureSessionIds.parent)}, 'turn-parent', 'item-parent', 2, 1751364000000, '{}'),
        (${sqlValue(fixtureSessionIds.child)}, 'turn-child', 'item-child', 2, 1751364100000, '{}'),
        (${sqlValue(fixtureSessionIds.standalone)}, 'turn-standalone', 'item-standalone', 2, 1751364200000, '{}');
      insert into thread_history_projection_state values
        (${sqlValue(fixtureSessionIds.parent)}, 100, 3),
        (${sqlValue(fixtureSessionIds.child)}, 100, 3),
        (${sqlValue(fixtureSessionIds.standalone)}, 100, 3);
      insert into thread_realtime_items values
        (${sqlValue(fixtureSessionIds.parent)}, 'realtime-parent', 3, 1751364000000, 'realtime_session_started', '{}'),
        (${sqlValue(fixtureSessionIds.child)}, 'realtime-child', 3, 1751364100000, 'realtime_session_started', '{}'),
        (${sqlValue(fixtureSessionIds.standalone)}, 'realtime-standalone', 3, 1751364200000, 'realtime_session_started', '{}');
    `,
  );

  const sessionIndex = [
    { id: fixtureSessionIds.parent, thread_name: "Safer cleanup", updated_at: "2026-07-01T11:00:00.000Z" },
    { id: fixtureSessionIds.child, thread_name: "Storage inspection", updated_at: "2026-07-01T10:58:00.000Z" },
    { id: fixtureSessionIds.standalone, thread_name: "Package review", updated_at: "2026-07-01T10:55:00.000Z" },
  ];
  const history = [
    { session_id: fixtureSessionIds.parent, ts: 1751364000000, text: "Build a safer cleanup flow" },
    { session_id: fixtureSessionIds.child, ts: 1751364100000, text: "Inspect storage" },
    { session_id: fixtureSessionIds.standalone, ts: 1751364200000, text: "Review package metadata" },
  ];

  await Promise.all([
    fs.writeFile(
      path.join(codexHome, "session_index.jsonl"),
      `${sessionIndex.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    ),
    fs.writeFile(
      path.join(codexHome, "history.jsonl"),
      `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    ),
    fs.writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      `${JSON.stringify({
        "thread-project-assignments": {
          [fixtureSessionIds.parent]: "project-a",
          [fixtureSessionIds.standalone]: "project-b",
        },
        "projectless-thread-ids": [fixtureSessionIds.child],
      })}\n`,
    ),
    fs.writeFile(
      path.join(codexHome, ".codex-global-state.json.bak"),
      `${JSON.stringify({
        "thread-writable-roots": {
          [fixtureSessionIds.parent]: [workspace],
        },
      })}\n`,
    ),
  ]);

  if (includeUnknownDatabase) {
    createDatabase(
      path.join(codexHome, "future_1.sqlite"),
      "create table future_records (session_id text, payload text);",
    );
  }

  const fixture = {
    codexHome,
    layout,
    stateDatabasePath,
    transcripts,
    workspace,
  };
  const eventFixture = includeEventTranscript
    ? await writeCodexEventTranscript(fixture)
    : null;

  return {
    ...fixture,
    eventFixture,
  };
}

export async function removeCodexHomeFixture(codexHome) {
  await fs.rm(codexHome, { force: true, recursive: true });
}

export async function createLargeCodexHomeFixture({ sessionCount = 12_000 } = {}) {
  const fixture = await createCodexHomeFixture();
  const database = new DatabaseSync(fixture.stateDatabasePath);

  try {
    database.exec("begin immediate");
    const insert = database.prepare(`
      insert into threads (
        id, rollout_path, cwd, title, first_user_message,
        agent_nickname, agent_role, archived, is_pinned,
        created_at, updated_at, created_at_ms, updated_at_ms
      ) values (?, null, ?, ?, ?, null, null, 0, 0, ?, ?, ?, ?)
    `);

    for (let index = 0; index < sessionCount; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const timestamp = 1_751_000_000_000 + index;
      insert.run(
        `scale-${suffix}`,
        fixture.workspace,
        `Scale session ${suffix}`,
        `Scale session ${suffix}`,
        Math.floor(timestamp / 1000),
        Math.floor(timestamp / 1000),
        timestamp,
        timestamp,
      );
    }

    database.exec("commit");
  } catch (error) {
    if (database.isTransaction) database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }

  return {
    ...fixture,
    sessionCount,
  };
}

export async function attachSizedTranscripts(
  fixture,
  { sessionCount = fixture.sessionCount, sizeForIndex = (index) => 64 + (index % 4096) } = {},
) {
  const transcriptsDirectory = path.join(fixture.codexHome, "sessions", "sized");
  const transcriptPaths = new Map();
  const batchSize = 64;
  await fs.mkdir(transcriptsDirectory, { recursive: true });

  for (let start = 0; start < sessionCount; start += batchSize) {
    const writes = [];
    const end = Math.min(sessionCount, start + batchSize);

    for (let index = start; index < end; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const id = `scale-${suffix}`;
      const transcriptPath = path.join(transcriptsDirectory, `rollout-${suffix}.jsonl`);
      transcriptPaths.set(id, transcriptPath);
      writes.push(fs.writeFile(transcriptPath, Buffer.alloc(Math.max(0, sizeForIndex(index)))));
    }

    await Promise.all(writes);
  }

  const database = new DatabaseSync(fixture.stateDatabasePath);

  try {
    database.exec("begin immediate");
    const update = database.prepare("update threads set rollout_path = ? where id = ?");
    for (const [id, transcriptPath] of transcriptPaths) update.run(transcriptPath, id);
    database.exec("commit");
  } catch (error) {
    if (database.isTransaction) database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }

  return transcriptPaths;
}

export async function appendTranscriptOnlySessions(
  fixture,
  { sessionCount = 500 } = {},
) {
  const sessionsDirectory = path.join(fixture.codexHome, "sessions", "transcript-only");
  const batchSize = 50;
  await fs.mkdir(sessionsDirectory, { recursive: true });

  for (let start = 0; start < sessionCount; start += batchSize) {
    const writes = [];
    const end = Math.min(sessionCount, start + batchSize);

    for (let index = start; index < end; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const id = `transcript-only-${suffix}`;
      const transcriptPath = path.join(
        sessionsDirectory,
        `rollout-transcript-only-${suffix}.jsonl`,
      );
      writes.push(fs.writeFile(
        transcriptPath,
        `${transcriptHeader({ cwd: fixture.workspace, id })}\n`,
      ));
    }

    await Promise.all(writes);
  }

  return {
    firstId: "transcript-only-000000",
    lastId: `transcript-only-${String(sessionCount - 1).padStart(6, "0")}`,
    sessionCount,
  };
}

export async function appendTranscriptOnlySubagent(
  fixture,
  { id = "transcript-only-subagent", parentId = fixtureSessionIds.parent } = {},
) {
  const sessionsDirectory = path.join(fixture.codexHome, "sessions", "transcript-only");
  const transcriptPath = path.join(sessionsDirectory, `rollout-${id}.jsonl`);
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${transcriptHeader({ cwd: fixture.workspace, id, parentThreadId: parentId })}\n`,
  );

  return { id, parentId, transcriptPath };
}

async function appendGeneratedLines(filePath, count, createEntry, trailingLines) {
  const output = createWriteStream(filePath, { encoding: "utf8", flags: "a" });

  try {
    for (let index = 0; index < count; index += 1) {
      if (!output.write(`${JSON.stringify(createEntry(index))}\n`)) {
        await once(output, "drain");
      }
    }

    for (const line of trailingLines) {
      if (!output.write(`${line}\n`)) {
        await once(output, "drain");
      }
    }

    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
}

export async function appendLargeJsonlFixture(fixture, { entryCount = 50_000 } = {}) {
  const historyPath = path.join(fixture.codexHome, "history.jsonl");
  const sessionIndexPath = path.join(fixture.codexHome, "session_index.jsonl");

  await Promise.all([
    appendGeneratedLines(
      historyPath,
      entryCount,
      (index) => ({ session_id: `bulk-${index}`, ts: index, text: `History ${index}` }),
      [
        JSON.stringify({ session_id: fixtureSessionIds.parent, ts: 1, text: "Repeated parent" }),
        "malformed history line",
      ],
    ),
    appendGeneratedLines(
      sessionIndexPath,
      entryCount,
      (index) => ({ id: `bulk-${index}`, thread_name: `Session ${index}`, updated_at: String(index) }),
      [
        JSON.stringify({ id: fixtureSessionIds.child, thread_name: "Repeated child", updated_at: "2026-07-02T00:00:00.000Z" }),
        JSON.stringify({ id: fixtureSessionIds.standalone, thread_name: "Standalone duplicate one", updated_at: "2026-07-02T00:00:00.000Z" }),
        JSON.stringify({ id: fixtureSessionIds.standalone, thread_name: "Standalone duplicate two", updated_at: "2026-07-03T00:00:00.000Z" }),
        "malformed index line",
      ],
    ),
  ]);

  return { entryCount, historyPath, sessionIndexPath };
}
