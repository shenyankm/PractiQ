use crate::{
    contract::{list, text},
    exams::Paper,
    language::Locale,
    store::{hash, Store},
};
use rusqlite::params;
use serde_json::{json, Value};
use std::io::Write;

fn setup() -> (tempfile::TempDir, Store, Vec<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().to_owned()).unwrap();
    let preview = store
        .preview(
            include_bytes!("../../fixtures/sample.json").to_vec(),
            "英语".into(),
        )
        .unwrap();
    let bank = store
        .import(text(&preview, "ticket"), None, "英语")
        .unwrap();
    let rows = store
        .questions(Some(text(&bank, "bankId")), "", "", "")
        .unwrap();
    (dir, store, rows.as_array().unwrap().clone())
}

fn start(store: &Store, rows: &[Value], kind: &str) -> Value {
    let question_ids = rows
        .iter()
        .map(|q| text(q, "id").to_owned())
        .collect::<Vec<_>>();
    let selected =
        crate::paper::selected_rows(&store.question_rows().unwrap(), &question_ids).unwrap();
    store
        .start_paper(Paper {
            question_ids,
            digest: crate::paper::digest(&selected).unwrap(),
            kind: kind.into(),
            minutes: (kind == "mock_exam").then_some(60),
            scores: if kind == "practice" {
                vec![]
            } else {
                vec![100; rows.len()]
            },
            total_cents: if kind == "practice" {
                0
            } else {
                rows.len() as i64 * 100
            },
        })
        .unwrap()
}

#[test]
fn titles_draft_progress_activity_and_filters_match_session_lifecycle() {
    let (_dir, store, rows) = setup();
    let practice = start(&store, &rows[..1], "practice");
    let exam = start(&store, &[rows[2].clone(), rows[4].clone()], "mock_exam");
    assert_eq!(practice["title"], "英语 · 练习 · 1 题");
    assert_eq!(exam["title"], "英语 · 限时模考 · 2 题");
    let pid = text(&practice, "id");
    let eid = text(&exam, "id");
    store
        .save_draft((eid, 0), json!({"value":false}), 0)
        .unwrap();
    store.save_draft((eid, 1), json!({"text":"  "}), 0).unwrap();
    let page = store.sessions_filtered(30, 0, "active").unwrap();
    let summary = list(&page, "items")
        .iter()
        .find(|s| s["id"] == eid)
        .unwrap();
    assert_eq!(summary["answered"], 0);
    assert_eq!(summary["draftAnswered"], 1);
    assert_eq!(summary["kind"], "mock_exam");
    assert_eq!(summary["deadlineAt"], exam["deadlineAt"]);
    assert_eq!(page["total"], 2);
    store
        .connect()
        .unwrap()
        .execute("UPDATE sessions SET last_active_at=1", [])
        .unwrap();
    store
        .save_draft((pid, 0), json!({"correct":["A"]}), 0)
        .unwrap();
    let resumed = store.unfinished_session().unwrap();
    assert_eq!(resumed["id"], pid);
    assert!(resumed["lastActiveAt"].as_i64().unwrap() > 1);
    store.submit_paper(eid, true).unwrap();
    assert_eq!(
        store.sessions_filtered(30, 0, "active").unwrap()["total"],
        1
    );
    let review = store.sessions_filtered(30, 999, "review").unwrap();
    assert_eq!(review["total"], 1);
    assert_eq!(review["offset"], 0);
    assert_eq!(review["items"][0]["answered"], 2);
    assert_eq!(review["items"][0]["draftAnswered"], 0);
    store.complete_review(eid).unwrap();
    assert_eq!(
        store.sessions_filtered(30, 0, "finished").unwrap()["total"],
        1
    );
    assert_eq!(store.sessions_filtered(30, 0, "all").unwrap()["total"], 2);
    assert!(store.sessions_filtered(30, 0, "unknown").is_err());
    assert_eq!(practice["bankIds"], json!([rows[0]["bankId"]]));
    store.delete_bank(text(&rows[0], "bankId")).unwrap();
    assert_eq!(store.session(pid).unwrap()["bankIds"], json!([]));
}

#[test]
fn completed_practice_accepts_only_self_assessment_without_changing_answers() {
    let (_dir, store, rows) = setup();
    let session = start(
        &store,
        &[
            rows[0].clone(),
            rows[3].clone(),
            rows[4].clone(),
            rows[8].clone(),
        ],
        "practice",
    );
    let sid = text(&session, "id");
    assert!(store.self_assess(sid, 2, true).is_err());
    for (ordinal, answer) in [
        json!({"correct":["A"]}),
        json!({"answers":["南京"]}),
        json!({"text":"自己的回答"}),
    ]
    .into_iter()
    .enumerate()
    {
        store.save_draft((sid, ordinal), answer, 0).unwrap();
    }
    let finished = store.submit_paper(sid, true).unwrap();
    assert!(store.self_assess(sid, 0, false).is_err());
    assert!(store.self_assess(sid, 3, true).is_err());
    assert!(store.self_assess(sid, 100, true).is_err());
    store.self_assess(sid, 1, true).unwrap();
    let graded = store.self_assess(sid, 2, false).unwrap();
    for ordinal in 0..4 {
        for key in [
            "answer",
            "snapshot",
            "autoResult",
            "submittedAt",
            "skipped",
            "elapsedMs",
        ] {
            assert_eq!(
                graded["attempts"][ordinal][key],
                finished["attempts"][ordinal][key]
            );
        }
    }
    assert_eq!(graded["finishedAt"], finished["finishedAt"]);
    assert_eq!(graded["attempts"][1]["result"], true);
    assert_eq!(graded["attempts"][1]["autoResult"], false);
    assert_eq!(graded["attempts"][2]["gradeKind"], "self");
    assert_eq!(graded["attempts"][2]["result"], false);
    assert!(store
        .save_draft((sid, 2), json!({"text":"改写答案"}), 0)
        .is_err());
    let exam = start(&store, &rows[4..5], "self_test");
    store
        .save_draft((text(&exam, "id"), 0), json!({"text":"回答"}), 0)
        .unwrap();
    store.submit_paper(text(&exam, "id"), true).unwrap();
    assert!(store.self_assess(text(&exam, "id"), 0, true).is_err());
}

