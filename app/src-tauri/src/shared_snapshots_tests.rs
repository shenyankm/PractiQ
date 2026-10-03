use crate::{
    contract::{list, text},
    store::{now, Store},
};
use rusqlite::params;
use serde_json::{json, Value};

fn shared_session(
    nodes: usize,
    mode: &str,
    kind: &str,
    passage_bytes: usize,
) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().into()).unwrap();
    let parent = json!({"id":"root","parentId":null,"stem":"Shared material","answerMode":mode,
        "passage":[{"partType":"text","textValue":"x".repeat(passage_bytes)}],"contentBlocks":[],
        "options":[{"label":"A","content":"shared option"}],"answerPayload":null,
        "sourceText":"material source","analysis":"material analysis","scoringRubric":null,
        "transcript":[{"partType":"text","textValue":"secret transcript"}],"audioStartSeconds":0,"audioEndSeconds":10,"examPlayCount":2});
    let group = json!({"id":"group","title":"Shared group","instructions":"instructions","questionIds":["root"]});
    let visual = json!({"id":"visual","visualType":"image","description":"shared visual","questionIds":["root"],"sourceRef":{"sha256":"secret-source"}});
    let mut rows = vec![
        json!({"id":"root","bankId":"bank","bankTitle":"Bank","question":parent,"groups":[group],"visuals":[visual],"sources":[],"warnings":[],"missingAssets":false,"favorite":false,"latestResult":null}),
    ];
    for i in 0..nodes {
        rows.push(json!({"id":format!("q{i}"),"bankId":"bank","bankTitle":"Bank",
            "question":{"id":format!("q{i}"),"parentId":"root","stem":format!("Question {i}"),"answerMode":"choice","choiceVariant":"single",
                "questionKind":null,"options":[],"optionSourceId":if mode=="word_bank"{Some("root")}else{None},"answerPayload":{"correct":["A"]},"contentBlocks":[],"missingFields":[]},
            "groups":[],"visuals":[],"sources":[],"warnings":[],"missingAssets":false,"favorite":false,"latestResult":null}));
    }
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind) VALUES('shared','Shared',?1,0,'ordered',?2)", params![now(),kind]).unwrap();
    tx.execute(
        "INSERT INTO session_documents VALUES('shared',?1)",
        [crate::questions::freeze(&rows).to_string()],
    )
    .unwrap();
    for i in 0..nodes {
        tx.execute("INSERT INTO attempts(session_id,ordinal,snapshot_question_id,max_cents) VALUES('shared',?1,?2,100)", params![i,format!("q{i}")]).unwrap();
    }
    tx.commit().unwrap();
    (dir, store)
}

fn expand(mut session: Value) -> Value {
    let content = session["snapshotDocument"].take();
    session.as_object_mut().unwrap().remove("snapshotDocument");
    for attempt in session["attempts"].as_array_mut().unwrap() {
        let snapshot = &mut attempt["snapshot"];
        let refs = snapshot["snapshotRefs"].take();
        snapshot.as_object_mut().unwrap().remove("snapshotRefs");
        for field in ["materials", "groups", "visuals"] {
            snapshot[field] = json!(list(&refs, field)
                .iter()
                .map(|i| &content[i.as_u64().unwrap() as usize])
                .collect::<Vec<_>>());
        }
        if let Some(index) = refs["options"].as_u64() {
            snapshot["question"]["options"] = content[index as usize].clone();
        }
        if let Some(index) = refs["warnings"].as_u64() {
            snapshot["warnings"] = content[index as usize].clone();
        }
    }
    session
}

#[test]
fn thousand_subquestions_send_shared_material_options_and_context_once() {
    let (_dir, store) = shared_session(1000, "word_bank", "practice", 10_000);
    let full = store.session("shared").unwrap();
    let compact = store.session_data("shared", None).unwrap();
    assert_eq!(list(&compact, "snapshotDocument").len(), 4);
    let bytes = serde_json::to_vec(&compact).unwrap().len();
    assert!(bytes < 1_200_000, "wire response has {bytes} bytes");
    assert!(serde_json::to_vec(&full).unwrap().len() > bytes * 8);
    assert_eq!(expand(compact), full);
}

