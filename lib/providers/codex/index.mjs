import {
  diagnoseStorageCompatibility,
  executeSessionDeletion,
  filterAndSortSessions,
  formatSessionForJson,
  getSessionRecord,
  listSessions,
  loadSessionStore,
  planSessionDeletion,
  preflightSessionDeletion,
  verifySessionDeletion,
} from "./store.mjs";

export const codexProvider = Object.freeze({
  id: "codex",
  displayName: "Codex",
  diagnoseStorageCompatibility,
  executeSessionDeletion,
  filterAndSortSessions,
  formatSessionForJson,
  getSessionRecord,
  listSessions,
  loadSessionStore,
  planSessionDeletion,
  preflightSessionDeletion,
  verifySessionDeletion,
});
