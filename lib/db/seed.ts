import { hash } from '@node-rs/bcrypt';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });
config();

const requiredColumns = {
  users: ['email', 'membership', 'password_hash', 'role', 'username'],
  question_banks: ['created_by', 'description', 'is_public', 'name', 'subject'],
  user_bank_links: ['bank_id', 'is_owner', 'user_id']
} as const;

async function seed() {
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('POSTGRES_URL or DATABASE_URL is required');

  const sql = postgres(databaseUrl, { max: 1 });
  const requiredTables = Object.keys(requiredColumns);
  const passwordHash = await hash('OpenWook123', 10);

  const relations = await sql<Array<{ name: string; present: string | null }>>`
    SELECT relation_name AS name, to_regclass('public.' || relation_name)::text AS present
    FROM unnest(${sql.array(requiredTables)}::text[]) AS required_relations(relation_name)
  `;
  const missingTables = relations
    .filter(({ present }) => present === null)
    .map(({ name }) => name);

  const columns = await sql<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${sql.array(requiredTables)}::text[])
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
      `Database seed prerequisites are missing. Apply db/*/*.sql before running pnpm db:seed (${details.join('; ')}).`
    );
  }

  await sql.begin(async (tx) => {
    const users = await tx<Array<{ id: number }>>`
      INSERT INTO users (username, email, password_hash, role, membership)
      VALUES ('admin', 'admin@openwook.local', ${passwordHash}, 'admin', 'plus')
      ON CONFLICT (LOWER(username)) DO UPDATE
      SET email = EXCLUDED.email,
          role = EXCLUDED.role,
          membership = EXCLUDED.membership
      RETURNING id
    `;
    const userId = users[0].id;

    const banks = await tx<Array<{ id: number }>>`
      INSERT INTO question_banks (name, description, subject, created_by, is_public)
      VALUES ('OpenWook 示例题库', '用于本地验证题库、题目、练习闭环。', 'general', ${userId}, true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    if (banks[0]) {
      await tx`
        INSERT INTO user_bank_links (user_id, bank_id, is_owner)
        VALUES (${userId}, ${banks[0].id}, true)
        ON CONFLICT (user_id, bank_id) DO UPDATE SET is_owner = true
      `;
    }
  });

  await sql.end();
  console.log('OpenWook seed complete. User: admin / OpenWook123');
}

seed()
  .catch((error) => {
    console.error('Seed process failed:', error);
    process.exit(1);
  })
  .finally(() => {
    console.log('Seed process finished. Exiting...');
    process.exit(0);
  });
