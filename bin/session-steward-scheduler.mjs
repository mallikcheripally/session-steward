#!/usr/bin/env node

import { parseArgs } from "node:util";

import { assertSupportedNode } from "../lib/runtime.mjs";

assertSupportedNode();

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "config-directory": { type: "string" },
    help: { short: "h", type: "boolean" },
    "run-due": { type: "boolean" },
    start: { type: "boolean" },
    status: { type: "boolean" },
    stop: { type: "boolean" },
  },
});

if (values.help) {
  process.stdout.write(`Usage: session-steward-scheduler <option>

Options:
  --start    Start automatic cleanup and enable it after restart
  --stop     Stop automatic cleanup and remove its startup task
  --status   Show whether automatic cleanup is running
  --run-due  Run due cleanup schedules once and exit
  --config-directory <path> Use a specific Session Steward settings folder
  -h, --help Show this help
`);
} else if ([values["run-due"], values.start, values.status, values.stop].filter(Boolean).length !== 1) {
  process.stderr.write("Choose exactly one of --start, --stop, --status, or --run-due.\n");
  process.exitCode = 1;
} else if (values["run-due"]) {
  const { createCleanupScheduleStore, runDueCleanupSchedules } = await import(
    "../lib/cleanup-schedules.mjs"
  );
  const { createProviderSettings } = await import("../lib/settings.mjs");
  const settings = await createProviderSettings({
    configDirectory: values["config-directory"],
  });
  const scheduleStore = createCleanupScheduleStore({
    configDirectory: settings.getConfigDirectory(),
  });
  const results = await runDueCleanupSchedules({ scheduleStore, settings });
  if (results.some((result) => ["failed", "recovery-failed"].includes(result.status))) {
    process.exitCode = 1;
  }
} else {
  const { createCleanupSchedulerService } = await import(
    "../lib/cleanup-scheduler-service.mjs"
  );
  const service = createCleanupSchedulerService({
    configDirectory: values["config-directory"],
  });
  const status = values.start
    ? await service.start()
    : values.stop ? await service.stop() : await service.status();
  process.stdout.write(`Automatic cleanup is ${status.running ? "running" : "stopped"}.\n`);
}
