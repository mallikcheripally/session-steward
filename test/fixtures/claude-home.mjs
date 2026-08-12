import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function claudeRecord(fixture, message, sequence, type) {
  return {
    entrypoint: "cli",
    message,
    sessionId: fixture.cliId,
    timestamp: new Date(Date.UTC(2026, 7, 1, 10, 0, sequence)).toISOString(),
    type,
  };
}

export async function writeClaudeEventTranscript(fixture) {
  const records = [
    {
      cwd: "/workspace/demo",
      entrypoint: "cli",
      gitBranch: "main",
      sessionId: fixture.cliId,
      timestamp: "2026-08-01T10:00:00.000Z",
      type: "system",
      version: "2.1.220",
    },
    claudeRecord(fixture, {
      content: [{ text: "<environment_context>Generated context</environment_context>", type: "text" }],
    }, 1, "user"),
    claudeRecord(fixture, {
      content: [{ text: "Implement the reader", type: "text" }],
    }, 2, "user"),
    claudeRecord(fixture, {
      content: [{ text: "I will keep it bounded.", type: "text" }],
      model: "claude-opus-4-1",
    }, 3, "assistant"),
    claudeRecord(fixture, {
      content: [{
        id: "edit-success",
        input: { file_path: "/workspace/demo/app.mjs" },
        name: "Edit",
        type: "tool_use",
      }],
    }, 4, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Updated file",
        is_error: false,
        tool_use_id: "edit-success",
        type: "tool_result",
      }],
    }, 5, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "edit-failure",
        input: { file_path: "/workspace/demo/failed.mjs" },
        name: "Write",
        type: "tool_use",
      }],
    }, 6, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Permission denied",
        is_error: true,
        tool_use_id: "edit-failure",
        type: "tool_result",
      }],
    }, 7, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "bash-success",
        input: { command: "npm run build" },
        name: "Bash",
        type: "tool_use",
      }],
    }, 8, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Build completed",
        is_error: false,
        tool_use_id: "bash-success",
        type: "tool_result",
      }],
    }, 9, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "bash-failure",
        input: { command: "npm test" },
        name: "Bash",
        type: "tool_use",
      }],
    }, 10, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Exit code 2",
        is_error: true,
        tool_use_id: "bash-failure",
        type: "tool_result",
      }],
    }, 11, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "future-file",
        input: { file_path: "/workspace/demo/generated.mjs" },
        name: "mcp__future__writer",
        type: "tool_use",
      }],
    }, 12, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Generated file",
        is_error: false,
        tool_use_id: "future-file",
        type: "tool_result",
      }],
    }, 13, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "future-command",
        input: { command: "git status" },
        name: "mcp__future__shell",
        type: "tool_use",
      }],
    }, 14, "assistant"),
    claudeRecord(fixture, {
      content: [{
        content: "Command failed",
        is_error: true,
        tool_use_id: "future-command",
        type: "tool_result",
      }],
    }, 15, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "question-1",
        input: { questions: [{ question: "Fix now or continue?" }] },
        name: "AskUserQuestion",
        type: "tool_use",
      }],
    }, 16, "assistant"),
    claudeRecord(fixture, {
      content: [{ text: "Fix now", type: "text" }],
    }, 17, "user"),
    claudeRecord(fixture, {
      content: [{
        id: "plan-1",
        input: { todos: [{ content: "Define the contract", status: "completed" }] },
        name: "TodoWrite",
        type: "tool_use",
      }],
    }, 18, "assistant"),
    {
      ...claudeRecord(fixture, { content: "Prior context was compacted." }, 19, "user"),
      isCompactSummary: true,
    },
    claudeRecord(fixture, {
      content: [{
        id: "future-unclassified",
        input: { script: "return document.title" },
        name: "mcp__future__javascript",
        type: "tool_use",
      }],
    }, 20, "assistant"),
    claudeRecord(fixture, {
      content: [{ text: "private reasoning", type: "thinking" }],
    }, 21, "assistant"),
  ];
  const oversized = claudeRecord(fixture, {
    content: [{ text: "x".repeat(2_000), type: "text" }],
  }, 22, "user");
  await fs.writeFile(
    fixture.cliTranscript,
    `${records.map(line).join("")}malformed line\n${line(oversized)}{"truncated":`,
  );
  return { maxLineBytes: 1_024, records };
}

