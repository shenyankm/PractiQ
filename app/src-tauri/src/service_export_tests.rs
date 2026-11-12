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
fn stored_diagnostics_reject_cross_bank_references_without_publishing_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let root = json!({"status":"PARTIAL","processing":null,"result":{"schemaVersion":3,"questions":[{"id":"q","stem":"Source question","answerMode":"short_answer","answerPayload":null}],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0}});
    let mut banks = Vec::new();
    for title in ["First", "Second"] {
        let preview = store
            .preview(serde_json::to_vec(&root).unwrap(), title.into())
            .unwrap();
        banks.push(
            store.import(text(&preview, "ticket"), None, title).unwrap()["bankId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let rows = store.question_rows().unwrap();
    let foreign = rows.iter().find(|row| row["bankId"] == banks[1]).unwrap();
    let corrupted = json!([{"questionIds":[foreign["id"]],"status":"PARTIAL","processing":null}]);
    store.connect().unwrap().execute("UPDATE import_warnings SET message=?1 WHERE position=-1 AND import_id IN (SELECT id FROM imports WHERE bank_id=?2)",rusqlite::params![corrupted.to_string(),banks[0]]).unwrap();
    let before = store.banks().unwrap();
    let error = crate::import_diagnostics::read(&store.connect().unwrap(), &banks[0]).unwrap_err();
    assert!(error.to_string().contains("another bank"));
    for (file, backup) in [("invalid-backup.zip", true), ("invalid-bank.zip", false)] {
        let destination = dir.path().join(file);
        assert!(if backup {
            store.backup(&destination)
        } else {
            store.export_bank(&banks[0], &destination)
        }
        .is_err());
        assert!(!destination.exists());
    }
    assert_eq!(store.banks().unwrap(), before);
}

#[test]
fn appended_snapshots_keep_separate_diagnostics_and_duplicate_import_repairs_old_metadata() {
    use std::io::Write;
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/service-export/partial-media-bank.zip");
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let preview = store.preview_bank_zip(&fixture).unwrap();
    let imported = store
        .import(text(&preview, "ticket"), None, "Partial")
        .unwrap();
    let bank = text(&imported, "bankId");
    store
        .connect()
        .unwrap()
        .execute("DELETE FROM import_warnings WHERE position=-1", [])
        .unwrap();
    store
        .connect()
        .unwrap()
        .execute("UPDATE questions SET position=3-position", [])
        .unwrap();
    let preview = store.preview_bank_zip(&fixture).unwrap();
    assert_eq!(
        store
            .import(text(&preview, "ticket"), Some(bank.into()), "Partial")
            .unwrap()["duplicate"],
        true
    );
    assert!(
        crate::import_diagnostics::read(&store.connect().unwrap(), bank)
            .unwrap()
            .is_empty()
    );
    store
        .connect()
        .unwrap()
        .execute("UPDATE questions SET position=3-position", [])
        .unwrap();
    for _ in 0..2 {
        let preview = store.preview_bank_zip(&fixture).unwrap();
        let duplicate = store
            .import(text(&preview, "ticket"), Some(bank.into()), "Partial")
            .unwrap();
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(
            crate::import_diagnostics::read(&store.connect().unwrap(), bank)
                .unwrap()
                .len(),
            1
        );
    }
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&fixture).unwrap()).unwrap();
    let mut full: Value =
        serde_json::from_reader(archive.by_name("questions.json").unwrap()).unwrap();
    full["status"] = json!("SUCCEEDED");
    full["processing"]["failures"] = json!([]);
    full["processing"]["truncated"] = json!(false);
    let mut extra = full["result"]["questions"][1].clone();
    extra["id"] = json!("new-child");
    extra["stem"] = json!("A new question in the final snapshot");
    full["result"]["questions"]
        .as_array_mut()
        .unwrap()
        .push(extra);
    full["processing"]["questionSources"]
        .as_array_mut()
        .unwrap()
        .push(json!({"questionId":"new-child","stage":"document_parse","unitIndex":1}));
    let path = dir.path().join("full.zip");
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().into_owned();
        writer
            .start_file(&name, zip::write::SimpleFileOptions::default())
            .unwrap();
        if name == "questions.json" {
            writer
                .write_all(&serde_json::to_vec(&full).unwrap())
                .unwrap();
        } else {
            std::io::copy(&mut entry, &mut writer).unwrap();
        }
    }
    writer.finish().unwrap();
    let preview = store.preview_bank_zip(&path).unwrap();
    let appended = store
        .import(text(&preview, "ticket"), Some(bank.into()), "Final")
        .unwrap();
    assert_eq!(appended["duplicate"], false);
    assert_eq!(store.banks().unwrap()[0]["count"], 5);
    let shared = dir.path().join("snapshots.zip");
    store.export_bank(bank, &shared).unwrap();
    let preview = store.preview_bank_zip(&shared).unwrap();
    assert_eq!(preview["status"], "PARTIAL");
    assert!(preview["processing"].is_null());
    assert_eq!(list(&preview, "importDiagnostics").len(), 2);
    assert_eq!(
        preview["importDiagnostics"][0]["processing"]["failures"][0]["code"],
        "MODEL_UNAVAILABLE"
    );
    assert_eq!(preview["importDiagnostics"][1]["status"], "SUCCEEDED");
    let copy = store
        .import(text(&preview, "ticket"), None, "Both snapshots")
        .unwrap();
    let rows = store.question_rows().unwrap();
    assert!(rows
        .iter()
        .filter(|row| row["bankId"] == copy["bankId"])
        .all(|row| !list(row, "sources").is_empty()));
    let deleted = rows
        .iter()
        .find(|row| {
            row["bankId"] == copy["bankId"]
                && row["question"]["answerMode"] == "choice"
                && row["question"]["answerPayload"].is_null()
        })
        .unwrap();
    store
        .delete_question(text(&deleted["question"], "parentId"))
        .unwrap();
    let pruned = dir.path().join("deleted-question.zip");
    store.export_bank(text(&copy, "bankId"), &pruned).unwrap();
    let preview = store.preview_bank_zip(&pruned).unwrap();
    assert_eq!(
        preview["importDiagnostics"][0]["processing"]["quality"]["issues"],
        json!([])
    );
    assert_eq!(
        preview["importDiagnostics"][0]["processing"]["chunks"]["total"],
        2
    );
    let before = store.banks().unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE import_warnings SET message='[{}]' WHERE position=-1",
            [],
        )
        .unwrap();
    assert!(store.backup(&dir.path().join("invalid.zip")).is_err());
    assert_eq!(store.banks().unwrap(), before);
    assert!(!dir.path().join("invalid.zip").exists());
}

