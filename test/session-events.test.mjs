import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionEventReadState,
  isInjectedSessionAsk,
} from "../lib/session-event-reader.mjs";
import {
  createSessionEvent,
  createSessionEventComposition,
  createSessionEventCoverage,
  createSessionEventHeader,
  createSessionEventSummary,
  createSessionEventsResult,
  SESSION_EVENT_KIND,
  SESSION_EVENT_COVERAGE_THRESHOLD,
  SESSION_EVENT_REASON,
  SESSION_EVENT_WINDOW_END,
  sessionEventCoveragePercent,
} from "../lib/session-events.mjs";

test("defines the shared session event vocabulary", () => {
  assert.deepEqual(SESSION_EVENT_KIND, {
    ASK: "ask",
    DECIDED: "decided",
    EDIT: "edit",
    PLAN: "plan",
    RAN: "ran",
    SAID: "said",
    SUMMARY: "summary",
  });

  assert.deepEqual(
    createSessionEvent({
      atMs: null,
      injected: true,
      kind: SESSION_EVENT_KIND.ASK,
      sequence: 0,
      text: "Review this session",
    }),
    {
      atMs: null,
      injected: true,
      kind: "ask",
      sequence: 0,
      text: "Review this session",
    },
  );
  assert.deepEqual(
    createSessionEvent({
      atMs: 1_000,
      kind: SESSION_EVENT_KIND.SAID,
      sequence: 1,
      text: "The cleanup is safe.",
    }),
    {
      atMs: 1_000,
      kind: "said",
      sequence: 1,
      text: "The cleanup is safe.",
    },
  );
  assert.deepEqual(
    createSessionEvent({
      added: 12,
      atMs: 2_000,
      files: ["lib/session-events.mjs"],
      kind: SESSION_EVENT_KIND.EDIT,
      removed: 4,
      sequence: 2,
    }),
    {
      added: 12,
      applied: null,
      atMs: 2_000,
      files: ["lib/session-events.mjs"],
      kind: "edit",
      removed: 4,
      sequence: 2,
    },
  );
  assert.deepEqual(
    createSessionEvent({
      atMs: 3_000,
      command: "npm test",
      kind: SESSION_EVENT_KIND.RAN,
      sequence: 3,
      workdir: "/workspace/session-steward",
    }),
    {
      atMs: 3_000,
      command: "npm test",
      error: null,
      failed: null,
      kind: "ran",
      sequence: 3,
      unclassified: false,
      unextracted: false,
      workdir: "/workspace/session-steward",
    },
  );
  assert.deepEqual(
    createSessionEvent({
      answer: "Fix now",
      atMs: 4_000,
      kind: SESSION_EVENT_KIND.DECIDED,
      question: "Fix now or continue?",
      sequence: 4,
    }),
    {
      answer: "Fix now",
      atMs: 4_000,
      kind: "decided",
      question: "Fix now or continue?",
      sequence: 4,
    },
  );
  assert.deepEqual(
    createSessionEvent({
      atMs: 5_000,
      kind: SESSION_EVENT_KIND.PLAN,
      sequence: 5,
      steps: [{ status: "completed", text: "Define the vocabulary" }],
    }),
    {
      atMs: 5_000,
      kind: "plan",
      sequence: 5,
      steps: [{ status: "completed", text: "Define the vocabulary" }],
    },
  );
  assert.deepEqual(
    createSessionEvent({
      atMs: 6_000,
      kind: SESSION_EVENT_KIND.SUMMARY,
      sequence: 6,
      text: "Prior work was compacted.",
    }),
    {
      atMs: 6_000,
      kind: "summary",
      sequence: 6,
      text: "Prior work was compacted.",
    },
  );
});

test("keeps recent event and pending-outcome memory bounded by the requested limit", () => {
  const state = createSessionEventReadState({ limit: 2 });
  const first = createSessionEvent({
    command: "first",
    kind: SESSION_EVENT_KIND.RAN,
    sequence: 0,
  });
  const second = createSessionEvent({
    command: "second",
    kind: SESSION_EVENT_KIND.RAN,
    sequence: 1,
  });
  const third = createSessionEvent({
    command: "third",
    kind: SESSION_EVENT_KIND.RAN,
    sequence: 2,
  });
  state.add(first, { pendingId: "first" });
  state.add(second, { pendingId: "second" });
  state.add(third, { pendingId: "third" });

  assert.deepEqual(state.values(), [second, third]);
  assert.equal(state.resolve("first", () => {}), false);
  assert.equal(state.resolve("third", (event) => {
    event.failed = false;
  }), true);
  assert.equal(third.failed, false);
});

test("marks only conservative machine-wrapped leading asks as injected", () => {
  assert.equal(
    isInjectedSessionAsk("<future_context>Generated context</future_context>"),
    true,
  );
  assert.equal(
    isInjectedSessionAsk([
      "<app-context>Generated context</app-context>",
      "<other_context>More context</other_context>",
    ].join("\n")),
    true,
  );
  assert.equal(isInjectedSessionAsk("# AGENTS.md instructions\nKeep changes focused."), true);
  assert.equal(
    isInjectedSessionAsk("<future_context>Generated context</future_context>\nFix the bug."),
    false,
  );
  assert.equal(isInjectedSessionAsk("<div>Ordinary markup</div>"), false);
});

