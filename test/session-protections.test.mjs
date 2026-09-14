import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySessionProtection,
  compileSessionProtectionMatcher,
  createSessionProtectionStore,
} from "../lib/session-protections.mjs";

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-steward-keeps-"));
  context.after(() => fs.rm(directory, { force: true, recursive: true }));
  return directory;
}

test("session Keeps are scoped to provider and provider home", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory, now: () => 123 });
  await store.keepSession({ providerHome: "/one/codex", providerId: "codex", sessionId: "session-1" });
  const snapshot = await store.list();

  assert.equal(classifySessionProtection({
    providerHome: "/one/codex", providerId: "codex", record: { id: "session-1" }, snapshot,
  }).kept, true);
  assert.equal(classifySessionProtection({
    providerHome: "/two/codex", providerId: "codex", record: { id: "session-1" }, snapshot,
  }).kept, false);
  assert.equal(classifySessionProtection({
    providerHome: "/one/codex", providerId: "claude-code", record: { id: "session-1" }, snapshot,
  }).kept, false);
});

test("workspace Keeps cover descendants across providers", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory });
  await store.keepWorkspace({ workspace: "/work/product" });
  const snapshot = await store.list();

  for (const providerId of ["codex", "claude-code"]) {
    assert.equal(classifySessionProtection({
      providerHome: providerId === "codex" ? "/home/codex" : "/home/claude",
      providerId,
      record: { cwd: "/work/product/packages/app", id: `${providerId}-1` },
      snapshot,
    }).workspace, true);
  }
  assert.equal(classifySessionProtection({
    providerHome: "/home/codex",
    providerId: "codex",
    record: { cwd: "/work/product-old", id: "other" },
    snapshot,
  }).kept, false);
});

test("corrupt Keep data fails closed", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  await fs.writeFile(path.join(configDirectory, "protections.json"), "{not-json\n");
  const store = createSessionProtectionStore({ configDirectory });
  await assert.rejects(store.list(), /Keep data is invalid.*Cleanup was paused/u);
});

test("Keep mutations are idempotent and removable", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory, now: () => 456 });
  const input = { providerHome: "/home/codex", providerId: "codex", sessionId: "session-1" };
  await store.keepSession(input);
  await store.keepSession(input);
  assert.equal((await store.list()).sessions.length, 1);
  assert.equal(await store.removeSession(input), true);
  assert.equal(await store.removeSession(input), false);
});

test("multiple session Keeps are saved atomically without duplicates", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory, now: () => 789 });
  const input = { providerHome: "/home/codex", providerId: "codex" };

  const kept = await store.keepSessions({
    ...input,
    sessionIds: ["session-1", "session-2", "session-1"],
  });
  const snapshot = await store.list();

  assert.deepEqual(kept.map((item) => item.sessionId), ["session-1", "session-2"]);
  assert.deepEqual(snapshot.sessions.map((item) => item.sessionId), ["session-1", "session-2"]);
  assert.equal(snapshot.revision, 1);
});

test("compiled Keep matching uses direct ID lookup and the closest workspace ancestor", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory });
  await store.keepSession({ providerHome: "/home/codex", providerId: "codex", sessionId: "direct" });
  await store.keepWorkspace({ workspace: "/work" });
  await store.keepWorkspace({ workspace: "/work/product" });
  const match = compileSessionProtectionMatcher({
    providerHome: "/home/codex",
    providerId: "codex",
    snapshot: await store.list(),
  });

  assert.deepEqual(match({ cwd: "/elsewhere", id: "direct" }).reasons, ["session"]);
  assert.deepEqual(match({ cwd: "/work/product/app", id: "workspace" }), {
    kept: true,
    reasons: ["workspace"],
    session: false,
    workspace: true,
    workspacePath: "/work/product",
  });
});

test("bulk Keep removal is atomic", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  const store = createSessionProtectionStore({ configDirectory });
  const input = { providerHome: "/home/codex", providerId: "codex" };
  await store.keepSessions({ ...input, sessionIds: ["one", "two", "three"] });

  assert.equal(await store.removeSessions({ ...input, sessionIds: ["one", "three"] }), 2);
  assert.deepEqual((await store.list()).sessions.map((item) => item.sessionId), ["two"]);
});

test("workspace rules are searched and paginated without returning the whole rule set", async (context) => {
  const configDirectory = await temporaryDirectory(context);
  await fs.mkdir(configDirectory, { recursive: true });
  const workspaces = Array.from({ length: 10_000 }, (_, index) => ({
    createdAtMs: index,
    path: `/work/project-${String(index).padStart(5, "0")}`,
  }));
  await fs.writeFile(path.join(configDirectory, "protections.json"), JSON.stringify({
    revision: 1,
    sessions: [],
    version: 1,
    workspaces,
  }));
  const store = createSessionProtectionStore({ configDirectory });

  const page = await store.listWorkspaceRules({ page: 2, pageSize: 25 });
  assert.equal(page.total, 10_000);
  assert.equal(page.pageCount, 400);
  assert.equal(page.records.length, 25);
  assert.equal(page.records[0].path, "/work/project-09974");

  const searched = await store.listWorkspaceRules({ search: "project-00042" });
  assert.equal(searched.total, 1);
  assert.equal(searched.records[0].path, "/work/project-00042");
});