export async function createClaudeHomeFixture({
  extraSessions = 0,
  includeEventTranscript = false,
  layout = "current",
} = {}) {
  if (!["current", "alternate"].includes(layout)) throw new Error(`Unknown Claude fixture layout: ${layout}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-claude-"));
  const claudeHome = path.join(root, ".claude");
  const desktopDataHome = path.join(root, "Claude");
  const projectDirectory = path.join(claudeHome, "projects", layout === "alternate" ? "workspace-demo-v2" : "-workspace-demo");
  const desktopSessions = path.join(desktopDataHome, "claude-code-sessions");
  const cliId = "11111111-1111-4111-8111-111111111111";
  const desktopId = "22222222-2222-4222-8222-222222222222";
  const unrelatedId = "33333333-3333-4333-8333-333333333333";
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.mkdir(path.join(claudeHome, "sessions"), { recursive: true });

  const createTranscript = async (id, entrypoint, title, cwd = "/workspace/demo") => {
    const transcriptPath = path.join(projectDirectory, `${id}.jsonl`);
    await fs.writeFile(transcriptPath, [
      line({ cwd, entrypoint, sessionId: id, timestamp: "2026-01-01T00:00:00.000Z", type: "system" }),
      line({ entrypoint, message: { content: title }, sessionId: id, timestamp: "2026-01-01T00:00:01.000Z", type: "user" }),
    ].join(""));
    return transcriptPath;
  };

  const cliTranscript = await createTranscript(cliId, "cli", "Refactor the authentication boundary");
  const desktopTranscript = await createTranscript(desktopId, "claude-desktop", "Polish the release dashboard");
  const unrelatedTranscript = await createTranscript(unrelatedId, "cli", "Keep this unrelated session");
  const desktopLocalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const desktopStatePath = path.join(desktopSessions, desktopLocalId, desktopLocalId, `local_${desktopLocalId}.json`);
  await fs.mkdir(path.dirname(desktopStatePath), { recursive: true });
  await fs.writeFile(desktopStatePath, JSON.stringify({
    cliSessionId: desktopId,
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    cwd: "/workspace/demo-worktree",
    isArchived: true,
    lastActivityAt: Date.parse("2026-01-02T00:00:00.000Z"),
    originCwd: "/workspace/demo",
    sessionId: desktopLocalId,
    title: "Desktop release dashboard",
  }));
  await fs.writeFile(
    path.join(path.dirname(desktopStatePath), "scheduled-tasks.json"),
    JSON.stringify({ recordedSkips: {}, scheduledTasks: {} }),
  );
  await fs.mkdir(path.join(projectDirectory, cliId, "subagents"), { recursive: true });
  await fs.writeFile(path.join(projectDirectory, cliId, "subagents", "agent-helper.jsonl"), line({ sessionId: cliId, type: "assistant" }));
  await fs.mkdir(path.join(claudeHome, "tasks", cliId), { recursive: true });
  await fs.writeFile(path.join(claudeHome, "tasks", cliId, "1.json"), "{}\n");
  await fs.mkdir(path.join(claudeHome, "file-history", cliId), { recursive: true });
  await fs.writeFile(path.join(claudeHome, "file-history", cliId, "checkpoint.txt"), "checkpoint\n");
  await fs.writeFile(path.join(claudeHome, "history.jsonl"), [
    line({ display: "selected", sessionId: cliId, timestamp: 1 }),
    line({ display: "desktop", sessionId: desktopId, timestamp: 2 }),
    line({ display: "unrelated", sessionId: unrelatedId, timestamp: 3 }),
  ].join(""));
  await fs.writeFile(path.join(desktopDataHome, "git-worktrees.json"), JSON.stringify({ schemaVersion: 1, worktrees: { keep: { path: "/workspace/demo-worktree" } } }));

  for (let index = 0; index < extraSessions; index += 1) {
    const id = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    await createTranscript(id, "cli", `Synthetic session ${index}`, `/workspace/project-${index % 25}`);
  }

  const fixture = { claudeHome, cliId, cliTranscript, desktopDataHome, desktopId, desktopStatePath, desktopTranscript, layout, root, unrelatedId, unrelatedTranscript };
  const eventFixture = includeEventTranscript
    ? await writeClaudeEventTranscript(fixture)
    : null;

  return { ...fixture, eventFixture };
}

export async function removeClaudeHomeFixture(fixture) {
  await fs.rm(fixture.root, { force: true, recursive: true });
}
