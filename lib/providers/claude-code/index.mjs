import { readSessionEvents } from "./events.mjs";
import { readSessionTokens } from "./tokens.mjs";
import * as store from "./store.mjs";

export const claudeCodeProvider = Object.freeze({
  id: "claude-code",
  displayName: "Claude Code",
  ...store,
  readSessionEvents,
  readSessionTokens,
});
