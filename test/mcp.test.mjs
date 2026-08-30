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

import { createMcpServer } from "../lib/mcp.mjs";
import { createCleanupScheduleStore } from "../lib/cleanup-schedules.mjs";
import { getProvider } from "../lib/providers/index.mjs";
import { createProviderSettings } from "../lib/settings.mjs";
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
  "clean_sessions",
  "find_sessions",
  "get_overview",
  "inspect_session",
  "list_backups",
  "manage_automatic_cleanup",
  "manage_settings",
  "restore_backup",
];

const DESTRUCTIVE_TOOL_NAMES = new Set([
  "clean_sessions",
  "manage_automatic_cleanup",
  "restore_backup",
]);

const MUTATING_TOOL_NAMES = new Set([
  "manage_settings",
]);

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
  const server = createMcpServer({ settings, ...options });
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

test("MCP publishes bounded tools with strict inputs and accurate safety annotations", async (context) => {
  const fixture = await createCodexHomeFixture();
  const connection = await connect({ getHome: () => fixture.codexHome });
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  for (const tool of listed.tools) {
    assert.equal(tool.outputSchema, undefined);
    assert.deepEqual(tool.annotations, DESTRUCTIVE_TOOL_NAMES.has(tool.name)
      ? {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      }
      : MUTATING_TOOL_NAMES.has(tool.name)
        ? {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        }
      : {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      });
  }
  const listTool = listed.tools.find((tool) => tool.name === "find_sessions");
  assert.match(listTool.description, /chats, threads, conversations/u);
  assert.match(listTool.description, /old, unused, inactive/u);
  assert.match(listTool.description, /fetch all pages only/u);

  const largestAcceptedPage = await call(connection.client, "find_sessions", {
    inactiveDays: 50,
    pageSize: 100,
    provider: "codex",
  });
  assert.equal(largestAcceptedPage.providers[0].page, 1);

  const oversizedPage = await connection.client.callTool({
    arguments: { pageSize: 101, provider: "codex" },
    name: "find_sessions",
  });
  assert.equal(oversizedPage.isError, true);

  const unknownInput = await connection.client.callTool({
    arguments: { provider: "codex", unexpected: true },
    name: "get_overview",
  });
  assert.equal(unknownInput.isError, true);

  const oversizedBackupPage = await connection.client.callTool({
    arguments: { pageSize: 101, provider: "codex" },
    name: "list_backups",
  });
  assert.equal(oversizedBackupPage.isError, true);
});

test("MCP combines both providers while preserving provider and workspace paging", async (context) => {
  const codexFixture = await createCodexHomeFixture();
  const claudeFixture = await createClaudeHomeFixture();
  const installedVersions = {
    chatgptDesktop: "test-chatgpt",
    claudeCli: "test-claude-cli",
    claudeDesktop: "test-claude-desktop",
    codexCli: "test-codex-cli",
  };
  const settings = {
    getClaudeDesktopDataHome: () => claudeFixture.desktopDataHome,
    getHome: (provider) => provider === "codex"
      ? codexFixture.codexHome
      : claudeFixture.claudeHome,
  };
  const connection = await connect(settings, {
    readInstalledProductVersions: async () => installedVersions,
  });
  context.after(async () => {
    await connection.close();
    await Promise.all([
      removeCodexHomeFixture(codexFixture.codexHome),
      removeClaudeHomeFixture(claudeFixture),
    ]);
  });

  const overview = await call(connection.client, "get_overview", {
    includeCompatibility: true,
    provider: "all",
    workspacePageSize: 1,
  });
  assert.deepEqual(overview.providers.map(({ provider }) => provider), ["codex", "claude-code"]);
  assert.equal(
    overview.totals.sessions,
    overview.providers.reduce((sum, item) => sum + item.counts.sessions, 0),
  );
  assert.equal(
    overview.totals.transcriptBytes,
    overview.providers.reduce((sum, item) => sum + item.storage.transcriptBytes, 0),
  );
  for (const item of overview.providers) {
    assert.ok(item.workspaces.items.length <= 1);
    assert.deepEqual(item.compatibility.currentVersions, installedVersions);
  }

  const listed = await call(connection.client, "find_sessions", {
    pageSize: 1,
    provider: "all",
  });
  assert.deepEqual(listed.providers.map(({ provider }) => provider), ["codex", "claude-code"]);
  assert.equal(listed.returned, 2);
  assert.equal(listed.total, listed.providers.reduce((sum, item) => sum + item.total, 0));
});

