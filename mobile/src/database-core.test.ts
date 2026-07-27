import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  pauseDatabaseReads,
  pauseDatabaseWrites,
  registerDatabaseRefresher,
  runDatabaseRead,
  writeTransaction,
} from './database-core';
import { expoDatabase } from './test-database';

test('database writes pause cleanly and invalidate only after commit', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE items(id INTEGER PRIMARY KEY)');
  const db = expoDatabase(sqlite);
  let refreshes = 0;
  const unregister = registerDatabaseRefresher(() => {
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM items').get()?.count, 1);
    refreshes += 1;
  }, ['items']);

  const resume = await pauseDatabaseWrites();
  let entered = false;
  const pending = writeTransaction(
    db,
    ['items'],
    async (transaction) => {
      entered = true;
      await transaction.runAsync('INSERT INTO items DEFAULT VALUES');
    },
  );
  await Promise.resolve();
  assert.equal(entered, false);
  resume();
  await pending;
  assert.equal(refreshes, 1);

  await writeTransaction(
    db,
    ['other_table'],
    async () => undefined,
  );
  assert.equal(refreshes, 1);
  unregister();
  sqlite.close();
});

test('database writes fail closed when a native connection lacks foreign keys', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = OFF; CREATE TABLE items(id INTEGER PRIMARY KEY)');
  const db = expoDatabase(sqlite);
  await assert.rejects(
    writeTransaction(
      db,
      ['items'],
      (transaction) => transaction.runAsync('INSERT INTO items DEFAULT VALUES'),
    ),
    /foreign keys are disabled/,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM items').get()?.count, 0);
  sqlite.close();
});

test('database read pauses drain in-flight work and hold new live queries', async () => {
  let finishFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { finishFirst = resolve; });
  let firstStarted = false;
  const first = runDatabaseRead(async () => {
    firstStarted = true;
    await firstBlocked;
  });
  assert.equal(firstStarted, true);

  let pauseResolved = false;
  const pausing = pauseDatabaseReads().then((resume) => {
    pauseResolved = true;
    return resume;
  });
  await Promise.resolve();
  assert.equal(pauseResolved, false);
  finishFirst();
  await first;
  const resume = await pausing;

  let secondStarted = false;
  const second = runDatabaseRead(async () => {
    secondStarted = true;
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  resume();
  await second;
  assert.equal(secondStarted, true);
});