test("reports recognized coverage apart from deliberate exclusions", () => {
  assert.equal(SESSION_EVENT_COVERAGE_THRESHOLD, 90);
  assert.equal(sessionEventCoveragePercent({
    duplicates: 0,
    oversized: 0,
    recognized: 9,
    skipped: 10,
    total: 20,
    unmapped: 0,
    unparseable: 1,
  }), 90);
  assert.equal(sessionEventCoveragePercent({
    duplicates: 0,
    oversized: 0,
    recognized: 0,
    skipped: 12,
    total: 12,
    unmapped: 0,
    unparseable: 0,
  }), 100);
  assert.equal(sessionEventCoveragePercent({
    duplicates: 0,
    oversized: 0,
    recognized: 9,
    skipped: 10,
    total: 20,
    unmapped: 1,
    unparseable: 0,
  }), 90);
});

test("normalizes full-session activity counts", () => {
  assert.deepEqual(createSessionEventSummary(), {
    asks: 0,
    commands: 0,
    edits: 0,
  });
  assert.deepEqual(createSessionEventSummary({ asks: 14, commands: 23, edits: 47 }), {
    asks: 14,
    commands: 23,
    edits: 47,
  });
  assert.throws(
    () => createSessionEventSummary({ edits: -1 }),
    /summary\.edits must be a non-negative integer/u,
  );
});

test("marks a preview complete when the transcript ends before its limit", () => {
  const state = createSessionEventReadState({
    limit: 2,
    mode: "preview",
  });
  state.add(createSessionEvent({
    kind: SESSION_EVENT_KIND.SAID,
    sequence: 0,
    text: "Done",
  }));

  assert.deepEqual(state.window({ complete: true, stoppedEarly: false }), {
    complete: true,
    end: "newest",
    outcomesMayBeUnresolved: false,
  });
});

test("keeps edit and command outcomes on their originating events", () => {
  const edit = createSessionEvent({
    files: ["lib/session-events.mjs"],
    kind: SESSION_EVENT_KIND.EDIT,
    sequence: 0,
  });
  const command = createSessionEvent({
    command: "npm test",
    kind: SESSION_EVENT_KIND.RAN,
    sequence: 1,
  });

  assert.equal(edit.applied, null);
  assert.equal(command.failed, null);

  edit.applied = true;
  command.error = "Exit code 1";
  command.failed = true;

  assert.equal(edit.applied, true);
  assert.equal(command.error, "Exit code 1");
  assert.equal(command.failed, true);
});

test("builds a provider-agnostic extraction result", () => {
  const coverage = createSessionEventCoverage({
    duplicates: 0,
    oversized: 1,
    recognized: 3,
    skipped: 2,
    total: 7,
    unparseable: 1,
  });
  const header = createSessionEventHeader({
    cwd: "/workspace/session-steward",
    git: {
      branch: "main",
      commit: "abc123",
      repository: "https://github.com/mallikcheripally/session-steward",
    },
    model: "gpt-5",
    origin: "cli",
    provider: "codex",
    version: "0.146.0",
  });
  const events = [createSessionEvent({
    kind: SESSION_EVENT_KIND.ASK,
    sequence: 0,
    text: "Proceed",
  })];
  const summary = createSessionEventSummary({ asks: 1, commands: 2, edits: 3 });
  const composition = createSessionEventComposition({
    attachments: 15,
    compaction: 25,
    edits: 20,
    largeRecords: 60,
    messages: 10,
    other: 5,
    reasoning: 15,
    toolOutput: 90,
    total: 240,
  });

  assert.deepEqual(createSessionEventsResult({
    composition,
    coverage,
    events,
    header,
    summary,
    window: {
      complete: false,
      end: SESSION_EVENT_WINDOW_END.OLDEST,
      outcomesMayBeUnresolved: true,
    },
  }), {
    composition,
    coverage,
    events,
    header,
    reason: null,
    summary,
    window: {
      complete: false,
      end: "oldest",
      outcomesMayBeUnresolved: true,
    },
  });

  assert.equal(createSessionEventsResult({
    coverage: createSessionEventCoverage(),
    events: [],
    header,
    reason: SESSION_EVENT_REASON.NO_RECOGNIZED_EVENTS,
  }).reason, "no-recognized-events");
});

test("session event composition requires an exact byte total", () => {
  assert.throws(
    () => createSessionEventComposition({ messages: 10, total: 9 }),
    /must add up to the transcript size/u,
  );
  assert.throws(
    () => createSessionEventComposition({ messages: -1, total: -1 }),
    /composition.messages/u,
  );
});

test("rejects invalid vocabulary values and inconsistent coverage", () => {
  assert.throws(
    () => createSessionEvent({ kind: "tool_use", sequence: 0 }),
    /Unsupported session event kind/u,
  );
  assert.throws(
    () => createSessionEvent({ kind: SESSION_EVENT_KIND.ASK, sequence: -1, text: "Proceed" }),
    /sequence must be a non-negative integer/u,
  );
  assert.throws(
    () => createSessionEventsResult({
      coverage: { recognized: 1, total: 2 },
      header: { provider: "codex" },
    }),
    /coverage counts must add up to the total/u,
  );
});
