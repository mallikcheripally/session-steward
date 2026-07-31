import { DatabaseSync, backup } from "node:sqlite";

const SQLITE_BATCH_SIZE = 400;

function openDatabase(databasePath, { readOnly }) {
  return new DatabaseSync(databasePath, {
    readOnly,
    timeout: 5_000,
  });
}

export function queryRows(databasePath, sql, parameters = []) {
  const database = openDatabase(databasePath, { readOnly: true });

  try {
    return database.prepare(sql).all(...parameters);
  } finally {
    database.close();
  }
}

export function executeTransaction(databasePath, statements) {
  const database = openDatabase(databasePath, { readOnly: false });

  try {
    database.exec("begin immediate");

    for (const { parameters = [], sql } of statements) {
      database.prepare(sql).run(...parameters);
    }

    database.exec("commit");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("rollback");
    }

    throw error;
  } finally {
    database.close();
  }
}

export async function backupDatabase(databasePath, destinationPath) {
  const database = openDatabase(databasePath, { readOnly: true });

  try {
    await backup(database, destinationPath);
  } finally {
    database.close();
  }
}

export function placeholders(values) {
  if (values.length === 0) {
    throw new Error("At least one SQLite value is required.");
  }

  return values.map(() => "?").join(", ");
}

export function* batches(values, size = SQLITE_BATCH_SIZE) {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}
