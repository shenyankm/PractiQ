use crate::{
    contract::Result,
    store::{hash, read_bounded, Store},
};
use rusqlite::{params, Connection};
use std::{fs, io::Write, path::PathBuf};

// Match the accepted source-image upload limit, including full-page references.
pub const LIMIT: usize = 25 * 1024 * 1024;
pub const SCHEMA: &str = "CREATE TABLE assets(hash TEXT PRIMARY KEY,media TEXT NOT NULL,size INTEGER NOT NULL,path TEXT NOT NULL);";
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}
impl Store {
    pub fn asset_path(&self, digest: &str) -> Result<PathBuf> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(crate::language::error(
                "LOCAL_ASSET_HASH_INVALID",
                serde_json::json!({}),
            ));
        }
        let root = self.dir.join("assets");
        fs::create_dir_all(&root).map_err(err)?;
        if fs::symlink_metadata(&root)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err(crate::language::error(
                "LOCAL_ASSET_DIRECTORY_LINK",
                serde_json::json!({}),
            ));
        }
        Ok(root.join(digest))
    }
    pub fn write_asset(&self, digest: &str, bytes: &[u8]) -> Result<()> {
        if bytes.len() > LIMIT || hash(bytes) != digest {
            return Err(crate::language::error(
                "LOCAL_ASSET_CHECKSUM_MISMATCH",
                serde_json::json!({}),
            ));
        }
        let path = self.asset_path(digest)?;
        if path.exists() {
            self.read_asset(digest, bytes.len() as u64)?;
            return Ok(());
        }
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or(
            crate::language::error("LOCAL_ASSET_DIRECTORY_INVALID", serde_json::json!({})),
        )?)
        .map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.as_file().sync_all().map_err(err)?;
        file.persist_noclobber(&path).map_err(err)?;
        fs::File::open(path.parent().ok_or(crate::language::error(
            "LOCAL_ASSET_DIRECTORY_INVALID",
            serde_json::json!({}),
        ))?)
        .map_err(err)?
        .sync_all()
        .map_err(err)?;
        Ok(())
    }
    pub fn read_asset(&self, digest: &str, size: u64) -> Result<Vec<u8>> {
        let path = self.asset_path(digest)?;
        if fs::symlink_metadata(&path)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err(crate::language::error(
                "LOCAL_ASSET_LINK",
                serde_json::json!({}),
            ));
        }
        let bytes = read_bounded(&path, LIMIT)?;
        if bytes.len() as u64 != size || hash(&bytes) != digest {
            return Err(crate::language::error(
                "LOCAL_ASSET_MISSING",
                serde_json::json!({}),
            ));
        }
        Ok(bytes)
    }
    pub fn migrate_assets(&self, db: &mut Connection) -> Result<()> {
        let recovery = self.dir.join("recoveries");
        fs::create_dir_all(&recovery).map_err(err)?;
        let backup = recovery.join(format!("before-assets-{}.sqlite", crate::store::id()));
        db.backup(rusqlite::MAIN_DB, &backup, None).map_err(err)?;
        let mut assets = Vec::new();
        {
            let mut statement = db
                .prepare("SELECT hash,media,data FROM assets")
                .map_err(err)?;
            let mut rows = statement.query([]).map_err(err)?;
            while let Some(row) = rows.next().map_err(err)? {
                let digest: String = row.get(0).map_err(err)?;
                let media: String = row.get(1).map_err(err)?;
                let bytes: Vec<u8> = row.get(2).map_err(err)?;
                if !crate::store::image_signature(&bytes, &media) {
                    return Err(crate::language::error(
                        "LOCAL_LEGACY_IMAGE_INVALID",
                        serde_json::json!({}),
                    ));
                }
                self.write_asset(&digest, &bytes)?;
                assets.push((digest, media, bytes.len()));
            }
        }
        let tx = db.transaction().map_err(err)?;
        tx.execute_batch("ALTER TABLE assets RENAME TO old_assets;")
            .map_err(err)?;
        tx.execute_batch(SCHEMA).map_err(err)?;
        for (digest, media, size) in assets {
            tx.execute(
                "INSERT INTO assets VALUES(?1,?2,?3,?4)",
                params![digest, media, size, format!("assets/{digest}")],
            )
            .map_err(err)?;
        }
        tx.execute_batch("DROP TABLE old_assets; PRAGMA user_version=3;")
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
}
