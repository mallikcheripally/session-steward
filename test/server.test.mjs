import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { startLocalServer } from "../lib/server.mjs";
import {
  createCodexHomeFixture,
  createLargeCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "./fixtures/claude-home.mjs";

function startSlowDeletion({ baseUrl, bodyStart, token }) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(`${baseUrl}/api/deletions`, {
      headers: {
        "Content-Type": "application/json",
        "Origin": baseUrl,
        "X-Session-Steward-Token": token,
      },
      method: "POST",
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        status: incoming.statusCode,
      }));
    });
    request.on("error", reject);
    request.write(bodyStart);
  });

  return { request, response };
}

async function createDeletionPlan(baseUrl, ids, scope = "core", providerId = "codex") {
  const response = await fetch(`${baseUrl}/api/deletion-plans`, {
    body: JSON.stringify({ ids, providerId, scope }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error);
  return body.plan;
}

test("the session events route is read-only, bounded, and accepts only session IDs", async (context) => {
  const fixture = await createCodexHomeFixture();
  await fs.appendFile(fixture.transcripts.parent, `${JSON.stringify({
    payload: {
      content: [{ text: "Review the cleanup flow" }],
      role: "user",
      type: "message",
    },
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "response_item",
  })}\n`);
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close().catch(() => {});
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(
    `${baseUrl}/api/session-events?provider=codex&id=${fixtureSessionIds.parent}&limit=1`,
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].text, "Review the cleanup flow");
  assert.equal(result.header.provider, "codex");
  assert.equal(result.coverage.total, 2);

  const pathResponse = await fetch(
    `${baseUrl}/api/session-events?provider=codex&id=${encodeURIComponent("../state_5.sqlite")}`,
  );
  assert.equal(pathResponse.status, 400);
  assert.deepEqual(await pathResponse.json(), { error: "Enter a valid session ID." });

  const invalidLimitResponse = await fetch(
    `${baseUrl}/api/session-events?provider=codex&id=${fixtureSessionIds.parent}&limit=1001`,
  );
  assert.equal(invalidLimitResponse.status, 400);
  assert.deepEqual(await invalidLimitResponse.json(), {
    error: "limit must be between 1 and 1000.",
  });
});

test("the local server routes Claude Code sessions through the selected provider", async (context) => {
  const fixture = await createClaudeHomeFixture();
  const server = await startLocalServer({ claudeHome: fixture.claudeHome, port: 0 });
  context.after(async () => {
    await server.close().catch(() => {});
    await removeClaudeHomeFixture(fixture);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(config.providers["claude-code"].home, fixture.claudeHome);
  const sessions = await fetch(`${baseUrl}/api/sessions?provider=claude-code`).then((response) => response.json());
  assert.equal(sessions.total, 2);
  assert.ok(sessions.records.every((record) => record.providerId === "claude-code"));
  const overview = await fetch(`${baseUrl}/api/session-overview?provider=claude-code`).then((response) => response.json());
  assert.equal(overview.overview.cliSessionCount, 2);
  const plan = await createDeletionPlan(baseUrl, [fixture.cliId], "core", "claude-code");
  assert.equal(plan.sessionCount, 1);
  assert.ok(plan.transcriptCount >= 3);
  const operation = await runDeletion(baseUrl, config.mutationToken, plan.id);
  assert.equal(operation.status, "completed");
  await assert.rejects(fs.access(fixture.cliTranscript), { code: "ENOENT" });
  assert.equal((await fs.stat(fixture.unrelatedTranscript)).isFile(), true);
});

test("the active provider route is authorized and persists the selection", async (context) => {
  const fixture = await createCodexHomeFixture();
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-provider-route-"));
  let server = await startLocalServer({
    codexHome: fixture.codexHome,
    configDirectory,
    port: 0,
  });
  context.after(async () => {
    await server.close().catch(() => {});
    await Promise.all([
      removeCodexHomeFixture(fixture.codexHome),
      fs.rm(configDirectory, { force: true, recursive: true }),
    ]);
  });
  let baseUrl = `http://127.0.0.1:${server.port}`;
  let config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(config.activeProviderId, "codex");

  const unauthorized = await fetch(`${baseUrl}/api/settings/active-provider`, {
    body: JSON.stringify({ providerId: "claude-code" }),
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    method: "PUT",
  });
  assert.equal(unauthorized.status, 400);

  const saved = await fetch(`${baseUrl}/api/settings/active-provider`, {
    body: JSON.stringify({ providerId: "claude-code" }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Session-Steward-Token": config.mutationToken,
    },
    method: "PUT",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { activeProviderId: "claude-code" });
  await server.close();

  server = await startLocalServer({
    codexHome: fixture.codexHome,
    configDirectory,
    port: 0,
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(config.activeProviderId, "claude-code");
});

async function waitForOperation(baseUrl, operation) {
  let current = operation;

  while (["queued", "running", "restoring"].includes(current.status)) {
    await delay(10);
    const response = await fetch(`${baseUrl}/api/deletions/${current.id}`);
    assert.equal(response.status, 200);
    current = (await response.json()).operation;
  }

  return current;
}

async function runDeletion(baseUrl, token, planId) {
  const response = await fetch(`${baseUrl}/api/deletions`, {
    body: JSON.stringify({ planId }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Session-Steward-Token": token,
    },
    method: "POST",
  });
  const body = await response.json();
  assert.equal(response.status, 202, body.error);
  return waitForOperation(baseUrl, body.operation);
}

function requestLocalServer({
  body,
  headers = {},
  method = "GET",
  path: requestPath = "/",
  port,
  setHost = true,
}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers,
      host: "127.0.0.1",
      method,
      path: requestPath,
      port,
      setHost,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const responseText = Buffer.concat(chunks).toString("utf8");
        resolve({
          body: responseText ? JSON.parse(responseText) : null,
          status: response.statusCode,
        });
      });
    });
    request.on("error", reject);

    if (body !== undefined) {
      request.write(body);
    }

    request.end();
  });
}

