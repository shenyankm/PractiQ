import * as SQLite from 'expo-sqlite';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  registerDatabaseRefresher,
  runDatabaseRead,
} from './database-core';

export {
  invalidateDatabaseQueries,
  pauseDatabaseWrites,
  writeTransaction,
} from './database-core';

export const DATABASE_NAME = 'application.db';

// Work around https://github.com/expo/expo/issues/38168: expo-sqlite can double-finalize FTS statements.
export const SQLITE_OPEN_OPTIONS = { finalizeUnusedStatementsBeforeClosing: false };

type BindValue = string | number | null;

function useDatabaseRefresh(tableNames: string[], enabled: boolean) {
  const [version, setVersion] = useState(0);
  const key = tableNames.join('|');
  const refetch = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    return registerDatabaseRefresher(refetch, key ? key.split('|') : []);
  }, [enabled, key, refetch]);
  return { refetch, version };
}

function paramsEqual(a: BindValue[], b: BindValue[]) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

// Avoid re-serializing bind params on every render; only recompute the cache key when
// the parameter contents actually change.
/* eslint-disable react-hooks/refs -- intentional deep-stable render cache for SQLite query subscriptions */
function useStableParams(params: BindValue[]) {
  const cache = useRef<{ params: BindValue[]; key: string } | null>(null);
  if (!cache.current || !paramsEqual(cache.current.params, params)) {
    cache.current = { params, key: JSON.stringify(params) };
  }
  return cache.current;
}
/* eslint-enable react-hooks/refs */

export function useLiveQuery<T>(
  sql: string,
  params: BindValue[] = [],
  tableNames: string[] = [],
  options: { enabled?: boolean } = {},
) {
  const db = SQLite.useSQLiteContext();
  const enabled = options.enabled ?? true;
  const { refetch, version } = useDatabaseRefresh(tableNames, enabled);
  const stableParams = useStableParams(params);
  const queryKey = `${sql}\u0000${stableParams.key}`;
  const [result, setResult] = useState<{
    db: SQLite.SQLiteDatabase;
    queryKey: string;
    version: number;
    data: T[];
    error: Error | null;
  } | null>(null);
  const current = enabled && result?.db === db && result.queryKey === queryKey ? result : null;
  const loading = enabled && current === null;
  const refreshing = enabled && current !== null && current.version !== version;
  const data = current?.data ?? [];
  const error = refreshing ? null : current?.error ?? null;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const boundParams = stableParams.params;
    runDatabaseRead(() => db.getAllAsync<T>(sql, boundParams))
      .then((rows) => {
        if (active) setResult({ db, queryKey, version, data: rows, error: null });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setResult((previous) => ({
          db,
          queryKey,
          version,
          data: previous?.db === db && previous.queryKey === queryKey ? previous.data : [],
          error: reason instanceof Error ? reason : new Error(String(reason)),
        }));
      });
    return () => {
      active = false;
    };
  }, [db, enabled, stableParams, queryKey, sql, version]);

  return { data, error, loading, refreshing, refetch };
}

export function useFocusedLiveQuery<T>(
  sql: string,
  params: BindValue[] = [],
  tableNames: string[] = [],
  options: { enabled?: boolean } = {},
) {
  const focused = useIsFocused();
  return useLiveQuery<T>(sql, params, tableNames, {
    enabled: (options.enabled ?? true) && focused,
  });
}
