import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = [
  '../backend/db/study-groups/30_study_groups.sql',
  '../backend/db/study-groups/80_study_group_analytics.sql'
].map((file) => readFileSync(file, 'utf8')).join('\n');

function expectTable(name: string) {
  expect(schema).toContain(`CREATE TABLE ${name} (`);
}

describe('study group schema', () => {
  it('stores learning groups and active member roles', () => {
    expectTable('study_groups');
    expectTable('study_group_members');

    expect(schema).toContain("CONSTRAINT chk_study_groups_visibility CHECK (visibility IN ('private', 'public'))");
    expect(schema).toContain('created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(schema).toContain('CONSTRAINT uq_study_group_members_group_user UNIQUE (group_id, user_id)');
    expect(schema).toContain("CONSTRAINT chk_study_group_members_role CHECK (role IN ('owner', 'admin', 'member'))");
    expect(schema).toContain("CONSTRAINT chk_study_group_members_status CHECK (status IN ('active', 'pending', 'left', 'banned'))");
  });

  it('links group-managed banks to an existing group member', () => {
    expectTable('study_group_bank_links');

    expect(schema).toContain('group_id BIGINT NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE');
    expect(schema).toContain('bank_id BIGINT NOT NULL REFERENCES question_banks(id) ON DELETE CASCADE');
    expect(schema).toContain('CONSTRAINT uq_study_group_bank_links_group_bank UNIQUE (group_id, bank_id)');
    expect(schema).toContain('FOREIGN KEY (group_id, added_by)');
    expect(schema).toContain('REFERENCES study_group_members(group_id, user_id)');
  });

  it('exposes admin-readable member learning stats per group bank', () => {
    expect(schema).toContain('CREATE VIEW study_group_admins AS');
    expect(schema).toContain("role IN ('owner', 'admin')");
    expect(schema).toContain('CREATE VIEW study_group_member_bank_learning_stats AS');
    expect(schema).toContain('LEFT JOIN user_bank_stats ubs');
    expect(schema).toContain('LEFT JOIN user_question_stats uqs');
    expect(schema).toContain('avg_mastery_score');
  });

  it('adds a filtered helper for per-group bank learning analytics lookups', () => {
    expect(schema).toContain('CREATE OR REPLACE FUNCTION study_group_member_bank_learning_stats_for_bank(');
    expect(schema).toContain('RETURNS SETOF study_group_member_bank_learning_stats');
    expect(schema).toContain('WHERE group_id = p_group_id');
    expect(schema).toContain('AND bank_id = p_bank_id');
  });
});
