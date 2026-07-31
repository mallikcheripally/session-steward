import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
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
