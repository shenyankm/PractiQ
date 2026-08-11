import * as SQLite from 'expo-sqlite';

import { MIRROR_SCHEMA_SQL } from './mirror-schema';

const CACHE_DATABASE = 'practiq-cache.db';
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

// 迁移阶梯,按 PRAGMA user_version 逐级执行,DDL 全部幂等。
// v1:既有 blob 缓存态(resources + outbox)。存量版本 0 的库一次性清空 resources
//    (沿用原 cache.ts 语义),全新库 CREATE 后 DELETE 为空操作。
// v2:结构化镜像表(见 mirror-schema.ts)。
const V1_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS resources (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_key TEXT NOT NULL UNIQUE,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    body_json TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, id);
  DELETE FROM resources;
`;

const MIGRATIONS = [V1_SCHEMA_SQL, MIRROR_SCHEMA_SQL];

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  databasePromise ??= SQLite.openDatabaseAsync(CACHE_DATABASE).then(async (db) => {
    await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    for (let step = version; step < MIGRATIONS.length; step += 1) {
      await db.withTransactionAsync(() => db.execAsync(MIGRATIONS[step]));
      // PRAGMA user_version 不能在事务内修改,提交后单独置位;DDL 幂等,中途崩溃重跑无害
      await db.execAsync(`PRAGMA user_version = ${step + 1};`);
    }
    return db;
  });
  return databasePromise;
}
