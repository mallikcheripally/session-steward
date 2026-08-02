#!/usr/bin/env node

import { parseArgs } from "node:util";

import { assertSupportedNode } from "../lib/runtime.mjs";

assertSupportedNode();

const { runCli } = await import("../lib/cli.mjs");

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "archive-status": {
      type: "string",
    },
    "codex-home": {
      type: "string",
    },
    "claude-home": {
      type: "string",
    },
    help: {
      short: "h",
      type: "boolean",
    },
    "inactive-days": {
      type: "string",
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
    provider: {
      type: "string",
    },
    search: {
      type: "string",
    },
    sort: {
      type: "string",
    },
    workspace: {
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
  const providerId = values.provider || "codex";
  if (!["codex", "claude-code"].includes(providerId)) throw new Error("Provider must be codex or claude-code.");
  const homeOption = providerId === "codex" ? values["codex-home"] : values["claude-home"];
  let providerHome = homeOption;

  if (!help) {
    const { createProviderSettings } = await import("../lib/settings.mjs");
    const settings = await createProviderSettings({
      providerHomeOverrides: providerHome === undefined ? {} : { [providerId]: providerHome },
    });
    providerHome = settings.getHome(providerId);
  }

  await runCli({
    archiveStatus: values["archive-status"],
    help,
    inactiveDays: values["inactive-days"],
    includeInternals: values["include-internals"] ?? false,
    json: values.json ?? false,
    limit: numericLimit,
    providerHome,
    providerId,
    search: values.search ?? "",
    sort: values.sort ?? "updated",
    workspace: values.workspace,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