test("the local server exposes the UI and synthetic Codex sessions", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({
    codexHome: fixture.codexHome,
    port: 0,
  });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const [healthResponse, pageResponse, sessionsResponse, overviewResponse] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(baseUrl),
    fetch(`${baseUrl}/api/sessions`),
    fetch(`${baseUrl}/api/session-overview`),
  ]);

  assert.deepEqual(await healthResponse.json(), { status: "ok" });
  assert.match(await pageResponse.text(), /Session Steward/u);
  const sessions = await sessionsResponse.json();
  assert.equal(sessions.records.length, 2);
  assert.equal(sessions.total, 2);
  assert.equal(sessions.page, 1);
  assert.equal(sessions.pageCount, 1);
  assert.equal(sessions.pageSize, 25);
  assert.ok(sessions.records.every(({ providerId }) => providerId === "codex"));
  assert.ok(sessions.records.every(({ transcriptBytes }) => Number.isFinite(transcriptBytes)));
  const { overview } = await overviewResponse.json();
  assert.equal(overview.sessionCount, 3);
  assert.equal(overview.activeSessionCount, 2);
  assert.equal(overview.archivedSessionCount, 1);
  assert.equal(overview.primarySessionCount, 2);
  assert.equal(overview.subagentCount, 1);
  assert.equal(overview.transcriptFileCount, 3);
  assert.equal(overview.transcriptBytes > 0, true);
  assert.deepEqual(
    overview.workspaces.map(({ path: workspacePath, sessionCount }) => [workspacePath, sessionCount]),
    [[fixture.workspace, 3]],
  );
});

