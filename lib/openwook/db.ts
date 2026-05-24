import 'server-only';

import postgres from 'postgres';

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required');
}

export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10
});

export type SqlClient = typeof sql;
