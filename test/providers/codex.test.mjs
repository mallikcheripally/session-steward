import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { getProvider, listProviders } from "../../lib/providers/index.mjs";
import { queryRows } from "../../lib/storage/sqlite.mjs";
import {
  appendTranscriptOnlySubagent,
  createCodexHomeFixture,
  fixtureSessionIds,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");

test("the provider registry exposes Codex explicitly", () => {
  assert.deepEqual(listProviders().map(({ id }) => id), ["codex"]);
  assert.equal(codex.displayName, "Codex");
});

test("Codex discovery preserves relationships and readable names", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.equal(store.records.length, 3);

  const parent = store.recordsById.get(fixtureSessionIds.parent);
  const child = store.recordsById.get(fixtureSessionIds.child);
  assert.equal(parent.displayName, "Safer cleanup");
  assert.deepEqual(parent.childThreadIds, [fixtureSessionIds.child]);
  assert.equal(child.parentThreadId, fixtureSessionIds.parent);
  assert.equal(child.isSubagent, true);
});

test("Codex plans cascade from parent to child but not child to parent", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });

  const parentPlan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });
  assert.deepEqual(new Set(parentPlan.ids), new Set([
    fixtureSessionIds.parent,
    fixtureSessionIds.child,
  ]));
  assert.equal(parentPlan.childCount, 1);

  const childPlan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.child],
    store,
  });
  assert.deepEqual(childPlan.ids, [fixtureSessionIds.child]);
  assert.equal(childPlan.childCount, 0);
});

test("Codex cleanup cascades to transcript-only subagents", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const transcriptOnly = await appendTranscriptOnlySubagent(fixture);
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  assert.equal(store.recordsById.get(transcriptOnly.id).parentThreadId, transcriptOnly.parentId);
  assert.equal(store.recordsById.get(transcriptOnly.parentId).childThreadIds.includes(transcriptOnly.id), true);
  assert.equal(plan.ids.includes(transcriptOnly.id), true);
  assert.equal(plan.transcriptPaths.includes(transcriptOnly.transcriptPath), true);
});

test("Codex compatibility reports an unfamiliar database without claiming support", async (context) => {
  const fixture = await createCodexHomeFixture({ includeUnknownDatabase: true });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const compatibility = await codex.diagnoseStorageCompatibility({
    codexHome: fixture.codexHome,
  });
  assert.equal(compatibility.status, "newer-version");
  assert.deepEqual(
    compatibility.newlyDiscovered,
    ["Other local database found: future_1.sqlite"],
  );
  await assert.rejects(
    codex.assertDeepCleanupSupported({ codexHome: fixture.codexHome }),
    /unrecognized Codex storage/u,
  );
});

test("deep cleanup backs up, removes, and verifies only the selected family", async (context) => {
  const fixture = await createCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  const store = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  const plan = await codex.planSessionDeletion({
    recordIds: [fixtureSessionIds.parent],
    store,
  });

  const result = await codex.executeSessionDeletion({ plan, scope: "deep", store });
  const verification = await codex.verifySessionDeletion({ plan, scope: "deep", store });
  assert.equal(verification.complete, true);
  await access(result.backupDirectory);
  await access(path.join(result.backupDirectory, "history.jsonl"));
  await access(path.join(result.backupDirectory, "session_index.jsonl"));
  await access(path.join(result.backupDirectory, "transcripts", path.basename(fixture.transcripts.parent)));
  await access(path.join(result.backupDirectory, "transcripts", path.basename(fixture.transcripts.child)));
  const backupThreads = queryRows(
    path.join(result.backupDirectory, "databases", "state_5.sqlite"),
    "select id from threads order by id",
  );
  assert.equal(backupThreads.some(({ id }) => id === fixtureSessionIds.parent), true);
  assert.equal(backupThreads.some(({ id }) => id === fixtureSessionIds.child), true);
  const operation = JSON.parse(await readFile(
    path.join(result.backupDirectory, "operation.json"),
    "utf8",
  ));
  assert.deepEqual(new Set(operation.ids), new Set(plan.ids));

  const remainingStore = await codex.loadSessionStore({ codexHome: fixture.codexHome });
  assert.deepEqual(remainingStore.records.map(({ id }) => id), [fixtureSessionIds.standalone]);
});
