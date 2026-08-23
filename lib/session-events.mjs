export const SESSION_EVENT_KIND = Object.freeze({
  ASK: "ask",
  DECIDED: "decided",
  EDIT: "edit",
  PLAN: "plan",
  RAN: "ran",
  SAID: "said",
  SUMMARY: "summary",
});

export const SESSION_EVENT_COVERAGE_THRESHOLD = 90;

export const SESSION_EVENT_READ_MODE = Object.freeze({
  PREVIEW: "preview",
  RECENT: "recent",
});

export const SESSION_EVENT_REASON = Object.freeze({
  NO_RECOGNIZED_EVENTS: "no-recognized-events",
  NO_TRANSCRIPT_PATH: "no-transcript-path",
  TRANSCRIPT_MISSING: "transcript-missing",
});

export const SESSION_EVENT_WINDOW_END = Object.freeze({
  NEWEST: "newest",
  OLDEST: "oldest",
  PARTIAL: "partial",
});

const SESSION_EVENT_KINDS = new Set(Object.values(SESSION_EVENT_KIND));
const SESSION_EVENT_REASONS = new Set(Object.values(SESSION_EVENT_REASON));
const SESSION_EVENT_WINDOW_ENDS = new Set(Object.values(SESSION_EVENT_WINDOW_END));

function nullableBoolean(value, field) {
  if (value === null || typeof value === "boolean") return value;
  throw new TypeError(`${field} must be a boolean or null.`);
}

function nullableCount(value, field) {
  if (value === null || (Number.isInteger(value) && value >= 0)) return value;
  throw new TypeError(`${field} must be a non-negative integer or null.`);
}

function nullableString(value, field) {
  if (value === null || typeof value === "string") return value;
  throw new TypeError(`${field} must be a string or null.`);
}

function requiredCount(value, field) {
  if (Number.isInteger(value) && value >= 0) return value;
  throw new TypeError(`${field} must be a non-negative integer.`);
}

function requiredBoolean(value, field) {
  if (typeof value === "boolean") return value;
  throw new TypeError(`${field} must be a boolean.`);
}

function requiredString(value, field) {
  if (typeof value === "string") return value;
  throw new TypeError(`${field} must be a string.`);
}

function unmappedTypeEntries(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("coverage.unmappedTypes must be an array.");
  }

  return value.map((entry) => ({
    count: requiredCount(entry?.count, "coverage.unmappedTypes.count"),
    type: requiredString(entry?.type, "coverage.unmappedTypes.type"),
  }));
}

function sessionEventBase({ atMs, kind, sequence }) {
  if (!SESSION_EVENT_KINDS.has(kind)) {
    throw new TypeError(`Unsupported session event kind: ${kind}`);
  }

  if (atMs !== null && !Number.isFinite(atMs)) {
    throw new TypeError("atMs must be a finite number or null.");
  }

  return {
    atMs,
    kind,
    sequence: requiredCount(sequence, "sequence"),
  };
}

export function createSessionEvent({
  added = null,
  answer = null,
  applied = null,
  atMs = null,
  command = null,
  error = null,
  failed = null,
  files = [],
  injected = false,
  kind,
  question = null,
  removed = null,
  sequence,
  steps = [],
  text = null,
  unclassified = false,
  unextracted = false,
  workdir = null,
} = {}) {
  const base = sessionEventBase({ atMs, kind, sequence });

  if (kind === SESSION_EVENT_KIND.ASK) {
    return {
      atMs: base.atMs,
      injected: requiredBoolean(injected, "injected"),
      kind: base.kind,
      sequence: base.sequence,
      text: requiredString(text, "text"),
    };
  }

  if (kind === SESSION_EVENT_KIND.DECIDED) {
    return {
      answer: nullableString(answer, "answer"),
      atMs: base.atMs,
      kind: base.kind,
      question: requiredString(question, "question"),
      sequence: base.sequence,
    };
  }

  if (kind === SESSION_EVENT_KIND.EDIT) {
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
      throw new TypeError("files must be an array of strings.");
    }

    return {
      added: nullableCount(added, "added"),
      applied: nullableBoolean(applied, "applied"),
      atMs: base.atMs,
      files: [...files],
      kind: base.kind,
      removed: nullableCount(removed, "removed"),
      sequence: base.sequence,
    };
  }

  if (kind === SESSION_EVENT_KIND.PLAN) {
    if (!Array.isArray(steps)) {
      throw new TypeError("steps must be an array.");
    }

    return {
      atMs: base.atMs,
      kind: base.kind,
      sequence: base.sequence,
      steps: steps.map((step) => ({
        status: requiredString(step?.status, "step.status"),
        text: requiredString(step?.text, "step.text"),
      })),
    };
  }

  if (kind === SESSION_EVENT_KIND.RAN) {
    return {
      atMs: base.atMs,
      command: nullableString(command, "command"),
      error: nullableString(error, "error"),
      failed: nullableBoolean(failed, "failed"),
      kind: base.kind,
      sequence: base.sequence,
      unclassified: requiredBoolean(unclassified, "unclassified"),
      unextracted: requiredBoolean(unextracted, "unextracted"),
      workdir: nullableString(workdir, "workdir"),
    };
  }

  return {
    atMs: base.atMs,
    kind: base.kind,
    sequence: base.sequence,
    text: requiredString(text, "text"),
  };
}

