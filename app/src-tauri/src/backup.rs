use crate::{
    contract::Result,
    store::{id, now, Store},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
fn file_digest(path: &Path) -> Result<(u64, String)> {
    let mut file = fs::File::open(path).map_err(err)?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > LIMIT as u64 {
            return Err(crate::language::error("LOCAL_BACKUP_TOO_LARGE", json!({})));
        }
        digest.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
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
        let (database_size, database_hash) = file_digest(&snapshot)?;
        let assets=db.prepare("SELECT hash,media,size,path FROM assets ORDER BY hash").map_err(err)?.query_map([],|r| Ok(json!({"sha256":r.get::<_,String>(0)?,"mediaType":r.get::<_,String>(1)?,"sizeBytes":r.get::<_,u64>(2)?,"file":r.get::<_,String>(3)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        let manifest = json!({"format":"practiq-backup","version":3,"schemaVersion":version,"createdAt":now(),"database":{"file":"practiq.sqlite","sha256":database_hash,"sizeBytes":database_size},"assets":assets});
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
            std::io::copy(&mut fs::File::open(&snapshot).map_err(err)?, &mut zip).map_err(err)?;
            let mut total = database_size;
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
                total += data.len() as u64;
                if total > LIMIT as u64 {
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
        let result = self.restore_inner(source);
        if result.is_err() {
            let _ = self.collect_unused_assets();
        }
        result
    }
    fn restore_inner(&mut self, source: &Path) -> Result<Value> {
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
        if manifest["format"] == "practiq-question-bank" {
            return Err(crate::language::error("LOCAL_USE_BANK_IMPORT", json!({})));
        }
        if manifest["format"] != "practiq-backup" || manifest["version"] != 3 {
            return Err(crate::language::error(
                "LOCAL_BACKUP_VERSION_UNSUPPORTED",
                serde_json::json!({}),
            ));
        }
        let assets = {
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
        let mut candidate_file = fs::File::create(&candidate).map_err(err)?;
        let copied = std::io::copy(
            &mut archive
                .by_name("practiq.sqlite")
                .map_err(err)?
                .take(LIMIT as u64 + 1),
            &mut candidate_file,
        )
        .map_err(err)?;
        drop(candidate_file);
        if copied > LIMIT as u64
            || manifest["database"]["sizeBytes"] != copied
            || manifest["database"]["sha256"] != file_digest(&candidate)?.1
        {
            return Err(crate::language::error(
                "LOCAL_BACKUP_CHECKSUM_MISMATCH",
                serde_json::json!({}),
            ));
        }
        let version = validate_database(&candidate)?;
        if manifest["schemaVersion"] != version {
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
        if rows.len() != assets.len() {
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
            if !assets
                .iter()
                .any(|a| a["sha256"] == digest && a["sizeBytes"] == size && a["mediaType"] == media)
            {
                return Err(crate::language::error(
                    "LOCAL_BACKUP_IMAGE_MANIFEST",
                    serde_json::json!({}),
                ));
            }
            let data = staged.read_asset(&digest, size)?;
            if !crate::store::valid_image(&data, &media) {
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
        if let Err(error) = self.collect_unused_assets() {
            eprintln!("Asset cleanup deferred after restore: {error}");
        }
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
    if version != 9 {
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
    let locale: Option<String> = db
        .query_row("SELECT locale FROM settings WHERE id=1", [], |r| r.get(0))
        .map_err(err)?;
    if locale.as_deref().is_some_and(|v| v != "zh-CN" && v != "en") {
        return Err("Invalid locale".into());
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
    let rows = crate::questions::read(&db)?;
    let mut questions: Vec<_> = rows.iter().map(|r| r["question"].clone()).collect();
    crate::contract::validate_tree(&mut questions)?;
    crate::questions::validate_tables(&db)?;
    let doc = crate::questions::freeze(&rows);
    let ids: std::collections::HashSet<_> = rows
        .iter()
        .map(|r| crate::contract::text(r, "id"))
        .collect();
    crate::contract::validate_context(
        crate::contract::list(&doc, "groups"),
        crate::contract::list(&doc, "visuals"),
        &ids,
    )?;
    let sessions = db
        .prepare("SELECT session_id,content FROM session_documents")
        .map_err(err)?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    for (sid, raw) in sessions {
        if raw.len() > LIMIT {
            return Err("Snapshot exceeds backup limit".into());
        }
        let doc: Value = serde_json::from_str(&raw).map_err(err)?;
        let rows = crate::questions::thaw(&doc)?;
        let mut qs: Vec<_> = rows.iter().map(|r| r["question"].clone()).collect();
        crate::contract::validate_tree(&mut qs)?;
        let ids: std::collections::HashSet<_> = rows
            .iter()
            .map(|r| crate::contract::text(r, "id"))
            .collect();
        if rows.iter().any(|r| r["id"] != r["question"]["id"]) {
            return Err("Frozen question identity mismatch".into());
        }
        crate::contract::validate_context(
            crate::contract::list(&doc, "groups"),
            crate::contract::list(&doc, "visuals"),
            &ids,
        )?;
        let attempts = db
            .prepare("SELECT snapshot_question_id FROM attempts WHERE session_id=?1")
            .map_err(err)?
            .query_map([&sid], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        if attempts.iter().any(|id| !ids.contains(id.as_str())) {
            return Err("Attempt references a missing frozen question".into());
        }
    }
    let missing:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s LEFT JOIN session_documents d ON d.session_id=s.id WHERE d.session_id IS NULL)",[],|r|r.get(0)).map_err(err)?;
    if missing {
        return Err("Session snapshot is missing".into());
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_legacy_database_without_upgrading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=8;").unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        assert!(validate_database(&path).is_err());
        assert_eq!(before, fs::read(&path).unwrap());
    }
}