test("MCP reads and updates only Session Steward provider settings", async (context) => {
  const fixture = await createCodexHomeFixture();
  const claudeFixture = await createClaudeHomeFixture();
  const configDirectory = path.join(fixture.codexHome, "mcp-settings");
  const settings = await createProviderSettings({ configDirectory });
  const connection = await connect(settings);
  context.after(async () => {
    await connection.close();
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      removeClaudeHomeFixture(claudeFixture),
    ]);
  });

  const initial = await call(connection.client, "get_overview", {
    includeSettings: true,
    provider: "codex",
  });
  assert.equal(initial.settings.activeProvider, "codex");
  assert.equal(initial.settings.providers.codex.source, "default");

  const saved = await call(connection.client, "manage_settings", {
    action: "set-provider-home",
    home: fixture.codexHome,
    provider: "codex",
  });
  assert.equal(saved.providers.codex.home, fixture.codexHome);
  assert.equal(saved.providers.codex.source, "saved");

  const active = await call(connection.client, "manage_settings", {
    action: "set-default-provider",
    provider: "claude-code",
  });
  assert.equal(active.activeProvider, "claude-code");

  const restored = await call(connection.client, "manage_settings", {
    action: "reset-provider-home",
    provider: "codex",
  });
  assert.equal(restored.providers.codex.isDefault, true);
  assert.equal(restored.providers.codex.source, "default");

  const reloaded = await createProviderSettings({ configDirectory });
  assert.equal(reloaded.getActiveProviderId(), "claude-code");
  assert.equal(reloaded.getAll().codex.source, "default");

  const invalid = await connection.client.callTool({
    arguments: {
      action: "reset-provider-home",
      home: fixture.codexHome,
      provider: "codex",
    },
    name: "manage_settings",
  });
  assert.equal(invalid.isError, true);
});

test("MCP saves, runs, pauses, and removes an automatic cleanup schedule", async (context) => {
  const fixture = await createCodexHomeFixture();
  const configDirectory = path.join(fixture.codexHome, "schedule-config");
  const scheduleStore = createCleanupScheduleStore({ configDirectory });
  let schedulerRunning = false;
  let schedulerStartCount = 0;
  const schedulerService = {
    start: async () => {
      schedulerStartCount += 1;
      schedulerRunning = true;
      return { platform: "test", running: true, supported: true };
    },
    status: async () => ({ platform: "test", running: schedulerRunning, supported: true }),
    stop: async () => {
      schedulerRunning = false;
      return { platform: "test", running: false, supported: true };
    },
  };
  const connection = await connect({
    getConfigDirectory: () => configDirectory,
    getAll: () => ({ codex: { source: "startup" } }),
    getHome: () => fixture.codexHome,
  }, { scheduleStore, schedulerService });
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const saved = await call(connection.client, "manage_automatic_cleanup", {
    action: "save",
    inactiveDays: 50,
    maxSessions: 1,
    name: "Old Codex sessions",
    provider: "codex",
    runEveryDays: 12,
  });
  assert.equal(saved.scheduler.running, true);
  assert.equal(saved.schedule.cleanupMode, "thorough");
  assert.equal(saved.schedule.inactiveDays, 50);
  assert.equal(saved.schedule.runEveryDays, 12);
  assert.equal(schedulerStartCount, 1);
  assert.equal("providerHomeOverride" in saved.schedule, false);
  const privateScheduleState = JSON.parse(await fs.readFile(
    path.join(configDirectory, "cleanup-schedules.json"),
    "utf8",
  ));
  assert.equal(privateScheduleState.schedules[0].providerHomeOverride, fixture.codexHome);

  const listed = await call(connection.client, "get_overview", {
    includeAutomaticCleanup: true,
    provider: "codex",
  });
  assert.equal(listed.automaticCleanup.schedules.length, 1);
  assert.equal(listed.automaticCleanup.scheduler.running, true);

  const invalidUpdate = await connection.client.callTool({
    arguments: {
      action: "save",
      id: "missing-schedule",
      inactiveDays: 50,
      name: "Missing schedule",
      provider: "codex",
      runEveryDays: 12,
    },
    name: "manage_automatic_cleanup",
  });
  assert.equal(invalidUpdate.isError, true);
  assert.equal(schedulerStartCount, 1);

  const before = await getProvider("codex").listSessions({
    codexHome: fixture.codexHome,
    includeInternals: false,
    includeSupporting: false,
    page: 1,
    pageSize: 100,
  });
  const run = await call(connection.client, "manage_automatic_cleanup", {
    action: "run",
    id: saved.schedule.id,
  });
  assert.equal(run.status, "completed");
  assert.equal(run.candidateCount, 1);
  const after = await getProvider("codex").listSessions({
    codexHome: fixture.codexHome,
    includeInternals: false,
    includeSupporting: false,
    page: 1,
    pageSize: 100,
  });
  assert.equal(after.total, before.total - 1);

  const stopped = await call(connection.client, "manage_automatic_cleanup", { action: "stop" });
  assert.equal(stopped.running, false);
  const removed = await call(connection.client, "manage_automatic_cleanup", {
    action: "remove",
    id: saved.schedule.id,
  });
  assert.equal(removed.removed, true);
});

