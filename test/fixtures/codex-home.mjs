import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const fixtureSessionIds = Object.freeze({
  child: "22222222-2222-4222-8222-222222222222",
  parent: "11111111-1111-4111-8111-111111111111",
  standalone: "33333333-3333-4333-8333-333333333333",
});

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDatabase(databasePath, sql) {
  execFileSync("sqlite3", [databasePath], {
    input: sql,
    stdio: ["pipe", "ignore", "pipe"],
  });
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

export async function createCodexHomeFixture({ includeUnknownDatabase = false } = {}) {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-codex-"));
  const sessionsDirectory = path.join(codexHome, "sessions", "2026", "07", "01");
  const workspace = path.join(codexHome, "workspace");
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  const transcripts = Object.fromEntries(
    Object.entries(fixtureSessionIds).map(([name, id]) => [
      name,
      path.join(sessionsDirectory, `rollout-${name}-${id}.jsonl`),
    ]),
  );

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

  const stateDatabasePath = path.join(codexHome, "state_5.sqlite");
  createDatabase(
    stateDatabasePath,
    `
      pragma foreign_keys = on;
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
      create table thread_spawn_edges (
        parent_thread_id text,
        child_thread_id text,
        status text
      );
      insert into threads values
        (${sqlValue(fixtureSessionIds.parent)}, ${sqlValue(transcripts.parent)}, ${sqlValue(workspace)}, 'Build a safer cleanup flow', 'Build a safer cleanup flow', null, null, 0, 1, 1751364000, 1751367600, 1751364000000, 1751367600000),
        (${sqlValue(fixtureSessionIds.child)}, ${sqlValue(transcripts.child)}, ${sqlValue(workspace)}, 'Inspect storage', 'Inspect storage', 'Scout', 'explorer', 0, 0, 1751364100, 1751367500, 1751364100000, 1751367500000),
        (${sqlValue(fixtureSessionIds.standalone)}, ${sqlValue(transcripts.standalone)}, ${sqlValue(workspace)}, '', 'Review package metadata', null, null, 1, 0, 1751364200, 1751367400, 1751364200000, 1751367400000);
      insert into thread_spawn_edges values
        (${sqlValue(fixtureSessionIds.parent)}, ${sqlValue(fixtureSessionIds.child)}, 'completed');
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

  return {
    codexHome,
    transcripts,
    workspace,
  };
}

export async function removeCodexHomeFixture(codexHome) {
  await fs.rm(codexHome, { force: true, recursive: true });
}
