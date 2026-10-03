use crate::{
    contract::Result,
    store::{hash, read_bounded, Store},
};
use std::{collections::HashSet, fs, io::Write, path::PathBuf};

// Match the accepted source-image upload limit, including full-page references.
pub const LIMIT: usize = 25 * 1024 * 1024;
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}

impl Store {
    pub fn collect_unused_assets(&self) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute(
            "DELETE FROM visuals WHERE document_level=0 AND NOT EXISTS(SELECT 1 FROM question_visuals WHERE visual_id=visuals.id)",
            [],
        )
        .map_err(err)?;
        let hashes = tx
            .prepare("SELECT hash FROM assets")
            .map_err(err)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let mut used = HashSet::new();
        if !hashes.is_empty() {
            let mut stmt = tx.prepare("WITH refs(visual) AS (SELECT content FROM visuals UNION ALL SELECT value FROM session_documents, json_each(session_documents.content,'$.visuals')) SELECT json_extract(visual,'$.imageRef.sha256'),json_extract(visual,'$.sourceRef.sha256') FROM refs").map_err(err)?;
            let visuals = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                    ))
                })
                .map_err(err)?;
            for visual in visuals {
                let (image, source) = visual.map_err(err)?;
                used.extend(image.into_iter().chain(source));
            }
        }
        let has_audio: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE media NOT IN ('image/png','image/jpeg'))",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        if has_audio {
            let mut statement=tx.prepare("SELECT json_extract(audio_ref,'$.sha256') FROM listening_questions UNION SELECT json_extract(value,'$.question.audioRef.sha256') FROM session_documents,json_each(session_documents.content,'$.questions')").map_err(err)?;
            for digest in statement
                .query_map([], |r| r.get::<_, Option<String>>(0))
                .map_err(err)?
            {
                if let Some(digest) = digest.map_err(err)? {
                    used.insert(digest);
                }
            }
            drop(statement);
        }
        for digest in &hashes {
            if !used.contains(digest) {
                tx.execute("DELETE FROM assets WHERE hash=?1", [digest])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
        let live: HashSet<_> = hashes
            .into_iter()
            .filter(|hash| used.contains(hash))
            .collect();
        let root = self.dir.join("assets");
        if !root.exists() {
            return Ok(());
        }
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
        for entry in fs::read_dir(root).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.len() == 64
                && name
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                && !live.contains(name.as_ref())
            {
                fs::remove_file(entry.path()).map_err(err)?;
            }
        }
        Ok(())
    }
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
        crate::filesystem::persist(file, &path, false).map_err(err)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn image_only_collection_skips_audio_content_and_preserves_snapshot_audio_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let image = include_bytes!("../../fixtures/rich-content/resources/chart.png");
        let image_hash = hash(image);
        store.write_asset(&image_hash, image).unwrap();
        let db = store.connect().unwrap();
        db.execute(
            "INSERT INTO assets VALUES(?1,'image/png',?2,?3)",
            params![image_hash, image.len(), format!("assets/{image_hash}")],
        )
        .unwrap();
        db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES('snapshot','bank',0,0,'all')", []).unwrap();
        // Cleanup extracts resource references, not question content; only an audio scan would
        // attempt json_extract on this string. Full restore still validates every snapshot.
        let mut document = json!({"visuals":[{"imageRef":{"sha256":image_hash}}],"questions":["content without audio"]});
        db.execute(
            "INSERT INTO session_documents VALUES('snapshot',?1)",
            [document.to_string()],
        )
        .unwrap();
        store.collect_unused_assets().unwrap();
        assert!(store.asset_bytes(&image_hash).unwrap().is_some());

        let audio = include_bytes!("../../fixtures/resources/audio/chimes.wav");
        let audio_hash = hash(audio);
        store.write_asset(&audio_hash, audio).unwrap();
        db.execute(
            "INSERT INTO assets VALUES(?1,'audio/wav',?2,?3)",
            params![audio_hash, audio.len(), format!("assets/{audio_hash}")],
        )
        .unwrap();
        document["questions"] = json!([{"question":{"audioRef":{"sha256":audio_hash}}}]);
        db.execute(
            "UPDATE session_documents SET content=?1 WHERE session_id='snapshot'",
            [document.to_string()],
        )
        .unwrap();
        store.collect_unused_assets().unwrap();
        assert!(store.asset_bytes(&audio_hash).unwrap().is_some());
        document["questions"] = json!([]);
        db.execute(
            "UPDATE session_documents SET content=?1 WHERE session_id='snapshot'",
            [document.to_string()],
        )
        .unwrap();
        store.collect_unused_assets().unwrap();
        assert!(store.asset_bytes(&audio_hash).unwrap().is_none());
        assert!(store.asset_bytes(&image_hash).unwrap().is_some());
    }
}
