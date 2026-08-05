import { spawnSync } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { getProvider } from "../../lib/providers/index.mjs";
import {
  createLargeCodexHomeFixture,
  removeCodexHomeFixture,
} from "../fixtures/codex-home.mjs";

const totalScaleSessions = 50_000;
const sampleCount = 5;
const warmPageCount = 7;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

async function addSecondStore(fixture) {
  const sessionsPerStore = totalScaleSessions / 2;
  const newerDatabasePath = path.join(fixture.codexHome, "state_6.sqlite");
  await copyFile(fixture.stateDatabasePath, newerDatabasePath);
  const database = new DatabaseSync(newerDatabasePath);
  try {
    database.exec("begin immediate");
    database.exec("delete from threads where id like 'scale-%'");
    const insert = database.prepare(`
      insert into threads (
        id, rollout_path, cwd, title, first_user_message,
        agent_nickname, agent_role, archived, is_pinned,
        created_at, updated_at, created_at_ms, updated_at_ms
      ) values (?, null, ?, ?, ?, null, null, 0, 0, ?, ?, ?, ?)
    `);
    for (let index = 0; index < sessionsPerStore; index += 1) {
      const suffix = String(index).padStart(6, "0");
      const timestamp = 1_752_000_000_000 + index;
      insert.run(
        `newer-${suffix}`,
        fixture.workspace,
        `Newer store session ${suffix}`,
        `Newer store session ${suffix}`,
        Math.floor(timestamp / 1000),
        Math.floor(timestamp / 1000),
        timestamp,
        timestamp,
      );
    }
    database.exec("commit");
  } catch (error) {
    if (database.isTransaction) database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}

async function measureScenario({ forceUnion = false, sort, stores }) {
  const fixture = await createLargeCodexHomeFixture({
    sessionCount: stores === 1 ? totalScaleSessions : totalScaleSessions / 2,
  });
  try {
    if (stores === 2) await addSecondStore(fixture);
    const measurements = [];
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const workerArguments = [
        "--expose-gc",
        fileURLToPath(import.meta.url),
        "--measure",
        "--codex-home",
        fixture.codexHome,
        "--sort",
        sort,
        "--stores",
        String(stores),
      ];
      if (forceUnion) workerArguments.push("--force-union");
      const result = spawnSync(
        process.execPath,
        workerArguments,
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr || "Versioned-store benchmark failed.");
      measurements.push(JSON.parse(result.stdout));
    }
    return {
      peakRssMb: Number(median(measurements.map(({ peakRssMb }) => peakRssMb)).toFixed(2)),
      forceUnion,
      samples: sampleCount,
      sessions: totalScaleSessions + 3,
      sort,
      stores,
      warmPageMs: Number(median(measurements.map(({ warmPageMs }) => warmPageMs)).toFixed(2)),
    };
  } finally {
    await removeCodexHomeFixture(fixture.codexHome);
  }
}

if (!process.argv.includes("--measure")) {
  const requestedSort = argument("--sort");
  const requestedStores = Number(argument("--stores", "0"));
  const forceUnion = process.argv.includes("--force-union");
  const scenarios = requestedSort && requestedStores
    ? [{ forceUnion, sort: requestedSort, stores: requestedStores }]
    : [
        { sort: "updated", stores: 1 },
        { sort: "size", stores: 1 },
        { sort: "updated", stores: 2 },
      ];
  const results = [];
  for (const scenario of scenarios) results.push(await measureScenario(scenario));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  const codexHome = argument("--codex-home");
  const sort = argument("--sort", "updated");
  const stores = Number(argument("--stores", "1"));
  const forceUnion = process.argv.includes("--force-union");
  const provider = getProvider("codex");
  provider.invalidateSessionCache({ codexHome });
  global.gc?.();
  const cold = await provider.listSessions({
    codexHome,
    forceUnion,
    includeInternals: true,
    page: 1,
    pageSize: 25,
    refresh: true,
    sort,
  });
  const warmDurations = [];
  for (let sample = 0; sample < warmPageCount; sample += 1) {
    const startedAt = performance.now();
    const result = await provider.listSessions({
      codexHome,
      forceUnion,
      includeInternals: true,
      page: 2,
      pageSize: 25,
      sort,
    });
    warmDurations.push(performance.now() - startedAt);
    if (result.total !== totalScaleSessions + 3 || result.records.length !== 25) {
      throw new Error("Versioned-store benchmark returned an unexpected session page.");
    }
  }
  if (cold.total !== totalScaleSessions + 3 || cold.records.length !== 25) {
    throw new Error("Versioned-store benchmark returned an unexpected cold page.");
  }
  global.gc?.();
  process.stdout.write(`${JSON.stringify({
    peakRssMb: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
    sort,
    stores,
    warmPageMs: Number(median(warmDurations).toFixed(2)),
  })}\n`);
}
