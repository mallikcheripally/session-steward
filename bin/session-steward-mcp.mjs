#!/usr/bin/env node

import { parseArgs } from "node:util";

import packageMetadata from "../package.json" with { type: "json" };
import { assertSupportedNode } from "../lib/runtime.mjs";

assertSupportedNode();

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "claude-home": { type: "string" },
    "codex-home": { type: "string" },
    help: { short: "h", type: "boolean" },
    version: { short: "v", type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(`Usage: session-steward-mcp [options]

Run Session Steward's MCP server over stdio. MCP clients start and stop this
process automatically. Destructive tools use the client's normal approval flow.

Options:
  --codex-home <path>  Use a custom Codex session folder
  --claude-home <path> Use a custom Claude session folder
  -h, --help           Show this help
  -v, --version        Show the installed version
`);
  process.exit(0);
}

if (values.version) {
  process.stdout.write(`${packageMetadata.version}\n`);
  process.exit(0);
}

const { createProviderSettings } = await import("../lib/settings.mjs");
const { serveMcp } = await import("../lib/mcp.mjs");
const providerHomeOverrides = {};

if (values["codex-home"] !== undefined) {
  providerHomeOverrides.codex = values["codex-home"];
}
if (values["claude-home"] !== undefined) {
  providerHomeOverrides["claude-code"] = values["claude-home"];
}

const settings = await createProviderSettings({ providerHomeOverrides });
const handle = serveMcp({
  onerror: (error) => process.stderr.write(`Session Steward MCP error: ${error.message}\n`),
  settings,
});
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  await handle.close();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