#[test]
fn grading_replays_frozen_language_and_legacy_payloads_and_clears_stale_failures() {
    let (_dir, mut store, rows) = setup();
    store.locale = Locale::English;
    let session = start(&store, &rows[4..5], "self_test");
    assert_eq!(session["title"], "英语 · Self-test · 1 question");
    let sid = text(&session, "id");
    store
        .save_draft((sid, 0), json!({"text":"My answer"}), 0)
        .unwrap();
    store.submit_paper(sid, true).unwrap();
    let english = store.prepare_grade(sid, 0, false).unwrap();
    let input: Value = serde_json::from_str(text(&english, "payload")).unwrap();
    assert_eq!(input["feedbackLocale"], "en");
    store.locale = Locale::Chinese;
    assert_eq!(store.prepare_grade(sid, 0, false).unwrap(), english);
    let chinese = store.prepare_grade(sid, 0, true).unwrap();
    assert_ne!(chinese["inputDigest"], english["inputDigest"]);
    assert_ne!(chinese["requestId"], english["requestId"]);
    let rid = text(&chinese, "requestId");
    store
        .record_grade(
            sid,
            0,
            rid,
            &json!({"status":"unknown","error":"unknown outcome"}),
        )
        .unwrap();
    let graded = store.record_grade(sid, 0, rid, &json!({"status":"graded","result":{"scoreCents":70,"maxCents":100,"reason":"Partial credit","evidence":[],"reviewReasons":[]}})).unwrap();
    assert!(graded["attempts"][0]["grading"]
        .get("lastRequest")
        .is_none());
    assert_eq!(graded["attempts"][0]["earnedCents"], 70);
    let mut old_input: Value = serde_json::from_str(text(&chinese, "payload")).unwrap();
    old_input.as_object_mut().unwrap().remove("feedbackLocale");
    let old_raw = old_input.to_string();
    let old_digest = hash(old_raw.as_bytes());
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE grade_requests SET input=?2 WHERE id=?1",
            params![
                rid,
                json!({"requestId":rid,"inputDigest":old_digest}).to_string()
            ],
        )
        .unwrap();
    store.locale = Locale::English;
    assert_eq!(
        store.prepare_grade(sid, 0, false).unwrap(),
        json!({"requestId":rid,"inputDigest":old_digest,"payload":old_raw})
    );
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE grade_requests SET input=?2 WHERE id=?1",
            params![
                rid,
                json!({"requestId":rid,"inputDigest":"invalid"}).to_string()
            ],
        )
        .unwrap();
    assert!(store.prepare_grade(sid, 0, false).is_err());
    store
        .manual_score(sid, 0, 90, "Manual partial credit")
        .unwrap();
    let current = store
        .questions(Some(text(&rows[4], "bankId")), "", "", "")
        .unwrap();
    let partial = current
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == rows[4]["id"])
        .unwrap();
    assert_eq!(partial["latestResult"], false);
    assert_eq!(
        partial["latestScore"],
        json!({"earnedCents":90,"maxCents":100,"gradeKind":"manual"})
    );
    let ungraded = current
        .as_array()
        .unwrap()
        .iter()
        .find(|q| q["id"] == rows[8]["id"])
        .unwrap();
    assert!(ungraded["latestResult"].is_null());
    assert!(ungraded["latestScore"].is_null());
}

#[test]
fn old_schema_ten_databases_and_backups_gain_activity_without_losing_compatibility() {
    let legacy = tempfile::tempdir().unwrap();
    let path = legacy.path().join("practiq.sqlite");
    let old_schema = include_str!("schema.sql").replace(", last_active_at INTEGER", "");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(&old_schema).unwrap();
    drop(db);
    let bytes = std::fs::read(&path).unwrap();
    let archive = legacy.path().join("legacy.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(json!({"format":"practiq-backup","version":4,"schemaVersion":10,"createdAt":1,"database":{"file":"practiq.sqlite","sha256":hash(&bytes),"sizeBytes":bytes.len()},"assets":[]}).to_string().as_bytes()).unwrap();
    zip.start_file("practiq.sqlite", options).unwrap();
    zip.write_all(&bytes).unwrap();
    zip.finish().unwrap();
    let (_dir, mut target, _rows) = setup();
    target.restore(&archive).unwrap();
    assert_eq!(target.banks().unwrap(), json!([]));
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("INSERT INTO sessions(id,bank_title,created_at,finished_at,position,mode) VALUES('old','Old',1,10,0,'ordered')", []).unwrap();
    drop(db);
    let migrated = Store::new(legacy.path().to_owned()).unwrap();
    let activity: i64 = migrated
        .connect()
        .unwrap()
        .query_row(
            "SELECT last_active_at FROM sessions WHERE id='old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(activity, 10);
    migrated
        .connect()
        .unwrap()
        .execute(
            "INSERT INTO session_documents VALUES('old',?1)",
            [json!({"schemaVersion":3,"questions":[],"groups":[],"visuals":[]}).to_string()],
        )
        .unwrap();
    let backup = legacy.path().join("migrated.zip");
    migrated.backup(&backup).unwrap();
    target.restore(&backup).unwrap();
}