#[test]
fn shared_snapshot_roundtrip_keeps_exam_and_partial_listening_visibility() {
    for kind in ["practice", "self_test"] {
        let (_dir, store) = shared_session(2, "listening", kind, 100);
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE attempts SET submitted_at=?1 WHERE session_id='shared' AND ordinal=0",
                [now()],
            )
            .unwrap();
        let compact = store.session_data("shared", None).unwrap();
        assert!(!compact.to_string().contains("secret transcript"));
        assert!(!compact.to_string().contains("secret-source"));
        assert_eq!(expand(compact), store.session("shared").unwrap());
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE attempts SET submitted_at=?1 WHERE session_id='shared'",
                [now()],
            )
            .unwrap();
        if kind == "self_test" {
            store
                .connect()
                .unwrap()
                .execute(
                    "UPDATE sessions SET submitted_at=?1 WHERE id='shared'",
                    [now()],
                )
                .unwrap();
        }
        let revealed = store.session_data("shared", None).unwrap();
        assert!(revealed.to_string().contains("secret transcript"));
        assert_eq!(expand(revealed), store.session("shared").unwrap());
    }
}

#[test]
fn shared_material_keeps_distinct_redacted_variants() {
    let (_dir, store) = shared_session(2, "reading", "practice", 100);
    let db = store.connect().unwrap();
    let raw: String = db
        .query_row(
            "SELECT content FROM session_documents WHERE session_id='shared'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut document: Value = serde_json::from_str(&raw).unwrap();
    document["questions"][2]["question"]["questionKind"] = json!("translation");
    db.execute(
        "UPDATE session_documents SET content=?1 WHERE session_id='shared'",
        [document.to_string()],
    )
    .unwrap();
    let wire = store.session_data("shared", None).unwrap();
    assert_ne!(
        wire["attempts"][0]["snapshot"]["snapshotRefs"]["materials"],
        wire["attempts"][1]["snapshot"]["snapshotRefs"]["materials"]
    );
    assert_eq!(expand(wire), store.session("shared").unwrap());
}

#[test]
fn shared_warning_context_is_pooled_without_dropping_quality_flags() {
    let (_dir, store) = shared_session(2, "reading", "practice", 100);
    let db = store.connect().unwrap();
    let raw: String = db
        .query_row(
            "SELECT content FROM session_documents WHERE session_id='shared'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut document: Value = serde_json::from_str(&raw).unwrap();
    for row in document["questions"].as_array_mut().unwrap() {
        row["warnings"] = json!(["Shared import warning"]);
    }
    db.execute(
        "UPDATE session_documents SET content=?1 WHERE session_id='shared'",
        [document.to_string()],
    )
    .unwrap();
    let wire = store.session_data("shared", None).unwrap();
    assert_eq!(
        wire["attempts"][0]["snapshot"]["snapshotRefs"]["warnings"],
        wire["attempts"][1]["snapshot"]["snapshotRefs"]["warnings"]
    );
    assert_eq!(expand(wire), store.session("shared").unwrap());
}

#[test]
fn flags_self_assessment_manual_and_ai_scores_reuse_snapshot_keys() {
    let (_dir, store) = shared_session(1, "reading", "self_test", 100);
    let initial = store.session_data("shared", None).unwrap();
    let key = text(&initial, "snapshotKey");
    let flagged = store.flag_with_key("shared", 0, true, Some(key)).unwrap();
    assert!(flagged["attempts"][0]["snapshot"].is_null());
    assert_eq!(flagged["attempts"][0]["flagged"], true);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE sessions SET submitted_at=?1 WHERE id='shared'",
            [now()],
        )
        .unwrap();
    let revealed = store.session_data("shared", Some(key)).unwrap();
    assert!(revealed["attempts"][0]["snapshot"].is_object());
    let key = text(&revealed, "snapshotKey");
    let manual = store
        .manual_score_with_key("shared", 0, 50, "Checked", Some(key))
        .unwrap();
    assert!(manual["attempts"][0]["snapshot"].is_null());
    assert_eq!(manual["attempts"][0]["earnedCents"], 50);
    store
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO grade_requests VALUES('grade','shared',0,'{}',NULL,?1)",
            [now()],
        )
        .unwrap();
    let ai = store
        .record_grade_with_key(
            "shared",
            0,
            "grade",
            &json!({"status":"graded","result":{"scoreCents":100,"maxCents":100}}),
            Some(key),
        )
        .unwrap();
    assert!(ai["attempts"][0]["snapshot"].is_null());
    assert_eq!(ai["attempts"][0]["earnedCents"], 50);
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE sessions SET kind='practice',submitted_at=NULL WHERE id='shared'",
            [],
        )
        .unwrap();
    store.connect().unwrap().execute("UPDATE attempts SET submitted_at=?1,auto_result=NULL,grade_kind='ungraded' WHERE session_id='shared'", [now()]).unwrap();
    let practice = store.session_data("shared", None).unwrap();
    let own = store
        .self_assess_with_key("shared", 0, false, Some(text(&practice, "snapshotKey")))
        .unwrap();
    assert!(own["attempts"][0]["snapshot"].is_null());
    assert_eq!(own["attempts"][0]["result"], false);
}

