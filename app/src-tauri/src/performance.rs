//! Opt-in repeatable synthetic workload; never opens a user's database.
use crate::{
    contract::{list, text},
    store::Store,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Instant;

fn measure(mut run: impl FnMut() -> Value) -> Value {
    let mut milliseconds = Vec::new();
    let mut bytes = 0;
    for _ in 0..3 {
        let start = Instant::now();
        let value = run();
        bytes = serde_json::to_vec(&value).unwrap().len();
        milliseconds.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    milliseconds.sort_by(f64::total_cmp);
    json!({"medianMs":milliseconds[1],"maxMs":milliseconds[2],"jsonBytes":bytes})
}

#[test]
#[ignore = "synthetic performance workload; run with --release --ignored --nocapture"]
fn desktop_stress() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().into()).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO banks VALUES('bulk','Bulk','',1)", [])
        .unwrap();
    tx.execute("INSERT INTO banks VALUES('small','Small','',2)", [])
        .unwrap();
    for i in 0..5000 {
        let id = format!("q{i}");
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,?2,?3,?4,'true_false','[]',1,0,'[]')", params![id,if i<20 {"small"} else {"bulk"},i,format!("Question {i}")]).unwrap();
        tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    let mut report = json!({"questions":5000,"attempts":1000,"repetitions":3});
    report["allQuestions"] = measure(|| {
        let rows = store.questions(None, "", "", "").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 5000);
        rows
    });
    report["smallBank"] = measure(|| {
        let rows = store.questions(Some("small"), "", "", "").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 20);
        rows
    });
    report["firstPage"] = measure(|| {
        let page = store
            .query_questions(None, &[], ("", "", ""), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 5000);
        assert_eq!(list(&page, "items").len(), 30);
        page
    });
    let frozen = crate::questions::freeze(&store.question_rows().unwrap()[..1000]);
    let ids: Vec<_> = list(&frozen, "questions")
        .iter()
        .map(|q| text(q, "id").to_owned())
        .collect();
    for i in 0..3 {
        let sid = format!("exam{i}");
        db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind) VALUES(?1,'Exam',?2,0,'ordered','self_test')", params![sid,crate::store::now()]).unwrap();
        db.execute(
            "INSERT INTO session_documents VALUES(?1,?2)",
            params![sid, frozen.to_string()],
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        for (ordinal, id) in ids.iter().enumerate() {
            tx.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,answer,max_cents) VALUES(?1,?2,?3,?3,'{\"value\":true}',100)",params![sid,ordinal,id]).unwrap();
        }
        tx.commit().unwrap();
    }
    report["session"] = measure(|| {
        let session = store.session("exam0").unwrap();
        assert_eq!(list(&session, "attempts").len(), 1000);
        assert!(session["attempts"][0]["snapshot"]["question"]["answerPayload"].is_null());
        session
    });
    report["saveAttempt"] = measure(|| {
        store
            .save_attempt(("exam0", 0), json!({"value":true}), 0, false, false, None)
            .unwrap()
    });
    report["saveDraft"] = measure(|| {
        store
            .save_draft(("exam0", 0), json!({"value":true}), 0)
            .unwrap()
    });
    let mut saves = Vec::new();
    for i in 0..100 {
        let start = Instant::now();
        assert!(store
            .save_draft(("exam0", 0), json!({"value":i%2==1}), 0)
            .unwrap()
            .is_null());
        saves.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    saves.sort_by(f64::total_cmp);
    assert_eq!(
        Store::new(dir.path().into())
            .unwrap()
            .session("exam0")
            .unwrap()["attempts"][0]["answer"],
        json!({"value":true})
    );
    report["draftBurst"] =
        json!({"writes":100,"p50Ms":saves[50],"p95Ms":saves[95],"lastAnswerSurvivesReopen":true});
    let mut i = 0;
    report["submit"] = measure(|| {
        let sid = format!("exam{i}");
        i += 1;
        let session = store.submit_paper(&sid, true).unwrap();
        assert!(list(&session, "attempts")
            .iter()
            .all(|a| a["earnedCents"] == 100));
        session
    });
    let output =
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT to the report path");
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{report}");
}
