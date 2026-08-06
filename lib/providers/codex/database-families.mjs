import { readdirSync } from "node:fs";
import path from "node:path";

import { queryRows } from "../../storage/sqlite.mjs";

const CACHE_TTL_MS = 2_000;

export const CODEX_DATABASE_PROFILE = Object.freeze({
  id: "codex-local-store-2026-08",
  builtFor: {
    chatgptDesktop: ["26.727.40816"],
    codexCli: ["0.144.1", "0.146.0"],
  },
});

const SCHEMA_REQUIREMENTS = Object.freeze({
  state: {
    fallback: "state_5.sqlite",
    pattern: /^state_(\d+)\.sqlite$/u,
    required: true,
    tables: [{ name: "threads", requiredColumns: ["id", "rollout_path"] }],
  },
  logs: {
    fallback: "logs_2.sqlite",
    pattern: /^logs_(\d+)\.sqlite$/u,
    required: false,
    tables: [{ name: "logs", requiredColumns: ["thread_id"] }],
  },
  memories: {
    fallback: "memories_1.sqlite",
    pattern: /^memories_(\d+)\.sqlite$/u,
    required: false,
    tables: [{ name: "stage1_outputs", requiredColumns: ["thread_id"] }],
  },
  goals: {
    fallback: "goals_1.sqlite",
    pattern: /^goals_(\d+)\.sqlite$/u,
    required: false,
    tables: [
      { name: "thread_goals", requiredColumns: ["thread_id"] },
      { name: "thread_goal_continuation_deferrals", requiredColumns: ["thread_id"] },
    ],
  },
});

const resolutionCache = new Map();

function inspectTable(databasePath, tableName) {
  const exists = queryRows(
    databasePath,
    "select name from sqlite_master where type = 'table' and name = ?",
    [tableName],
  ).length > 0;
  if (!exists) return { columns: new Set(), exists: false };
  return {
    columns: new Set(
      queryRows(databasePath, "select name from pragma_table_info(?)", [tableName])
        .map((column) => String(column.name)),
    ),
    exists: true,
  };
}

function inspectCandidate(codexHome, filename, version, family) {
  const databasePath = path.join(codexHome, filename);
  try {
    const tables = Object.fromEntries(
      family.tables.map((requirement) => {
        const inspection = inspectTable(databasePath, requirement.name);
        const missingColumns = requirement.requiredColumns.filter(
          (column) => !inspection.columns.has(column),
        );
        return [requirement.name, { ...inspection, missingColumns }];
      }),
    );
    const invalidTable = family.tables.find((requirement) => {
      const table = tables[requirement.name];
      return !table.exists || table.missingColumns.length > 0;
    });
    return {
      filename,
      path: databasePath,
      reason: invalidTable
        ? !tables[invalidTable.name].exists
          ? `Missing table: ${invalidTable.name}`
          : `Missing fields in ${invalidTable.name}: ${tables[invalidTable.name].missingColumns.join(", ")}`
        : null,
      tables,
      valid: !invalidTable,
      version,
    };
  } catch (error) {
    return {
      filename,
      path: databasePath,
      reason: error instanceof Error ? error.message : "Database could not be inspected.",
      tables: {},
      valid: false,
      version,
    };
  }
}

function fallbackResolution(codexHome) {
  return Object.fromEntries(Object.entries(SCHEMA_REQUIREMENTS).map(([name, family]) => [name, {
    invalid: [],
    primary: {
      filename: family.fallback,
      path: path.join(codexHome, family.fallback),
      tables: {},
      valid: true,
      version: Number(family.pattern.exec(family.fallback)?.[1] ?? 0),
    },
    required: family.required,
    secondaries: [],
  }]));
}

function discover(codexHome) {
  let names;
  try {
    names = readdirSync(codexHome, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return { families: fallbackResolution(codexHome), readable: false };
  }

  const families = {};
  for (const [name, family] of Object.entries(SCHEMA_REQUIREMENTS)) {
    const candidates = names.flatMap((filename) => {
      const match = family.pattern.exec(filename);
      return match ? [{ filename, version: Number(match[1]) }] : [];
    }).sort((left, right) => right.version - left.version || left.filename.localeCompare(right.filename));
    const inspected = candidates.map((candidate) => inspectCandidate(
      codexHome,
      candidate.filename,
      candidate.version,
      family,
    ));
    const valid = inspected.filter((candidate) => candidate.valid);
    families[name] = {
      invalid: inspected.filter((candidate) => !candidate.valid),
      primary: valid[0] ?? null,
      required: family.required,
      secondaries: valid.slice(1),
    };
  }
  return { families, readable: true };
}

export function resolveCodexDatabases(codexHomeInput, { refresh = false } = {}) {
  const codexHome = path.resolve(codexHomeInput);
  const cached = resolutionCache.get(codexHome);
  if (!refresh && cached?.expiresAtMs > Date.now()) return cached.value;
  const value = discover(codexHome);
  resolutionCache.set(codexHome, { expiresAtMs: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export function invalidateCodexDatabaseResolution(codexHomeInput) {
  resolutionCache.delete(path.resolve(codexHomeInput));
}

export function databaseFamilySummary(resolution) {
  return Object.fromEntries(Object.entries(resolution.families).map(([name, family]) => [name, {
    invalid: family.invalid.map(({ filename, reason, version }) => ({ filename, reason, version })),
    primary: family.primary
      ? { filename: family.primary.filename, version: family.primary.version }
      : null,
    secondaries: family.secondaries.map(({ filename, version }) => ({ filename, version })),
  }]));
}

export function allValidDatabases(family) {
  return family.primary ? [family.primary, ...family.secondaries] : [];
}
