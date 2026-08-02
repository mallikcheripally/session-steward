#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

import packageMetadata from "../package.json" with { type: "json" };
import { assertSupportedNode } from "../lib/runtime.mjs";
import { findAvailableUpdate, formatUpdateNotice } from "../lib/update-check.mjs";

assertSupportedNode();

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "codex-home": { type: "string" },
    "claude-home": { type: "string" },
    help: { short: "h", type: "boolean" },
    "no-open": { type: "boolean", default: false },
    port: { type: "string" },
    version: { short: "v", type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(`Usage: session-steward [options]

Options:
  --codex-home <path>  Use a custom Codex session folder
  --claude-home <path> Use a custom Claude session folder
  --port <number>      Use a specific local port
  --no-open            Start without opening a browser
  -h, --help           Show this help
  -v, --version        Show the installed version
`);
  process.exit(0);
}

if (values.version) {
  process.stdout.write(`${packageMetadata.version}\n`);
  process.exit(0);
}

const { startLocalServer } = await import("../lib/server.mjs");
const port = values.port === undefined ? 0 : Number.parseInt(values.port, 10);
const availableUpdate = await findAvailableUpdate({ packageMetadata });

if (availableUpdate) {
  process.stdout.write(`${formatUpdateNotice(availableUpdate)}\n`);
}

const server = await startLocalServer({
  claudeHome: values["claude-home"],
  codexHome: values["codex-home"],
  port,
});

process.stdout.write(`Session Steward is running at http://127.0.0.1:${server.port}\n`);

if (!values["no-open"]) {
  const url = `http://127.0.0.1:${server.port}`;
  const openerCommand = process.platform === "darwin"
    ? "open"
    : process.platform === "linux"
      ? "xdg-open"
      : null;

  if (openerCommand) {
    const opener = spawn(openerCommand, [url], { detached: true, stdio: "ignore" });
    opener.unref();
  } else {
    process.stdout.write(`Open ${url} in a browser.\n`);
  }
}

process.stdout.write("Press Ctrl+C to stop.\n");
