use crate::{
    contract::{self, list, text, Result},
    store::{self, Pending, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const ZIP_LIMIT: u64 = 300 * 1024 * 1024;
const IMAGE_LIMIT: usize = 256 * 1024 * 1024;
const MANIFEST_LIMIT: usize = 64 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    bank: Bank,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bank {
    title: String,
    description: String,
}
fn error(detail: impl std::fmt::Display) -> crate::AppError {
    crate::language::error(
        "LOCAL_BANK_ZIP_INVALID",
        json!({"detail":detail.to_string()}),
    )
}
fn read_entry(archive: &mut ZipArchive<fs::File>, name: &str, limit: usize) -> Result<Vec<u8>> {
    let file = archive.by_name(name).map_err(error)?;
    if file.size() > limit as u64 {
        return Err(error("Entry exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > limit {
        return Err(error("Entry exceeds size limit"));
    }
    Ok(bytes)
}
fn references(root: &Value) -> Result<BTreeMap<String, Value>> {
    let mut refs = BTreeMap::new();
    for reference in list(contract::result(root), "visualElements")
        .iter()
        .flat_map(contract::visual_refs)
    {
        let key = text(reference, "objectKey");
        if key.is_empty()
            || key.contains('\\')
            || key
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
            || Path::new(key).is_absolute()
        {
            return Err(error("Unsafe image path"));
        }
        let name = format!("resources/{key}");
        if refs.get(&name).is_some_and(|old| old != reference) {
            return Err(error("Conflicting image references"));
        }
        refs.insert(name, reference.clone());
    }
    Ok(refs)
}
fn verify_image(reference: &Value, bytes: &[u8]) -> Result<()> {
    if bytes.len() > crate::assets::LIMIT
        || reference["sizeBytes"] != bytes.len()
        || store::hash(bytes) != text(reference, "sha256")
        || !store::image_signature(bytes, text(reference, "mediaType"))
    {
        return Err(error(format!(
            "Invalid or missing image: {}",
            text(reference, "objectKey")
        )));
    }
    Ok(())
}
pub fn filename(title: &str) -> String {
    let clean: String = title
        .chars()
        .take(100)
        .map(|c| {
            if c.is_control() || "/\\:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim().trim_matches('.');
    format!(
        "{}.zip",
        if clean.is_empty() {
            "PractiQ-bank"
        } else {
            clean
        }
    )
}
impl Store {
    pub fn preview_bank_zip(&mut self, source: &Path) -> Result<Value> {
        let file = fs::File::open(source).map_err(error)?;
        if file.metadata().map_err(error)?.len() > ZIP_LIMIT {
            return Err(error("ZIP exceeds 300 MiB"));
        }
        let mut archive = ZipArchive::new(file).map_err(error)?;
        if archive.len() > 2002 {
            return Err(error("Too many ZIP entries"));
        }
        let mut names = HashSet::new();
        let mut total = 0u64;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(error)?;
            let name = entry.name();
            if entry.is_dir()
                || name.contains('\\')
                || name
                    .split('/')
                    .any(|v| v.is_empty() || v == "." || v == "..")
                || !names.insert(name.to_owned())
                || entry
                    .unix_mode()
                    .is_some_and(|m| m & 0o170000 != 0 && m & 0o170000 != 0o100000)
            {
                return Err(error("Unsafe or duplicate ZIP entry"));
            }
            total = total
                .checked_add(entry.size())
                .ok_or_else(|| error("ZIP size overflow"))?;
            if total > (contract::MAX_JSON + IMAGE_LIMIT + MANIFEST_LIMIT) as u64 {
                return Err(error("Expanded ZIP exceeds size limit"));
            }
        }
        let raw = read_entry(&mut archive, "manifest.json", MANIFEST_LIMIT)?;
        let value: Value = serde_json::from_slice(&raw).map_err(error)?;
        if value["format"] == "practiq-backup" {
            return Err(crate::language::error(
                "LOCAL_USE_BACKUP_RESTORE",
                json!({}),
            ));
        }
        let manifest: Manifest = serde_json::from_value(value).map_err(error)?;
        if manifest.format != "practiq-question-bank"
            || manifest.version != 1
            || manifest.bank.title.trim().is_empty()
            || manifest.bank.title.chars().count() > 255
            || manifest.bank.description.chars().count() > 20_000
        {
            return Err(error("Unsupported package or invalid bank metadata"));
        }
        let mut pending = Pending::new(
            read_entry(&mut archive, "questions.json", contract::MAX_JSON)?,
            manifest.bank.title,
        )?;
        pending.description = manifest.bank.description;
        let refs = references(&pending.root)?;
        let allowed: HashSet<_> = refs
            .keys()
            .cloned()
            .chain(["manifest.json".into(), "questions.json".into()])
            .collect();
        if names != allowed {
            return Err(error("Missing or undeclared ZIP files"));
        }
        let mut total = 0;
        for (name, reference) in refs {
            let bytes = read_entry(&mut archive, &name, crate::assets::LIMIT)?;
            total += bytes.len();
            if total > IMAGE_LIMIT {
                return Err(error("Images exceed 256 MiB"));
            }
            verify_image(&reference, &bytes)?;
            pending.assets.insert(
                text(&reference, "sha256").into(),
                (text(&reference, "mediaType").into(), bytes),
            );
        }
        pending.missing.clear();
        self.pending = Some(pending);
        self.preview_value()
    }
    pub fn export_bank(&self, bank_id: &str, destination: &Path) -> Result<Value> {
        // One read transaction freezes the bank metadata and content for the package.
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(error)?;
        let bank = tx
            .query_row(
                "SELECT title,description FROM banks WHERE id=?1",
                [bank_id],
                |r| {
                    Ok(Bank {
                        title: r.get(0)?,
                        description: r.get(1)?,
                    })
                },
            )
            .map_err(error)?;
        let rows = crate::questions::read_scoped(&tx, &[bank_id.to_owned()], None)?;
        let frozen = crate::questions::freeze(&rows);
        let clean = |key: &str| -> Vec<Value> {
            list(&frozen, key)
                .iter()
                .map(|item| {
                    let mut v = item.clone();
                    v.as_object_mut().unwrap().remove("id");
                    v
                })
                .collect()
        };
        let warnings = tx.prepare("SELECT w.message FROM import_warnings w JOIN imports i ON i.id=w.import_id WHERE i.bank_id=?1 ORDER BY i.created_at,w.position").map_err(error)?.query_map([bank_id],|r|r.get::<_,String>(0)).map_err(error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(error)?;
        let root = json!({"schemaVersion":2,"questions":rows.iter().map(|r|r["question"].clone()).collect::<Vec<_>>(),"groups":clean("groups"),"visualElements":clean("visuals"),"warnings":warnings,"confidenceScore":rows.iter().map(|r|r["question"]["confidence"].as_f64().unwrap_or(0.0)).fold(1.0,f64::min)*100.0});
        let bytes = serde_json::to_vec(&root).map_err(error)?;
        contract::parse(&bytes)?;
        let refs = references(&root)?;
        let manifest = serde_json::to_vec(&Manifest {
            format: "practiq-question-bank".into(),
            version: 1,
            bank,
        })
        .map_err(error)?;
        if manifest.len() > MANIFEST_LIMIT {
            return Err(error("Manifest exceeds size limit"));
        }
        let mut output = tempfile::NamedTempFile::new_in(
            destination
                .parent()
                .ok_or_else(|| error("Invalid destination"))?,
        )
        .map_err(error)?;
        {
            let mut zip = ZipWriter::new(output.as_file_mut());
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, data) in [
                ("manifest.json", manifest.as_slice()),
                ("questions.json", bytes.as_slice()),
            ] {
                zip.start_file(name, options).map_err(error)?;
                zip.write_all(data).map_err(error)?;
            }
            let mut total = 0;
            for (name, reference) in refs {
                let data = self
                    .read_asset(
                        text(&reference, "sha256"),
                        reference["sizeBytes"]
                            .as_u64()
                            .ok_or_else(|| error("Invalid image size"))?,
                    )
                    .map_err(|_| {
                        error(format!(
                            "Missing or damaged image: {}",
                            text(&reference, "objectKey")
                        ))
                    })?;
                verify_image(&reference, &data)?;
                total += data.len();
                if total > IMAGE_LIMIT {
                    return Err(error("Images exceed 256 MiB"));
                }
                zip.start_file(name, options).map_err(error)?;
                zip.write_all(&data).map_err(error)?;
            }
            zip.finish().map_err(error)?;
        }
        tx.commit().map_err(error)?;
        if output.as_file().metadata().map_err(error)?.len() > ZIP_LIMIT {
            return Err(error("ZIP exceeds 300 MiB"));
        }
        output.as_file().sync_all().map_err(error)?;
        output.persist_noclobber(destination).map_err(error)?;
        Ok(json!({"path":destination.display().to_string()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample_store() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::new(dir.path().into()).unwrap();
        let p = s
            .preview(
                include_bytes!("../../fixtures/sample.json").to_vec(),
                "Shared".into(),
            )
            .unwrap();
        s.resources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources"))
            .unwrap();
        let id = s.import(text(&p, "ticket"), None, "Shared").unwrap()["bankId"]
            .as_str()
            .unwrap()
            .to_owned();
        (dir, s, id)
    }
    #[test]
    fn roundtrip_shares_content_only_and_repairs_duplicate_images() {
        let (dir, s, bank) = sample_store();
        s.save_bank(Some(bank.clone()), "Shared", "Description")
            .unwrap();
        let rows = s.questions(Some(&bank), "", "", "").unwrap();
        s.favorite(text(&rows[0], "id"), true).unwrap();
        let id = text(&rows[4], "id").to_owned();
        let selected =
            crate::paper::selected_rows(&s.question_rows().unwrap(), std::slice::from_ref(&id))
                .unwrap();
        let session = s
            .start_paper(crate::exams::Paper {
                question_ids: vec![id],
                kind: "self_test".into(),
                minutes: None,
                scores: vec![100],
                total_cents: 100,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        s.save_draft(
            (sid, 0),
            json!({"text":"PERSONAL_ANSWER_NOT_FOR_SHARING"}),
            0,
        )
        .unwrap();
        s.submit_paper(sid, true).unwrap();
        s.manual_score(sid, 0, 50, "PERSONAL_GRADING_REASON")
            .unwrap();
        s.connect()
            .unwrap()
            .execute(
                "UPDATE settings SET base_url='https://private.example/v1' WHERE id=1",
                [],
            )
            .unwrap();
        let path = dir.path().join("bank.zip");
        s.export_bank(&bank, &path).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(s.export_bank(&bank, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let other = tempfile::tempdir().unwrap();
        let mut imported = Store::new(other.path().into()).unwrap();
        // First import without resources, then repair with the complete ZIP.
        let mut zip = ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
        let raw = read_entry(&mut zip, "questions.json", contract::MAX_JSON).unwrap();
        let shared = String::from_utf8(raw.clone()).unwrap();
        for private in [
            "PERSONAL_ANSWER_NOT_FOR_SHARING",
            "PERSONAL_GRADING_REASON",
            "private.example",
            "favorite",
            "latestResult",
        ] {
            assert!(!shared.contains(private));
        }

        let p = imported.preview(raw, "Without images".into()).unwrap();
        let target = imported
            .import(text(&p, "ticket"), None, "Existing")
            .unwrap()["bankId"]
            .as_str()
            .unwrap()
            .to_owned();
        let p = imported.preview_bank_zip(&path).unwrap();
        assert_eq!(p["assetCount"], 1);
        let receipt = imported
            .import(text(&p, "ticket"), Some(target.clone()), "Ignored")
            .unwrap();
        assert_eq!(receipt["duplicate"], true);
        let hash = p["visuals"][0]["imageRef"]["sha256"].as_str().unwrap();
        assert!(!imported.asset(hash).unwrap().is_null());
        assert_eq!(imported.banks().unwrap()[0]["title"], "Existing");
        assert_eq!(
            imported
                .questions(Some(&target), "", "", "")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            9
        );
        let backup = other.path().join("backup.zip");
        imported.backup(&backup).unwrap();
        let fresh = tempfile::tempdir().unwrap();
        let mut restored = Store::new(fresh.path().into()).unwrap();
        restored.restore(&backup).unwrap();
        assert!(!restored.asset(hash).unwrap().is_null());
        assert!(restored.preview_bank_zip(&backup).unwrap_err().code == "LOCAL_USE_BACKUP_RESTORE");
        assert!(restored.restore(&path).unwrap_err().code == "LOCAL_USE_BANK_IMPORT");
        let p = restored.preview_bank_zip(&path).unwrap();
        let new = restored.import(text(&p, "ticket"), None, "Shared").unwrap();
        let rows = restored
            .questions(new["bankId"].as_str(), "", "", "")
            .unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["favorite"] == false && r["latestResult"].is_null()));
        let meta = restored.banks_page(30, 0).unwrap()["items"].clone();
        assert!(meta
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["title"] == "Shared" && b["description"] == "Description"));
        assert_eq!(restored.sessions(30, 0).unwrap()["items"], json!([]));
        // Image integrity is checked before publication; existing files survive failures.
        fs::remove_file(s.asset_path(hash).unwrap()).unwrap();
        assert!(s
            .export_bank(&bank, &dir.path().join("missing.zip"))
            .is_err());
        assert!(!dir.path().join("missing.zip").exists());
        assert_eq!(fs::read(path).unwrap(), before);
    }
    #[test]
    fn packaged_examples_are_ready_for_offline_import() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::new(dir.path().into()).unwrap();
        for name in ["sample", "composite"] {
            let path =
                Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../fixtures/{name}.zip"));
            let p = s.preview_bank_zip(&path).unwrap();
            assert!(list(&p, "missingAssets").is_empty());
            s.import(text(&p, "ticket"), None, name).unwrap();
        }
        assert_eq!(s.banks().unwrap().as_array().unwrap().len(), 2);
    }
    #[test]
    fn imports_into_existing_database_with_early_schema_nine_layout() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::new(dir.path().into()).unwrap();
        s.connect()
            .unwrap()
            .execute_batch("ALTER TABLE imports ADD COLUMN raw TEXT NOT NULL DEFAULT ''; ALTER TABLE visuals DROP COLUMN document_level;")
            .unwrap();
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/sample.zip");
        let p = s.preview_bank_zip(&path).unwrap();
        let bank = s.import(text(&p, "ticket"), None, "Legacy").unwrap();
        assert_eq!(bank["count"], 9);
        assert_eq!(
            s.connect()
                .unwrap()
                .query_row("SELECT raw FROM imports", [], |r| r.get::<_, String>(0))
                .unwrap(),
            ""
        );
    }
    #[test]
    fn composite_roundtrip_preserves_contract_and_reference_graph() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Store::new(dir.path().into()).unwrap();
        let raw = include_bytes!("../../fixtures/composite.json");
        let p = s.preview(raw.to_vec(), "Composite".into()).unwrap();
        let bank = s.import(text(&p, "ticket"), None, "Composite").unwrap();
        let file = dir.path().join("composite.zip");
        s.export_bank(text(&bank, "bankId"), &file).unwrap();
        let p = s.preview_bank_zip(&file).unwrap();
        let original = contract::parse(raw).unwrap();
        assert_eq!(
            list(&p, "questions").len(),
            list(&original, "questions").len()
        );
        let imported = s.import(text(&p, "ticket"), None, "Copy").unwrap();
        let rows = s
            .questions(imported["bankId"].as_str(), "", "", "")
            .unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .any(|r| !list(r, "children").is_empty()));
    }
    #[test]
    fn rejects_corrupt_unlisted_and_oversized_packages_without_changes() {
        let (dir, mut s, bank) = sample_store();
        let original = dir.path().join("good.zip");
        s.export_bank(&bank, &original).unwrap();
        let mut zip = ZipArchive::new(fs::File::open(&original).unwrap()).unwrap();
        let entries: Vec<_> = (0..zip.len())
            .map(|i| {
                let mut entry = zip.by_index(i).unwrap();
                let name = entry.name().to_owned();
                let mut data = Vec::new();
                entry.read_to_end(&mut data).unwrap();
                (name, data)
            })
            .collect();
        let before = s.banks().unwrap();
        for case in [
            "traversal",
            "extra",
            "checksum",
            "missing",
            "version",
            "oversize",
            "symlink",
            "truncated",
        ] {
            let path = dir.path().join(format!("{case}.zip"));
            let mut writer = ZipWriter::new(fs::File::create(&path).unwrap());
            for (name, bytes) in &entries {
                if case == "missing" && name.starts_with("resources/") {
                    continue;
                }
                if case == "symlink" && name.starts_with("resources/") {
                    writer
                        .add_symlink(name, "/tmp/outside", SimpleFileOptions::default())
                        .unwrap();
                    continue;
                }
                writer
                    .start_file(
                        name,
                        SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated),
                    )
                    .unwrap();
                if case == "checksum" && name.starts_with("resources/") {
                    writer.write_all(b"invalid").unwrap();
                } else if case == "oversize" && name == "manifest.json" {
                    writer.write_all(&vec![0; MANIFEST_LIMIT + 1]).unwrap();
                } else if case == "version" && name == "manifest.json" {
                    writer.write_all(b"{\"format\":\"practiq-question-bank\",\"version\":99,\"bank\":{\"title\":\"x\",\"description\":\"\"}}").unwrap();
                } else {
                    writer.write_all(bytes).unwrap();
                }
            }
            if case == "extra" || case == "traversal" {
                writer
                    .start_file(
                        if case == "extra" {
                            "extra"
                        } else {
                            "../escape"
                        },
                        SimpleFileOptions::default(),
                    )
                    .unwrap();
            }
            writer.finish().unwrap();
            if case == "truncated" {
                fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_len(12)
                    .unwrap();
            }
            assert!(s.preview_bank_zip(&path).is_err(), "{case}");
            assert_eq!(s.banks().unwrap(), before);
        }
        let duplicate = dir.path().join("duplicate.zip");
        let mut writer = ZipWriter::new(fs::File::create(&duplicate).unwrap());
        for name in ["a", "b"] {
            writer
                .start_file(
                    name,
                    SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
        }
        writer.finish().unwrap();
        let mut bytes = fs::read(&duplicate).unwrap();
        for byte in &mut bytes {
            if *byte == b'b' {
                *byte = b'a';
            }
        }
        fs::write(&duplicate, bytes).unwrap();
        assert!(s.preview_bank_zip(&duplicate).is_err());
        let enormous = dir.path().join("huge.zip");
        fs::File::create(&enormous)
            .unwrap()
            .set_len(ZIP_LIMIT + 1)
            .unwrap();
        assert!(s.preview_bank_zip(&enormous).is_err());
        assert!(s
            .export_bank(&bank, &dir.path().join("absent/file.zip"))
            .is_err());
        assert_eq!(filename("../bad/name"), "_bad_name.zip");
    }
}
