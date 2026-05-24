import 'server-only';

import postgres from 'postgres';

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required');
}

export const sql = postgres(connectionString, {
  max: Number(process.env.POSTGRES_POOL_MAX || process.env.DATABASE_POOL_MAX || 10),
  idle_timeout: Number(process.env.POSTGRES_IDLE_TIMEOUT_SECONDS || 30),
  connect_timeout: Number(process.env.POSTGRES_CONNECT_TIMEOUT_SECONDS || 10)
});

export type SqlClient = typeof sql;
