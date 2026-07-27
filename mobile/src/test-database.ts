import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

type BindParameter = SQLInputValue | SQLInputValue[];

export function expoDatabase(sqlite: DatabaseSync): SQLiteDatabase {
  const bind = (params: BindParameter[]) => (
    params.length === 1 && Array.isArray(params[0]) ? params[0] : params as SQLInputValue[]
  );
  const queries = {
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    getAllAsync: async <T,>(sql: string, ...params: BindParameter[]) => (
      sqlite.prepare(sql).all(...bind(params)) as T[]
    ),
    getFirstAsync: async <T,>(sql: string, ...params: BindParameter[]) => (
      (sqlite.prepare(sql).get(...bind(params)) as T | undefined) ?? null
    ),
    runAsync: async (sql: string, ...params: BindParameter[]) => {
      const result = sqlite.prepare(sql).run(...bind(params));
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    prepareAsync: async (sql: string) => {
      const statement = sqlite.prepare(sql);
      return {
        executeAsync: async (...params: BindParameter[]) => {
          const result = statement.run(...bind(params));
          return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
        },
        finalizeAsync: async () => undefined,
      };
    },
  };
  return {
    ...queries,
    withTransactionAsync: async <T,>(work: () => Promise<T>) => {
      sqlite.exec('BEGIN');
      try {
        const result = await work();
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    withExclusiveTransactionAsync: async <T,>(work: (database: typeof queries) => Promise<T>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(queries);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as SQLiteDatabase;
}
