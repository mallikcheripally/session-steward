#!/usr/bin/env node

import { parseArgs } from "node:util";

import { assertSupportedNode } from "../lib/runtime.mjs";

assertSupportedNode();

const { runCli } = await import("../lib/cli.mjs");

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

async function main() {
  const help = values.help ?? false;
  let codexHome = values["codex-home"];

  if (!help) {
    const { createProviderSettings } = await import("../lib/settings.mjs");
    const settings = await createProviderSettings({
      providerHomeOverrides: codexHome === undefined ? {} : { codex: codexHome },
    });
    codexHome = settings.getHome("codex");
  }

  await runCli({
    codexHome,
    help,
    includeInternals: values["include-internals"] ?? false,
    json: values.json ?? false,
    limit: numericLimit,
    search: values.search ?? "",
    sort: values.sort ?? "updated",
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
