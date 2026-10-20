//! Consume bytes produced by the independent service's real `export_task_bank`.
//! The fixture is fixed: ordinary Rust tests need no Python runtime or service.
use crate::{
    audio::PlaybackAction,
    contract::{list, text},
    exams::Paper,
    store::{hash, Store},
};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

#[test]
#[ignore = "requires explicitly supplied live service ZIPs and an isolated evidence directory"]
fn live_service_exports_survive_sqlite_import_and_restart() {
    let directory = std::path::PathBuf::from(
        std::env::var_os("PRACTIQ_LIVE_EXPORT_DIR").expect("PRACTIQ_LIVE_EXPORT_DIR"),
    );
    let mut files: Vec<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|suffix| suffix == "zip"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "No live exports supplied");
    let mut checks = Vec::new();
    for file in files {
        let name = file.file_stem().unwrap().to_str().unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
        let exported: Value =
            serde_json::from_reader(archive.by_name("questions.json").unwrap()).unwrap();
        let root = crate::contract::parse(&serde_json::to_vec(&exported).unwrap()).unwrap();
        let result = crate::contract::result(&root);
        let mut resources = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if entry.name().unwrap().starts_with("resources/") {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                resources.push((hash(&bytes), bytes));
            }
        }
        for repetition in 0..3 {
            let dir = directory
                .join("native")
                .join(format!("{name}-{repetition}-{}", uuid::Uuid::new_v4()));
            let mut store = Store::new(dir.clone()).unwrap();
            let preview = store.preview_bank_zip(&file).unwrap();
            assert_eq!(preview["questions"], result["questions"], "{name}: preview");
            assert_eq!(preview["processing"], root["processing"]);
            assert_eq!(preview["missingAssets"], json!([]));
            let imported = store.import(text(&preview, "ticket"), None, name).unwrap();
            let bank = text(&imported, "bankId").to_owned();
            let before = store.question_rows().unwrap();
            assert_eq!(before.len(), list(result, "questions").len());
            let ids: std::collections::HashMap<_, _> = list(result, "questions")
                .iter()
                .zip(&before)
                .map(|(question, row)| {
                    (text(question, "id").to_owned(), text(row, "id").to_owned())
                })
                .collect();
            for (source, row) in list(result, "questions").iter().zip(&before) {
                let mut expected = source.clone();
                crate::questions::remap(&mut expected, &ids).unwrap();
                let mut actual = row["question"].clone();
                crate::contract::validate_question(&mut actual).unwrap();
                for (key, value) in expected.as_object().unwrap() {
                    assert!(
                        &actual[key] == value
                            || (value.is_number()
                                && actual[key].is_number()
                                && actual[key].as_f64() == value.as_f64()),
                        "{name}: persisted question field {key}: {} != {value}",
                        actual[key]
                    );
                }
                assert_eq!(row["warnings"], result["warnings"], "{name}: warnings");
                let sources: Vec<_> = list(&root["processing"], "questionSources")
                    .iter()
                    .filter(|item| item["questionId"] == source["id"])
                    .map(|item| {
                        let mut item = item.clone();
                        item["questionId"] = row["id"].clone();
                        item
                    })
                    .collect();
                assert_eq!(row["sources"], json!(sources), "{name}: provenance");
            }
            for (digest, bytes) in &resources {
                assert_eq!(store.asset_bytes(digest).unwrap().unwrap().1, *bytes);
            }
            drop(store);
            let mut reopened = Store::new(dir.clone()).unwrap();
            assert_eq!(reopened.question_rows().unwrap(), before, "{name}: restart");
            let roundtrip = dir.join("roundtrip.zip");
            reopened.export_bank(&bank, &roundtrip).unwrap();
            let mut archive =
                zip::ZipArchive::new(std::fs::File::open(roundtrip).unwrap()).unwrap();
            let saved: Value =
                serde_json::from_reader(archive.by_name("questions.json").unwrap()).unwrap();
            let saved = crate::contract::result(&saved);
            for key in ["groups", "visualElements"] {
                let mut expected = list(result, key).to_vec();
                for item in &mut expected {
                    for id in item["questionIds"].as_array_mut().unwrap() {
                        *id = json!(ids[id.as_str().unwrap()]);
                    }
                }
                let canonical = |items: &[Value]| {
                    let mut items: Vec<_> = items
                        .iter()
                        .map(|item| {
                            let mut item = item.clone();
                            item["questionIds"]
                                .as_array_mut()
                                .unwrap()
                                .sort_by_key(Value::to_string);
                            item.to_string()
                        })
                        .collect();
                    items.sort();
                    items
                };
                assert_eq!(
                    canonical(list(saved, key)),
                    canonical(&expected),
                    "{name}: {key}"
                );
            }
            assert_eq!(saved["missingFields"], result["missingFields"]);
            let again = reopened.preview_bank_zip(&file).unwrap();
            let duplicate = reopened
                .import(text(&again, "ticket"), Some(bank), name)
                .unwrap();
            assert_eq!(duplicate["duplicate"], true);
            assert_eq!(duplicate["count"], 0);
            assert_eq!(
                reopened.question_rows().unwrap(),
                before,
                "{name}: duplicate import"
            );
            let integrity: String = reopened
                .connect()
                .unwrap()
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .unwrap();
            assert_eq!(integrity, "ok");
            let broken_references: usize = reopened
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(broken_references, 0);
            checks.push(json!({"file":file.file_name().unwrap().to_str().unwrap(), "repetition":repetition,
                "questions":before.len(), "resources":resources.len(), "store":dir,
                "fieldsPreserved":true,"restartPreserved":true,"duplicateAdded":0,"sqliteIntegrity":integrity,"brokenReferences":broken_references}));
        }
    }
    std::fs::write(
        directory.join("native-report.json"),
        serde_json::to_vec_pretty(&checks).unwrap(),
    )
    .unwrap();
}

