import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const splitFiles = [
  '../backend/db/core/00_functions.sql',
  '../backend/db/users/10_users.sql',
  '../backend/db/banks/20_question_banks.sql',
  '../backend/db/study-groups/30_study_groups.sql',
  '../backend/db/imports/40_question_import_jobs.sql',
  '../backend/db/questions/50_questions.sql',
  '../backend/db/media/60_media.sql',
  '../backend/db/practice/70_user_answers.sql',
  '../backend/db/study-groups/80_study_group_analytics.sql'
];

function splitSchema() {
  return splitFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
}

function objectNames(sql: string) {
  const patterns = [
    /CREATE OR REPLACE FUNCTION\s+(\w+)\s*\(/gm,
    /CREATE TABLE\s+(\w+)\s*\(/gm,
    /CREATE VIEW\s+(\w+)\s+AS/gm,
    /CREATE (?:UNIQUE )?INDEX\s+(\w+)\s+/gm,
    /CREATE TRIGGER\s+(\w+)\s+/gm
  ];
  return patterns.flatMap((pattern) => Array.from(sql.matchAll(pattern), (match) => match[1])).sort();
}

function duplicated(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts).filter(([, count]) => count > 1).map(([value]) => value).sort();
}

describe('db schema file structure', () => {
  it('keeps schema source split by business area with English purpose headers', () => {
    for (const file of splitFiles) {
      expect(existsSync(file), `${file} should exist`).toBe(true);
      const content = readFileSync(file, 'utf8');
      expect(content.slice(0, 240), `${file} should explain its purpose in English`).toMatch(/-- Purpose: [A-Za-z]/);
    }
  });

  it('does not keep a duplicate aggregate schema file', () => {
    expect(existsSync('../backend/db/schema.sql')).toBe(false);
  });

  it('uses PostgreSQL syntax without duplicate object declarations', () => {
    const schema = splitSchema();

    expect(schema).not.toMatch(/\b(?:AUTO_INCREMENT|UNSIGNED|TINYINT|DATETIME|ENGINE=|ROW_FORMAT|COLLATE|CHARSET)\b/i);
    expect(schema).not.toMatch(/\bENUM\s*\(/i);
    expect(duplicated(objectNames(schema))).toEqual([]);
  });
});
