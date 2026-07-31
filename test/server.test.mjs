import assert from "node:assert/strict";
import test from "node:test";

import { startLocalServer } from "../lib/server.mjs";
import {
  createCodexHomeFixture,
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "./fixtures/codex-home.mjs";

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
