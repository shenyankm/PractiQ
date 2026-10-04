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
    let finished = store.finish(&sid).unwrap();
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