test("cleanup requests require the local authorization token", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const response = await fetch(`http://127.0.0.1:${server.port}/api/deletions`, {
    body: JSON.stringify({ ids: ["11111111-1111-4111-8111-111111111111"], scope: "core" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Destructive requests must originate from this local server.",
  });
});

test("cleanup requests reject oversized bodies", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${baseUrl}/api/deletions`, {
    body: JSON.stringify({ planId: "x".repeat(70 * 1024) }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request body is too large." });
});

test("the local server rejects non-loopback and incorrect Host headers", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const normalConfigResponse = await fetch(`${baseUrl}/api/config`);
  const normalConfig = await normalConfigResponse.json();
  assert.equal(normalConfigResponse.status, 200);
  assert.equal(normalConfig.mutationToken, server.token);

  for (const host of [
    `attacker.example:${server.port}`,
    "127.0.0.1:1",
    "localhost",
  ]) {
    const response = await requestLocalServer({
      headers: { Host: host },
      path: "/api/config",
      port: server.port,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "This request is not allowed." });
    assert.equal(Object.hasOwn(response.body, "mutationToken"), false);
  }

  const missingHostResponse = await requestLocalServer({
    path: "/api/config",
    port: server.port,
    setHost: false,
  });
  assert.equal(missingHostResponse.status, 400);
  assert.equal(missingHostResponse.body, null);

  const absoluteTargetResponse = await requestLocalServer({
    headers: { Host: `127.0.0.1:${server.port}` },
    path: `http://attacker.example:${server.port}/api/config`,
    port: server.port,
  });
  assert.equal(absoluteTargetResponse.status, 403);
  assert.deepEqual(absoluteTargetResponse.body, { error: "This request is not allowed." });

  const attackerOrigin = `http://attacker.example:${server.port}`;
  const deletionResponse = await requestLocalServer({
    body: JSON.stringify({ ids: [fixtureSessionIds.standalone], scope: "core" }),
    headers: {
      "Content-Type": "application/json",
      Host: `attacker.example:${server.port}`,
      Origin: attackerOrigin,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
    path: "/api/deletions",
    port: server.port,
  });
  assert.equal(deletionResponse.status, 403);
  assert.deepEqual(deletionResponse.body, { error: "This request is not allowed." });

  const sessions = await fetch(`${baseUrl}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(sessions.records.some(({ id }) => id === fixtureSessionIds.standalone), true);
});

test("deep cleanup remains available while unrelated storage is left alone", async (context) => {
  const fixture = await createCodexHomeFixture({ includeUnknownDatabase: true });
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const deepPlanResponse = await fetch(`${baseUrl}/api/deletion-plans`, {
    body: JSON.stringify({ ids: [fixtureSessionIds.parent], scope: "deep" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(deepPlanResponse.status, 200);
  const corePlanResponse = await fetch(`${baseUrl}/api/deletion-plans`, {
    body: JSON.stringify({ ids: [fixtureSessionIds.parent], scope: "core" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(corePlanResponse.status, 200);
  const sessions = await fetch(`${baseUrl}/api/sessions?includeInternals=true`).then((result) => result.json());
  assert.equal(sessions.records.some(({ id }) => id === fixtureSessionIds.parent), true);
});

test("only one deletion request can run at a time", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const invalidResponse = await fetch(`${baseUrl}/api/deletions`, {
    body: "{",
    headers: {
      "Content-Type": "application/json",
      "Origin": baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });
  assert.equal(invalidResponse.status, 400);
  const firstPlan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent]);
  const secondPlan = await createDeletionPlan(baseUrl, [fixtureSessionIds.standalone]);
  const first = startSlowDeletion({
    baseUrl,
    bodyStart: "{\"planId\":\"",
    token: server.token,
  });
  await delay(50);
  const settingsResponse = await fetch(`${baseUrl}/api/settings/providers/codex`, {
    body: JSON.stringify({ home: fixture.codexHome }),
    headers: {
      "Content-Type": "application/json",
      "Origin": baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "PUT",
  });
  assert.equal(settingsResponse.status, 409);
  assert.deepEqual(await settingsResponse.json(), {
    error: "Wait for the current change to finish before changing folders.",
  });
  const secondResponse = await fetch(`${baseUrl}/api/deletions`, {
    body: JSON.stringify({ planId: secondPlan.id }),
    headers: {
      "Content-Type": "application/json",
      "Origin": baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });

  assert.equal(secondResponse.status, 409);
  assert.deepEqual(await secondResponse.json(), {
    error: "Another deletion is already in progress.",
  });
  first.request.end(`${firstPlan.id}\"}`);
  const firstResponse = await first.response;
  assert.equal(firstResponse.status, 202);
  const completed = await waitForOperation(baseUrl, firstResponse.body.operation);
  assert.equal(completed.status, "completed");
  assert.equal(completed.verification.complete, true);
});