for (const providerId of ["codex", "claude-code"]) {
  test(`MCP cleans and verifies an exact ${providerId} session`, async (context) => {
    const fixture = providerId === "codex"
      ? await createCodexHomeFixture()
      : await createClaudeHomeFixture();
    const settings = providerId === "codex"
      ? { getHome: () => fixture.codexHome }
      : {
        getClaudeDesktopDataHome: () => fixture.desktopDataHome,
        getHome: () => fixture.claudeHome,
      };
    const id = providerId === "codex" ? fixtureSessionIds.standalone : fixture.cliId;
    const options = providerId === "codex"
      ? { codexHome: fixture.codexHome }
      : { claudeHome: fixture.claudeHome, desktopDataHome: fixture.desktopDataHome };
    const connection = await connect(settings);
    context.after(async () => {
      await connection.close();
      if (providerId === "codex") await removeCodexHomeFixture(fixture.codexHome);
      else await removeClaudeHomeFixture(fixture);
    });

    const cleaned = await call(connection.client, "clean_sessions", {
      cleanupMode: "standard",
      ids: [id],
      provider: providerId,
    });

    assert.equal(cleaned.status, "completed");
    assert.equal(cleaned.requestedSessionCount, 1);
    assert.equal(cleaned.deletedSessionCount, 1);
    assert.equal(cleaned.recovery.attempted, false);
    assert.equal(await getProvider(providerId).getSessionRecord({ ...options, id }), null);
    assert.deepEqual(await getProvider(providerId).listSessionDeletionBackups(options), []);
  });
}

test("MCP defaults to thorough cleanup and visibly falls back when it is unsupported", async (context) => {
  const fixture = await createCodexHomeFixture();
  const baseProvider = getProvider("codex");
  const provider = {
    ...baseProvider,
    diagnoseStorageCompatibility: async () => ({ status: "unsupported" }),
  };
  const connection = await connect(
    { getHome: () => fixture.codexHome },
    { resolveProvider: () => provider },
  );
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const result = await connection.client.callTool({
    arguments: {
      ids: [fixtureSessionIds.standalone],
      provider: "codex",
    },
    name: "clean_sessions",
  });

  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.requestedCleanupMode, "thorough");
  assert.equal(result.structuredContent.cleanupMode, "standard");
  assert.equal(result.structuredContent.cleanupFallback, true);
  assert.match(result.content[0].text, /standard cleanup was used/u);
});