#[test]
fn playback_reuses_the_cached_immutable_document_and_checks_identity() {
    let (_dir, store) = shared_session(1, "listening", "practice", 100);
    let doc = store
        .session_document(&store.connect().unwrap(), "shared")
        .unwrap();
    assert!(store
        .listening_playback("shared", "root", crate::audio::PlaybackAction::State, None)
        .is_ok());
    let cached = store.session_document_cache.borrow();
    assert!(std::sync::Arc::ptr_eq(&doc, &cached.as_ref().unwrap().1));
    assert!(store
        .listening_playback("shared", "q0", crate::audio::PlaybackAction::State, None)
        .is_err());
    assert!(store
        .listening_playback(
            "shared",
            "missing",
            crate::audio::PlaybackAction::State,
            None
        )
        .is_err());
    assert!(crate::questions::question_from_document(
        &json!({"schemaVersion":2,"questions":[]}),
        "q"
    )
    .is_err());
}

#[test]
fn uncached_playback_keeps_the_selective_read_through_path() {
    let (_dir, store) = shared_session(1, "listening", "practice", 100);
    assert!(store.session_document_cache.borrow().is_none());
    assert!(store
        .listening_playback("shared", "root", crate::audio::PlaybackAction::State, None)
        .is_ok());
    assert!(store.session_document_cache.borrow().is_none());
    assert!(store
        .listening_playback(
            "shared",
            "missing",
            crate::audio::PlaybackAction::State,
            None
        )
        .is_err());
}

#[test]
fn oversized_playback_documents_keep_the_cache_bound_and_read_through() {
    let (_dir, store) = shared_session(1, "listening", "practice", 8 * 1024 * 1024 + 1);
    let doc = store
        .session_document(&store.connect().unwrap(), "shared")
        .unwrap();
    assert!(store.session_document_cache.borrow().is_none());
    drop(doc);
    assert!(store
        .listening_playback("shared", "root", crate::audio::PlaybackAction::State, None)
        .is_ok());
    assert!(store.session_document_cache.borrow().is_none());
}

