import type { SQLiteDatabase } from 'expo-sqlite';

type DatabaseRefresher = { refresh: () => void; tables: Set<string> };

const databaseRefreshers = new Set<DatabaseRefresher>();
let writeTail: Promise<void> = Promise.resolve();
let activeReads = 0;
let readPauseCount = 0;
let releaseReadAdmission: (() => void) | null = null;
let readAdmission = Promise.resolve();
const readDrainWaiters = new Set<() => void>();

export function registerDatabaseRefresher(refresh: () => void, tableNames: readonly string[]) {
  const refresher = { refresh, tables: new Set(tableNames) };
  databaseRefreshers.add(refresher);
  return () => { databaseRefreshers.delete(refresher); };
}

export function invalidateDatabaseQueries(tableNames?: readonly string[]) {
  const changed = tableNames ? new Set(tableNames) : null;
  for (const { refresh, tables } of databaseRefreshers) {
    if (!changed || [...changed].some((table) => tables.has(table))) refresh();
  }
}

export async function runDatabaseRead<T>(work: () => Promise<T>) {
  while (readPauseCount) await readAdmission;
  activeReads += 1;
  try {
    return await work();
  } finally {
    activeReads -= 1;
    if (!activeReads) {
      for (const resolve of readDrainWaiters) resolve();
      readDrainWaiters.clear();
    }
  }
}

/** Stops new live-query reads and waits for reads already in flight. */
export async function pauseDatabaseReads() {
  readPauseCount += 1;
  if (readPauseCount === 1) {
    readAdmission = new Promise<void>((resolve) => { releaseReadAdmission = resolve; });
  }
  if (activeReads) {
    await new Promise<void>((resolve) => { readDrainWaiters.add(resolve); });
  }
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    readPauseCount -= 1;
    if (!readPauseCount) {
      releaseReadAdmission?.();
      releaseReadAdmission = null;
    }
  };
}

function enqueueWrite<T>(work: () => Promise<T>) {
  const result = writeTail.then(work, work);
  writeTail = result.then(() => undefined, () => undefined);
  return result;
}

export function writeTransaction<T>(
  db: SQLiteDatabase,
  tableNames: readonly string[] | undefined,
  work: (transaction: SQLiteDatabase) => Promise<T>,
) {
  return enqueueWrite(async () => {
    let value!: T;
    await db.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync('PRAGMA busy_timeout = 5000');
      const foreignKeys = await transaction.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
      if (foreignKeys?.foreign_keys !== 1) {
        throw new Error('SQLite foreign keys are disabled; rebuild the native app before writing data.');
      }
      value = await work(transaction);
    });
    invalidateDatabaseQueries(tableNames);
    return value;
  });
}

/** Waits for current writes and queues future writes until the returned function is called. */
export async function pauseDatabaseWrites() {
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const pending = writeTail;
  writeTail = pending.then(() => paused, () => paused);
  await pending.catch(() => undefined);
  return resume;
}
