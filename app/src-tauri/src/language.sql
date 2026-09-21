BEGIN IMMEDIATE;
ALTER TABLE settings ADD COLUMN locale TEXT CHECK(locale IS NULL OR locale IN ('zh-CN','en'));
PRAGMA user_version=8;
COMMIT;
