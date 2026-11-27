import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");
// Recorded with the official CLIs in isolated homes, --bare --print,
// and a loopback SSE mock. No real model request or credentials were used.
const transcripts = new Map(await Promise.all(["2.1.325", "2.1.330", "2.1.332"].map(async (version) => [
  version, await fs.readFile(new URL(`../fixtures/claude-${version}.jsonl`, import.meta.url), "utf8"),
])));
const transcript = transcripts.get("2.1.332");
const recordedId = "44444444-4444-4444-8444-444444444444";

for (const [version, transcript] of transcripts) {
  for (const scope of ["core", "deep"]) {
    test(`Claude ${version} print-mode sessions support inspection, ${scope} cleanup, and restore`, async (context) => {
      const fixture = await createClaudeHomeFixture();
      context.after(() => removeClaudeHomeFixture(fixture));
      const contents = transcript.replaceAll(recordedId, fixture.cliId);
      await fs.writeFile(fixture.cliTranscript, contents);
      const configPath = path.join(fixture.claudeHome, ".claude.json");
      await fs.writeFile(configPath, '{"sharedConfig":true}\n');
      const compatibility = await claude.diagnoseStorageCompatibility(fixture);
      assert.equal(compatibility.status, "ready");
      assert.ok(compatibility.builtFor.claudeCli.includes(version));
      const listed = await claude.listSessions({ ...fixture, search: "Compatibility fixture request", pageSize: 1 });
      assert.equal(listed.total, 1);
      assert.equal(listed.records[0].id, fixture.cliId);
      assert.equal(listed.records[0].surface, "cli");
      const events = await claude.readSessionEvents({ ...fixture, id: fixture.cliId });
      assert.equal(events.header.version, version);
      assert.equal(events.coverage.unmapped, 0);
      assert.deepEqual(events.events.filter(({ kind }) => kind === "ask" || kind === "said").map(({ text }) => text), [
        "Compatibility fixture request.", "Compatibility fixture response.",
      ]);
      const tokens = await claude.readSessionTokens({ ...fixture, id: fixture.cliId });
      assert.equal(tokens.available, true);
      assert.equal(tokens.total, 8);
      const store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
      const plan = await claude.planSessionDeletion({ store, recordIds: [fixture.cliId] });
      const result = await claude.executeSessionDeletion({ store, plan, scope });
      assert.equal((await claude.verifySessionDeletion({ store, plan, scope })).complete, true);
      assert.equal(await fs.readFile(configPath, "utf8"), '{"sharedConfig":true}\n');
      await claude.restoreSessionDeletionBackup({ ...fixture, backupDirectory: result.backupDirectory });
      assert.equal(await fs.readFile(fixture.cliTranscript, "utf8"), contents);
      assert.equal((await claude.getSessionRecord({ ...fixture, id: fixture.unrelatedId })).id, fixture.unrelatedId);
    });
  }
}

test("current Claude Desktop metadata is skipped without hiding unknown records or conversation events", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const contents = transcript.replaceAll(recordedId, fixture.desktopId).replaceAll('"sdk-cli"', '"claude-desktop"');
  // Synthetic values preserve the metadata field shapes observed in Desktop
  // 6.28899.6. No user transcript or private app state is copied into fixtures.
  const metadata = [
    { type: "agent-name", agentName: "Compatibility agent", sessionId: fixture.desktopId },
    { type: "file-history-delta", messageId: "message", snapshotMessageId: "snapshot", trackingPath: "/workspace/example", backup: {}, timestamp: "2026-11-21T00:00:00Z" },
    { type: "relocated", relocatedCwd: "/workspace/relocated", sessionId: fixture.desktopId },
    { type: "api-request-blob", hash: "fixture", sessionId: fixture.desktopId, message: { role: "user", content: "Request metadata must not become a second user message." } },
    { type: "tools-used", tools: ["Read"], sessionId: fixture.desktopId },
    { type: "derived-from", v: 1, sessionId: fixture.desktopId, sessions: [{ type: "session", id: "other", via: "fork" }] },
    { type: "data-flow-records", v: 1, sessionId: fixture.desktopId, records: [] },
    { type: "data-flow-incomplete", v: 1, sessionId: fixture.desktopId, codes: [1] },
  ];
  await fs.writeFile(fixture.desktopTranscript, contents + metadata.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const options = { ...fixture, id: fixture.desktopId };
  const before = await claude.readSessionEvents(options);
  assert.equal(before.coverage.unmapped, 0);
  assert.deepEqual(before.events.filter(({ kind }) => kind === "ask" || kind === "said").map(({ text }) => text), [
    "Compatibility fixture request.", "Compatibility fixture response.",
  ]);
  await fs.appendFile(fixture.desktopTranscript, JSON.stringify({ type: "future-desktop-record", sessionId: fixture.desktopId }) + "\n");
  const after = await claude.readSessionEvents(options);
  assert.equal(after.coverage.unmapped, 1);
  assert.deepEqual(after.coverage.unmappedTypes, [{ type: "claude:future-desktop-record", count: 1 }]);
  assert.equal((await claude.readSessionTokens(options)).total, 8);
  assert.ok((await claude.diagnoseStorageCompatibility(fixture)).builtFor.claudeDesktop.includes("6.28899.6"));
});

test("Claude accepts CLI and print-mode copies of one local session while retaining unknown entrypoints", async (context) => {
  const fixture = await createClaudeHomeFixture();
  context.after(() => removeClaudeHomeFixture(fixture));
  const contents = transcript.replaceAll(recordedId, fixture.cliId);
  await fs.writeFile(fixture.cliTranscript, contents);
  const copyDirectory = path.join(fixture.claudeHome, "projects", "another-project");
  await fs.mkdir(copyDirectory);
  await fs.writeFile(path.join(copyDirectory, `${fixture.cliId}.jsonl`), contents.replaceAll('"sdk-cli"', '"cli"'));
  let store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  assert.equal(store.recordsById.get(fixture.cliId).transcriptPaths.length, 2);
  await fs.writeFile(fixture.cliTranscript, contents.replaceAll('"sdk-cli"', '"future-remote"'));
  claude.invalidateSessionCache(fixture);
  assert.equal((await claude.diagnoseStorageCompatibility(fixture)).status, "partial");
  store = await claude.loadDeletionStore({ ...fixture, recordIds: [fixture.cliId] });
  const plan = await claude.planSessionDeletion({ store, recordIds: [fixture.cliId] });
  assert.equal(plan.transcriptPaths.includes(fixture.cliTranscript), false);
});
