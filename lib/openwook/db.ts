import 'server-only';

import postgres from 'postgres';
import { trace } from '@opentelemetry/api';
import { errorToLog, logger } from './logger';
import { recordDependencyDuration } from './metrics';
import { env } from './env';

const connectionString = env.POSTGRES_URL || env.DATABASE_URL;

if (!connectionString) {
  throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required');
}

const dbTracer = trace.getTracer('openwook-postgres');

const rawSql = postgres(connectionString, {
  max: Number(env.POSTGRES_POOL_MAX || env.DATABASE_POOL_MAX || 10),
  idle_timeout: Number(env.POSTGRES_IDLE_TIMEOUT_SECONDS || 30),
  connect_timeout: Number(env.POSTGRES_CONNECT_TIMEOUT_SECONDS || 10)
});
export const postgresClient = rawSql;

const slowQueryMs = Number(env.SLOW_QUERY_MS || 500);

type QueryLike = {
  then: (onFulfilled?: (...args: never[]) => unknown, onRejected?: (...args: never[]) => unknown) => unknown;
  catch?: (onRejected?: (...args: never[]) => unknown) => unknown;
  finally?: (onFinally?: () => unknown) => unknown;
};

function observePendingQuery<T>(operation: string, query: T): T {
  const span = dbTracer.startSpan(`postgres ${operation}`);
  span.setAttributes({ 'db.system': 'postgresql', 'db.operation': operation });
  const started = Date.now();
  let observed = false;

  const finish = (status: 'ok' | 'error', error?: unknown) => {
    if (observed) return;
    observed = true;
    const durationMs = Date.now() - started;
    recordDependencyDuration({ dependency: 'postgres', operation, status }, durationMs);
    if (status === 'ok' && durationMs >= slowQueryMs) {
      logger.warn({ dependency: 'postgres', operation, durationMs, slowQueryMs }, 'slow postgres operation');
    }
    span.setAttribute('openwook.duration_ms', durationMs);
    span.setAttribute('openwook.status', status);
    if (status === 'error') {
      span.recordException(error as Error);
      logger.error({ ...errorToLog(error), dependency: 'postgres', operation, durationMs }, 'postgres operation failed');
    }
    span.end();
  };

  const queryLike = query as QueryLike;
  const originalThen = queryLike.then.bind(query);
  queryLike.then = ((onFulfilled?: unknown, onRejected?: unknown) => originalThen(
    (value: unknown) => {
      finish('ok');
      return typeof onFulfilled === 'function' ? onFulfilled(value) : value;
    },
    (error: unknown) => {
      finish('error', error);
      if (typeof onRejected === 'function') return onRejected(error);
      throw error;
    }
  )) as QueryLike['then'];

  if (typeof queryLike.catch === 'function') {
    queryLike.catch = ((onRejected?: unknown) => queryLike.then(undefined, onRejected as never)) as QueryLike['catch'];
  }
  if (typeof queryLike.finally === 'function') {
    queryLike.finally = ((onFinally?: unknown) => queryLike.then(
      (value: unknown) => Promise.resolve(typeof onFinally === 'function' ? onFinally() : undefined).then(() => value),
      (error: unknown) => Promise.resolve(typeof onFinally === 'function' ? onFinally() : undefined).then(() => { throw error; })
    )) as QueryLike['finally'];
  }

  return query;
}

function observePromise<T>(operation: string, promise: Promise<T>): Promise<T> {
  const span = dbTracer.startSpan(`postgres ${operation}`);
  span.setAttributes({ 'db.system': 'postgresql', 'db.operation': operation });
  const started = Date.now();
  return promise.then(
    (value) => {
      const durationMs = Date.now() - started;
      recordDependencyDuration({ dependency: 'postgres', operation, status: 'ok' }, durationMs);
      span.setAttribute('openwook.duration_ms', durationMs);
      span.setAttribute('openwook.status', 'ok');
      span.end();
      if (durationMs >= slowQueryMs) {
        logger.warn({ dependency: 'postgres', operation, durationMs, slowQueryMs }, 'slow postgres operation');
      }
      return value;
    },
    (error) => {
      const durationMs = Date.now() - started;
      recordDependencyDuration({ dependency: 'postgres', operation, status: 'error' }, durationMs);
      span.setAttribute('openwook.duration_ms', durationMs);
      span.setAttribute('openwook.status', 'error');
      span.recordException(error as Error);
      span.end();
      logger.error({ ...errorToLog(error), dependency: 'postgres', operation, durationMs }, 'postgres operation failed');
      throw error;
    }
  );
}

function instrumentTransactionSql<T extends postgres.TransactionSql>(tx: T): T {
  const wrapped = ((first: unknown, ...rest: unknown[]) => observePendingQuery('transaction_query', tx(first as never, ...(rest as never[])))) as unknown as T;
  Object.assign(wrapped, tx);
  wrapped.unsafe = ((query: string, parameters?: unknown[], options?: postgres.UnsafeQueryOptions) => (
    observePendingQuery('transaction_unsafe', tx.unsafe(query, parameters as never[] | undefined, options))
  )) as T['unsafe'];
  return wrapped;
}

export const sql = ((first: unknown, ...rest: unknown[]) => observePendingQuery('query', rawSql(first as never, ...(rest as never[])))) as typeof rawSql;

Object.assign(sql, rawSql);

sql.unsafe = ((query: string, parameters?: unknown[], options?: postgres.UnsafeQueryOptions) => (
  observePendingQuery('unsafe', rawSql.unsafe(query, parameters as never[] | undefined, options))
)) as typeof rawSql.unsafe;

sql.file = ((path: string | Buffer | URL | number, argsOrOptions?: unknown, options?: { cache?: boolean }) => (
  Array.isArray(argsOrOptions)
    ? observePendingQuery('file', rawSql.file(path, argsOrOptions as never[], options))
    : observePendingQuery('file', rawSql.file(path, argsOrOptions as { cache?: boolean } | undefined))
)) as typeof rawSql.file;

sql.begin = (async (optionsOrCallback: unknown, maybeCallback?: unknown) => {
  const run = typeof optionsOrCallback === 'function'
    ? rawSql.begin((tx) => optionsOrCallback(instrumentTransactionSql(tx)))
    : rawSql.begin(optionsOrCallback as string, (tx) => (maybeCallback as (tx: postgres.TransactionSql) => unknown)(instrumentTransactionSql(tx)));
  return observePromise('transaction', run);
}) as typeof rawSql.begin;

export type SqlClient = typeof sql;
