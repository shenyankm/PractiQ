use crate::{
    contract::Result,
    store::{hash, read_bounded, Store},
};
use std::{fs, io::Write, path::PathBuf};

// Match the accepted source-image upload limit, including full-page references.
pub const LIMIT: usize = 25 * 1024 * 1024;
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
}
