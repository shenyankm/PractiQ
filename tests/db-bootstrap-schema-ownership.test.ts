import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ensureSource = readFileSync('lib/db/ensure-openwook.ts', 'utf8');
const seedSource = readFileSync('lib/db/seed.ts', 'utf8');

const forbiddenSchemaOwnershipPatterns = [
  { reason: 'alters the users table at runtime', pattern: /\bALTER TABLE users\b/ },
  { reason: 'creates the ai_artifacts table at runtime', pattern: /\bCREATE TABLE IF NOT EXISTS ai_artifacts\b/ },
  { reason: 'adds ai_artifacts constraints at runtime', pattern: /\bALTER TABLE ai_artifacts\b/ },
  { reason: 'creates ai_artifacts indexes at runtime', pattern: /\bCREATE INDEX IF NOT EXISTS idx_ai_artifacts_/ },
  {
    reason: 'creates core study-data indexes at runtime',
    pattern: /\bCREATE INDEX IF NOT EXISTS idx_(?:user_bank_links|question_import_jobs|questions|bank_question_links|bank_group_links|group_question_links)_/
  },
  { reason: 'creates the billing_subscriptions table at runtime', pattern: /\bCREATE TABLE IF NOT EXISTS billing_subscriptions\b/ },
  {
    reason: 'creates billing subscription indexes at runtime',
    pattern: /\bCREATE (?:UNIQUE )?INDEX IF NOT EXISTS (?:uq_billing_subscriptions_|idx_billing_subscriptions_)/
  },
  {
    reason: 'creates the billing_subscriptions trigger at runtime',
    pattern: /\bCREATE TRIGGER trg_billing_subscriptions_set_updated_at\b/
  }
] as const;

function matchingLines(source: string, pattern: RegExp) {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => pattern.test(text))
    .map(({ line, text }) => `${line}: ${text}`);
}

function forbiddenSchemaOwnership(source: string) {
  return forbiddenSchemaOwnershipPatterns.flatMap(({ reason, pattern }) =>
    matchingLines(source, pattern).map((match) => `${reason} -> ${match}`)
  );
}

describe('database bootstrap schema ownership', () => {
  it('keeps bootstrap scripts focused on prerequisites, compatibility cleanup, and seed data', () => {
    expect(ensureSource).toContain("POSTGRES_URL or DATABASE_URL is required");
    expect(ensureSource).toContain('DROP TABLE IF EXISTS');
    expect(seedSource).toContain("POSTGRES_URL or DATABASE_URL is required");
    expect(seedSource).toContain('INSERT INTO users');
  });

  it('does not let ensure or seed act as schema managers for core objects', () => {
    expect({
      'lib/db/ensure-openwook.ts': forbiddenSchemaOwnership(ensureSource),
      'lib/db/seed.ts': forbiddenSchemaOwnership(seedSource)
    }).toEqual({
      'lib/db/ensure-openwook.ts': [],
      'lib/db/seed.ts': []
    });
  });
});