#[test]
#[ignore = "release synthetic workload; run each mode in a separate process for RSS"]
fn shared_snapshot_stress() {
    use std::time::Instant;
    let mode = std::env::var("PRACTIQ_SHARED_MODE").unwrap_or_else(|_| "compact".into());
    let (_dir, store) = shared_session(1000, "word_bank", "practice", 100_000);
    let mut samples = Vec::new();
    let mut bytes = 0;
    for _ in 0..5 {
        let start = Instant::now();
        let response = if mode == "expanded" {
            store.session("shared").unwrap()
        } else {
            store.session_data("shared", None).unwrap()
        };
        let construction = start.elapsed().as_secs_f64() * 1000.0;
        let encoded = serde_json::to_vec(&response).unwrap();
        let total = start.elapsed().as_secs_f64() * 1000.0;
        bytes = encoded.len();
        samples.push(json!({"constructionMs":construction,"serializationMs":total-construction,"totalMs":total}));
    }
    samples.sort_by(|a, b| {
        a["totalMs"]
            .as_f64()
            .unwrap()
            .total_cmp(&b["totalMs"].as_f64().unwrap())
    });
    let mut report = json!({"mode":mode,"nodes":1000,"sharedPassageBytes":100000,"responseBytes":bytes,"median":samples[2],"samples":samples,
        "scope":"Synthetic SQLite + snapshot construction/serialization; excludes IPC, WebView and media decoding. Measure RSS with a separate executable process per mode."});
    if mode == "compact" {
        let (_audio_dir, audio_store) = shared_session(1000, "listening", "practice", 100_000);
        let db = audio_store.connect().unwrap();
        let doc = audio_store.session_document(&db, "shared").unwrap();
        let start = Instant::now();
        for _ in 0..100 {
            let raw: String = db.query_row("SELECT q.value FROM session_documents d,json_each(d.content,'$.questions') q WHERE d.session_id=?1 AND json_extract(d.content,'$.schemaVersion')=3 AND json_extract(q.value,'$.id')=?2", params!["shared","root"], |r| r.get(0)).unwrap();
            let question: Value = serde_json::from_str::<Value>(&raw).unwrap()["question"].take();
            assert_eq!(text(&question, "answerMode"), "listening");
        }
        report["audioOriginalLookup100Ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        for _ in 0..100 {
            let cached = audio_store.session_document(&db, "shared").unwrap();
            assert_eq!(
                text(
                    crate::questions::question_from_document(&cached, "root").unwrap(),
                    "answerMode"
                ),
                "listening"
            );
            assert!(std::sync::Arc::ptr_eq(&doc, &cached));
        }
        report["audioCachedLookup100Ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        let start = Instant::now();
        for _ in 0..100 {
            audio_store
                .listening_playback("shared", "root", crate::audio::PlaybackAction::State, None)
                .unwrap();
        }
        report["audioState100Ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        let (_key_dir, keyed) = shared_session(1000, "reading", "self_test", 100_000);
        let initial = keyed.session_data("shared", None).unwrap();
        let flagged = keyed
            .flag_with_key("shared", 0, true, Some(text(&initial, "snapshotKey")))
            .unwrap();
        report["flagBytes"] = json!(serde_json::to_vec(&flagged).unwrap().len());
        keyed
            .connect()
            .unwrap()
            .execute(
                "UPDATE sessions SET submitted_at=?1 WHERE id='shared'",
                [now()],
            )
            .unwrap();
        let reveal = keyed.session_data("shared", None).unwrap();
        let key = text(&reveal, "snapshotKey");
        let manual = keyed
            .manual_score_with_key("shared", 0, 50, "Checked", Some(key))
            .unwrap();
        report["manualScoreBytes"] = json!(serde_json::to_vec(&manual).unwrap().len());
        keyed
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO grade_requests VALUES('grade','shared',0,'{}',NULL,?1)",
                [now()],
            )
            .unwrap();
        let graded = keyed
            .record_grade_with_key(
                "shared",
                0,
                "grade",
                &json!({"status":"graded","result":{"scoreCents":100,"maxCents":100}}),
                Some(key),
            )
            .unwrap();
        report["aiGradeBytes"] = json!(serde_json::to_vec(&graded).unwrap().len());
        keyed
            .connect()
            .unwrap()
            .execute(
                "UPDATE sessions SET kind='practice',submitted_at=NULL WHERE id='shared'",
                [],
            )
            .unwrap();
        keyed.connect().unwrap().execute("UPDATE attempts SET submitted_at=?1,auto_result=NULL,grade_kind='ungraded' WHERE session_id='shared' AND ordinal=0",[now()]).unwrap();
        let practice = keyed.session_data("shared", None).unwrap();
        let own = keyed
            .self_assess_with_key("shared", 0, true, Some(text(&practice, "snapshotKey")))
            .unwrap();
        report["selfAssessBytes"] = json!(serde_json::to_vec(&own).unwrap().len());
    }
    if let Ok(output) = std::env::var("PRACTIQ_BENCH_OUTPUT") {
        std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{report}");
}
