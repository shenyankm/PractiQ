// In-memory expo-sqlite substitute backed by node:sqlite (Node >= 22.5).
// Every openDatabaseAsync() call returns a fresh database, so jest
// test files that need isolation can jest.resetModules() + re-import.
import { DatabaseSync } from 'node:sqlite';

type SqliteRow = Record<string, unknown>;

export type MockDatabase = {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
};

export function openDatabaseAsync(_name: string): Promise<MockDatabase> {
  return Promise.resolve(createDatabase());
}

function createDatabase(): MockDatabase {
  const sqlite = new DatabaseSync(':memory:');
  return {
    async execAsync(sql: string) {
      sqlite.exec(sql);
    },
    async getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      const row = sqlite.prepare(sql).get(...(params as any)) as SqliteRow | undefined;
      return (row as T | undefined) ?? null;
    },
    async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      return sqlite.prepare(sql).all(...(params as any)) as T[];
    },
    async runAsync(sql: string, ...params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }> {
      const result = sqlite.prepare(sql).run(...(params as any));
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      sqlite.exec('BEGIN');
      try {
        await fn();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
