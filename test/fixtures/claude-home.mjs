import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

export async function createClaudeHomeFixture({ extraSessions = 0, layout = "current" } = {}) {
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

  return { claudeHome, cliId, cliTranscript, desktopDataHome, desktopId, desktopStatePath, desktopTranscript, layout, root, unrelatedId, unrelatedTranscript };
}

export async function removeClaudeHomeFixture(fixture) {
  await fs.rm(fixture.root, { force: true, recursive: true });
}
