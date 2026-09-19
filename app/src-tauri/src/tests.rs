use crate::{
    contract::{self, list, text},
    store::Store,
};
use serde_json::{json, Value};
fn sample() -> Vec<u8> {
    include_bytes!("../../fixtures/sample.json").to_vec()
}
fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().to_owned()).unwrap();
    (dir, store)
}
fn import(store: &mut Store) -> String {
    let preview = store.preview(sample(), "示例题库".into()).unwrap();
    let imported = store
        .import(text(&preview, "ticket"), None, "示例题库")
        .unwrap();
    text(&imported, "bankId").into()
}
#[test]
fn shared_contract_corpus() {
    let cases: Value = serde_json::from_str(include_str!("../../fixtures/contracts.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let parsed = contract::parse(&serde_json::to_vec(&case["input"]).unwrap());
        assert_eq!(
            parsed.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {:?}",
            case["name"],
            parsed.as_ref().err()
        );
        if let Ok(root) = parsed {
            assert_eq!(
                root["questions"][0]["missingFields"], case["missingFields"],
                "{}",
                case["name"]
            );
        }
    }
    let raw: Value = serde_json::from_slice(&sample()).unwrap();
    let envelope = json!({"status":"PARTIAL","result":raw});
    assert!(contract::parse(&serde_json::to_vec(&envelope).unwrap()).is_ok());
    let mut legacy = envelope.clone();
    legacy["result"]["visualElements"][0]["excelSource"] = json!({"sheetName":"Old export"});
    assert!(contract::parse(&serde_json::to_vec(&legacy).unwrap()).is_ok());
    // Source metadata in old Word exports is not a new document-parsing request.
    legacy["document"] = json!({"sourceType":"docx","fileName":"old.docx"});
    let (_, mut store) = store();
    let preview = store
        .preview(serde_json::to_vec(&legacy).unwrap(), "旧 Word 题库".into())
        .unwrap();
    assert_eq!(preview["count"], raw["questions"].as_array().unwrap().len());
    let mut bad = envelope;
    bad["result"]["groups"][0]["questionIndexes"] = json!([999]);
    assert!(contract::parse(&serde_json::to_vec(&bad).unwrap()).is_err());
}
#[test]
fn grading_all_modes_and_partial_results() {
    let root = contract::parse(&sample()).unwrap();
    let qs = list(&root, "questions");
    for (i, q) in qs.iter().enumerate() {
        let expected = if i == 4 || i == 8 { None } else { Some(true) };
        assert_eq!(
            contract::grade(q, &q["answerPayload"]),
            expected,
            "question {i}"
        );
    }
    assert_eq!(
        contract::grade(&qs[1], &json!({"correct":["C","A"]})),
        Some(true)
    );
    assert_eq!(
        contract::grade(&qs[1], &json!({"correct":["A"]})),
        Some(false)
    );
    assert_eq!(
        contract::grade(&qs[3], &json!({"answers":[" 北京 "]})),
        Some(true)
    );
    assert_eq!(
        contract::grade(&qs[3], &json!({"answers":["北 京"]})),
        Some(false)
    );
    assert_eq!(
        contract::grade(&qs[5], &json!({"order":[0,1,2]})),
        Some(false)
    );
    let mut missing = qs[0].clone();
    missing["missingFields"] = json!(["material"]);
    assert_eq!(contract::grade(&missing, &missing["answerPayload"]), None);
}
#[test]
fn transactional_import_resume_snapshot_and_latest_wrong() {
    let (_dir, mut s) = store();
    let bank = import(&mut s);
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    assert_eq!(qs.as_array().unwrap().len(), 9);
    let p = s.preview(sample(), "duplicate".into()).unwrap();
    assert_eq!(
        s.import(text(&p, "ticket"), Some(bank.clone()), "same")
            .unwrap()["duplicate"],
        true
    );
    let session = s.start(Some(&bank), "", "choice", "", false, 1).unwrap();
    let sid = text(&session, "id");
    s.save_attempt(
        (sid, 0),
        json!({"correctOption":"B"}),
        1000,
        false,
        false,
        None,
    )
    .unwrap();
    let resumed = Store::new(s.dir.clone()).unwrap().session(sid).unwrap();
    assert_eq!(resumed["attempts"][0]["answer"]["correctOption"], "B");
    s.save_attempt(
        (sid, 0),
        json!({"correctOption":"B"}),
        1000,
        true,
        false,
        None,
    )
    .unwrap();
    s.save_attempt(
        (sid, 0),
        json!({"correctOption":"A"}),
        1000,
        true,
        false,
        None,
    )
    .unwrap();
    assert_eq!(
        s.session(sid).unwrap()["attempts"][0]["result"],
        false,
        "submission is idempotent"
    );
    assert_eq!(
        s.questions(Some(&bank), "", "", "wrong")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let retry = s
        .start(Some(&bank), "", "choice", "wrong", true, 1)
        .unwrap();
    s.save_attempt(
        (text(&retry, "id"), 0),
        json!({"correctOption":"A"}),
        0,
        true,
        false,
        None,
    )
    .unwrap();
    assert_eq!(
        s.questions(Some(&bank), "", "", "wrong")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let first = &qs[0];
    let mut q = first["question"].clone();
    q["stem"] = json!("edited");
    s.save_question(Some(text(first, "id").into()), &bank, q)
        .unwrap();
    assert_ne!(
        s.session(sid).unwrap()["attempts"][0]["snapshot"]["question"]["stem"],
        "edited"
    );
    s.delete_bank(&bank).unwrap();
    assert!(s.banks().unwrap().as_array().unwrap().is_empty());
    assert_eq!(
        s.session(sid).unwrap()["attempts"][0]["answer"]["correctOption"],
        "B"
    );
}
#[test]
fn assets_backup_restore_and_failed_restore_preserve_data() {
    let (dir, mut s) = store();
    let preview = s.preview(sample(), "示例".into()).unwrap();
    s.resources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources"))
        .unwrap();
    let bank = text(
        &s.import(text(&preview, "ticket"), None, "示例").unwrap(),
        "bankId",
    )
    .to_owned();
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    assert_eq!(qs[8]["missingAssets"], false);
    let digest = text(&qs[8]["visuals"][0]["imageRef"], "sha256");
    assert!(s
        .asset(digest)
        .unwrap()
        .as_str()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    let session = s.start(Some(&bank), "", "", "", true, 9).unwrap();
    let sid = text(&session, "id");
    s.finish(sid).unwrap();
    assert_eq!(s.position(sid, 5).unwrap()["position"], 5);
    let backup = dir.path().join("saved.zip");
    s.backup(&backup).unwrap();
    s.delete_bank(&bank).unwrap();
    let recovery = s.restore(&backup).unwrap();
    assert!(std::path::Path::new(text(&recovery, "recoveryPath")).exists());
    assert_eq!(s.banks().unwrap()[0]["count"], 9);
    assert_eq!(
        s.session(sid).unwrap()["attempts"]
            .as_array()
            .unwrap()
            .len(),
        9
    );
    std::fs::write(dir.path().join("invalid.zip"), b"invalid").unwrap();
    assert!(s.restore(&dir.path().join("invalid.zip")).is_err());
    assert_eq!(s.banks().unwrap()[0]["count"], 9);
}
#[test]
fn malformed_import_rolls_back_and_resources_cannot_escape() {
    let (_dir, mut s) = store();
    let mut root: Value = serde_json::from_slice(&sample()).unwrap();
    root["questions"][1]["options"][0]["label"] = json!("C");
    assert!(s
        .preview(serde_json::to_vec(&root).unwrap(), "bad".into())
        .is_err());
    assert_eq!(s.banks().unwrap(), json!([]));
    let mut root: Value = serde_json::from_slice(&sample()).unwrap();
    root["visualElements"][0]["imageRef"]["objectKey"] = json!("../outside.png");
    s.preview(serde_json::to_vec(&root).unwrap(), "escape".into())
        .unwrap();
    assert!(s.resources(&s.dir.clone()).is_err());
    let root: Value = serde_json::from_slice(&sample()).unwrap();
    s.preview(serde_json::to_vec(&root).unwrap(), "broken".into())
        .unwrap();
    let key = text(&root["visualElements"][0]["imageRef"], "objectKey");
    let path = s.dir.join(key);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"wrong checksum").unwrap();
    assert!(s.resources(&s.dir.clone()).is_err());
}
#[test]
fn self_grade_preserves_auto_result_and_ungraded_denominator() {
    let (_dir, mut s) = store();
    let bank = import(&mut s);
    let session = s
        .start(Some(&bank), "", "fill_blank", "", false, 1)
        .unwrap();
    let sid = text(&session, "id");
    s.save_attempt(
        (sid, 0),
        json!({"answers":["北京城"]}),
        0,
        true,
        false,
        None,
    )
    .unwrap();
    let v = s
        .save_attempt((sid, 0), json!({}), 0, true, false, Some(true))
        .unwrap();
    assert_eq!(v["attempts"][0]["result"], true);
    assert_eq!(v["attempts"][0]["autoResult"], false);
    assert_eq!(v["attempts"][0]["answer"]["answers"][0], "北京城");
    let subjective = s
        .start(Some(&bank), "", "short_answer", "", false, 2)
        .unwrap();
    s.save_attempt(
        (text(&subjective, "id"), 0),
        json!({"text":"my answer"}),
        0,
        true,
        false,
        None,
    )
    .unwrap();
    s.finish(text(&subjective, "id")).unwrap();
    let summaries = s.sessions().unwrap();
    let summary = summaries
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == subjective["id"])
        .unwrap();
    assert_eq!(summary["graded"], 0);
    assert_eq!(summary["skipped"], 1);
}

#[test]
fn version_one_backup_migrates_and_malicious_packages_do_not_replace_data() {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};
    let (dir, mut s) = store();
    let bank = import(&mut s);
    let old = dir.path().join("old.sqlite");
    let db = rusqlite::Connection::open(&old).unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    db.close().unwrap();
    let bytes = std::fs::read(old).unwrap();
    let archive = dir.path().join("v1.zip");
    {
        let mut zip = ZipWriter::new(std::fs::File::create(&archive).unwrap());
        let options = SimpleFileOptions::default();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(json!({"format":"practiq-backup","version":1,"schemaVersion":1,"database":{"sha256":crate::store::hash(&bytes),"sizeBytes":bytes.len()}}).to_string().as_bytes()).unwrap();
        zip.start_file("practiq.sqlite", options).unwrap();
        zip.write_all(&bytes).unwrap();
        zip.finish().unwrap();
    }
    s.restore(&archive).unwrap();
    assert_eq!(
        s.connect()
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert!(s.connection_settings().unwrap().base_url.is_none());
    let bank = s.save_bank(None, &bank, "").unwrap();
    let malicious = dir.path().join("malicious.zip");
    {
        let mut zip = ZipWriter::new(std::fs::File::create(&malicious).unwrap());
        zip.start_file("../practiq.sqlite", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"escape").unwrap();
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
    }
    assert!(s.restore(&malicious).is_err());
    assert_eq!(s.banks().unwrap()[0]["id"], bank);
}

#[test]
fn stale_edits_and_deleted_import_targets_are_rejected() {
    let (_dir, mut s) = store();
    let bank = import(&mut s);
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    let q = &qs[0];
    s.delete_question(text(q, "id")).unwrap();
    assert!(s
        .save_question(Some(text(q, "id").into()), &bank, q["question"].clone())
        .is_err());
    let preview = s.preview(sample(), "stale".into()).unwrap();
    s.delete_bank(&bank).unwrap();
    assert!(s
        .import(text(&preview, "ticket"), Some(bank), "stale")
        .is_err());
    assert!(s.banks().unwrap().as_array().unwrap().is_empty());
}

#[test]
fn file_assets_migrate_and_corruption_does_not_replace_database() {
    use rusqlite::{params, Connection};
    let dir = tempfile::tempdir().unwrap();
    let db = Connection::open(dir.path().join("practiq.sqlite")).unwrap();
    db.execute_batch(include_str!("schema.sql")).unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nlegacy-image";
    let digest = crate::store::hash(bytes);
    db.execute(
        "INSERT INTO assets VALUES(?1,'image/png',?2)",
        params![digest, bytes.as_slice()],
    )
    .unwrap();
    drop(db);
    let mut s = Store::new(dir.path().to_owned()).unwrap();
    assert_eq!(s.read_asset(&digest, bytes.len() as u64).unwrap(), bytes);
    let db = s.connect().unwrap();
    assert!(db.prepare("SELECT data FROM assets").is_err());
    assert_eq!(
        db.query_row("SELECT path FROM assets", [], |r| r.get::<_, String>(0))
            .unwrap(),
        format!("assets/{digest}")
    );
    drop(db);
    let backup = dir.path().join("backup.zip");
    s.backup(&backup).unwrap();
    let bank = s.save_bank(None, "preserved", "").unwrap();
    std::fs::write(s.asset_path(&digest).unwrap(), b"corrupted").unwrap();
    assert!(s.asset(&digest).is_err());
    assert!(s.backup(&dir.path().join("bad.zip")).is_err());
    assert!(s.restore(&backup).is_err());
    assert_eq!(s.banks().unwrap()[0]["id"], bank);
    assert!(s.asset_path("../escape").is_err());
}
