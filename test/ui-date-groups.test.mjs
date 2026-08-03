import assert from "node:assert/strict";
import test from "node:test";

import { sessionDateGroup, sessionDateGroupForSort } from "../ui/src/date-groups.mjs";

test("session date groups use local calendar boundaries", () => {
  const now = new Date(2026, 7, 5, 12).getTime();

  assert.equal(sessionDateGroup(new Date(2026, 7, 5, 8).getTime(), now), "Today");
  assert.equal(sessionDateGroup(new Date(2026, 7, 4, 8).getTime(), now), "Yesterday");
  assert.equal(sessionDateGroup(new Date(2026, 7, 3, 8).getTime(), now), "Earlier this week");
  assert.equal(sessionDateGroup(new Date(2026, 7, 1, 8).getTime(), now), "Earlier this month");
  assert.equal(sessionDateGroup(new Date(2026, 6, 31, 8).getTime(), now), "Older");
  assert.equal(sessionDateGroup(0, now), "Older");
});

test("only chronological sorts produce session date groups", () => {
  const now = new Date(2026, 7, 5, 12).getTime();
  const record = {
    createdAtMs: new Date(2026, 7, 4, 8).getTime(),
    updatedAtMs: new Date(2026, 7, 5, 8).getTime(),
  };

  assert.equal(sessionDateGroupForSort(record, "created", now), "Yesterday");
  assert.equal(sessionDateGroupForSort(record, "updated", now), "Today");
  for (const sort of ["cwd", "name", "size"]) {
    assert.equal(sessionDateGroupForSort(record, sort, now), null);
  }
});
