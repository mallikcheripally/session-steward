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
    backups: {
      type: "boolean",
    },
    "codex-home": {
      type: "string",
    },
    "claude-home": {
      type: "string",
    },
    cleanup: {
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
    "include-supporting": {
      type: "boolean",
    },
    json: {
      type: "boolean",
    },
    limit: {
      type: "string",
    },
    overview: {
      type: "boolean",
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
  if (help) {
    await runCli({ help: true });
    return;
  }
  const { createProviderSettings } = await import("../lib/settings.mjs");
  let settings = await createProviderSettings();
  const providerId = values.provider || settings.getActiveProviderId();
  if (!["codex", "claude-code"].includes(providerId)) throw new Error("Provider must be codex or claude-code.");
  const homeOption = providerId === "codex" ? values["codex-home"] : values["claude-home"];

  if (homeOption !== undefined) {
    settings = await createProviderSettings({
      providerHomeOverrides: { [providerId]: homeOption },
    });
  }
  const providerHome = settings.getHome(providerId);

  await runCli({
    archiveStatus: values["archive-status"],
    backups: values.backups ?? false,
    cleanup: values.cleanup,
    help,
    inactiveDays: values["inactive-days"],
    includeInternals: values["include-internals"] ?? false,
    includeSupporting: values["include-supporting"] ?? false,
    json: values.json ?? false,
    limit: numericLimit,
    overview: values.overview ?? false,
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
