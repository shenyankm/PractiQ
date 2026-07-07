import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import dotenv from 'dotenv';
import { env } from '../openwook/env';

dotenv.config({ path: '.env.local' });

if (!env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set');
}

export const client = postgres(env.POSTGRES_URL);
export const db = drizzle(client, { schema });
