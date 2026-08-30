import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCleanupSchedulerService } from "../lib/cleanup-scheduler-service.mjs";
import {
  createCleanupScheduleStore,
  runCleanupSchedule,
  runDueCleanupSchedules,
} from "../lib/cleanup-schedules.mjs";

async function temporaryDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function definition(overrides = {}) {
  return {
    inactiveDays: 60,
    name: "Old sessions",
    provider: "codex",
    runEveryDays: 1,
    ...overrides,
  };
}

test("cleanup schedules persist strict bounded criteria and claim only once", async (context) => {
  const configDirectory = await temporaryDirectory("session-steward-schedules-");
  context.after(() => fs.rm(configDirectory, { force: true, recursive: true }));
  let currentTime = 1_000_000;
  const createStore = () => createCleanupScheduleStore({
    configDirectory,
    createId: () => "schedule-1",
    now: () => currentTime,
  });
  const store = createStore();

  await assert.rejects(
    store.save(definition({ inactiveDays: 0 })),
    /Inactivity period in days must be a whole number/u,
  );
  await assert.rejects(
    store.save(definition({ runEveryDays: 3_651 })),
    /Run interval in days must be a whole number/u,
  );
  await assert.rejects(
    store.save(definition({ maxSessions: 101 })),
    /between 1 and 100/u,
  );

  const saved = await store.save(definition({
    inactiveDays: 50,
    maxSessions: 40,
    minimumTranscriptBytes: 500_000_000,
    providerHomeOverride: "/one-time/codex-home",
    runEveryDays: 12,
    workspace: "/workspace/app",
  }));
  assert.equal(saved.id, "schedule-1");
  assert.equal(saved.cleanupMode, "thorough");
  assert.equal(saved.inactiveDays, 50);
  assert.equal(saved.runEveryDays, 12);
  assert.equal(saved.nextRunAtMs, currentTime + 12 * 86_400_000);
  assert.equal((await createStore().list())[0].minimumTranscriptBytes, 500_000_000);
  assert.equal("providerHomeOverride" in (await createStore().list())[0], false);

  currentTime = saved.nextRunAtMs;
  const claimed = await store.claim(saved.id);
  assert.equal(claimed.id, saved.id);
  assert.equal(await store.claim(saved.id), null);
  const completed = await store.complete(saved.id, {
    affectedSessionCount: 2,
    atMs: currentTime,
    candidateCount: 2,
    deletedSessionCount: 2,
    status: "completed",
    transcriptBytes: 1_000_000_000,
  });
  assert.equal(completed.runningSinceMs, null);
  assert.equal(completed.lastRun.deletedSessionCount, 2);
});

test("existing daily and weekly schedules become day intervals", async (context) => {
  const configDirectory = await temporaryDirectory("session-steward-schedule-legacy-");
  context.after(() => fs.rm(configDirectory, { force: true, recursive: true }));
  await fs.writeFile(path.join(configDirectory, "cleanup-schedules.json"), JSON.stringify({
    schedules: [
      { frequency: "daily", id: "daily" },
      { frequency: "weekly", id: "weekly" },
    ],
    version: 1,
  }));

  const listed = await createCleanupScheduleStore({ configDirectory }).list();
  assert.deepEqual(listed.map(({ id, runEveryDays }) => [id, runEveryDays]), [
    ["daily", 1],
    ["weekly", 7],
  ]);
  assert.ok(listed.every((schedule) => !("frequency" in schedule)));
});

test("schedule runs select the oldest bounded matches and keep cleanup criteria server-side", async (context) => {
  const configDirectory = await temporaryDirectory("session-steward-schedule-run-");
  context.after(() => fs.rm(configDirectory, { force: true, recursive: true }));
  const now = () => Date.UTC(2026, 7, 29);
  const store = createCleanupScheduleStore({
    configDirectory,
    createId: () => "oldest",
    now,
  });
  await store.save(definition({
    maxSessions: 2,
    providerHomeOverride: "/one-time/codex-home",
  }));
  const calls = [];
  const provider = {
    listSessions: async (options) => {
      calls.push(options);
      if (options.page === 1) {
        return {
          pageCount: 3,
          records: [{ id: "newer-1" }, { id: "newer-2" }],
        };
      }
      assert.equal(options.page, 3);
      return { pageCount: 3, records: [{ id: "old-2" }, { id: "old-1" }] };
    },
  };
  let cleanupRequest;
  const result = await runCleanupSchedule({
    cleanup: async (request) => {
      cleanupRequest = request;
      return {
        affectedSessionCount: 2,
        deletedSessionCount: 2,
        status: "completed",
        transcriptBytes: 900,
      };
    },
    force: true,
    id: "oldest",
    now,
    resolveProvider: () => provider,
    scheduleStore: store,
    settings: { getHome: () => "/provider-home" },
  });

  assert.deepEqual(cleanupRequest.recordIds, ["old-1", "old-2"]);
  assert.equal(cleanupRequest.scope, "deep");
  assert.equal(calls[0].inactiveBeforeMs, now() - 60 * 86_400_000);
  assert.equal(calls[0].pageSize, 2);
  assert.equal(calls[0].codexHome, "/one-time/codex-home");
  assert.equal(result.status, "completed");
  assert.equal((await store.list())[0].lastRun.candidateCount, 2);
});

