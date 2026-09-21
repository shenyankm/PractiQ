use crate::{
    contract::Result,
    store::{hash, id, now, read_bounded, Store},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};
const LIMIT: usize = 512 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}
impl Store {
    pub fn backup(&self, destination: &Path) -> Result<Value> {
        if destination.starts_with(self.dir.join("assets")) || destination == self.db_path() {
            return Err(crate::language::error(
                "LOCAL_BACKUP_OVERWRITE",
                serde_json::json!({}),
            ));
        }
        let dir = tempfile::tempdir_in(&self.dir).map_err(err)?;
        let snapshot = dir.path().join("practiq.sqlite");
        self.connect()?
            .backup(rusqlite::MAIN_DB, &snapshot, None)
            .map_err(err)?;
        let db = Connection::open(&snapshot).map_err(err)?;
        // In-flight model requests are task state, not portable practice history.
        db.execute("DELETE FROM grade_requests WHERE response IS NULL", [])
            .map_err(err)?;
        let bytes = read_bounded(&snapshot, LIMIT)?;
        let assets=db.prepare("SELECT hash,media,size,path FROM assets ORDER BY hash").map_err(err)?.query_map([],|r| Ok(json!({"sha256":r.get::<_,String>(0)?,"mediaType":r.get::<_,String>(1)?,"sizeBytes":r.get::<_,u64>(2)?,"file":r.get::<_,String>(3)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        let manifest = json!({"format":"practiq-backup","version":2,"schemaVersion":version,"createdAt":now(),"database":{"file":"practiq.sqlite","sha256":hash(&bytes),"sizeBytes":bytes.len()},"assets":assets});
        let manifest = serde_json::to_vec(&manifest).map_err(err)?;
        if manifest.len() > 1024 * 1024 {
            return Err(crate::language::error(
                "LOCAL_MANIFEST_TOO_LARGE",
                serde_json::json!({}),
            ));
        }
        let parent = destination.parent().ok_or(crate::language::error(
            "LOCAL_BACKUP_PATH_INVALID",
            serde_json::json!({}),
        ))?;
        let mut output = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
        {
            let mut zip = ZipWriter::new(output.as_file_mut());
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("manifest.json", options).map_err(err)?;
            zip.write_all(&manifest).map_err(err)?;
            zip.start_file("practiq.sqlite", options).map_err(err)?;
            zip.write_all(&bytes).map_err(err)?;
            let mut total = bytes.len();
            for asset in &assets {
                let digest = asset["sha256"].as_str().ok_or(crate::language::error(
                    "LOCAL_IMAGE_HASH_INVALID",
                    serde_json::json!({}),
                ))?;
                if asset["file"] != format!("assets/{digest}") {
                    return Err(crate::language::error(
                        "LOCAL_IMAGE_PATH_INVALID",
                        serde_json::json!({}),
                    ));
                }
                let data = self.read_asset(
                    digest,
                    asset["sizeBytes"].as_u64().ok_or(crate::language::error(
                        "LOCAL_IMAGE_SIZE_INVALID",
                        serde_json::json!({}),
                    ))?,
                )?;
                total += data.len();
                if total > LIMIT {
                    return Err(crate::language::error(
                        "LOCAL_BACKUP_TOO_LARGE",
                        serde_json::json!({}),
                    ));
                }
                zip.start_file(format!("assets/{digest}"), options)
                    .map_err(err)?;
                zip.write_all(&data).map_err(err)?;
            }
            zip.finish().map_err(err)?;
        }
        output.as_file().sync_all().map_err(err)?;
        output.persist(destination).map_err(err)?;
        Ok(json!({"path":destination.display().to_string()}))
    }
    pub fn restore(&mut self, source: &Path) -> Result<Value> {
        let file = fs::File::open(source).map_err(err)?;
        if file.metadata().map_err(err)?.len() > (LIMIT + 2 * 1024 * 1024) as u64 {
            return Err(crate::language::error(
                "LOCAL_ARCHIVE_TOO_LARGE",
                serde_json::json!({}),
            ));
        }
        let mut archive = ZipArchive::new(file).map_err(err)?;
        let mut manifest = Vec::new();
        archive
            .by_name("manifest.json")
            .map_err(err)?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut manifest)
            .map_err(err)?;
        if manifest.len() > 1024 * 1024 {
            return Err(crate::language::error(
                "LOCAL_MANIFEST_TOO_LARGE",
                serde_json::json!({}),
            ));
        }
        let manifest: Value = serde_json::from_slice(&manifest).map_err(err)?;
        let legacy = manifest["version"] == 1;
        if manifest["format"] != "practiq-backup" || (!legacy && manifest["version"] != 2) {
            return Err(crate::language::error(
                "LOCAL_BACKUP_VERSION_UNSUPPORTED",
                serde_json::json!({}),
            ));
        }
        let assets = if legacy {
            Vec::new()
        } else {
            manifest["assets"]
                .as_array()
                .ok_or(crate::language::error(
                    "LOCAL_IMAGE_MANIFEST_MISSING",
                    serde_json::json!({}),
                ))?
                .clone()
        };
        let mut allowed = std::collections::HashSet::from([
            "manifest.json".to_owned(),
            "practiq.sqlite".to_owned(),
        ]);
        for asset in &assets {
            let digest = asset["sha256"].as_str().ok_or(crate::language::error(
                "LOCAL_IMAGE_HASH_INVALID",
                serde_json::json!({}),
            ))?;
            self.asset_path(digest)?;
            let path = format!("assets/{digest}");
            if asset["file"] != path || !allowed.insert(path) {
                return Err(crate::language::error(
                    "LOCAL_IMAGE_MANIFEST_INVALID",
                    serde_json::json!({}),
                ));
            }
        }
        if archive.len() != allowed.len() {
            return Err(crate::language::error(
                "LOCAL_BACKUP_UNDECLARED_FILE",
                serde_json::json!({}),
            ));
        }
        let mut total = 0u64;
        for i in 0..archive.len() {
            let f = archive.by_index(i).map_err(err)?;
            if !allowed.remove(f.name()) || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_UNSAFE_PATH",
                    serde_json::json!({}),
                ));
            }
            total = total.checked_add(f.size()).ok_or(crate::language::error(
                "LOCAL_BACKUP_SIZE_OVERFLOW",
                serde_json::json!({}),
            ))?;
            if total > (LIMIT + 1024 * 1024) as u64 {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_EXPANDED_TOO_LARGE",
                    serde_json::json!({}),
                ));
            }
        }
        let staging = tempfile::tempdir_in(&self.dir).map_err(err)?;
        let candidate = staging.path().join("practiq.sqlite");
        let mut bytes = Vec::new();
        archive
            .by_name("practiq.sqlite")
            .map_err(err)?
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > LIMIT
            || manifest["database"]["sizeBytes"] != bytes.len()
            || manifest["database"]["sha256"] != hash(&bytes)
        {
            return Err(crate::language::error(
                "LOCAL_BACKUP_CHECKSUM_MISMATCH",
                serde_json::json!({}),
            ));
        }
        fs::write(&candidate, &bytes).map_err(err)?;
        let version = validate_database(&candidate)?;
        if manifest["schemaVersion"] != version || (legacy && version > 2) {
            return Err(crate::language::error(
                "LOCAL_BACKUP_SCHEMA_MISMATCH",
                serde_json::json!({}),
            ));
        }
        let staged = Store {
            locale: Default::default(),
            dir: staging.path().to_owned(),
            pending: None,
        };
        for asset in &assets {
            let digest = asset["sha256"].as_str().ok_or(crate::language::error(
                "LOCAL_IMAGE_HASH_INVALID",
                serde_json::json!({}),
            ))?;
            let mut data = Vec::new();
            archive
                .by_name(&format!("assets/{digest}"))
                .map_err(err)?
                .take(crate::assets::LIMIT as u64 + 1)
                .read_to_end(&mut data)
                .map_err(err)?;
            if asset["sizeBytes"] != data.len() {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_SIZE",
                    serde_json::json!({}),
                ));
            }
            staged.write_asset(digest, &data)?;
        }
        // Upgrade only the validated staging database, never the live database.
        let db = staged.connect()?;
        let rows = db
            .prepare("SELECT hash,media,size,path FROM assets")
            .map_err(err)?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        if !legacy && rows.len() != assets.len() {
            return Err(crate::language::error(
                "LOCAL_BACKUP_IMAGE_MANIFEST",
                serde_json::json!({}),
            ));
        }
        for (digest, media, size, path) in rows {
            if path != format!("assets/{digest}") {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_PATH",
                    serde_json::json!({}),
                ));
            }
            if !legacy
                && !assets.iter().any(|a| {
                    a["sha256"] == digest && a["sizeBytes"] == size && a["mediaType"] == media
                })
            {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_MANIFEST",
                    serde_json::json!({}),
                ));
            }
            let data = staged.read_asset(&digest, size)?;
            if !crate::store::image_signature(&data, &media) {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_FORMAT",
                    serde_json::json!({}),
                ));
            }
            self.write_asset(&digest, &data)?;
        }
        drop(db);
        fs::File::open(&candidate)
            .map_err(err)?
            .sync_all()
            .map_err(err)?;
        let recovery = self.dir.join("recoveries");
        fs::create_dir_all(&recovery).map_err(err)?;
        let recovery = recovery.join(format!("before-restore-{}-{}.zip", now(), id()));
        self.backup(&recovery)?;
        let previous = staging.path().join("previous.sqlite");
        self.connect()?
            .backup(rusqlite::MAIN_DB, &previous, None)
            .map_err(err)?;
        // Replace only after all resources validate. Keep a rollback generation until fsync succeeds.
        fs::rename(&candidate, self.db_path()).map_err(err)?;
        if let Err(error) = fs::File::open(&self.dir).and_then(|dir| dir.sync_all()) {
            fs::rename(&previous, self.db_path()).map_err(|rollback| {
                crate::language::error("LOCAL_RESTORE_ROLLBACK_FAILED", json!({"error":error.to_string(),"rollback":rollback.to_string(),"path":recovery.display().to_string()}))
            })?;
            return Err(crate::language::error(
                "LOCAL_RESTORE_FAILED",
                serde_json::json!({"error": error.to_string()}),
            ));
        }
        self.pending = None;
        Ok(json!({"recoveryPath":recovery.display().to_string()}))
    }
}
fn validate_database(path: &Path) -> Result<i64> {
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(err)?;
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(err)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    if ![1, 2, 3, 4, 5, 6, 7, 8].contains(&version) {
        return Err(crate::language::error(
            "LOCAL_BACKUP_DATABASE_VERSION",
            serde_json::json!({}),
        ));
    }
    let schema = |db: &Connection| -> Result<Vec<String>> {
        let mut stmt=db.prepare("SELECT type||':'||name||':'||COALESCE(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map_err(err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        Ok(rows)
    };
    let expected = Connection::open_in_memory().map_err(err)?;
    expected
        .execute_batch(include_str!("schema.sql"))
        .map_err(err)?;
    if version >= 2 {
        expected
            .execute_batch(include_str!("settings.sql"))
            .map_err(err)?;
    }
    if version >= 3 {
        expected.execute_batch("DROP TABLE assets;").map_err(err)?;
        expected.execute_batch(crate::assets::SCHEMA).map_err(err)?;
    }
    if version >= 4 {
        expected
            .execute_batch(include_str!("models.sql"))
            .map_err(err)?;
    }
    if version >= 5 {
        expected
            .execute_batch(include_str!("exams.sql"))
            .map_err(err)?;
    }
    if version >= 6 {
        expected
            .execute_batch(include_str!("ai_imports.sql"))
            .map_err(err)?;
    }
    if version >= 7 {
        expected
            .execute_batch(include_str!("single_model.sql"))
            .map_err(err)?;
    }
    if version >= 8 {
        expected
            .execute_batch(include_str!("language.sql"))
            .map_err(err)?;
        let value: Option<String> = db
            .query_row("SELECT locale FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(err)?;
        if value
            .as_deref()
            .is_some_and(|v| !["zh-CN", "en"].contains(&v))
        {
            return Err(crate::language::error("LOCAL_LANGUAGE_INVALID", json!({})));
        }
    }
    if schema(&db)? != schema(&expected)? {
        return Err(crate::language::error(
            "LOCAL_BACKUP_SCHEMA_UNSUPPORTED",
            serde_json::json!({}),
        ));
    }
    if version >= 2 {
        let config = db
            .query_row(
                "SELECT base_url,model_id,oss_url FROM settings WHERE id=1",
                [],
                |r| {
                    Ok(crate::settings::ConnectionSettings {
                        base_url: r.get(0)?,
                        model_id: r.get(1)?,
                        oss_url: r.get(2)?,
                    })
                },
            )
            .map_err(err)?;
        config.validate()?;
        // Validate every legacy field before migrating, including unused values.
        if (4..7).contains(&version) {
            let (text, vision): (Option<String>, Option<String>) = db
                .query_row(
                    "SELECT text_model,vision_model FROM settings WHERE id=1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(err)?;
            for model_id in [text, vision] {
                crate::settings::ConnectionSettings {
                    model_id,
                    ..Default::default()
                }
                .validate()?;
            }
        }
    }
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(err)?;
    if integrity != "ok" {
        return Err(crate::language::error(
            "LOCAL_BACKUP_INTEGRITY",
            serde_json::json!({}),
        ));
    }
    if db
        .prepare("PRAGMA foreign_key_check")
        .map_err(err)?
        .query([])
        .map_err(err)?
        .next()
        .map_err(err)?
        .is_some()
    {
        return Err(crate::language::error(
            "LOCAL_BACKUP_RELATIONS",
            serde_json::json!({}),
        ));
    }
    if version < 3 {
        let mut stmt = db
            .prepare("SELECT media,data,hash FROM assets")
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let media: String = row.get(0).map_err(err)?;
            let data: Vec<u8> = row.get(1).map_err(err)?;
            let digest: String = row.get(2).map_err(err)?;
            if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&media.as_str())
                || data.len() > crate::assets::LIMIT
                || hash(&data) != digest
            {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_CHECKSUM",
                    serde_json::json!({}),
                ));
            }
        }
    }
    for table in ["questions", "attempts"] {
        let mut stmt = db
            .prepare(&format!("SELECT snapshot FROM {table}"))
            .map_err(err)?;
        let mut rows = stmt.query([]).map_err(err)?;
        while let Some(row) = rows.next().map_err(err)? {
            let raw: String = row.get(0).map_err(err)?;
            if raw.len() > crate::contract::MAX_JSON {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_QUESTION_SIZE",
                    serde_json::json!({}),
                ));
            }
            let mut snapshot: Value = serde_json::from_str(&raw).map_err(err)?;
            crate::contract::validate_question(&mut snapshot["question"])?;
            for key in ["groups", "visuals", "sources", "warnings"] {
                if !snapshot[key].is_array() {
                    return Err(crate::language::error(
                        "LOCAL_BACKUP_SNAPSHOT_FIELD",
                        serde_json::json!({"key": key}),
                    ));
                }
            }
            let content = |key: &str| -> Result<Vec<Value>> {
                crate::contract::list(&snapshot, key)
                    .iter()
                    .map(|value| {
                        let mut value = value.clone();
                        let object = value.as_object_mut().ok_or(crate::language::error(
                            "LOCAL_BACKUP_CONTENT_INVALID",
                            serde_json::json!({}),
                        ))?;
                        object.remove("id");
                        object.remove("questionIds");
                        object.insert("questionIndexes".into(), json!([0]));
                        Ok(value)
                    })
                    .collect()
            };
            crate::contract::parse(&serde_json::to_vec(&json!({"questions":[snapshot["question"]],"groups":content("groups")?,"visualElements":content("visuals")?,"warnings":snapshot["warnings"],"confidenceScore":0})).map_err(err)?)?;
        }
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_models_migrate_once_and_backups_roundtrip() {
        for (vision, text, legacy, expected) in [
            (Some(" vision "), Some("text"), Some("old"), Some("vision")),
            (Some(" "), Some(" text "), Some("old"), Some("text")),
            (None, None, Some(" old "), Some("old")),
            (None, Some(" "), Some(" "), None),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("practiq.sqlite");
            let db = Connection::open(&path).unwrap();
            for sql in [include_str!("schema.sql"), include_str!("settings.sql")] {
                db.execute_batch(sql).unwrap();
            }
            db.execute_batch("DROP TABLE assets;").unwrap();
            db.execute_batch(crate::assets::SCHEMA).unwrap();
            for sql in [
                include_str!("models.sql"),
                include_str!("exams.sql"),
                include_str!("ai_imports.sql"),
            ] {
                db.execute_batch(sql).unwrap();
            }
            db.execute(
                "UPDATE settings SET vision_model=?1,text_model=?2,model_id=?3",
                rusqlite::params![vision, text, legacy],
            )
            .unwrap();
            assert_eq!(validate_database(&path).unwrap(), 6);
            drop(db);
            let bytes = fs::read(&path).unwrap();
            let archive_path = dir.path().join("legacy.zip");
            let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
            let manifest = json!({"format":"practiq-backup","version":2,"schemaVersion":6,"database":{"sha256":hash(&bytes),"sizeBytes":bytes.len()},"assets":[]});
            archive
                .start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            archive
                .write_all(&serde_json::to_vec(&manifest).unwrap())
                .unwrap();
            archive
                .start_file("practiq.sqlite", SimpleFileOptions::default())
                .unwrap();
            archive.write_all(&bytes).unwrap();
            archive.finish().unwrap();
            let restored_dir = tempfile::tempdir().unwrap();
            let mut restored = Store::new(restored_dir.path().to_owned()).unwrap();
            restored.restore(&archive_path).unwrap();
            assert_eq!(
                restored.connection_settings().unwrap().model_id.as_deref(),
                expected
            );
            let upgraded = Store::new(dir.path().to_owned()).unwrap();
            assert_eq!(
                upgraded.connection_settings().unwrap().model_id.as_deref(),
                expected
            );
            assert_eq!(validate_database(&path).unwrap(), 8);
            upgraded
                .connect()
                .unwrap()
                .execute("UPDATE settings SET model_id='changed'", [])
                .unwrap();
            assert_eq!(
                upgraded.connection_settings().unwrap().model_id.as_deref(),
                Some("changed")
            );
            assert!(upgraded
                .connect()
                .unwrap()
                .prepare("SELECT text_model,vision_model FROM settings")
                .is_err());
            let backup = dir.path().join("current.zip");
            upgraded.backup(&backup).unwrap();
            restored.restore(&backup).unwrap();
            assert_eq!(
                restored.connection_settings().unwrap().model_id.as_deref(),
                Some("changed")
            );
        }
    }

    #[test]
    fn settings_validation_covers_legacy_and_current_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(include_str!("schema.sql")).unwrap();
        db.execute_batch(include_str!("settings.sql")).unwrap();
        for version in [2, 4] {
            if version == 4 {
                db.execute_batch("DROP TABLE assets;").unwrap();
                db.execute_batch(crate::assets::SCHEMA).unwrap();
                db.execute_batch(include_str!("models.sql")).unwrap();
            }
            assert_eq!(validate_database(&path).unwrap(), version);
            for (column, valid, invalid) in [
                ("base_url", "https://example.com/v1", "file:///tmp/model"),
                ("oss_url", "https://example.com", "file:///tmp/images"),
                ("model_id", "legacy", "invalid\nmodel"),
                ("text_model", "text", "invalid\nmodel"),
                ("vision_model", "vision", "invalid\nmodel"),
            ] {
                if version < 4 && matches!(column, "text_model" | "vision_model") {
                    continue;
                }
                let query = format!("UPDATE settings SET {column}=?1 WHERE id=1");
                db.execute(&query, [invalid]).unwrap();
                assert!(validate_database(&path).is_err(), "{version}: {column}");
                db.execute(&query, [valid]).unwrap();
                assert_eq!(validate_database(&path).unwrap(), version);
            }
        }
    }
}
