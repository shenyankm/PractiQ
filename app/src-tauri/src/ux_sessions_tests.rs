use crate::{
    contract::{list, text},
    exams::Paper,
    language::Locale,
    store::{hash, Store},
};
use rusqlite::params;
use serde_json::{json, Value};

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
fn grading_replays_frozen_language_and_rejects_missing_locale_and_clears_stale_failures() {
    let (_dir, mut store, rows) = setup();
    store.locale = Locale::English;
    let session = start(&store, &rows[4..5], "self_test");
    assert_eq!(session["title"], "英语 · Self-test · 1 question");
    let sid = text(&session, "id");
    store
        .save_draft((sid, 0), json!({"text":"My answer"}), 0)
        .unwrap();
    store.submit_paper(sid, true).unwrap();
    store.locale = Locale::Chinese;
    let english = store.prepare_grade(sid, 0, false, Locale::English).unwrap();
    let input: Value = serde_json::from_str(text(&english, "payload")).unwrap();
    assert_eq!(input["feedbackLocale"], "en");
    store.locale = Locale::Chinese;
    assert_eq!(
        store.prepare_grade(sid, 0, false, Locale::Chinese).unwrap(),
        english
    );
    store.locale = Locale::English;
    let chinese = store.prepare_grade(sid, 0, true, Locale::Chinese).unwrap();
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
        store
            .prepare_grade(sid, 0, false, Locale::Chinese)
            .unwrap_err()
            .code,
        "LOCAL_GRADING_INPUT_CHANGED"
    );
    store
        .connect()
        .unwrap()
        .execute(
            "UPDATE grade_requests SET input=?2 WHERE id=?1",
            params![
                rid,
                json!({"requestId":rid,"inputDigest":"invalid","feedbackLocale":"en"}).to_string()
            ],
        )
        .unwrap();
    assert!(store.prepare_grade(sid, 0, false, Locale::Chinese).is_err());
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
fn clock_jumps_do_not_reject_drafts_or_change_a_running_exam_deadline() {
    let (_dir, store, rows) = setup();
    let wall = 1_800_000_000_000;
    store.session_clock.set(wall, 1_000);
    let exam = start(&store, &rows[..1], "mock_exam");
    let sid = text(&exam, "id");
    store.session_clock.set(wall - 120_000, 31_000);
    store
        .save_draft((sid, 0), json!({"correct":["A"]}), 30_000)
        .unwrap();
    assert_eq!(store.session(sid).unwrap()["clockNow"], wall + 30_000);
    store.session_clock.set(wall + 7_200_000, 61_000);
    store
        .save_draft((sid, 0), json!({"correct":["B"]}), 60_000)
        .unwrap();
    let active = store.session(sid).unwrap();
    assert!(active["submittedAt"].is_null());
    assert_eq!(active["clockNow"], wall + 60_000);
    assert_eq!(active["deadlineAt"], wall + 3_600_000);
    assert_eq!(
        store.sessions_filtered(30, 0, "review").unwrap()["total"],
        0
    );
    // The native tick includes sleep; no frontend interval or write is needed to expire.
    store.session_clock.set(wall - 120_000, 3_601_000);
    assert_eq!(
        store.sessions_filtered(30, 0, "review").unwrap()["total"],
        1
    );
    let expired = store.session(sid).unwrap();
    assert!(expired["submittedAt"].is_number());
    assert_eq!(expired["attempts"][0]["answer"], json!({"correct":["B"]}));
}

#[test]
fn clock_restart_clamps_backwards_time_and_preserves_drafts_on_forward_expiry() {
    let (dir, store, rows) = setup();
    let wall = 1_800_000_000_000;
    store.session_clock.set(wall, 1_000);
    let exam = start(&store, &rows[..1], "mock_exam");
    let sid = text(&exam, "id");
    store.session_clock.set(wall + 300_000, 301_000);
    store
        .save_draft((sid, 0), json!({"correct":["A"]}), 300_000)
        .unwrap();
    drop(store);
    let reopened = Store::new(dir.path().to_owned()).unwrap();
    reopened.session_clock.set(wall - 120_000, 500_000);
    let resumed = reopened.session(sid).unwrap();
    assert_eq!(resumed["clockNow"], wall + 300_000);
    assert_eq!(resumed["deadlineAt"], exam["deadlineAt"]);
    reopened.session_clock.set(wall - 120_000, 620_000);
    reopened
        .save_draft((sid, 0), json!({"correct":["B"]}), 420_000)
        .unwrap();
    assert_eq!(reopened.session(sid).unwrap()["clockNow"], wall + 420_000);
    drop(reopened);
    // While closed there is no trusted clock: a forward wall time follows the stored deadline.
    let reopened = Store::new(dir.path().to_owned()).unwrap();
    reopened.session_clock.set(wall + 7_200_000, 10);
    let expired = reopened.session(sid).unwrap();
    assert!(expired["submittedAt"].is_number());
    assert_eq!(expired["attempts"][0]["answer"], json!({"correct":["B"]}));
}

#[test]
fn clock_initializes_from_all_saved_sessions_once_without_history_jumps() {
    let (dir, store, rows) = setup();
    let wall = 1_800_000_000_000;
    store.session_clock.set(wall + 7_200_000, 1_000);
    let old = start(&store, &rows[..1], "practice");
    let old_id = text(&old, "id");
    store
        .save_draft((old_id, 0), json!({"correct":["A"]}), 0)
        .unwrap();
    drop(store);
    let reopened = Store::new(dir.path().to_owned()).unwrap();
    reopened.session_clock.set(wall, 100);
    let current = start(&reopened, &rows[..1], "mock_exam");
    let sid = text(&current, "id");
    assert_eq!(current["createdAt"], wall + 7_200_000);
    assert_eq!(current["deadlineAt"], wall + 10_800_000);
    reopened.session_clock.set(wall + 7_200_000, 30_100);
    // A later read of another session, even one with a future saved timestamp,
    // cannot redefine an exam's already established monotonic time domain.
    reopened
        .connect()
        .unwrap()
        .execute(
            "UPDATE sessions SET last_active_at=?2 WHERE id=?1",
            params![old_id, wall + 14_400_000],
        )
        .unwrap();
    reopened.session(old_id).unwrap();
    let active = reopened.session(sid).unwrap();
    assert!(active["submittedAt"].is_null());
    assert_eq!(active["clockNow"], wall + 7_230_000);
    let summary = reopened.sessions_filtered(30, 0, "active").unwrap();
    let summary = list(&summary, "items")
        .iter()
        .find(|s| s["id"] == sid)
        .unwrap();
    assert_eq!(summary["clockNow"], active["clockNow"]);
    assert_eq!(summary["deadlineAt"], active["deadlineAt"]);
}
