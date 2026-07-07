import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { postgresClient } from '../openwook/db';

export const client = postgresClient;
export const db = drizzle(client, { schema });
