import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createReadOnlyMcpServer } from "../lib/mcp.mjs";
import {
  createClaudeHomeFixture,
  removeClaudeHomeFixture,
} from "./fixtures/claude-home.mjs";
import {
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";

const TOOL_NAMES = [
  "get_session",
  "get_session_overview",
  "list_sessions",
  "read_session_timeline",
  "read_session_tokens",
];

async function directoryState(root) {
  const entries = (await fs.readdir(root, { recursive: true })).sort();
  const files = {};

  for (const relativePath of entries) {
    const stats = await fs.stat(path.join(root, relativePath));
    if (stats.isFile()) {
      files[relativePath] = { mtimeMs: stats.mtimeMs, size: stats.size };
    }
  }

  return { entries, files };
}

async function connect(settings, options = {}) {
  const server = createReadOnlyMcpServer({ settings, ...options });
  const client = new Client({ name: "session-steward-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

async function call(client, name, args) {
  const result = await client.callTool({ arguments: args, name });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.notEqual(result.structuredContent, undefined);
  return result.structuredContent;
}

function assertSafeSession(session) {
  assert.deepEqual(Object.keys(session).sort(), [
    "activity",
    "agent",
    "archived",
    "id",
    "pinned",
    "provider",
    "relationship",
    "surface",
    "title",
    "transcript",
    "workspace",
  ]);
  assert.equal("rolloutPath" in session, false);
  assert.equal("recordSource" in session, false);
  assert.equal("titleSource" in session, false);
}

test("MCP publishes only bounded read-only tools with strict inputs", async (context) => {
  const fixture = await createCodexHomeFixture();
  const connection = await connect({ getHome: () => fixture.codexHome });
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  for (const tool of listed.tools) {
    assert.deepEqual(tool.annotations, {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    });
  }
  const listTool = listed.tools.find((tool) => tool.name === "list_sessions");
  assert.match(listTool.description, /chats, threads, and conversations/u);
  assert.match(listTool.description, /old, unused, inactive/u);
  assert.match(listTool.description, /pageCount/u);

  const largestAcceptedPage = await call(connection.client, "list_sessions", {
    pageSize: 100,
    provider: "codex",
  });
  assert.equal(largestAcceptedPage.page, 1);

  const oversizedPage = await connection.client.callTool({
    arguments: { pageSize: 101, provider: "codex" },
    name: "list_sessions",
  });
  assert.equal(oversizedPage.isError, true);

  const unknownInput = await connection.client.callTool({
    arguments: { provider: "codex", unexpected: true },
    name: "get_session_overview",
  });
  assert.equal(unknownInput.isError, true);
});

test("MCP cancellation reaches long transcript reads", async (context) => {
  let markAborted;
  let markStarted;
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    displayName: "Codex",
    readSessionEvents: async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal);
      markStarted();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      markAborted();
      throw new Error("Read cancelled.");
    },
  };
  const connection = await connect(
    { getHome: () => "/unused" },
    { resolveProvider: () => provider },
  );
  context.after(() => connection.close());

  const controller = new AbortController();
  const request = connection.client.callTool({
    arguments: { id: "session-id", provider: "codex" },
    name: "read_session_timeline",
  }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(request);
  let timeout;
  try {
    await Promise.race([
      aborted,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Server read did not observe cancellation.")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});

test("the MCP executable serves Codex and Claude Code over real stdio", async (context) => {
  const codexFixture = await createCodexHomeFixture({ includeEventTranscript: true });
  const claudeFixture = await createClaudeHomeFixture({ includeEventTranscript: true });
  const isolatedHome = path.join(claudeFixture.root, "mcp-user-home");
  await fs.mkdir(isolatedHome, { recursive: true });
  const environment = {
    ...getDefaultEnvironment(),
    APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
    HOME: isolatedHome,
    LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
    USERPROFILE: isolatedHome,
  };
  const transport = new StdioClientTransport({
    args: [
      path.resolve("bin/session-steward-mcp.mjs"),
      "--codex-home",
      codexFixture.codexHome,
      "--claude-home",
      claudeFixture.claudeHome,
    ],
    command: process.execPath,
    cwd: path.resolve("."),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({ name: "session-steward-stdio-test", version: "1.0.0" });
  context.after(async () => {
    await Promise.allSettled([client.close(), transport.close()]);
    await Promise.all([
      removeCodexHomeFixture(codexFixture.codexHome),
      removeClaudeHomeFixture(claudeFixture),
    ]);
  });

  await client.connect(transport);
  assert.ok(transport.pid);
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map((tool) => tool.name).sort(), TOOL_NAMES);

  const codex = await call(client, "get_session", {
    id: fixtureSessionIds.parent,
    provider: "codex",
  });
  assert.equal(codex.session.provider, "codex");

  const claude = await call(client, "get_session", {
    id: claudeFixture.cliId,
    provider: "claude-code",
  });
  assert.equal(claude.session.provider, "claude-code");
});

test("Codex MCP reads stay bounded and leave provider files unchanged", async (context) => {
  const fixture = await createCodexHomeFixture({ includeEventTranscript: true });
  const before = await directoryState(fixture.codexHome);
  const connection = await connect({ getHome: () => fixture.codexHome });
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const overview = await call(connection.client, "get_session_overview", {
    provider: "codex",
    workspaceLimit: 1,
  });
  assert.equal(overview.provider, "codex");
  assert.ok(overview.workspaces.length <= 1);

  const listed = await call(connection.client, "list_sessions", {
    pageSize: 1,
    provider: "codex",
  });
  assert.equal(listed.sessions.length, 1);
  assertSafeSession(listed.sessions[0]);

  const parentBytes = (await fs.stat(fixture.transcripts.parent)).size;
  const largeOnly = await call(connection.client, "list_sessions", {
    includeInternals: true,
    includeSupporting: true,
    minimumTranscriptBytes: parentBytes,
    provider: "codex",
  });
  assert.deepEqual(largeOnly.sessions.map(({ id }) => id), [fixtureSessionIds.parent]);

  const details = await call(connection.client, "get_session", {
    id: fixtureSessionIds.parent,
    provider: "codex",
  });
  assertSafeSession(details.session);

  const timeline = await call(connection.client, "read_session_timeline", {
    id: fixtureSessionIds.parent,
    limit: 1,
    provider: "codex",
  });
  assert.equal(timeline.events.length, 1);
  assert.equal(timeline.provider, "codex");

  const tokens = await call(connection.client, "read_session_tokens", {
    id: fixtureSessionIds.parent,
    provider: "codex",
  });
  assert.equal(tokens.id, fixtureSessionIds.parent);
  assert.equal(tokens.provider, "codex");

  assert.deepEqual(await directoryState(fixture.codexHome), before);
});

test("Claude Code MCP reads stay bounded and leave CLI and desktop files unchanged", async (context) => {
  const fixture = await createClaudeHomeFixture({ includeEventTranscript: true });
  const before = {
    claude: await directoryState(fixture.claudeHome),
    desktop: await directoryState(fixture.desktopDataHome),
  };
  const connection = await connect({
    getClaudeDesktopDataHome: () => fixture.desktopDataHome,
    getHome: () => fixture.claudeHome,
  });
  context.after(async () => {
    await connection.close();
    await removeClaudeHomeFixture(fixture);
  });

  const overview = await call(connection.client, "get_session_overview", {
    provider: "claude-code",
    workspaceLimit: 1,
  });
  assert.equal(overview.provider, "claude-code");
  assert.ok(overview.workspaces.length <= 1);

  const listed = await call(connection.client, "list_sessions", {
    pageSize: 1,
    provider: "claude-code",
  });
  assert.equal(listed.sessions.length, 1);
  assertSafeSession(listed.sessions[0]);

  const cliBytes = (await fs.stat(fixture.cliTranscript)).size;
  const largeOnly = await call(connection.client, "list_sessions", {
    minimumTranscriptBytes: cliBytes,
    provider: "claude-code",
  });
  assert.deepEqual(largeOnly.sessions.map(({ id }) => id), [fixture.cliId]);

  const details = await call(connection.client, "get_session", {
    id: fixture.cliId,
    provider: "claude-code",
  });
  assertSafeSession(details.session);

  const timeline = await call(connection.client, "read_session_timeline", {
    id: fixture.cliId,
    limit: 1,
    provider: "claude-code",
  });
  assert.equal(timeline.events.length, 1);
  assert.equal(timeline.provider, "claude-code");

  const tokens = await call(connection.client, "read_session_tokens", {
    id: fixture.cliId,
    provider: "claude-code",
  });
  assert.equal(tokens.id, fixture.cliId);
  assert.equal(tokens.provider, "claude-code");

  assert.deepEqual({
    claude: await directoryState(fixture.claudeHome),
    desktop: await directoryState(fixture.desktopDataHome),
  }, before);
});
