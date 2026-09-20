BEGIN IMMEDIATE;
CREATE TABLE ai_imports(
 thread_id TEXT NOT NULL,
 digest TEXT NOT NULL,
 checkpoint_id TEXT NOT NULL,
 import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
 PRIMARY KEY(thread_id,digest)
);
PRAGMA user_version=6;
COMMIT;