for (const providerId of ["codex", "claude-code"]) {
  test(`MCP lists and restores an exact ${providerId} recovery backup`, async (context) => {
    const fixture = providerId === "codex"
      ? await createCodexHomeFixture()
      : await createClaudeHomeFixture();
    const settings = providerId === "codex"
      ? { getHome: () => fixture.codexHome }
      : {
        getClaudeDesktopDataHome: () => fixture.desktopDataHome,
        getHome: () => fixture.claudeHome,
      };
    const options = providerId === "codex"
      ? { codexHome: fixture.codexHome }
      : { claudeHome: fixture.claudeHome, desktopDataHome: fixture.desktopDataHome };
    const id = providerId === "codex" ? fixtureSessionIds.standalone : fixture.cliId;
    const provider = getProvider(providerId);
    const store = await provider.loadDeletionStore({ ...options, recordIds: [id] });
    const plan = await provider.planSessionDeletion({ recordIds: [id], store });
    const deletion = await provider.executeSessionDeletion({ plan, scope: "core", store });
    provider.invalidateSessionCache?.(options);
    const connection = await connect(settings);
    context.after(async () => {
      await connection.close();
      if (providerId === "codex") await removeCodexHomeFixture(fixture.codexHome);
      else await removeClaudeHomeFixture(fixture);
    });

    const listed = await call(connection.client, "list_backups", {
      provider: providerId,
    });
    assert.equal(listed.total, 1);
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].id, path.basename(deletion.backupDirectory));
    assert.equal(listed.backups[0].restorable, true);
    assert.deepEqual(Object.keys(listed.backups[0]).sort(), [
      "bytes",
      "cleanupMode",
      "createdAtMs",
      "fileCount",
      "id",
      "itemCount",
      "restorable",
      "sessionCount",
    ]);
    assert.equal(JSON.stringify(listed).includes(deletion.backupDirectory), false);

    const restored = await call(connection.client, "restore_backup", {
      backupId: listed.backups[0].id,
      provider: providerId,
    });
    assert.equal(restored.status, "restored");
    assert.equal(restored.restoredItemCount > 0, true);
    assert.equal(restored.temporaryBackupRetained, false);
    assert.equal((await provider.getSessionRecord({ ...options, id })).id, id);
    assert.deepEqual(await provider.listSessionDeletionBackups(options), []);
  });
}

test("MCP retains recovery data and hides paths when restore fails", async (context) => {
  const fixture = await createCodexHomeFixture();
  const baseProvider = getProvider("codex");
  const options = { codexHome: fixture.codexHome };
  const id = fixtureSessionIds.standalone;
  const store = await baseProvider.loadDeletionStore({ ...options, recordIds: [id] });
  const plan = await baseProvider.planSessionDeletion({ recordIds: [id], store });
  const deletion = await baseProvider.executeSessionDeletion({ plan, scope: "core", store });
  const safetyBackupDirectory = path.join(
    fixture.codexHome,
    "session-steward-backups",
    "simulated-restore-safety",
  );
  await fs.mkdir(safetyBackupDirectory, { recursive: true });
  const provider = {
    ...baseProvider,
    restoreSessionDeletionBackup: async () => {
      const error = new Error(`Restore failed at ${safetyBackupDirectory}.`);
      error.safetyBackupDirectory = safetyBackupDirectory;
      throw error;
    },
  };
  const connection = await connect(
    { getHome: () => fixture.codexHome },
    { resolveProvider: () => provider },
  );
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const result = await connection.client.callTool({
    arguments: {
      backupId: path.basename(deletion.backupDirectory),
      provider: "codex",
    },
    name: "restore_backup",
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, "restore-failed");
  assert.equal(result.structuredContent.temporaryBackupRetained, true);
  assert.equal(JSON.stringify(result).includes(fixture.codexHome), false);
  assert.equal(await baseProvider.getSessionRecord({ ...options, id }), null);
  assert.equal((await baseProvider.listSessionDeletionBackups(options)).length, 2);
});

test("MCP reports a successful restore when temporary backup cleanup fails", async (context) => {
  const fixture = await createCodexHomeFixture();
  const baseProvider = getProvider("codex");
  const options = { codexHome: fixture.codexHome };
  const id = fixtureSessionIds.standalone;
  const store = await baseProvider.loadDeletionStore({ ...options, recordIds: [id] });
  const plan = await baseProvider.planSessionDeletion({ recordIds: [id], store });
  const deletion = await baseProvider.executeSessionDeletion({ plan, scope: "core", store });
  const provider = {
    ...baseProvider,
    deleteSessionDeletionBackup: async () => {
      throw new Error("Simulated temporary backup cleanup failure.");
    },
  };
  const connection = await connect(
    { getHome: () => fixture.codexHome },
    { resolveProvider: () => provider },
  );
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const restored = await call(connection.client, "restore_backup", {
    backupId: path.basename(deletion.backupDirectory),
    provider: "codex",
  });

  assert.equal(restored.status, "restored");
  assert.equal(restored.temporaryBackupRetained, true);
  assert.equal((await baseProvider.getSessionRecord({ ...options, id })).id, id);
  assert.equal((await baseProvider.listSessionDeletionBackups(options)).length, 1);
});

for (const providerId of ["codex", "claude-code"]) {
  test(`MCP automatically restores ${providerId} when cleanup verification fails`, async (context) => {
    const fixture = providerId === "codex"
      ? await createCodexHomeFixture()
      : await createClaudeHomeFixture();
    const settings = providerId === "codex"
      ? { getHome: () => fixture.codexHome }
      : {
        getClaudeDesktopDataHome: () => fixture.desktopDataHome,
        getHome: () => fixture.claudeHome,
      };
    const id = providerId === "codex" ? fixtureSessionIds.standalone : fixture.cliId;
    const options = providerId === "codex"
      ? { codexHome: fixture.codexHome }
      : { claudeHome: fixture.claudeHome, desktopDataHome: fixture.desktopDataHome };
    const baseProvider = getProvider(providerId);
    const provider = {
      ...baseProvider,
      verifySessionDeletion: async (args) => ({
        ...await baseProvider.verifySessionDeletion(args),
        complete: false,
      }),
    };
    const connection = await connect(settings, { resolveProvider: () => provider });
    context.after(async () => {
      await connection.close();
      if (providerId === "codex") await removeCodexHomeFixture(fixture.codexHome);
      else await removeClaudeHomeFixture(fixture);
    });

    const result = await connection.client.callTool({
      arguments: {
        cleanupMode: "standard",
        ids: [id],
        provider: providerId,
      },
      name: "clean_sessions",
    });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "restored");
    assert.equal(result.structuredContent.deletedSessionCount, 0);
    assert.equal(result.structuredContent.deletedTranscriptCount, 0);
    assert.deepEqual(result.structuredContent.recovery, {
      attempted: true,
      backupRetained: false,
      completed: true,
    });
    assert.equal((await baseProvider.getSessionRecord({ ...options, id })).id, id);
    assert.deepEqual(await baseProvider.listSessionDeletionBackups(options), []);
  });
}