test("the sessions API returns one requested page", async (context) => {
  const fixture = await createLargeCodexHomeFixture({ sessionCount: 60 });
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });

  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/sessions?includeInternals=true&page=2&pageSize=25`,
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.total, 63);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 3);
  assert.equal(result.records.length, 25);
});

test("the sessions API filters inactive sessions and exact workspaces", async (context) => {
  const fixture = await createCodexHomeFixture();
  const database = new DatabaseSync(path.join(fixture.codexHome, "state_5.sqlite"));
  const now = Date.now();
  const otherWorkspace = "/tmp/session-steward/another project";
  try {
    const update = database.prepare("update threads set cwd = ?, updated_at = ?, updated_at_ms = ? where id = ?");
    update.run(fixture.workspace, Math.floor((now - 100 * 86_400_000) / 1000), now - 100 * 86_400_000, fixtureSessionIds.parent);
    update.run(fixture.workspace, Math.floor((now - 10 * 86_400_000) / 1000), now - 10 * 86_400_000, fixtureSessionIds.child);
    update.run(otherWorkspace, Math.floor((now - 70 * 86_400_000) / 1000), now - 70 * 86_400_000, fixtureSessionIds.standalone);
  } finally {
    database.close();
  }

  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const inactiveResponse = await fetch(
    `${baseUrl}/api/sessions?inactiveDays=60&includeInternals=true&includeSupporting=true`,
  );
  const inactive = await inactiveResponse.json();
  assert.equal(inactiveResponse.status, 200);
  assert.deepEqual(
    inactive.records.map(({ id }) => id).sort(),
    [fixtureSessionIds.parent, fixtureSessionIds.standalone].sort(),
  );

  const workspaceResponse = await fetch(
    `${baseUrl}/api/sessions?includeInternals=true&includeSupporting=true&workspace=${encodeURIComponent(otherWorkspace)}`,
  );
  const workspace = await workspaceResponse.json();
  assert.equal(workspaceResponse.status, 200);
  assert.deepEqual(workspace.records.map(({ id }) => id), [fixtureSessionIds.standalone]);

  const archivedResponse = await fetch(
    `${baseUrl}/api/sessions?archiveStatus=archived&includeInternals=true&includeSupporting=true`,
  );
  const archived = await archivedResponse.json();
  assert.equal(archivedResponse.status, 200);
  assert.deepEqual(archived.records.map(({ id }) => id), [fixtureSessionIds.standalone]);

  const invalidArchiveResponse = await fetch(`${baseUrl}/api/sessions?archiveStatus=old`);
  assert.equal(invalidArchiveResponse.status, 400);
  assert.deepEqual(await invalidArchiveResponse.json(), {
    error: "Session status must be all, active, or archived.",
  });

  const invalidResponse = await fetch(`${baseUrl}/api/sessions?inactiveDays=45`);
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: "Last activity must be 30, 60, or 90 days." });

  const malformedResponse = await fetch(`${baseUrl}/api/sessions?inactiveDays=30days`);
  assert.equal(malformedResponse.status, 400);
});

test("the overview cache can be refreshed and is invalidated after cleanup", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const readOverview = async (suffix = "") => {
    const response = await fetch(`${baseUrl}/api/session-overview${suffix}`);
    assert.equal(response.status, 200);
    return (await response.json()).overview;
  };

  const initial = await readOverview();
  await fs.appendFile(fixture.transcripts.standalone, "extra transcript bytes\n");
  const cached = await readOverview();
  assert.equal(cached.transcriptBytes, initial.transcriptBytes);

  const refreshed = await readOverview("?refresh=true");
  assert.equal(refreshed.transcriptBytes > initial.transcriptBytes, true);

  const plan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent]);
  const operation = await runDeletion(baseUrl, server.token, plan.id);
  assert.equal(operation.status, "completed");
  assert.equal(operation.backupDirectory, null);
  assert.equal(operation.result.recoveryBackupDeleted, true);
  assert.deepEqual(
    await fs.readdir(path.join(fixture.codexHome, "session-steward-backups")),
    [],
  );
  const afterCleanup = await readOverview();
  assert.equal(afterCleanup.sessionCount, 1);
  assert.equal(afterCleanup.subagentCount, 0);
});

test("failed cleanup backups can be deleted explicitly", async (context) => {
  const fixture = await createCodexHomeFixture();
  const logsDatabase = new DatabaseSync(path.join(fixture.codexHome, "logs_2.sqlite"));
  try {
    logsDatabase.exec(`
      create trigger prevent_cleanup
      before delete on logs
      begin
        select raise(abort, 'forced cleanup failure');
      end;
    `);
  } finally {
    logsDatabase.close();
  }

  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const plan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent]);
  const failed = await runDeletion(baseUrl, server.token, plan.id);

  assert.equal(failed.status, "failed");
  assert.equal(failed.canRestore, true);
  assert.equal(failed.canDeleteBackup, true);
  const backupDirectory = failed.backupDirectory;
  await fs.access(backupDirectory);

  const response = await fetch(`${baseUrl}/api/deletions/${encodeURIComponent(failed.id)}/backup`, {
    headers: {
      Origin: baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "DELETE",
  });
  const { operation } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(operation.backupDirectory, null);
  assert.equal(operation.canRestore, false);
  assert.equal(operation.canDeleteBackup, false);
  await assert.rejects(fs.access(backupDirectory), { code: "ENOENT" });
});

test("restored cleanup backups are removed after recovery", async (context) => {
  const fixture = await createCodexHomeFixture();
  const logsDatabase = new DatabaseSync(path.join(fixture.codexHome, "logs_2.sqlite"));
  try {
    logsDatabase.exec(`
      create trigger prevent_cleanup
      before delete on logs
      begin
        select raise(abort, 'forced cleanup failure');
      end;
    `);
  } finally {
    logsDatabase.close();
  }

  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const plan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent]);
  const failed = await runDeletion(baseUrl, server.token, plan.id);
  assert.equal(failed.status, "failed");

  const response = await fetch(`${baseUrl}/api/deletions/${encodeURIComponent(failed.id)}/restore`, {
    headers: {
      Origin: baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });
  const body = await response.json();
  assert.equal(response.status, 202, body.error);
  const restored = await waitForOperation(baseUrl, body.operation);
  assert.equal(restored.status, "restored");
  assert.equal(restored.backupDirectory, null);
  assert.equal(restored.canDeleteBackup, false);
  assert.equal(restored.restoreResult.recoveryBackupsDeleted, true);
  assert.deepEqual(
    await fs.readdir(path.join(fixture.codexHome, "session-steward-backups")),
    [],
  );
});

test("deletion plans stay server-side and ignore unrelated session activity", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const plan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent], "deep");

  assert.equal(typeof plan.id, "string");
  assert.equal(plan.sessionCount, 2);
  assert.equal(plan.transcriptCount, 2);
  assert.equal(plan.transcriptBytes > 0, true);
  assert.equal(plan.relatedRecordCount > 0, true);
  assert.equal(plan.newestLinkedActivityAtMs, 1751367500000);
  assert.equal(Object.hasOwn(plan, "ids"), false);
  assert.equal(Object.hasOwn(plan, "records"), false);
  assert.equal(plan.recordSamples.length, 2);
  assert.ok(JSON.stringify(plan).length < 20_000);

  await fs.appendFile(
    path.join(fixture.codexHome, "history.jsonl"),
    `${JSON.stringify({ session_id: "another-session", text: "changed", ts: Date.now() })}\n`,
  );
  await fs.appendFile(
    path.join(fixture.codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: "another-session", thread_name: "Unrelated session" })}\n`,
  );
  const desktopStatePath = path.join(fixture.codexHome, ".codex-global-state.json");
  const desktopState = JSON.parse(await fs.readFile(desktopStatePath, "utf8"));
  desktopState["thread-project-assignments"]["another-session"] = "project-c";
  await fs.writeFile(desktopStatePath, `${JSON.stringify(desktopState)}\n`);

  for (const [databaseName, statement] of [
    ["state_5.sqlite", `update threads set updated_at_ms = updated_at_ms + 1 where id = '${fixtureSessionIds.standalone}'`],
    ["logs_2.sqlite", `insert into logs values ('${fixtureSessionIds.standalone}', 'new unrelated log')`],
    ["memories_1.sqlite", `insert into stage1_outputs values ('${fixtureSessionIds.standalone}', 'new unrelated memory')`],
    ["goals_1.sqlite", `insert into thread_goals values ('${fixtureSessionIds.standalone}', 'new unrelated goal')`],
  ]) {
    const database = new DatabaseSync(path.join(fixture.codexHome, databaseName));
    try {
      database.exec(statement);
    } finally {
      database.close();
    }
  }

  const operation = await runDeletion(baseUrl, server.token, plan.id);
  assert.equal(operation.status, "completed");
  assert.equal(operation.errorCode, null);

  const reusedPlanResponse = await fetch(`${baseUrl}/api/deletions`, {
    body: JSON.stringify({ planId: plan.id }),
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });
  assert.equal(reusedPlanResponse.status, 400);
  assert.deepEqual(await reusedPlanResponse.json(), {
    code: "DELETION_PLAN_REVIEW_REQUIRED",
    error: "This deletion preview has expired. Review the selection again.",
  });

  const sessions = await fetch(`${baseUrl}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(sessions.records.some(({ id }) => id === fixtureSessionIds.parent), false);
  assert.equal(sessions.records.some(({ id }) => id === fixtureSessionIds.standalone), true);
});

test("deletion plans require review when selected session data changes", async (context) => {
  const fixture = await createCodexHomeFixture();
  const server = await startLocalServer({ codexHome: fixture.codexHome, port: 0 });
  context.after(async () => {
    await server.close();
    await removeCodexHomeFixture(fixture.codexHome);
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const plan = await createDeletionPlan(baseUrl, [fixtureSessionIds.parent]);

  await fs.appendFile(
    path.join(fixture.codexHome, "history.jsonl"),
    `${JSON.stringify({
      session_id: fixtureSessionIds.parent,
      text: "selected session changed",
      ts: Date.now(),
    })}\n`,
  );

  const operation = await runDeletion(baseUrl, server.token, plan.id);
  assert.equal(operation.status, "failed");
  assert.equal(operation.errorCode, "DELETION_PLAN_REVIEW_REQUIRED");
  assert.equal(operation.backupDirectory, null);
  assert.match(operation.error, /Session data changed after this preview/u);

  const sessions = await fetch(`${baseUrl}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(sessions.records.some(({ id }) => id === fixtureSessionIds.parent), true);
});

