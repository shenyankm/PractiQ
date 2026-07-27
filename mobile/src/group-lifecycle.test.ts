import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { GROUP_LIFECYCLE_MIGRATION_SQL } from './group-lifecycle';

test('group membership keeps active-group invariants without deadlocking publication', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE questions (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE question_groups (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE group_question_links (
      group_id INTEGER REFERENCES question_groups(id) ON DELETE CASCADE,
      question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      sort_order INTEGER,
      PRIMARY KEY (group_id, question_id)
    );
    CREATE TRIGGER group_status_moves_forward
    BEFORE UPDATE OF status ON question_groups
    WHEN NOT (
      (old.status = 'draft' AND new.status IN ('draft', 'active')) OR
      (old.status = 'active' AND new.status IN ('active', 'archived')) OR
      (old.status = 'archived' AND new.status = 'archived')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid group status transition');
    END;
    CREATE TRIGGER active_group_requires_question
    BEFORE UPDATE OF status ON question_groups
    WHEN new.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM group_question_links WHERE group_id = new.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'active group requires a question');
    END;
    CREATE TRIGGER active_question_group_link_requires_active_group
    BEFORE INSERT ON group_question_links
    WHEN EXISTS (SELECT 1 FROM questions q WHERE q.id = new.question_id AND q.status = 'active')
      AND EXISTS (SELECT 1 FROM question_groups qg WHERE qg.id = new.group_id AND qg.status <> 'active')
    BEGIN
      SELECT RAISE(ABORT, 'old deadlock trigger');
    END;
  `);
  db.exec(GROUP_LIFECYCLE_MIGRATION_SQL);
  db.exec(`
    INSERT INTO questions VALUES (1, 'active'), (2, 'draft');
    INSERT INTO question_groups(id, status) VALUES (1, 'draft'), (2, 'draft');
    INSERT INTO group_question_links VALUES (1, 1, 0);
  `);
  assert.equal(db.prepare('SELECT status FROM question_groups WHERE id = 1').get()?.status, 'active');

  db.exec('DELETE FROM group_question_links WHERE group_id = 1 AND question_id = 1');
  assert.equal(db.prepare('SELECT status FROM question_groups WHERE id = 1').get()?.status, 'archived');
  assert.throws(
    () => db.exec('INSERT INTO group_question_links VALUES (1, 1, 0)'),
    /archived question group/,
  );

  db.exec('INSERT INTO group_question_links VALUES (2, 2, 0)');
  assert.equal(db.prepare('SELECT status FROM question_groups WHERE id = 2').get()?.status, 'draft');
  db.exec("UPDATE question_groups SET status = 'active' WHERE id = 2");
  db.exec('DELETE FROM group_question_links WHERE group_id = 2 AND question_id = 2');
  assert.equal(db.prepare('SELECT status FROM question_groups WHERE id = 2').get()?.status, 'archived');
  db.close();
});
