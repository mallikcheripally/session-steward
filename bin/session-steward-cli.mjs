#!/usr/bin/env node

import { parseArgs } from "node:util";

import { runCli } from "../lib/cli.mjs";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "codex-home": {
      type: "string",
    },
    help: {
      short: "h",
      type: "boolean",
    },
    "include-internals": {
      type: "boolean",
    },
    json: {
      type: "boolean",
    },
    limit: {
      type: "string",
    },
    search: {
      type: "string",
    },
    sort: {
      type: "string",
    },
  },
});

const numericLimit =
  values.limit && Number.isFinite(Number.parseInt(values.limit, 10))
    ? Number.parseInt(values.limit, 10)
    : null;

runCli({
  codexHome: values["codex-home"],
  help: values.help ?? false,
  includeInternals: values["include-internals"] ?? false,
  json: values.json ?? false,
  limit: numericLimit,
  search: values.search ?? "",
  sort: values.sort ?? "updated",
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