test("MCP retains recovery data without exposing its path when automatic restore fails", async (context) => {
  const fixture = await createCodexHomeFixture();
  const baseProvider = getProvider("codex");
  const provider = {
    ...baseProvider,
    restoreSessionDeletionBackup: async () => {
      throw new Error("Simulated restore failure.");
    },
    verifySessionDeletion: async (args) => ({
      ...await baseProvider.verifySessionDeletion(args),
      complete: false,
    }),
  };
  const connection = await connect(
    { getHome: () => fixture.codexHome },
    { resolveProvider: () => provider },
  );
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const result = await connection.client.callTool({
    arguments: {
      cleanupMode: "standard",
      ids: [fixtureSessionIds.standalone],
      provider: "codex",
    },
    name: "clean_sessions",
  });

  assert.equal(result.isError, true, JSON.stringify(result));
  assert.notEqual(result.structuredContent, undefined, result.content?.[0]?.text);
  assert.equal(result.structuredContent.status, "recovery-failed");
  assert.equal(result.structuredContent.deletedSessionCount, null);
  assert.deepEqual(result.structuredContent.recovery, {
    attempted: true,
    backupRetained: true,
    completed: false,
  });
  assert.equal(JSON.stringify(result).includes(fixture.codexHome), false);
  assert.equal((await baseProvider.listSessionDeletionBackups({ codexHome: fixture.codexHome })).length, 1);
});

