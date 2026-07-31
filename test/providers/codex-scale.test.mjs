import assert from "node:assert/strict";
import { stat, truncate } from "node:fs/promises";
import test from "node:test";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const codex = getProvider("codex");
const fixtureSessionSearch = "Build a safer cleanup flow";

test("Codex listing stays bounded for a large session collection", async (context) => {
  const fixture = await createLargeCodexHomeFixture();
  context.after(() => removeCodexHomeFixture(fixture.codexHome));

  const firstPage = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    page: 1,
    pageSize: 25,
  });
  const secondPage = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    page: 2,
    pageSize: 25,
  });

  assert.equal(firstPage.total, fixture.sessionCount + 3);
  assert.equal(firstPage.records.length, 25);
  assert.equal(secondPage.records.length, 25);
  assert.equal(firstPage.pageSize, 25);
  assert.equal(
    firstPage.records.some(({ id }) => secondPage.records.some((record) => record.id === id)),
    false,
  );
  assert.ok(JSON.stringify(firstPage).length < 50_000);
});

test("Codex listing does not read a large transcript body", async (context) => {
  const fixture = await createLargeCodexHomeFixture({ sessionCount: 10 });
  context.after(() => removeCodexHomeFixture(fixture.codexHome));
  await truncate(fixture.transcripts.parent, 256 * 1024 * 1024);
  assert.equal((await stat(fixture.transcripts.parent)).size, 256 * 1024 * 1024);

  const result = await codex.listSessions({
    codexHome: fixture.codexHome,
    includeInternals: true,
    pageSize: 25,
    search: fixtureSessionSearch,
  });

  assert.equal(result.total, 1);
  assert.equal(result.records[0].id, "11111111-1111-4111-8111-111111111111");
});
