import { Directory, Paths } from 'expo-file-system';

import { getDb } from './db';
import { MIRROR_TABLES } from './mirror-schema';

export type QueuedMutation = {
  id: number;
  mutation_key: string;
  method: string;
  path: string;
  body_json: string | null;
  state: 'pending' | 'failed';
  last_error: string | null;
};

export async function readResource<T>(key: string): Promise<T | null> {
  const row = await (await getDb()).getFirstAsync<{ payload: string }>(
    'SELECT payload FROM resources WHERE key = ?',
    key,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export async function writeResource(key: string, value: unknown) {
  await (await getDb()).runAsync(
    `INSERT INTO resources(key, payload) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP`,
    key,
    JSON.stringify(value),
  );
}

export function createMutationKey() {
  // ponytail: uniqueness, not cryptographic identity; replace with expo-crypto only if collisions appear in practice.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueMutation(method: string, path: string, body: unknown, mutationKey = createMutationKey()) {
  await (await getDb()).runAsync(
    'INSERT OR IGNORE INTO outbox(mutation_key, method, path, body_json) VALUES (?, ?, ?, ?)',
    mutationKey,
    method,
    path,
    body === undefined ? null : JSON.stringify(body),
  );
  return mutationKey;
}

export async function pendingMutations() {
  return (await getDb()).getAllAsync<QueuedMutation>(
    "SELECT id, mutation_key, method, path, body_json, state, last_error FROM outbox WHERE state = 'pending' ORDER BY id",
  );
}

export async function outboxCounts() {
  const rows = await (await getDb()).getAllAsync<{ state: string; count: number }>(
    'SELECT state, COUNT(*) AS count FROM outbox GROUP BY state',
  );
  return {
    pending: rows.find((row) => row.state === 'pending')?.count ?? 0,
    failed: rows.find((row) => row.state === 'failed')?.count ?? 0,
  };
}

export async function completeMutation(id: number) {
  await (await getDb()).runAsync('DELETE FROM outbox WHERE id = ?', id);
}

export async function failMutation(id: number, message: string) {
  await (await getDb()).runAsync(
    "UPDATE outbox SET state = 'failed', last_error = ? WHERE id = ?",
    message,
    id,
  );
}

export async function retryFailedMutations() {
  await (await getDb()).runAsync("UPDATE outbox SET state = 'pending', last_error = NULL WHERE state = 'failed'");
}

export async function clearCloudCache() {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM resources WHERE key <> 'setting:language';
    DELETE FROM outbox;
    ${MIRROR_TABLES.map((table) => `DELETE FROM ${table};`).join('\n    ')}
  `);
  const imports = new Directory(Paths.document, 'cloud-imports');
  if (imports.exists) imports.delete();
}
