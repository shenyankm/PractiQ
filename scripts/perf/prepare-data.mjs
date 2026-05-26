import { config } from 'dotenv';
import postgres from 'postgres';
import { hash } from '@node-rs/bcrypt';

config({ path: '.env.local' });
config();

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('POSTGRES_URL or DATABASE_URL is required');

const sql = postgres(databaseUrl, { max: 1 });
const prefix = process.env.PERF_DATA_PREFIX || 'perf_local';
const questionCount = Number(process.env.PERF_QUESTION_COUNT || 1000);
const userCount = Number(process.env.PERF_USER_COUNT || 80);
const password = process.env.PERF_USER_PASSWORD || 'OpenWookPerf123!';
const passwordHash = await hash(password, 10);

function log(message, extra) {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  console.log(`[prepare-data] ${message}${suffix}`);
}

try {
  const result = await sql.begin(async (tx) => {
    const adminRows = await tx`
      INSERT INTO users (username, email, password, role, membership)
      VALUES (${`${prefix}_owner`}, ${`${prefix}_owner@example.test`}, ${passwordHash}, 'admin', 'plus')
      ON CONFLICT (LOWER(username)) DO UPDATE
      SET password = EXCLUDED.password,
          role = 'admin',
          membership = 'plus',
          is_active = true,
          email = EXCLUDED.email
      RETURNING id, username
    `;
    const owner = adminRows[0];

    const existingBank = await tx`SELECT id FROM question_banks WHERE name = ${`${prefix} stress bank`} ORDER BY id LIMIT 1`;
    let bankId = existingBank[0]?.id;
    if (!bankId) {
      const bankRows = await tx`
        INSERT INTO question_banks (name, description, subject, created_by, is_public)
        VALUES (${`${prefix} stress bank`}, 'Synthetic local stress-test bank. Safe to delete by PERF_DATA_PREFIX.', 'general', ${owner.id}, true)
        RETURNING id
      `;
      bankId = bankRows[0].id;
    }

    await tx`
      INSERT INTO user_bank_links (user_id, bank_id, is_owner)
      VALUES (${owner.id}, ${bankId}, true)
      ON CONFLICT (user_id, bank_id) DO UPDATE SET is_owner = true
    `;

    const countRows = await tx`SELECT count(*)::int AS count FROM bank_question_links WHERE bank_id = ${bankId}`;
    const existingQuestionCount = Number(countRows[0].count || 0);

    if (existingQuestionCount < questionCount) {
      const needed = questionCount - existingQuestionCount;
      log('creating questions', { needed, existingQuestionCount, questionCount });
      const created = await tx`
        WITH seq AS (
          SELECT generate_series(${existingQuestionCount + 1}::int, ${questionCount}::int) AS n
        ), inserted AS (
          INSERT INTO questions (business_type, subject_id, question_type_id, answer_mode, choice_variant, stem, analysis, status, source_type, source_ref, imported_by)
          SELECT
            'standalone',
            'general',
            'generic_answer_mode',
            'choice',
            'single',
            ${prefix} || ' synthetic question #' || n || ': choose A for stable grading',
            'Synthetic explanation for local stress testing.',
            'active',
            'manual',
            ${prefix} || ':' || n,
            ${owner.id}
          FROM seq
          RETURNING id, source_ref
        ), options AS (
          INSERT INTO question_options (question_id, option_label, sort_order, content, is_correct)
          SELECT id, 'A', 1, 'A', true FROM inserted
          UNION ALL
          SELECT id, 'B', 2, 'B', false FROM inserted
          RETURNING question_id
        ), keys AS (
          INSERT INTO question_answer_keys (question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload)
          SELECT id, 'choice', 1, true, '{"selected":["A"]}', '{"text":"Synthetic answer"}', '{}'
          FROM inserted
          RETURNING question_id
        )
        INSERT INTO bank_question_links (bank_id, question_id, sort_order, question_no, status, added_by)
        SELECT ${bankId}, i.id, ${existingQuestionCount} + row_number() OVER (ORDER BY i.id), (${existingQuestionCount} + row_number() OVER (ORDER BY i.id))::text, 'active', ${owner.id}
        FROM inserted i
        ON CONFLICT (bank_id, question_id) DO NOTHING
        RETURNING question_id
      `;
      log('created bank links', { count: created.length });
    }

    const userRows = await tx`
      WITH seq AS (
        SELECT generate_series(1, ${userCount}::int) AS n
      ), upserted AS (
        INSERT INTO users (username, email, password, role, membership)
        SELECT ${prefix} || '_user_' || lpad(n::text, 4, '0'), ${prefix} || '_user_' || lpad(n::text, 4, '0') || '@example.test', ${passwordHash}, 'user', 'plus'
        FROM seq
        ON CONFLICT (LOWER(username)) DO UPDATE
        SET password = EXCLUDED.password,
            membership = 'plus',
            is_active = true,
            email = EXCLUDED.email
        RETURNING id, username
      ), links AS (
        INSERT INTO user_bank_links (user_id, bank_id, is_favorite)
        SELECT id, ${bankId}, true FROM upserted
        ON CONFLICT (user_id, bank_id) DO UPDATE SET is_favorite = true
        RETURNING user_id
      )
      SELECT id, username FROM upserted ORDER BY username
    `;

    await tx`UPDATE question_banks SET total_count = (SELECT count(*) FROM bank_question_links WHERE bank_id = ${bankId}) WHERE id = ${bankId}`;

    const sampleQuestionRows = await tx`
      SELECT question_id
      FROM bank_question_links
      WHERE bank_id = ${bankId}
      ORDER BY sort_order
      LIMIT 10
    `;

    return {
      prefix,
      bankId: Number(bankId),
      owner: { id: Number(owner.id), username: owner.username },
      userCount: userRows.length,
      users: userRows.slice(0, Math.min(userRows.length, 10)).map((row) => ({ id: Number(row.id), username: row.username })),
      questionCount,
      sampleQuestionIds: sampleQuestionRows.map((row) => Number(row.question_id)),
      password
    };
  });

  log('ready', result);
} finally {
  await sql.end();
}
