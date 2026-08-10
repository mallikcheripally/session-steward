import {
  SESSION_EVENT_READ_MODE,
  SESSION_EVENT_WINDOW_END,
} from "./session-events.mjs";

export const DEFAULT_SESSION_EVENT_LIMIT = 100;
export const MAX_SESSION_EVENT_LIMIT = 1_000;

const MAX_PENDING_SESSION_EVENTS = 2_048;
const MAX_UNMAPPED_SESSION_EVENT_TYPES = 128;
const SESSION_EVENT_READ_MODES = new Set(Object.values(SESSION_EVENT_READ_MODE));
const WRAPPED_CONTEXT_PATTERN = /^<([A-Za-z][\w:.-]*[_-][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/u;

export function isInjectedSessionAsk(value) {
  if (typeof value !== "string") return false;
  let remaining = value.trim();
  if (!remaining) return false;
  if (/^#{1,6}\s+[^\n]*\binstructions?\b/iu.test(remaining)) return true;
  let matched = false;

  while (remaining) {
    const match = WRAPPED_CONTEXT_PATTERN.exec(remaining);
    if (!match) return false;
    matched = true;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return matched;
}

export function createSessionEventReadState({
  limit = DEFAULT_SESSION_EVENT_LIMIT,
  mode = SESSION_EVENT_READ_MODE.RECENT,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_EVENT_LIMIT) {
    throw new TypeError(`limit must be between 1 and ${MAX_SESSION_EVENT_LIMIT}.`);
  }

  if (!SESSION_EVENT_READ_MODES.has(mode)) {
    throw new TypeError(`Unsupported session event read mode: ${mode}`);
  }

  const events = new Array(limit);
  const pending = new Map();
  const pendingIds = new WeakMap();
  let length = 0;
  let start = 0;

  function untrack(event) {
    const pendingId = pendingIds.get(event);
    if (pendingId && pending.get(pendingId) === event) pending.delete(pendingId);
  }

  return {
    add(event, { pendingId = null } = {}) {
      if (pendingId) {
        pending.delete(pendingId);
        pending.set(pendingId, event);
        pendingIds.set(event, pendingId);

        while (pending.size > MAX_PENDING_SESSION_EVENTS) {
          pending.delete(pending.keys().next().value);
        }
      }

      if (length < limit) {
        events[(start + length) % limit] = event;
        length += 1;
      } else if (mode === SESSION_EVENT_READ_MODE.RECENT) {
        untrack(events[start]);
        events[start] = event;
        start = (start + 1) % limit;
      }

      return mode === SESSION_EVENT_READ_MODE.PREVIEW && length === limit;
    },
    resolve(pendingId, update, { consume = true } = {}) {
      const event = pending.get(pendingId);
      if (!event) return false;
      if (consume) pending.delete(pendingId);
      update(event);
      return true;
    },
    values() {
      return Array.from({ length }, (_, index) => events[(start + index) % limit]);
    },
    window({ complete, stoppedEarly }) {
      return {
        complete,
        end: stoppedEarly
          ? SESSION_EVENT_WINDOW_END.OLDEST
          : complete
            ? SESSION_EVENT_WINDOW_END.NEWEST
            : SESSION_EVENT_WINDOW_END.PARTIAL,
        outcomesMayBeUnresolved: stoppedEarly || !complete,
      };
    },
  };
}

export function createUnmappedSessionEventTracker() {
  const counts = new Map();
  let other = 0;

  return {
    add(type) {
      const normalizedType = typeof type === "string" && type.trim()
        ? type.trim()
        : "unknown";
      if (counts.has(normalizedType)) {
        counts.set(normalizedType, counts.get(normalizedType) + 1);
      } else if (counts.size < MAX_UNMAPPED_SESSION_EVENT_TYPES) {
        counts.set(normalizedType, 1);
      } else {
        other += 1;
      }
    },
    values(limit = 5) {
      const entries = [...counts].map(([type, count]) => ({ count, type }));
      if (other > 0) entries.push({ count: other, type: "other unmapped types" });
      return entries
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
        .slice(0, limit);
    },
  };
}
