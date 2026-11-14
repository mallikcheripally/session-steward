import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import { createClaudeHomeFixture, removeClaudeHomeFixture } from "../fixtures/claude-home.mjs";

const claude = getProvider("claude-code");
// Recorded with the official 2.1.325 CLI in an isolated home, --bare --print,
// and a loopback SSE mock. No real model request or credentials were used.
const transcript = await fs.readFile(new URL("../fixtures/claude-2.1.325.jsonl", import.meta.url), "utf8");
const recordedId = "44444444-4444-4444-8444-444444444444";

for (const scope of ["core", "deep"]) {
  test(`Claude 2.1.325 print-mode sessions support inspection, ${scope} cleanup, and restore`, async (context) => {
    const fixture = await createClaudeHomeFixture();
    context.after(() => removeClaudeHomeFixture(fixture));
    const contents = transcript.replaceAll(recordedId, fixture.cliId);
    await fs.writeFile(fixture.cliTranscript, contents);
    const configPath = path.join(fixture.claudeHome, ".claude.json");
    await fs.writeFile(configPath, '{"sharedConfig":true}\n');
    const compatibility = await claude.diagnoseStorageCompatibility(fixture);
    assert.equal(compatibility.status, "ready");
    assert.ok(compatibility.builtFor.claudeCli.includes("2.1.325"));
    const listed = await claude.listSessions({ ...fixture, search: "Compatibility fixture request", pageSize: 1 });
    assert.equal(listed.total, 1);
    assert.equal(listed.records[0].id, fixture.cliId);
    assert.equal(listed.records[0].surface, "cli");
    const events = await claude.readSessionEvents({ ...fixture, id: fixture.cliId });
    assert.equal(events.header.version, "2.1.325");
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
