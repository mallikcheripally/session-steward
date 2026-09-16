import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

const executable = process.argv[2];

if (!executable) {
  throw new Error("Usage: node test/packed-mcp-smoke.mjs <session-steward executable>");
}

const expectedTools = [
  "clean_sessions",
  "find_sessions",
  "get_overview",
  "inspect_session",
  "list_backups",
  "manage_automatic_cleanup",
  "manage_settings",
  "restore_backup",
];
const transport = new StdioClientTransport({
  args: ["mcp"],
  command: executable,
  cwd: process.cwd(),
  env: getDefaultEnvironment(),
  stderr: "pipe",
});
const client = new Client({ name: "session-steward-packed-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map(({ name }) => name).sort(), expectedTools);
} finally {
  await Promise.allSettled([client.close(), transport.close()]);
}

console.log("Packed session-steward MCP launcher completed a stdio handshake.");
