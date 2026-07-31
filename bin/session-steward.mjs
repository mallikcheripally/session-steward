#!/usr/bin/env node

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

import { assertSupportedNode } from "../lib/runtime.mjs";

assertSupportedNode();

const { startLocalServer } = await import("../lib/server.mjs");

const { values } = parseArgs({
  options: {
    "codex-home": { type: "string" },
    "no-open": { type: "boolean", default: false },
    port: { type: "string" },
  },
});
const port = values.port === undefined ? 0 : Number.parseInt(values.port, 10);

const server = await startLocalServer({
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
