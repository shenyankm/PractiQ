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
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
impl Store {
    pub fn backup(&self, destination: &Path) -> Result<Value> {
        if destination.starts_with(self.dir.join("assets")) || destination == self.db_path() {
            return Err("不能覆盖应用数据".into());
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
            return Err("备份清单过大".into());
        }
        let parent = destination.parent().ok_or("备份路径无效")?;
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
                let digest = asset["sha256"].as_str().ok_or("图片摘要无效")?;
                if asset["file"] != format!("assets/{digest}") {
                    return Err("图片路径无效".into());
                }
                let data =
                    self.read_asset(digest, asset["sizeBytes"].as_u64().ok_or("图片大小无效")?)?;
                total += data.len();
                if total > LIMIT {
                    return Err("备份数据超过 512 MiB".into());
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
            return Err("备份包超过大小限制".into());
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
            return Err("备份清单过大".into());
        }
        let manifest: Value = serde_json::from_slice(&manifest).map_err(err)?;
        let legacy = manifest["version"] == 1;
        if manifest["format"] != "practiq-backup" || (!legacy && manifest["version"] != 2) {
            return Err("不支持的备份版本".into());
        }
        let assets = if legacy {
            Vec::new()
        } else {
            manifest["assets"].as_array().ok_or("缺少图片清单")?.clone()
        };
        let mut allowed = std::collections::HashSet::from([
            "manifest.json".to_owned(),
            "practiq.sqlite".to_owned(),
        ]);
        for asset in &assets {
            let digest = asset["sha256"].as_str().ok_or("图片摘要无效")?;
            self.asset_path(digest)?;
            let path = format!("assets/{digest}");
            if asset["file"] != path || !allowed.insert(path) {
                return Err("备份图片清单重复或路径非法".into());
            }
        }
        if archive.len() != allowed.len() {
            return Err("备份包含未声明文件".into());
        }
        let mut total = 0u64;
        for i in 0..archive.len() {
            let f = archive.by_index(i).map_err(err)?;
            if !allowed.remove(f.name()) || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            {
                return Err("备份包含非法路径或链接".into());
            }
            total = total.checked_add(f.size()).ok_or("备份大小溢出")?;
            if total > (LIMIT + 1024 * 1024) as u64 {
                return Err("备份解压后超过大小限制".into());
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
            return Err("备份数据库大小或校验和不匹配".into());
        }
        fs::write(&candidate, &bytes).map_err(err)?;
        let version = validate_database(&candidate)?;
        if manifest["schemaVersion"] != version || (legacy && version > 2) {
            return Err("备份清单与数据库版本不一致".into());
        }
        let staged = Store {
            dir: staging.path().to_owned(),
            pending: None,
        };
        for asset in &assets {
            let digest = asset["sha256"].as_str().ok_or("图片摘要无效")?;
            let mut data = Vec::new();
            archive
                .by_name(&format!("assets/{digest}"))
                .map_err(err)?
                .take(crate::assets::LIMIT as u64 + 1)
                .read_to_end(&mut data)
                .map_err(err)?;
            if asset["sizeBytes"] != data.len() {
                return Err("备份图片大小不匹配".into());
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
            return Err("图片清单与数据库不一致".into());
        }
        for (digest, media, size, path) in rows {
            if path != format!("assets/{digest}") {
                return Err("备份图片路径不合法".into());
            }
            if !legacy
                && !assets.iter().any(|a| {
                    a["sha256"] == digest && a["sizeBytes"] == size && a["mediaType"] == media
                })
            {
                return Err("图片清单与数据库不一致".into());
            }
            let data = staged.read_asset(&digest, size)?;
            if !crate::store::image_signature(&data, &media) {
                return Err("备份图片格式不匹配".into());
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
                format!(
                    "恢复失败：{error}；回滚失败：{rollback}；恢复副本：{}",
                    recovery.display()
                )
            })?;
            return Err(format!("恢复未完成：{error}；已恢复原数据库"));
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
    if ![1, 2, 3, 4, 5, 6].contains(&version) {
        return Err("备份数据库版本不兼容".into());
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
    if schema(&db)? != schema(&expected)? {
        return Err("备份数据库结构不受支持".into());
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
                        ..Default::default()
                    })
                },
            )
            .map_err(err)?;
        config.validate()?;
    }
    if version >= 4 {
        let config = db
            .query_row(
                "SELECT base_url,model_id,oss_url,text_model,vision_model FROM settings WHERE id=1",
                [],
                |r| {
                    Ok(crate::settings::ConnectionSettings {
                        base_url: r.get(0)?,
                        model_id: r.get(1)?,
                        oss_url: r.get(2)?,
                        text_model: r.get(3)?,
                        vision_model: r.get(4)?,
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
        return Err("备份数据库完整性检查失败".into());
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
        return Err("备份数据库关联损坏".into());
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
                || data.len() > 20 * 1024 * 1024
                || hash(&data) != digest
            {
                return Err("备份图片校验失败".into());
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
                return Err("备份题目过大".into());
            }
            let mut snapshot: Value = serde_json::from_str(&raw).map_err(err)?;
            crate::contract::validate_question(&mut snapshot["question"])?;
            for key in ["groups", "visuals", "sources", "warnings"] {
                if !snapshot[key].is_array() {
                    return Err(format!("备份快照字段不合法: {key}"));
                }
            }
            let content = |key: &str| -> Result<Vec<Value>> {
                crate::contract::list(&snapshot, key)
                    .iter()
                    .map(|value| {
                        let mut value = value.clone();
                        let object = value.as_object_mut().ok_or("备份材料或图片结构不合法")?;
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
