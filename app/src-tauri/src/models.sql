BEGIN;
ALTER TABLE settings ADD COLUMN text_model TEXT;
ALTER TABLE settings ADD COLUMN vision_model TEXT;
PRAGMA user_version=4;
COMMIT;