test("largest-first schedules use the provider's bounded size order", async (context) => {
  const configDirectory = await temporaryDirectory("session-steward-schedule-size-");
  context.after(() => fs.rm(configDirectory, { force: true, recursive: true }));
  const store = createCleanupScheduleStore({
    configDirectory,
    createId: () => "largest",
  });
  await store.save(definition({
    maxSessions: 2,
    minimumTranscriptBytes: 500,
    selectionOrder: "largest",
  }));
  let listing;
  let ids;
  await runCleanupSchedule({
    cleanup: async (request) => {
      ids = request.recordIds;
      return {
        affectedSessionCount: 2,
        deletedSessionCount: 2,
        status: "completed",
        transcriptBytes: 1_500,
      };
    },
    force: true,
    id: "largest",
    resolveProvider: () => ({
      listSessions: async (options) => {
        listing = options;
        return { pageCount: 8, records: [{ id: "large" }, { id: "next" }] };
      },
    }),
    scheduleStore: store,
    settings: { getHome: () => "/provider-home" },
  });
  assert.equal(listing.sort, "size");
  assert.equal(listing.page, 1);
  assert.equal(listing.minimumTranscriptBytes, 500);
  assert.deepEqual(ids, ["large", "next"]);
});

test("due runner skips disabled and future schedules", async (context) => {
  const configDirectory = await temporaryDirectory("session-steward-schedule-due-");
  context.after(() => fs.rm(configDirectory, { force: true, recursive: true }));
  let currentTime = 10_000;
  let id = 0;
  const store = createCleanupScheduleStore({
    configDirectory,
    createId: () => `schedule-${++id}`,
    now: () => currentTime,
  });
  const due = await store.save(definition());
  await store.save(definition({ enabled: false, name: "Disabled" }));
  currentTime = due.nextRunAtMs;
  const results = await runDueCleanupSchedules({
    cleanup: async () => {
      throw new Error("No cleanup expected without matches.");
    },
    now: () => currentTime,
    resolveProvider: () => ({
      listSessions: async () => ({ pageCount: 1, records: [] }),
    }),
    scheduleStore: store,
    settings: { getHome: () => "/provider-home" },
  });
  assert.deepEqual(results.map((result) => result.id), [due.id]);
  assert.equal(results[0].status, "no-matches");
});

for (const platform of ["darwin", "linux", "win32"]) {
  test(`automatic cleanup service has start, status, and stop behavior on ${platform}`, async (context) => {
    const home = await temporaryDirectory(`session-steward-service-${platform}-`);
    context.after(() => fs.rm(home, { force: true, recursive: true }));
    const calls = [];
    let active = false;
    const execute = async (command, args) => {
      calls.push([command, args]);
      if (
        (command === "launchctl" && args[0] === "print")
        || (command === "systemctl" && args.includes("is-active"))
        || (command === "schtasks" && args[0] === "/Query")
      ) {
        if (!active) throw new Error("not active");
      }
      if (
        (command === "launchctl" && args[0] === "bootstrap")
        || (command === "systemctl" && args.includes("enable"))
        || (command === "schtasks" && args[0] === "/Create")
      ) active = true;
      if (
        (command === "launchctl" && args[0] === "bootout")
        || (command === "systemctl" && args.includes("disable"))
        || (command === "schtasks" && args[0] === "/Delete")
      ) active = false;
      return { stderr: "", stdout: "" };
    };
    const service = createCleanupSchedulerService({
      configDirectory: path.join(home, "steward config"),
      environment: {},
      execute,
      home,
      nodePath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
      platform,
      runnerPath: platform === "win32" ? "C:\\Program Files\\session-steward\\runner.mjs" : "/opt/session steward/runner.mjs",
      userId: 501,
    });

    assert.equal((await service.status()).running, false);
    assert.equal((await service.start()).running, true);

    if (platform === "darwin") {
      const plist = await fs.readFile(path.join(
        home,
        "Library",
        "LaunchAgents",
        "com.mallikcheripally.session-steward.cleanup.plist",
      ), "utf8");
      assert.match(plist, /<string>\/opt\/session steward\/runner\.mjs<\/string>/u);
      assert.match(plist, /<string>\/.*\/steward config<\/string>/u);
      assert.ok(calls.some(([command, args]) => command === "launchctl" && args[0] === "bootstrap"));
    } else if (platform === "linux") {
      const serviceFile = await fs.readFile(path.join(
        home,
        ".config",
        "systemd",
        "user",
        "session-steward-cleanup.service",
      ), "utf8");
      assert.match(serviceFile, /ExecStart="\/usr\/bin\/node" "\/opt\/session steward\/runner\.mjs" --run-due --config-directory ".*\/steward config"/u);
      assert.ok(calls.some(([command, args]) => command === "systemctl" && args.includes("enable")));
    } else {
      const create = calls.find(([command, args]) => command === "schtasks" && args[0] === "/Create");
      assert.match(create[1].at(-1), /"C:\\Program Files\\nodejs\\node\.exe"/u);
      assert.match(create[1].at(-1), /--config-directory/u);
    }
    assert.equal((await service.stop()).running, false);
    assert.ok(calls.length >= 3);
  });
}