export function createSessionEventCoverage({
  duplicates = 0,
  oversized = 0,
  recognized = 0,
  skipped = 0,
  total = 0,
  unmapped = 0,
  unmappedTypes = [],
  unparseable = 0,
} = {}) {
  return {
    duplicates: requiredCount(duplicates, "coverage.duplicates"),
    oversized: requiredCount(oversized, "coverage.oversized"),
    recognized: requiredCount(recognized, "coverage.recognized"),
    skipped: requiredCount(skipped, "coverage.skipped"),
    total: requiredCount(total, "coverage.total"),
    unmapped: requiredCount(unmapped, "coverage.unmapped"),
    unmappedTypes: unmappedTypeEntries(unmappedTypes),
    unparseable: requiredCount(unparseable, "coverage.unparseable"),
  };
}

export function createSessionEventSummary({ asks = 0, commands = 0, edits = 0 } = {}) {
  return {
    asks: requiredCount(asks, "summary.asks"),
    commands: requiredCount(commands, "summary.commands"),
    edits: requiredCount(edits, "summary.edits"),
  };
}

// Ordered largest-concept-first so the bar and its legend agree
export const SESSION_EVENT_COMPOSITION_SEGMENTS = Object.freeze([
  "toolOutput",
  "largeRecords",
  "compaction",
  "attachments",
  "messages",
  "edits",
  "reasoning",
  "other",
]);

export function createSessionEventComposition({
  attachments = 0,
  compaction = 0,
  edits = 0,
  largeRecords = 0,
  messages = 0,
  other = 0,
  reasoning = 0,
  toolOutput = 0,
  total = 0,
} = {}) {
  const composition = {
    attachments: requiredCount(attachments, "composition.attachments"),
    compaction: requiredCount(compaction, "composition.compaction"),
    edits: requiredCount(edits, "composition.edits"),
    largeRecords: requiredCount(largeRecords, "composition.largeRecords"),
    messages: requiredCount(messages, "composition.messages"),
    other: requiredCount(other, "composition.other"),
    reasoning: requiredCount(reasoning, "composition.reasoning"),
    toolOutput: requiredCount(toolOutput, "composition.toolOutput"),
    total: requiredCount(total, "composition.total"),
  };

  const segments = SESSION_EVENT_COMPOSITION_SEGMENTS
    .reduce((sum, segment) => sum + composition[segment], 0);

  if (segments !== composition.total) {
    throw new TypeError("Session event composition segments must add up to the transcript size.");
  }

  return composition;
}

export function finalizeSessionEventComposition(composition, transcriptBytes) {
  const attributed = SESSION_EVENT_COMPOSITION_SEGMENTS
    .filter((segment) => segment !== "other")
    .reduce((sum, segment) => sum + (composition[segment] ?? 0), 0);
  const total = Math.max(transcriptBytes ?? 0, attributed);

  return createSessionEventComposition({
    ...composition,
    other: total - attributed,
    total,
  });
}

export function sessionEventCoveragePercent(coverage) {
  const normalizedCoverage = createSessionEventCoverage(coverage);
  const considered = normalizedCoverage.total - normalizedCoverage.skipped;
  if (considered === 0) return 100;
  return Math.round((normalizedCoverage.recognized / considered) * 100);
}

export function createSessionEventHeader({
  cwd = null,
  git = null,
  model = null,
  origin = null,
  provider,
  version = null,
} = {}) {
  let normalizedGit = null;

  if (git !== null) {
    if (typeof git !== "object" || Array.isArray(git)) {
      throw new TypeError("git must be an object or null.");
    }

    normalizedGit = {
      branch: nullableString(git.branch ?? null, "git.branch"),
      commit: nullableString(git.commit ?? null, "git.commit"),
      repository: nullableString(git.repository ?? null, "git.repository"),
    };
  }

  return {
    cwd: nullableString(cwd, "cwd"),
    git: normalizedGit,
    model: nullableString(model, "model"),
    origin: nullableString(origin, "origin"),
    provider: requiredString(provider, "provider"),
    version: nullableString(version, "version"),
  };
}

export function createSessionEventsResult({
  composition,
  coverage,
  events = [],
  header,
  reason = null,
  summary,
  tokens = null,
  window = {},
} = {}) {
  const normalizedCoverage = createSessionEventCoverage(coverage);
  const normalizedSummary = createSessionEventSummary(summary);
  const normalizedComposition = createSessionEventComposition(composition);

  if (
    normalizedCoverage.recognized
      + normalizedCoverage.skipped
      + normalizedCoverage.unmapped
      + normalizedCoverage.unparseable
      + normalizedCoverage.oversized
    !== normalizedCoverage.total
  ) {
    throw new TypeError("Session event coverage counts must add up to the total.");
  }

  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array.");
  }

  if (reason !== null && !SESSION_EVENT_REASONS.has(reason)) {
    throw new TypeError(`Unsupported session event reason: ${reason}`);
  }

  if (reason !== null && events.length > 0) {
    throw new TypeError("A session event reason requires an empty event list.");
  }

  const complete = window.complete ?? true;
  const end = window.end ?? SESSION_EVENT_WINDOW_END.NEWEST;
  const outcomesMayBeUnresolved = window.outcomesMayBeUnresolved ?? false;

  if (typeof complete !== "boolean") {
    throw new TypeError("window.complete must be a boolean.");
  }

  if (end !== null && !SESSION_EVENT_WINDOW_ENDS.has(end)) {
    throw new TypeError(`Unsupported session event window end: ${end}`);
  }

  if (typeof outcomesMayBeUnresolved !== "boolean") {
    throw new TypeError("window.outcomesMayBeUnresolved must be a boolean.");
  }

  return {
    coverage: normalizedCoverage,
    events: [...events],
    header: createSessionEventHeader(header),
    reason,
    composition: normalizedComposition,
    summary: normalizedSummary,
    // Counted during this same pass, so the panel's header does not have to
    // read the transcript a second time to fill in two fields.
    tokens,
    window: {
      complete,
      end,
      outcomesMayBeUnresolved,
    },
  };
}
