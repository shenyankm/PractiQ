import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { questionSearchPredicate } from './search';

test('question search selects FTS only for terms supported by the trigram tokenizer', () => {
  assert.deepEqual(questionSearchPredicate('函数图像'), {
    sql: 'q.id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?)',
    value: '"函数图像"',
  });
  assert.deepEqual(questionSearchPredicate('函数'), { sql: 'q.stem LIKE ?', value: '%函数%' });
});

test('FTS question search does not scan the questions table', (context) => {
  const sqlite = new DatabaseSync(':memory:');
  const ftsEnabled = sqlite.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled;
  if (!ftsEnabled) {
    sqlite.close();
    context.skip('The host Node SQLite build does not include FTS5');
    return;
  }
  sqlite.exec(`
    CREATE TABLE questions(id INTEGER PRIMARY KEY, stem TEXT NOT NULL);
    CREATE VIRTUAL TABLE questions_fts USING fts5(
      stem, content='questions', content_rowid='id', tokenize='trigram'
    );
  `);
  const search = questionSearchPredicate('函数图像');
  const plan = sqlite.prepare(
    `EXPLAIN QUERY PLAN SELECT q.id FROM questions q WHERE ${search.sql} ORDER BY q.id LIMIT 21 OFFSET 0`,
  ).all(search.value) as { detail: string }[];
  assert.equal(plan.some((step) => /SCAN q(?:\s|$)/.test(step.detail)), false, JSON.stringify(plan));
  sqlite.close();
});