test("MCP does not restore over a Codex session that becomes active during backup", async (context) => {
  const fixture = await createCodexHomeFixture();
  const baseProvider = getProvider("codex");
  const locksDirectory = path.join(fixture.codexHome, "thread-writer-locks");
  let lockCreated = false;
  const provider = {
    ...baseProvider,
    executeSessionDeletion: (args) => baseProvider.executeSessionDeletion({
      ...args,
      onProgress: async (update) => {
        if (!lockCreated && update.phase === "backup") {
          lockCreated = true;
          await fs.mkdir(locksDirectory, { recursive: true });
          await fs.writeFile(path.join(locksDirectory, `${fixtureSessionIds.standalone}.lock`), "");
        }
      },
    }),
  };
  const connection = await connect(
    { getHome: () => fixture.codexHome },
    { resolveProvider: () => provider },
  );
  context.after(async () => {
    await connection.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const result = await connection.client.callTool({
    arguments: {
      cleanupMode: "standard",
      ids: [fixtureSessionIds.standalone],
      provider: "codex",
    },
    name: "clean_sessions",
  });

  assert.equal(lockCreated, true);
  await fs.access(path.join(locksDirectory, `${fixtureSessionIds.standalone}.lock`));
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /Close the selected Codex session/u);
  assert.equal(result.content[0].text.includes(fixture.codexHome), false);
  assert.equal((await baseProvider.getSessionRecord({
    codexHome: fixture.codexHome,
    id: fixtureSessionIds.standalone,
  })).id, fixtureSessionIds.standalone);
  assert.deepEqual(await baseProvider.listSessionDeletionBackups({ codexHome: fixture.codexHome }), []);
});

test("MCP cancellation reaches long transcript reads", async (context) => {
  let markAborted;
  let markStarted;
  const aborted = new Promise((resolve) => { markAborted = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const provider = {
    displayName: "Codex",
    getSessionRecord: async () => ({ id: "session-id" }),
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
    arguments: { id: "session-id", includeTimeline: true, provider: "codex" },
    name: "inspect_session",
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

  const codex = await call(client, "inspect_session", {
    id: fixtureSessionIds.parent,
    provider: "codex",
  });
  assert.equal(codex.session.provider, "codex");

  const claude = await call(client, "inspect_session", {
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

  const overview = await call(connection.client, "get_overview", {
    provider: "codex",
    workspacePageSize: 1,
  });
  assert.equal(overview.providers[0].provider, "codex");
  assert.ok(overview.providers[0].workspaces.items.length <= 1);

  const listed = await call(connection.client, "find_sessions", {
    pageSize: 1,
    provider: "codex",
  });
  assert.equal(listed.providers[0].sessions.length, 1);
  assertSafeSession(listed.providers[0].sessions[0]);

  const parentBytes = (await fs.stat(fixture.transcripts.parent)).size;
  const largeOnly = await call(connection.client, "find_sessions", {
    includeInternals: true,
    includeSupporting: true,
    minimumTranscriptBytes: parentBytes,
    provider: "codex",
  });
  assert.deepEqual(largeOnly.providers[0].sessions.map(({ id }) => id), [fixtureSessionIds.parent]);

  const details = await call(connection.client, "inspect_session", {
    id: fixtureSessionIds.parent,
    includeTimeline: true,
    includeTokens: true,
    limit: 1,
    provider: "codex",
  });
  assertSafeSession(details.session);
  assert.equal(details.timeline.events.length, 1);
  assert.equal(details.provider, "codex");
  assert.notEqual(details.tokens, undefined);

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

  const overview = await call(connection.client, "get_overview", {
    provider: "claude-code",
    workspacePageSize: 1,
  });
  assert.equal(overview.providers[0].provider, "claude-code");
  assert.ok(overview.providers[0].workspaces.items.length <= 1);

  const listed = await call(connection.client, "find_sessions", {
    pageSize: 1,
    provider: "claude-code",
  });
  assert.equal(listed.providers[0].sessions.length, 1);
  assertSafeSession(listed.providers[0].sessions[0]);

  const cliBytes = (await fs.stat(fixture.cliTranscript)).size;
  const largeOnly = await call(connection.client, "find_sessions", {
    minimumTranscriptBytes: cliBytes,
    provider: "claude-code",
  });
  assert.deepEqual(largeOnly.providers[0].sessions.map(({ id }) => id), [fixture.cliId]);

  const details = await call(connection.client, "inspect_session", {
    id: fixture.cliId,
    includeTimeline: true,
    includeTokens: true,
    limit: 1,
    provider: "claude-code",
  });
  assertSafeSession(details.session);
  assert.equal(details.timeline.events.length, 1);
  assert.equal(details.provider, "claude-code");
  assert.notEqual(details.tokens, undefined);

  assert.deepEqual({
    claude: await directoryState(fixture.claudeHome),
    desktop: await directoryState(fixture.desktopDataHome),
  }, before);
});
