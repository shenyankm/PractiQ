import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });
config();

const requiredColumns = {
  users: ['avatar_url', 'membership', 'plus_expires_at', 'plus_trial_ends_at', 'role'],
  ai_artifacts: ['artifact_type', 'import_job_id', 'practice_session_id', 'question_id', 'status', 'user_id'],
  billing_subscriptions: ['membership', 'paddle_customer_id', 'paddle_subscription_id', 'source', 'status', 'updated_at', 'user_id']
} as const;

async function main() {
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('POSTGRES_URL or DATABASE_URL is required');

  const sql = postgres(databaseUrl, { max: 1 });
  const requiredTables = Object.keys(requiredColumns);

  const relations = await sql<Array<{ name: string; present: string | null }>>`
    SELECT relation_name AS name, to_regclass('public.' || relation_name)::text AS present
    FROM unnest(${sql.array(requiredTables, 'text')}) AS required_relations(relation_name)
  `;
  const missingTables = relations
    .filter(({ present }) => present === null)
    .map(({ name }) => name);

  const columns = await sql<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${sql.array(requiredTables, 'text')})
  `;
  const columnsByTable = new Map<string, Set<string>>();

  for (const { table_name, column_name } of columns) {
    const tableColumns = columnsByTable.get(table_name) ?? new Set<string>();
    tableColumns.add(column_name);
    columnsByTable.set(table_name, tableColumns);
  }

  const missingColumns = Object.entries(requiredColumns).flatMap(([table, expectedColumns]) => {
    const actualColumns = columnsByTable.get(table) ?? new Set<string>();
    return expectedColumns
      .filter((column) => !actualColumns.has(column))
      .map((column) => `${table}.${column}`);
  });

  if (missingTables.length > 0 || missingColumns.length > 0) {
    const details = [
      missingTables.length > 0 ? `missing tables: ${missingTables.join(', ')}` : null,
      missingColumns.length > 0 ? `missing columns: ${missingColumns.join(', ')}` : null
    ].filter(Boolean);

    throw new Error(
      `Database bootstrap prerequisites are missing. Apply db/*/*.sql before running pnpm db:ensure (${details.join('; ')}).`
    );
  }

  await sql.unsafe(`DROP TABLE IF EXISTS ${['ali', 'pay_payment_orders'].join('')}`);
  await sql.end();
  console.log('OpenWook runtime bootstrap prerequisites are ready.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
