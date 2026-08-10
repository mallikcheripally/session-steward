export const SESSION_EVENT_BATCH_SIZE = 100;
export const SESSION_EVENT_COLLAPSED_CHARACTERS = 320;
export const SESSION_EVENT_EXPANDED_CHARACTERS = 2_000;

export function newestSessionEvents(events) {
  return [...events].reverse();
}

export function sessionEventText(value, expanded = false) {
  const text = typeof value === "string" ? value : "";
  const limit = expanded
    ? SESSION_EVENT_EXPANDED_CHARACTERS
    : SESSION_EVENT_COLLAPSED_CHARACTERS;
  return {
    capped: text.length > SESSION_EVENT_EXPANDED_CHARACTERS,
    expandable: text.length > SESSION_EVENT_COLLAPSED_CHARACTERS,
    text: text.length > limit ? `${text.slice(0, limit)}…` : text,
  };
}

export function sessionEventCoveragePercent(coverage) {
  const considered = coverage.total - coverage.skipped;
  if (considered === 0) return 100;
  return Math.round((coverage.recognized / considered) * 100);
}