test("Codex folder settings persist while startup overrides remain run-only", async (context) => {
  const startupFixture = await createCodexHomeFixture();
  const savedFixture = await createLargeCodexHomeFixture({ sessionCount: 4 });
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-config-"));
  const servers = [];
  context.after(async () => {
    await Promise.allSettled(servers.map((server) => server.close()));
    await Promise.all([
      removeCodexHomeFixture(startupFixture.codexHome),
      removeCodexHomeFixture(savedFixture.codexHome),
      fs.rm(configDirectory, { force: true, recursive: true }),
    ]);
  });

  const overriddenServer = await startLocalServer({
    codexHome: startupFixture.codexHome,
    configDirectory,
    port: 0,
  });
  servers.push(overriddenServer);
  const overriddenConfig = await fetch(`http://127.0.0.1:${overriddenServer.port}/api/config`).then((response) => response.json());
  assert.equal(overriddenConfig.providers.codex.home, startupFixture.codexHome);
  assert.equal(overriddenConfig.providers.codex.source, "startup");
  await overriddenServer.close();
  await assert.rejects(fs.access(path.join(configDirectory, "config.json")), { code: "ENOENT" });

  const defaultServer = await startLocalServer({ configDirectory, port: 0 });
  servers.push(defaultServer);
  const defaultBaseUrl = `http://127.0.0.1:${defaultServer.port}`;
  const defaultConfig = await fetch(`${defaultBaseUrl}/api/config`).then((response) => response.json());
  assert.equal(defaultConfig.providers.codex.home, path.join(os.homedir(), ".codex"));
  assert.equal(defaultConfig.providers.codex.source, "default");
  const saveResponse = await fetch(`${defaultBaseUrl}/api/settings/providers/codex`, {
    body: JSON.stringify({ home: savedFixture.codexHome }),
    headers: {
      "Content-Type": "application/json",
      "Origin": defaultBaseUrl,
      "X-Session-Steward-Token": defaultConfig.mutationToken,
    },
    method: "PUT",
  });
  assert.equal(saveResponse.status, 200);
  const savedProvider = (await saveResponse.json()).provider;
  assert.equal(savedProvider.home, savedFixture.codexHome);
  assert.equal(savedProvider.source, "saved");
  const savedSessions = await fetch(`${defaultBaseUrl}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(savedSessions.total, 7);
  const deletionPlan = await createDeletionPlan(defaultBaseUrl, [fixtureSessionIds.standalone]);
  const deletion = await runDeletion(defaultBaseUrl, defaultConfig.mutationToken, deletionPlan.id);
  assert.equal(deletion.status, "completed");
  assert.equal(deletion.verification.complete, true);
  const sessionsAfterDeletion = await fetch(`${defaultBaseUrl}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(sessionsAfterDeletion.total, 6);
  await defaultServer.close();

  const secondOverrideServer = await startLocalServer({
    codexHome: startupFixture.codexHome,
    configDirectory,
    port: 0,
  });
  servers.push(secondOverrideServer);
  const secondOverrideConfig = await fetch(`http://127.0.0.1:${secondOverrideServer.port}/api/config`).then((response) => response.json());
  assert.equal(secondOverrideConfig.providers.codex.home, startupFixture.codexHome);
  assert.equal(secondOverrideConfig.providers.codex.source, "startup");
  const overrideSessions = await fetch(`http://127.0.0.1:${secondOverrideServer.port}/api/sessions?includeInternals=true`).then((response) => response.json());
  assert.equal(overrideSessions.total, 3);
  await secondOverrideServer.close();
  const persistedConfig = JSON.parse(await fs.readFile(path.join(configDirectory, "config.json"), "utf8"));
  assert.equal(persistedConfig.providers.codex.home, savedFixture.codexHome);

  const restoredServer = await startLocalServer({ configDirectory, port: 0 });
  servers.push(restoredServer);
  const restoredBaseUrl = `http://127.0.0.1:${restoredServer.port}`;
  const restoredConfig = await fetch(`${restoredBaseUrl}/api/config`).then((response) => response.json());
  assert.equal(restoredConfig.providers.codex.home, savedFixture.codexHome);
  assert.equal(restoredConfig.providers.codex.source, "saved");
  const resetResponse = await fetch(`${restoredBaseUrl}/api/settings/providers/codex`, {
    headers: {
      "Origin": restoredBaseUrl,
      "X-Session-Steward-Token": restoredConfig.mutationToken,
    },
    method: "DELETE",
  });
  assert.equal(resetResponse.status, 200);
  const resetProvider = (await resetResponse.json()).provider;
  assert.equal(resetProvider.home, path.join(os.homedir(), ".codex"));
  assert.equal(resetProvider.source, "default");
  const resetConfig = JSON.parse(await fs.readFile(path.join(configDirectory, "config.json"), "utf8"));
  assert.equal(resetConfig.providers.codex, undefined);
  assert.deepEqual(await fs.readdir(configDirectory), ["config.json"]);
  assert.equal((await fs.stat(path.join(configDirectory, "config.json"))).mode & 0o777, 0o600);
});

test("Codex folder settings reject invalid paths without changing the active folder", async (context) => {
  const fixture = await createCodexHomeFixture();
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-config-"));
  const filePath = path.join(configDirectory, "not-a-folder");
  await fs.writeFile(filePath, "private contents", "utf8");
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    providers: { codex: { home: "invalid/saved/folder" } },
    version: 1,
  }), "utf8");
  const server = await startLocalServer({
    codexHome: fixture.codexHome,
    configDirectory,
    port: 0,
  });
  context.after(async () => {
    await server.close().catch(() => {});
    await removeCodexHomeFixture(fixture.codexHome);
    await fs.rm(configDirectory, { force: true, recursive: true });
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());

  for (const [home, expectedError] of [
    ["relative/folder", "Enter a full folder path, such as ~/.codex."],
    [path.join(configDirectory, "missing"), "Choose an existing folder."],
    [filePath, "Choose a folder, not a file."],
  ]) {
    const response = await fetch(`${baseUrl}/api/settings/providers/codex`, {
      body: JSON.stringify({ home }),
      headers: {
        "Content-Type": "application/json",
        "Origin": baseUrl,
        "X-Session-Steward-Token": config.mutationToken,
      },
      method: "PUT",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: expectedError });
  }

  const unchanged = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
  assert.equal(unchanged.providers.codex.home, fixture.codexHome);
  assert.equal(unchanged.providers.codex.source, "startup");
});

test("invalid saved folder settings fall back to the default", async (context) => {
  const configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-config-"));
  await fs.writeFile(path.join(configDirectory, "config.json"), JSON.stringify({
    providers: { codex: { home: "invalid/saved/folder" } },
    version: 1,
  }), "utf8");
  const server = await startLocalServer({ configDirectory, port: 0 });
  context.after(async () => {
    await server.close().catch(() => {});
    await fs.rm(configDirectory, { force: true, recursive: true });
  });

  const config = await fetch(`http://127.0.0.1:${server.port}/api/config`).then((response) => response.json());
  assert.equal(config.providers.codex.home, path.join(os.homedir(), ".codex"));
  assert.equal(config.providers.codex.source, "default");
});