#[test]
fn service_export_imports_partial_media_and_preserves_offline_history() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/service-export/partial-media-bank.zip");
    let provenance: Value = serde_json::from_slice(include_bytes!(
        "../../fixtures/service-export/provenance.json"
    ))
    .unwrap();
    assert_eq!(
        hash(&std::fs::read(&fixture).unwrap()),
        provenance["archiveSha256"]
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&fixture).unwrap()).unwrap();
    let exported: Value = serde_json::from_reader(zip.by_name("questions.json").unwrap()).unwrap();
    let source = &exported["result"];
    let original = |id: &str| {
        list(source, "questions")
            .iter()
            .find(|q| text(q, "id") == id)
            .unwrap()
    };
    let image = &source["visualElements"][0]["imageRef"];
    let audio = &original("listening")["audioRef"];
    let mut resources = Vec::new();
    for reference in [image, audio] {
        assert!(text(reference, "objectKey").starts_with(&format!(
            "practiq-agent/artifacts/{}/",
            text(&provenance["source"], "sha256")
        )));
        let mut bytes = Vec::new();
        zip.by_name(&format!("resources/{}", text(reference, "objectKey")))
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(hash(&bytes), reference["sha256"]);
        assert_eq!(bytes.len() as u64, reference["sizeBytes"].as_u64().unwrap());
        resources.push((text(reference, "sha256").to_owned(), bytes));
    }
    drop(zip);

    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().to_owned()).unwrap();
    let bank = store
        .save_bank(None, "Existing local bank", "Preserve this")
        .unwrap();
    let bank = bank.as_str().unwrap();
    let mut existing = original("q-known").clone();
    existing["parentId"] = Value::Null;
    existing["stem"] = json!("Existing local question");
    store.save_question(None, bank, existing).unwrap();
    let existing_rows = store.question_rows().unwrap();
    let existing_id = text(&existing_rows[0], "id").to_owned();
    let previous = store
        .start_paper(Paper {
            question_ids: vec![existing_id.clone()],
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(&existing_rows).unwrap(),
        })
        .unwrap();
    let previous_id = text(&previous, "id").to_owned();

    let preview = store.preview_bank_zip(&fixture).unwrap();
    assert_eq!(preview["status"], "PARTIAL");
    assert_eq!(preview["processing"], exported["processing"]);
    assert_eq!(preview["warnings"], source["warnings"]);
    assert_eq!(preview["questions"], source["questions"]);
    assert_eq!(preview["assetCount"], 2);
    assert_eq!(preview["missingAssets"], json!([]));
    let imported = store
        .import(
            text(&preview, "ticket"),
            Some(bank.into()),
            "Ignored package title",
        )
        .unwrap();
    assert_eq!(imported["count"], 2);
    assert_eq!(imported["duplicate"], false);
    assert_eq!(store.banks().unwrap()[0]["count"], 3);
    assert_eq!(store.banks().unwrap()[0]["title"], "Existing local bank");
    assert_eq!(store.session(&previous_id).unwrap(), previous);
    let roots = store.questions(Some(bank), "", "listening", "").unwrap();
    let root = &roots[0];
    let root_id = text(root, "id").to_owned();
    assert_eq!(root["missingAssets"], false);
    assert_eq!(root["question"]["audioRef"], *audio);
    assert_eq!(list(root, "children").len(), 2);
    let rows = store.question_rows().unwrap();
    let null_row = rows
        .iter()
        .find(|row| row["question"]["stem"] == original("q-null")["stem"])
        .unwrap();
    assert_eq!(null_row["question"]["answerPayload"], Value::Null);
    assert_eq!(null_row["question"]["needsReview"], true);
    assert_eq!(null_row["warnings"], source["warnings"]);
    assert_eq!(null_row["sources"][0]["questionId"], null_row["id"]);
    assert_eq!(null_row["sources"][0]["stage"], "document_parse");
    assert_eq!(null_row["sources"][0]["unitIndex"], 0);

    // Re-importing restores missing immutable bytes, without duplicating content.
    std::fs::remove_file(store.asset_path(text(image, "sha256")).unwrap()).unwrap();
    let again = store.preview_bank_zip(&fixture).unwrap();
    let duplicate = store
        .import(text(&again, "ticket"), Some(bank.into()), "Same bank")
        .unwrap();
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(store.banks().unwrap()[0]["count"], 3);
    let assets: usize = store
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(assets, 2);
    for (digest, bytes) in &resources {
        assert_eq!(store.asset_bytes(digest).unwrap().unwrap().1, *bytes);
    }
    let selected = crate::paper::selected_rows(&rows, std::slice::from_ref(&root_id)).unwrap();
    let session = store
        .start_paper(Paper {
            question_ids: vec![root_id.clone()],
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(&selected).unwrap(),
        })
        .unwrap();
    let sid = text(&session, "id").to_owned();
    assert_eq!(list(&session, "attempts").len(), 2);
    assert_eq!(
        store
            .listening_playback(&sid, &root_id, PlaybackAction::Start, None)
            .unwrap()["used"],
        1
    );
    store
        .listening_playback(&sid, &root_id, PlaybackAction::End, Some(0.05))
        .unwrap();
    for (ordinal, attempt) in list(&session, "attempts").iter().enumerate() {
        assert_eq!(attempt["snapshot"]["missingAssets"], false);
        assert_eq!(attempt["snapshot"]["materials"][0]["audioRef"], *audio);
        store
            .save_attempt((&sid, ordinal), json!({"correct":["A"]}), 20, true, false)
            .unwrap();
    }
    let finished = store.submit_paper(&sid, false).unwrap();
    let known = list(&finished, "attempts")
        .iter()
        .find(|a| a["snapshot"]["question"]["answerPayload"].is_object())
        .unwrap();
    let unknown = list(&finished, "attempts")
        .iter()
        .find(|a| a["snapshot"]["question"]["answerPayload"].is_null())
        .unwrap();
    assert_eq!(known["autoResult"], true);
    assert_eq!(unknown["autoResult"], Value::Null);
    assert_eq!(unknown["gradeKind"], "ungraded");
    let completed_roots = store.questions(Some(bank), "", "listening", "").unwrap();

    let backup = dir.path().join("portable.zip");
    store.backup(&backup).unwrap();
    let restored_dir = tempfile::tempdir().unwrap();
    let mut restored = Store::new(restored_dir.path().to_owned()).unwrap();
    restored.restore(&backup).unwrap();
    let mut recovered = restored.session(&sid).unwrap();
    let mut expected = finished;
    recovered.as_object_mut().unwrap().remove("snapshotKey");
    expected.as_object_mut().unwrap().remove("snapshotKey");
    assert_eq!(recovered, expected);
    assert_eq!(restored.banks().unwrap()[0]["count"], 3);
    for (digest, bytes) in resources {
        assert_eq!(restored.asset_bytes(&digest).unwrap().unwrap().1, bytes);
    }
    assert_eq!(
        restored.questions(Some(bank), "", "listening", "").unwrap(),
        completed_roots
    );
    assert_eq!(
        restored.session(&previous_id).unwrap()["attempts"],
        previous["attempts"]
    );
    assert_eq!(
        restored
            .listening_playback(&sid, &root_id, PlaybackAction::State, None)
            .unwrap()["used"],
        1
    );
}

#[test]
fn saas_paused_snapshot_imports_as_independent_banks_with_review_flags() {
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/saas-export/partial-bank.zip");
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().to_owned()).unwrap();
    let mut banks = Vec::new();
    for _ in 0..2 {
        let preview = store.preview_bank_zip(&fixture).unwrap();
        assert_eq!(preview["status"], "PARTIAL");
        assert_eq!(preview["processing"]["chunks"]["total"], 2);
        assert_eq!(preview["processing"]["chunks"]["succeeded"], 1);
        assert_eq!(preview["processing"]["quality"]["reviewRequired"], true);
        assert_eq!(preview["questions"][0]["answerPayload"], Value::Null);
        let imported = store
            .import(text(&preview, "ticket"), None, "Paused import")
            .unwrap();
        assert_eq!(imported["count"], 1);
        banks.push(imported["bankId"].clone());
    }
    assert_ne!(banks[0], banks[1]);
    assert_eq!(store.banks().unwrap().as_array().unwrap().len(), 2);
    assert!(store
        .question_rows()
        .unwrap()
        .iter()
        .all(|row| row["question"]["needsReview"] == true));
}
