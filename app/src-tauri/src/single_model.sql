BEGIN IMMEDIATE;
UPDATE settings SET model_id=COALESCE(NULLIF(trim(vision_model),''),NULLIF(trim(text_model),''),NULLIF(trim(model_id),''));
ALTER TABLE settings DROP COLUMN text_model;
ALTER TABLE settings DROP COLUMN vision_model;
PRAGMA user_version=7;
COMMIT;
