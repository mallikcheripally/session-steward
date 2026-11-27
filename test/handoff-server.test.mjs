import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startLocalServer } from "../lib/server.mjs";
import { HANDOFF_DIRECTORY } from "../lib/session-handoff.mjs";
import { createCodexHomeFixture, fixtureSessionIds } from "./fixtures/codex-home.mjs";

async function setup(context, { partial = false, failLaunch = false } = {}) {
  const fixture = await createCodexHomeFixture();
  const calls = [];
  await fs.appendFile(fixture.transcripts.parent, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue this task without publishing anything." }] } }) + "\n" + (partial ? '{"type":"unknown-future-record"}\n' : ""));
  const server = await startLocalServer({ codexHome: fixture.codexHome, configDirectory: path.join(fixture.codexHome, "config"), handoffLauncher: async handoff => {
    calls.push(handoff);
    if (failLaunch) throw new Error("Desktop app missing.");
  } });
  context.after(async () => { await server.close(); await fs.rm(fixture.codexHome, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.port}`;
  const request = async (route, body, token = server.token) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "Origin": base, "X-Session-Steward-Token": token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const prepare = token => request("/api/handoffs", { providerId: "codex", id: fixtureSessionIds.parent, target: "claude" }, token);
  return { fixture, calls, request, prepare, base };
}

test("handoff API requires the browser token before creating files or opening apps", async context => {
  const state = await setup(context);
  const result = await state.prepare("wrong-token");
  assert.equal(result.status, 400);
  assert.match(result.body.error, /allowed|token|authorization/iu);
  assert.equal(state.calls.length, 0);
  await assert.rejects(fs.access(path.join(state.fixture.workspace, HANDOFF_DIRECTORY)), { code: "ENOENT" });
});

test("one browser action prepares a complete archive and requests the desktop composer", async context => {
  const state = await setup(context);
  const result = await state.prepare();
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.handoff.partial, false);
  assert.equal(result.body.handoff.launchAttempted, true);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].target, "claude");
  assert.match(await fs.readFile(result.body.handoff.startPath, "utf8"), /Continue this task/);
});

test("partial handoffs open directly with coverage notes in the destination prompt", async context => {
  const state = await setup(context, { partial: true });
  const result = await state.prepare();
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.handoff.partial, true);
  assert.equal(result.body.handoff.launchAttempted, true);
  assert.equal(state.calls.length, 1);
  assert.match(state.calls[0].prompt, /Handoff coverage notes:.*unknown/u);
  const route = `/api/handoffs/${result.body.handoff.id}/open`;
  assert.equal((await state.request(route, {})).status, 200);
  assert.equal(state.calls.length, 2);
});

test("a missing desktop app does not destroy a usable handoff", async context => {
  const state = await setup(context, { failLaunch: true });
  const result = await state.prepare();
  assert.equal(result.status, 200);
  assert.equal(result.body.handoff.launchError, "Desktop app missing.");
  assert.match(result.body.handoff.prompt, /START.md/);
  await fs.access(result.body.handoff.startPath);
});

test("copy-only preparation retains a prompt without attempting to open the desktop app", async context => {
  const state = await setup(context, { failLaunch: true, partial: true });
  const result = await state.request("/api/handoffs", { providerId: "codex", id: fixtureSessionIds.parent, target: "claude", launch: false });
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.handoff.launchAttempted, false);
  assert.equal(result.body.handoff.launchError, null);
  assert.equal(state.calls.length, 0);
  assert.match(result.body.handoff.prompt, /START.md/);
  assert.match(result.body.handoff.prompt, /Handoff coverage notes:/);
  await fs.access(result.body.handoff.startPath);
  const continued = await state.prepare();
  assert.equal(continued.body.handoff.id, result.body.handoff.id);
  assert.equal(continued.body.handoff.reused, true);
  assert.equal(continued.body.handoff.launchAttempted, true);
  assert.equal(state.calls.length, 1);
});

test("the dedicated copy route never dispatches an app and requires authorization", async context => {
  const state = await setup(context);
  const body = { providerId: "codex", id: fixtureSessionIds.parent, target: "claude", launch: true };
  assert.equal((await state.request("/api/handoffs/prepare", body, "wrong-token")).status, 400);
  await assert.rejects(fs.access(path.join(state.fixture.workspace, HANDOFF_DIRECTORY)), { code: "ENOENT" });
  const copied = await state.request("/api/handoffs/prepare", body);
  assert.equal(copied.status, 200, copied.body.error);
  assert.equal(copied.body.handoff.launchAttempted, false);
  assert.equal(state.calls.length, 0);
  await fs.access(copied.body.handoff.startPath);
});

test("continuing after copying checks for new session activity before reusing context", async context => {
  const state = await setup(context);
  const copied = await state.request("/api/handoffs", { providerId: "codex", id: fixtureSessionIds.parent, target: "claude", launch: false });
  assert.equal(copied.status, 200);
  await fs.appendFile(state.fixture.transcripts.parent, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "A newer requirement recorded after copying." }] } }) + "\n");
  const continued = await state.prepare();
  assert.equal(continued.status, 200);
  assert.notEqual(continued.body.handoff.id, copied.body.handoff.id);
  assert.equal(state.calls.length, 1);
  assert.match(await fs.readFile(path.join(continued.body.handoff.directory, "history", "part-000001.md"), "utf8"), /A newer requirement/);
});

test("an invalid launch option cannot silently open an app or create files", async context => {
  const state = await setup(context);
  const result = await state.request("/api/handoffs", { providerId: "codex", id: fixtureSessionIds.parent, target: "claude", launch: "false" });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /launch must be a boolean/);
  assert.equal(state.calls.length, 0);
  await assert.rejects(fs.access(path.join(state.fixture.workspace, HANDOFF_DIRECTORY)), { code: "ENOENT" });
});

test("the browser catalog lists and reuses an unchanged handoff across requests", async context => {
  const state = await setup(context);
  const first = await state.prepare(); const second = await state.prepare();
  assert.equal(second.body.handoff.id, first.body.handoff.id);
  assert.equal(second.body.handoff.reused, true);
  const listed = await (await fetch(`${state.base}/api/handoffs`)).json();
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].id, first.body.handoff.id);
  assert.ok(listed.totalBytes > 0);
});

test("View handoffs filters by the selected session and provider without a broad search", async context => {
  const state = await setup(context);
  const prepared = await state.prepare();
  const query = new URLSearchParams({ providerId: "codex", sessionId: fixtureSessionIds.parent });
  const selected = await (await fetch(`${state.base}/api/handoffs?${query}`)).json();
  assert.equal(selected.total, 1); assert.equal(selected.records[0].id, prepared.body.handoff.id);
  assert.equal(selected.scope.sessionId, fixtureSessionIds.parent);
  query.set("sessionId", fixtureSessionIds.standalone);
  const otherSession = await (await fetch(`${state.base}/api/handoffs?${query}`)).json();
  assert.equal(otherSession.total, 0); assert.equal(otherSession.allCount, 1);
  query.set("sessionId", fixtureSessionIds.parent); query.set("providerId", "claude-code");
  assert.equal((await (await fetch(`${state.base}/api/handoffs?${query}`)).json()).total, 0);
  assert.equal((await fetch(`${state.base}/api/handoffs?sessionId=${fixtureSessionIds.parent}`)).status, 400);
  assert.equal((await (await fetch(`${state.base}/api/handoffs`)).json()).total, 1);
});

test("handoff cleanup requires authorization and affects only the selected archive", async context => {
  const state = await setup(context);
  const first = await state.prepare(); const id = first.body.handoff.id;
  const source = await fs.readFile(state.fixture.transcripts.parent);
  assert.equal((await state.request("/api/handoffs/delete", { ids: [id] }, "wrong-token")).status, 400);
  await fs.access(first.body.handoff.startPath);
  const removed = await state.request("/api/handoffs/delete", { ids: [id] });
  assert.equal(removed.status, 200); assert.deepEqual(removed.body.deletedIds, [id]);
  assert.deepEqual(await fs.readFile(state.fixture.transcripts.parent), source);
  assert.equal((await state.request(`/api/handoffs/${id}/open`, {})).status, 400);
  assert.equal((await (await fetch(`${state.base}/api/handoffs`)).json()).total, 0);
});

test("handoffs page supports direct navigation", async context => {
  const state = await setup(context);
  const response = await fetch(`${state.base}/handoffs`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Session Steward/);
});
