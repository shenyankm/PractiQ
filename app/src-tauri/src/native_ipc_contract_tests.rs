use crate::{
    contract::{self, list, text},
    exams::Paper,
    settings::{self, ConnectionSettings, ServiceSettings},
    store::Store,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn configuration(shared: &crate::Shared, config: ServiceSettings) -> Value {
    {
        let store = shared.lock().unwrap();
        store
            .prepare_service_settings_restore(Some(config), "0".repeat(64))
            .unwrap();
        store.finish_service_settings_restore(true).unwrap();
    }
    settings::settings(shared).unwrap()
}

fn replace_identifiers(value: &mut Value, replacements: &[(&str, &str)]) {
    match value {
        Value::String(value) => {
            if let Some((_, replacement)) = replacements.iter().find(|(old, _)| *old == value) {
                *value = (*replacement).into();
            }
        }
        Value::Array(items) => {
            for item in items {
                replace_identifiers(item, replacements);
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                replace_identifiers(item, replacements);
            }
        }
        _ => {}
    }
}

#[test]
fn native_ipc_payloads_match_frontend_fixture() {
    let dir = tempfile::tempdir().unwrap();
    let shared = Arc::new(Mutex::new(Store::new(dir.path().to_owned()).unwrap()));
    let defaults = settings::settings(&shared).unwrap();
    let service = configuration(
        &shared,
        ServiceSettings {
            service_url: Some("http://127.0.0.1:8090".into()),
            model: None,
        },
    );
    let direct = configuration(
        &shared,
        ServiceSettings {
            service_url: None,
            model: Some(ConnectionSettings {
                base_url: Some("https://model.example.com/v1".into()),
                model_id: Some("fixture-model".into()),
            }),
        },
    );
    let mut store = shared.lock().unwrap();
    store.locale = crate::language::Locale::English;
    store.session_clock.set(1_800_000_000_000, 1_000);
    let empty_banks = store.banks_page(1, 0).unwrap();
    store
        .save_bank(
            Some("fixture-bank".into()),
            "IPC fixture",
            "Synthetic input",
        )
        .unwrap();
    store
        .save_bank(Some("empty-bank".into()), "Empty bank", "")
        .unwrap();
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE banks SET created_at=CASE id WHEN 'fixture-bank' THEN 2 ELSE 1 END",
            [],
        )
        .unwrap();
    let document = contract::parse(include_bytes!("../../fixtures/sample.json")).unwrap();
    let mut question = list(contract::result(&document), "questions")
        .iter()
        .find(|question| {
            text(question, "answerMode") == "short_answer" && crate::exams::has_basis(question)
        })
        .unwrap()
        .clone();
    question["id"] = json!("subjective");
    store
        .save_question_tree("fixture-bank", None, vec![question])
        .unwrap();
    let selected = crate::questions::read_scoped(&store.connect().unwrap(), &[], None).unwrap();
    let session = store
        .start_paper_data(Paper {
            question_ids: vec!["subjective".into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![500],
            total_cents: 500,
            digest: crate::paper::digest(&selected).unwrap(),
        })
        .unwrap();
    let sid = text(&session, "id");
    store
        .save_draft((sid, 0), json!({"text":"Fixture answer"}), 0)
        .unwrap();
    store.submit_paper_data(sid, true).unwrap();
    let target = json!({"kind":"direct","baseUrl":"https://model.example.com/v1","model":"fixture-model","promptVersion":1});
    let request = store
        .prepare_grade_target(sid, 0, false, store.locale, Some(&target))
        .unwrap();
    let rid = text(&request, "requestId");
    assert!(store.claim_model_grade(rid).unwrap().is_none());
    let unknown_session = store.session_data(sid, None).unwrap();
    let unknown = unknown_session["attempts"][0]["grading"]["lastRequest"].clone();
    let graded = store
        .record_grade_with_key(
            sid,
            0,
            rid,
            &json!({"status":"graded","result":{"scoreCents":300,"maxCents":500,
                "reason":"Three credited items", "evidence":["Fixture answer"],"reviewReasons":[]}}),
            None,
        )
        .unwrap();
    let legacy: Value =
        serde_json::from_str(include_str!("../../fixtures/legacy-grading-errors.json")).unwrap();
    let historical = store
        .record_grade_with_key(sid, 0, rid, &legacy[0]["response"], None)
        .unwrap()["attempts"][0]["grading"]["lastRequest"]
        .clone();
    let pages = json!({
        "emptyBanks":empty_banks,
        "banks":store.banks_page(1, 0).unwrap(),
        "nextBanks":store.banks_page(1, 1).unwrap(),
        "questions":store.questions_with_stats(&["fixture-bank".into()], ("", "", ""), (1, 0)).unwrap(),
        "sessions":store.sessions_filtered(1, 0, "review").unwrap(),
    });
    let manual_session = store
        .manual_score_with_key(sid, 0, 400, "Reviewed against the supplied reference", None)
        .unwrap();
    let archive = dir.path().join("fixture.zip");
    store.backup(&archive).unwrap();
    let restored = store.restore(&archive).unwrap();
    let mut fixture = json!({"settings":{"defaults":defaults,"service":service,"direct":direct},
        "pages":pages,"receipts":{"unknown":unknown,"graded":graded["attempts"][0]["grading"]["ai"],"historical":historical},
        "unknownSession":unknown_session,"gradedSession":graded,"manualSession":manual_session,"restore":restored});
    // Normalize only generated identities and the temporary recovery path, never payload fields.
    replace_identifiers(
        &mut fixture,
        &[
            (sid, "fixture-session"),
            (rid, "fixture-request"),
            (text(&graded, "snapshotKey"), "fixture-snapshot"),
            (text(&graded, "attemptKey"), "fixture-attempts"),
            (
                text(&unknown_session, "attemptKey"),
                "fixture-unknown-attempts",
            ),
            (
                text(&manual_session, "attemptKey"),
                "fixture-manual-attempts",
            ),
            (text(&restored, "recoveryPath"), "<temporary>/recovery.zip"),
        ],
    );
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/native-ipc.json");
    if std::env::var("PRACTIQ_UPDATE_NATIVE_IPC_FIXTURE").as_deref() == Ok("1") {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
    }
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(fixture, expected, "Native IPC changed; regenerate the fixture explicitly and review its frontend contract tests");
}
