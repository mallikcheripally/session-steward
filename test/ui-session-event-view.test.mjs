import assert from "node:assert/strict";
import test from "node:test";

import {
  newestSessionEvents,
  SESSION_EVENT_COLLAPSED_CHARACTERS,
  SESSION_EVENT_EXPANDED_CHARACTERS,
  sessionEventCoveragePercent,
  sessionEventText,
} from "../ui/src/session-event-view.mjs";

test("session timeline helpers keep newest events first and cap rendered text", () => {
  const events = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }];
  assert.deepEqual(newestSessionEvents(events).map(({ sequence }) => sequence), [3, 2, 1]);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3]);

  const large = "x".repeat(SESSION_EVENT_EXPANDED_CHARACTERS + 100);
  const collapsed = sessionEventText(large);
  const expanded = sessionEventText(large, true);
  assert.equal(collapsed.expandable, true);
  assert.equal(collapsed.text.length, SESSION_EVENT_COLLAPSED_CHARACTERS + 1);
  assert.equal(expanded.capped, true);
  assert.equal(expanded.text.length, SESSION_EVENT_EXPANDED_CHARACTERS + 1);
});

test("coverage excludes records deliberately skipped by the provider", () => {
  assert.equal(sessionEventCoveragePercent({
    recognized: 9,
    skipped: 10,
    total: 20,
  }), 90);
});
