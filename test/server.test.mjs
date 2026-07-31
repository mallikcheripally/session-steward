import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { startLocalServer } from "../lib/server.mjs";
import {
  createCodexHomeFixture,
  createLargeCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";

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
  const [healthResponse, pageResponse, sessionsResponse] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(baseUrl),
    fetch(`${baseUrl}/api/sessions`),
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

test("deep cleanup is paused when unrecognized storage exists", async (context) => {
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
  assert.equal(deepPlanResponse.status, 400);
  assert.deepEqual(await deepPlanResponse.json(), {
    error: "Deep cleanup is paused because unrecognized Codex storage was found.",
  });
  const corePlanResponse = await fetch(`${baseUrl}/api/deletion-plans`, {
    body: JSON.stringify({ ids: [fixtureSessionIds.parent], scope: "core" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(corePlanResponse.status, 200);
  const response = await fetch(`${baseUrl}/api/deletions`, {
    body: JSON.stringify({ ids: [fixtureSessionIds.parent], scope: "deep" }),
    headers: {
      "Content-Type": "application/json",
      "Origin": baseUrl,
      "X-Session-Steward-Token": server.token,
    },
    method: "POST",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Deep cleanup is paused because unrecognized Codex storage was found.",
  });
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
  const first = startSlowDeletion({
    baseUrl,
    bodyStart: "{\"ids\":",
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
    body: JSON.stringify({ ids: [fixtureSessionIds.standalone], scope: "core" }),
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
  first.request.end(`${JSON.stringify([fixtureSessionIds.parent])},\"scope\":\"core\"}`);
  const firstResponse = await first.response;
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.body.verification.complete, true);
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
  const deletionResponse = await fetch(`${defaultBaseUrl}/api/deletions`, {
    body: JSON.stringify({ ids: [fixtureSessionIds.standalone], scope: "core" }),
    headers: {
      "Content-Type": "application/json",
      "Origin": defaultBaseUrl,
      "X-Session-Steward-Token": defaultConfig.mutationToken,
    },
    method: "POST",
  });
  assert.equal(deletionResponse.status, 200);
  assert.equal((await deletionResponse.json()).verification.complete, true);
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