#[test]
fn import_diagnostics_reject_invalid_shapes_counts_and_references_before_preview() {
    let result: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
    let valid = json!({"questionIds":["q0"],"status":"PARTIAL","processing":null});
    let root = json!({"result":result,"importDiagnostics":[valid]});
    crate::contract::parse(&serde_json::to_vec(&root).unwrap()).unwrap();
    for (pointer, value) in [
        ("/importDiagnostics", json!({})),
        ("/importDiagnostics/0/status", json!("COMPLETED")),
        ("/importDiagnostics/0/questionIds", json!(["q0", "q0"])),
        ("/importDiagnostics/0/questionIds", json!(["missing"])),
        ("/importDiagnostics/0/threadId", json!("private")),
        (
            "/importDiagnostics/0/processing",
            json!({"chunks":{"total":0,"succeeded":1,"skipped":0},"visuals":{"total":0,"succeeded":0,"skipped":0},"truncated":false,"failures":[]}),
        ),
        (
            "/importDiagnostics/0/processing",
            json!({"chunks":{"total":u64::MAX,"succeeded":u64::MAX,"skipped":1},"visuals":{"total":0,"succeeded":0,"skipped":0},"truncated":false,"failures":[]}),
        ),
        (
            "/importDiagnostics/0/processing",
            json!({"chunks":{"total":1,"succeeded":1,"skipped":0},"visuals":{"total":0,"succeeded":0,"skipped":0},"truncated":false,"failures":[],"questionSources":[{"questionId":"q1","stage":"document_parse","unitIndex":0}]}),
        ),
    ] {
        let mut invalid = root.clone();
        if pointer.ends_with("threadId") {
            invalid["importDiagnostics"][0]["threadId"] = value;
        } else {
            *invalid.pointer_mut(pointer).unwrap() = value;
        }
        assert!(
            crate::contract::parse(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "{pointer}"
        );
    }
}

#[test]
fn zero_question_diagnostics_survive_merging_with_regular_content() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let result = json!({"schemaVersion":3,"questions":[],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0});
    let processing = json!({"chunks":{"total":1,"succeeded":0,"skipped":0},"visuals":{"total":0,"succeeded":0,"skipped":0},"truncated":false,"failures":[{"stage":"document_parse","index":0,"code":"OUTPUT_INVALID","retryable":true}],"questionSources":[],"quality":{"reviewRequired":true,"reviewQuestionCount":0,"issues":[]}});
    let root = json!({"result":result,"status":"PARTIAL","processing":processing});
    let preview = store
        .preview(serde_json::to_vec(&root).unwrap(), "No questions".into())
        .unwrap();
    let empty = store
        .import(text(&preview, "ticket"), None, "No questions")
        .unwrap();
    let mut regular: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
    regular["visualElements"] = json!([]);
    let preview = store
        .preview(serde_json::to_vec(&regular).unwrap(), "Regular".into())
        .unwrap();
    let regular = store
        .import(text(&preview, "ticket"), None, "Regular")
        .unwrap();
    let merged = store
        .merge_banks(
            &[
                text(&empty, "bankId").into(),
                text(&regular, "bankId").into(),
            ],
            "Merged",
        )
        .unwrap();
    let exported = dir.path().join("empty-diagnostics.zip");
    store
        .export_bank(text(&merged, "bankId"), &exported)
        .unwrap();
    let preview = store.preview_bank_zip(&exported).unwrap();
    assert_eq!(preview["status"], "PARTIAL");
    assert_eq!(preview["importDiagnostics"][0]["questionIds"], json!([]));
    assert_eq!(preview["processing"], processing);
}

#[test]
fn duplicate_content_without_unique_source_evidence_does_not_guess_old_diagnostic_ids() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let question =
        json!({"id":"a","stem":"Identical","answerMode":"short_answer","answerPayload":null});
    let mut other = question.clone();
    other["id"] = json!("b");
    let root = json!({"status":"PARTIAL","processing":null,"result":{"schemaVersion":3,"questions":[question,other],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0}});
    let raw = serde_json::to_vec(&root).unwrap();
    let preview = store.preview(raw.clone(), "Ambiguous".into()).unwrap();
    let imported = store
        .import(text(&preview, "ticket"), None, "Ambiguous")
        .unwrap();
    let bank = text(&imported, "bankId");
    store
        .connect()
        .unwrap()
        .execute("DELETE FROM import_warnings WHERE position=-1", [])
        .unwrap();
    let preview = store.preview(raw, "Ambiguous".into()).unwrap();
    assert_eq!(
        store
            .import(text(&preview, "ticket"), Some(bank.into()), "Ambiguous")
            .unwrap()["duplicate"],
        true
    );
    assert!(
        crate::import_diagnostics::read(&store.connect().unwrap(), bank)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.banks().unwrap()[0]["count"], 2);
}

#[test]
fn import_diagnostics_survive_restart_share_merge_and_backup() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../fixtures/service-export/partial-media-bank.zip");
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let preview = store.preview_bank_zip(&fixture).unwrap();
    let processing = preview["processing"].clone();
    let imported = store
        .import(text(&preview, "ticket"), None, "Partial")
        .unwrap();
    let bank = text(&imported, "bankId").to_owned();
    drop(store);
    let mut store = Store::new(dir.path().into()).unwrap();
    let root = store.questions(Some(&bank), "", "", "").unwrap()[0].clone();
    let detail = store.question_detail(text(&root, "id")).unwrap();
    assert_eq!(detail["importDiagnostics"][0]["status"], "PARTIAL");
    assert_eq!(
        detail["importDiagnostics"][0]["processing"]["failures"],
        processing["failures"]
    );
    assert_eq!(
        detail["importDiagnostics"][0]["processing"]["truncated"],
        true
    );
    let other = store.save_bank(None, "Empty", "").unwrap();
    let merged = store
        .merge_banks(&[bank.clone(), other.as_str().unwrap().into()], "Merged")
        .unwrap();
    let merged = text(&merged, "bankId");
    let shared = dir.path().join("shared.zip");
    store.export_bank(merged, &shared).unwrap();
    let portable = store.preview_bank_zip(&shared).unwrap();
    assert_eq!(portable["status"], "PARTIAL");
    assert_eq!(portable["processing"]["failures"], processing["failures"]);
    assert_eq!(
        portable["processing"]["quality"]["issues"][0]["code"],
        "NEEDS_REVIEW"
    );
    let again = store
        .import(text(&portable, "ticket"), None, "Reimported")
        .unwrap();
    let backup = dir.path().join("backup.zip");
    store.backup(&backup).unwrap();
    let restored = tempfile::tempdir().unwrap();
    let mut target = Store::new(restored.path().into()).unwrap();
    target.restore(&backup).unwrap();
    let rows = target
        .questions(Some(text(&again, "bankId")), "", "", "")
        .unwrap();
    let detail = target.question_detail(text(&rows[0], "id")).unwrap();
    assert_eq!(detail["importDiagnostics"][0]["status"], "PARTIAL");
    assert_eq!(
        detail["importDiagnostics"][0]["processing"]["failures"],
        processing["failures"]
    );
}

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
        .save_bank(None, "Existing bank", "Preserve this")
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
    assert_eq!(store.banks().unwrap()[0]["title"], "Existing bank");
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
