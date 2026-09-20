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
fn practice(store: &Store, rows: Value, count: usize) -> Value {
    store
        .start_paper(crate::exams::Paper {
            question_ids: rows.as_array().unwrap()[..count]
                .iter()
                .map(|q| text(q, "id").to_owned())
                .collect(),
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
        })
        .unwrap()
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
    let session = practice(&s, s.questions(Some(&bank), "", "choice", "").unwrap(), 1);
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
    let retry = practice(
        &s,
        s.questions(Some(&bank), "", "choice", "wrong").unwrap(),
        1,
    );
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
    let session = practice(&s, qs.clone(), 9);
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
    let session = practice(
        &s,
        s.questions(Some(&bank), "", "fill_blank", "").unwrap(),
        1,
    );
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
    let subjective = practice(
        &s,
        s.questions(Some(&bank), "", "short_answer", "").unwrap(),
        2,
    );
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
        6
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

#[test]
fn exam_submit_expiry_scores_and_manual_override() {
    use crate::exams::Paper;
    let (_dir, mut s) = store();
    let bank = import(&mut s);
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    let ids = vec![text(&qs[0], "id").to_owned(), text(&qs[4], "id").to_owned()];
    let exam = s
        .start_paper(Paper {
            question_ids: ids,
            kind: "mock_exam".into(),
            minutes: Some(60),
            scores: vec![333, 667],
            total_cents: 1000,
        })
        .unwrap();
    let sid = text(&exam, "id");
    assert!(exam["attempts"][0]["snapshot"]["question"]["answerPayload"].is_null());
    assert!(s
        .save_attempt((sid, 0), json!({"correctOption":"A"}), 0, true, false, None)
        .is_err());
    s.save_attempt(
        (sid, 0),
        json!({"correctOption":"A"}),
        0,
        false,
        false,
        None,
    )
    .unwrap();
    s.save_attempt((sid, 1), json!({"text":"学生作答"}), 0, false, false, None)
        .unwrap();
    s.flag(sid, 1, true).unwrap();
    let result = s.submit_paper(sid, true).unwrap();
    assert_eq!(result["attempts"][0]["earnedCents"], 333);
    assert!(result["attempts"][1]["earnedCents"].is_null());
    assert_eq!(result["attempts"][1]["flagged"], true);
    assert_eq!(s.submit_paper(sid, true).unwrap(), result);
    assert!(s
        .save_attempt((sid, 0), json!(null), 0, false, false, None)
        .is_err());
    let request = s.prepare_grade(sid, 1, false).unwrap();
    assert_eq!(request, s.prepare_grade(sid, 1, false).unwrap());
    let response = json!({"status":"graded","result":{"scoreCents":400,"maxCents":667,"reason":"部分得分","evidence":[],"reviewReasons":[]}});
    s.record_grade(sid, 1, text(&request, "requestId"), &response)
        .unwrap();
    let result = s.manual_score(sid, 1, 500, "复核得分点").unwrap();
    assert_eq!(result["attempts"][1]["earnedCents"], 500);
    assert!(s.manual_score(sid, 1, 668, "越界").is_err());
    let late = s
        .record_grade(sid, 1, text(&request, "requestId"), &response)
        .unwrap();
    assert_eq!(late["attempts"][1]["earnedCents"], 500);
    assert_eq!(late["attempts"][1]["gradeKind"], "manual");
    let failed = s
        .record_grade(
            sid,
            1,
            text(&request, "requestId"),
            &json!({"status":"unknown","error":"timeout"}),
        )
        .unwrap();
    assert_eq!(failed["attempts"][1]["earnedCents"], 500);
    assert_eq!(
        failed["attempts"][1]["grading"]["manualHistory"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.retry_wrong(sid).unwrap()["attempts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let exam = s
        .start_paper(Paper {
            question_ids: vec![text(&qs[0], "id").into()],
            kind: "mock_exam".into(),
            minutes: Some(1),
            scores: vec![100],
            total_cents: 100,
        })
        .unwrap();
    let sid = text(&exam, "id");
    s.save_attempt(
        (sid, 0),
        json!({"correctOption":"B"}),
        0,
        false,
        false,
        None,
    )
    .unwrap();
    s.connect()
        .unwrap()
        .execute("UPDATE sessions SET deadline_at=0 WHERE id=?1", [sid])
        .unwrap();
    let reopened = Store::new(s.dir.clone()).unwrap().session(sid).unwrap();
    assert!(reopened["submittedAt"].is_number());
    assert_eq!(reopened["attempts"][0]["earnedCents"], 0);
    assert!(s
        .save_attempt(
            (sid, 0),
            json!({"correctOption":"A"}),
            0,
            false,
            false,
            None
        )
        .is_err());
}

#[test]
fn merged_copy_filters_grading_and_backup_preserve_independence() {
    use crate::exams::Paper;
    let (dir, mut s) = store();
    let bank = import(&mut s);
    let p = s.preview(sample(), "second".into()).unwrap();
    let second = s.import(text(&p, "ticket"), None, "second").unwrap();
    let second = text(&second, "bankId").to_owned();
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    let mut q = qs[4]["question"].clone();
    q["sourceScore"] = json!(5.25);
    q["scoringRubric"] = json!("正确解释得 5.25 分");
    q["scoreSourceText"] = json!("本题 5.25 分");
    s.save_question(Some(text(&qs[4], "id").into()), &bank, q)
        .unwrap();
    s.favorite(text(&qs[4], "id"), true).unwrap();
    assert_eq!(
        s.questions_multi(None, std::slice::from_ref(&bank), "", "single", "")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        s.questions_multi(None, &[bank.clone(), second.clone()], "", "multiple", "")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let merged = s
        .merge_banks(&[bank.clone(), second.clone()], "merged")
        .unwrap();
    let new = text(&merged, "bankId");
    assert_eq!(merged["count"], 18);
    let copied = s.questions(Some(new), "", "short_answer", "").unwrap();
    assert_eq!(copied[0]["question"]["sourceScore"], 5.25);
    assert_eq!(copied[0]["favorite"], true);
    let paper = s
        .start_paper(Paper {
            question_ids: vec![text(&copied[0], "id").into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![100],
            total_cents: 100,
        })
        .unwrap();
    let sid = text(&paper, "id");
    s.save_attempt((sid, 0), json!({"text":"回答"}), 0, false, false, None)
        .unwrap();
    s.submit_paper(sid, true).unwrap();
    s.prepare_grade(sid, 0, false).unwrap();
    s.manual_score(sid, 0, 75, "部分得分").unwrap();
    s.delete_bank(&bank).unwrap();
    s.delete_bank(&second).unwrap();
    assert_eq!(
        s.questions(Some(new), "", "", "")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        18
    );
    let backup = dir.path().join("exam.zip");
    s.backup(&backup).unwrap();
    s.restore(&backup).unwrap();
    assert_eq!(s.session(sid).unwrap()["attempts"][0]["earnedCents"], 75);
    assert_eq!(
        s.connect()
            .unwrap()
            .query_row("SELECT count(*) FROM grade_requests", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let before = s.banks().unwrap();
    assert!(s
        .merge_banks(&[new.into(), "deleted".into()], "bad")
        .is_err());
    assert_eq!(before, s.banks().unwrap());
    let session = practice(&s, s.questions(Some(new), "", "true_false", "").unwrap(), 1);
    let sid = text(&session, "id");
    s.save_attempt((sid, 0), json!({"value":false}), 0, false, false, None)
        .unwrap();
    let done = s.submit_paper(sid, true).unwrap();
    assert_eq!(done["attempts"][0]["skipped"], false);
    let unattempted = s
        .questions(Some(new), "", "true_false", "unattempted")
        .unwrap();
    assert_eq!(unattempted.as_array().unwrap().len(), 1);
}

#[test]
fn exam_hides_answer_roles_and_reads_live_favorites_without_changing_snapshot() {
    use crate::exams::Paper;
    let (_dir, mut s) = store();
    let bank = import(&mut s);
    let qs = s.questions(Some(&bank), "", "", "").unwrap();
    let qid = text(&qs[4], "id");
    let roles = [
        "answer_key",
        "correct-answer",
        "reference answer",
        "MODEL ANSWER",
        "worked_solution",
        "answer explanation",
        "评分细则",
        "参考答案",
        "解答过程",
    ];
    let mut q = qs[4]["question"].clone();
    q["confidence"] = json!(1e-7);
    let mut blocks: Vec<Value> = roles
        .iter()
        .map(|role| json!({"partType":"text","role":role,"textValue":"secret"}))
        .collect();
    blocks.push(json!({"partType":"text","role":"stem","textValue":"prompt"}));
    q["contentBlocks"] = json!(blocks);
    s.save_question(Some(qid.into()), &bank, q).unwrap();
    let exam = s
        .start_paper(Paper {
            question_ids: vec![qid.into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![500],
            total_cents: 500,
        })
        .unwrap();
    let sid = text(&exam, "id");
    assert_eq!(
        list(
            &exam["attempts"][0]["snapshot"]["question"],
            "contentBlocks"
        )
        .len(),
        1
    );
    assert_eq!(exam["attempts"][0]["favorite"], false);
    s.favorite(qid, true).unwrap();
    let refreshed = s.session(sid).unwrap();
    assert_eq!(refreshed["attempts"][0]["favorite"], true);
    assert_eq!(
        refreshed["attempts"][0]["snapshot"],
        exam["attempts"][0]["snapshot"]
    );
    s.favorite(qid, false).unwrap();
    assert_eq!(s.session(sid).unwrap()["attempts"][0]["favorite"], false);
    s.save_attempt((sid, 0), json!({"text":"中文\n😀"}), 0, false, false, None)
        .unwrap();
    let submitted = s.submit_paper(sid, true).unwrap();
    assert_eq!(
        list(
            &submitted["attempts"][0]["snapshot"]["question"],
            "contentBlocks"
        )
        .len(),
        roles.len() + 1
    );
    let wire = s.prepare_grade(sid, 0, false).unwrap();
    let raw = text(&wire, "payload");
    assert!(raw.contains("1e-7"));
    assert_eq!(
        text(&wire, "inputDigest"),
        crate::store::hash(raw.as_bytes())
    );
    let input: Value = serde_json::from_str(raw).unwrap();
    assert_eq!(input["answer"], "中文\n😀");
    assert_eq!(wire, s.prepare_grade(sid, 0, false).unwrap());
    let retried = s.prepare_grade(sid, 0, true).unwrap();
    assert_eq!(wire["inputDigest"], retried["inputDigest"]);
    assert_ne!(wire["requestId"], retried["requestId"]);
    s.delete_bank(&bank).unwrap();
    assert!(s.session(sid).unwrap()["attempts"][0]["favorite"].is_null());
}

#[test]
fn ai_import_receipts_deduplicate_versions_and_survive_backup_without_work_manifests() {
    use crate::store::{ImportSource, Pending};
    let (dir, mut s) = store();
    let task = crate::store::id();
    let mut result: Value = serde_json::from_slice(&sample()).unwrap();
    result["visualElements"] = json!([]);
    let mut pending = Pending::new(serde_json::to_vec(&result).unwrap(), "first".into()).unwrap();
    pending.source = Some(ImportSource {
        thread_id: task.clone(),
        checkpoint_id: "cp1".into(),
    });
    let first = s.import_pending(&pending, None, "first").unwrap();
    let duplicate = s
        .import_pending(&pending, None, "new bank should not exist")
        .unwrap();
    assert_eq!(duplicate["bankId"], first["bankId"]);
    assert_eq!(duplicate["duplicate"], true);
    result["questions"][0]["stem"] = json!("Changed source result");
    let mut revised = Pending::new(serde_json::to_vec(&result).unwrap(), "second".into()).unwrap();
    revised.source = Some(ImportSource {
        thread_id: task.clone(),
        checkpoint_id: "cp2".into(),
    });
    let second = s.import_pending(&revised, None, "second").unwrap();
    assert_ne!(second["bankId"], first["bankId"]);
    let db = s.connect().unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM ai_imports", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    std::fs::create_dir_all(dir.path().join("ai/import-batches")).unwrap();
    std::fs::write(
        dir.path().join("ai/import-batches/excluded.json"),
        b"not backed up",
    )
    .unwrap();
    let archive = dir.path().join("receipt-backup.zip");
    s.backup(&archive).unwrap();
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
    for i in 0..zip.len() {
        assert!(!zip.by_index(i).unwrap().name().starts_with("ai/"));
    }
    s.restore(&archive).unwrap();
    assert_eq!(
        s.import_pending(&pending, None, "after restore").unwrap()["bankId"],
        first["bankId"]
    );
    assert_eq!(
        s.imported_ai(&task, Some(&revised.digest().unwrap()), None)
            .unwrap(),
        second["bankId"].as_str().map(String::from)
    );
}

#[test]
fn database_failure_rolls_back_bank_and_receipt_together() {
    use crate::store::{ImportSource, Pending};
    let (_dir, s) = store();
    let mut result: Value = serde_json::from_slice(&sample()).unwrap();
    result["visualElements"] = json!([]);
    let mut pending = Pending::new(serde_json::to_vec(&result).unwrap(), "failure".into()).unwrap();
    pending.source = Some(ImportSource {
        thread_id: crate::store::id(),
        checkpoint_id: "cp".into(),
    });
    let db = s.connect().unwrap();
    db.execute_batch("CREATE TRIGGER fail_questions BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;").unwrap();
    assert!(s.import_pending(&pending, None, "failure").is_err());
    for table in ["banks", "imports", "ai_imports", "questions"] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn e2e_exam_restart_restore_on_fresh_install_and_retry() {
    use crate::exams::Paper;
    let (dir, mut source) = store();
    let preview = source.preview(sample(), "离线题库".into()).unwrap();
    source
        .resources(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources"))
        .unwrap();
    let imported = source
        .import(text(&preview, "ticket"), None, "离线题库")
        .unwrap();
    let bank = text(&imported, "bankId");
    let rows = source.questions(Some(bank), "", "", "").unwrap();
    let digest = text(&rows[8]["visuals"][0]["imageRef"], "sha256");
    let image = source.asset(digest).unwrap();
    source.favorite(text(&rows[0], "id"), true).unwrap();
    let exam = source
        .start_paper(Paper {
            question_ids: vec![text(&rows[0], "id").into(), text(&rows[4], "id").into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![300, 700],
            total_cents: 1000,
        })
        .unwrap();
    let sid = text(&exam, "id");
    source
        .save_attempt(
            (sid, 0),
            json!({"correctOption":"B"}),
            1200,
            false,
            false,
            None,
        )
        .unwrap();
    source
        .save_attempt(
            (sid, 1),
            json!({"text":"我的作答"}),
            2300,
            false,
            false,
            None,
        )
        .unwrap();
    source.position(sid, 1).unwrap();
    drop(source);

    let source = Store::new(dir.path().to_owned()).unwrap();
    let resumed = source.session(sid).unwrap();
    assert_eq!(resumed["position"], 1);
    assert_eq!(resumed["attempts"][1]["answer"], json!({"text":"我的作答"}));
    assert!(resumed["submittedAt"].is_null());
    let submitted = source.submit_paper(sid, true).unwrap();
    assert_eq!(submitted["attempts"][0]["earnedCents"], 0);
    assert!(submitted["attempts"][1]["earnedCents"].is_null());
    source.manual_score(sid, 1, 400, "覆盖部分得分点").unwrap();
    let finished = source.complete_review(sid).unwrap();
    let summaries = source.sessions().unwrap();
    assert_eq!(summaries[0]["earnedCents"], 400);
    assert_eq!(summaries[0]["totalCents"], 1000);
    let backup = dir.path().join("portable.zip");
    source.backup(&backup).unwrap();

    // Restore into an empty installation, so existing files cannot hide a broken backup.
    let (_destination, mut restored) = store();
    restored.restore(&backup).unwrap();
    assert_eq!(restored.session(sid).unwrap(), finished);
    assert_eq!(restored.sessions().unwrap(), summaries);
    assert_eq!(restored.asset(digest).unwrap(), image);
    assert_eq!(
        restored
            .questions(Some(bank), "", "", "favorite")
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(restored
        .save_attempt(
            (sid, 0),
            json!({"correctOption":"A"}),
            0,
            false,
            false,
            None
        )
        .is_err());
    let retry = restored.retry_wrong(sid).unwrap();
    assert_eq!(retry["attempts"].as_array().unwrap().len(), 2);
    let retried = restored
        .save_attempt(
            (text(&retry, "id"), 0),
            json!({"correctOption":"A"}),
            10,
            true,
            false,
            None,
        )
        .unwrap();
    assert_eq!(retried["attempts"][0]["result"], true);
    restored.delete_bank(bank).unwrap();
    let mut expected = finished["attempts"].clone();
    // Live favorites disappear with the bank; immutable snapshots and scores remain.
    for attempt in expected.as_array_mut().unwrap() {
        attempt["favorite"] = Value::Null;
    }
    assert_eq!(restored.session(sid).unwrap()["attempts"], expected);
    assert_eq!(restored.asset(digest).unwrap(), image);
}

#[test]
fn rich_content_survives_import_reopen_practice_and_backup_exactly() {
    let (dir, mut s) = store();
    let mut expected: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/rich-content/expected.json"))
            .unwrap();
    expected["visualElements"][0]["sourceRef"] = expected["visualElements"][0]["imageRef"].clone();
    let p = s
        .preview(
            serde_json::to_vec(&expected).unwrap(),
            "Rich content".into(),
        )
        .unwrap();
    s.resources(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/rich-content/resources"),
    )
    .unwrap();
    let bank = text(
        &s.import(text(&p, "ticket"), None, "Rich content").unwrap(),
        "bankId",
    )
    .to_owned();
    let rows = s.questions(Some(&bank), "", "", "").unwrap();
    assert_eq!(rows[0]["question"], expected["questions"][0]);
    assert_eq!(
        rows[0]["visuals"][0]["imageRef"],
        expected["visualElements"][0]["imageRef"]
    );
    assert_eq!(
        rows[0]["visuals"][0]["sourceRef"],
        expected["visualElements"][0]["sourceRef"]
    );
    assert_eq!(rows[0]["missingAssets"], false);
    let digest = text(&expected["visualElements"][0]["imageRef"], "sha256");
    let image = s.asset(digest).unwrap();
    let session = practice(&s, rows.clone(), 1);
    let sid = text(&session, "id");
    let reopened = Store::new(dir.path().to_owned()).unwrap();
    assert_eq!(reopened.questions(Some(&bank), "", "", "").unwrap(), rows);
    assert_eq!(
        reopened.session(sid).unwrap()["attempts"][0]["snapshot"]["question"],
        expected["questions"][0]
    );
    drop(reopened);
    let backup = dir.path().join("rich.zip");
    s.backup(&backup).unwrap();
    s.delete_bank(&bank).unwrap();
    s.restore(&backup).unwrap();
    assert_eq!(s.questions(Some(&bank), "", "", "").unwrap(), rows);
    assert_eq!(s.asset(digest).unwrap(), image);
    let exam = s
        .start_paper(crate::exams::Paper {
            question_ids: vec![text(&rows[0], "id").into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![100],
            total_cents: 100,
        })
        .unwrap();
    assert!(exam["attempts"][0]["snapshot"]["visuals"][0]
        .get("sourceRef")
        .is_none());
    let submitted = s.submit_paper(text(&exam, "id"), true).unwrap();
    assert_eq!(
        submitted["attempts"][0]["snapshot"]["visuals"][0]["sourceRef"],
        expected["visualElements"][0]["sourceRef"]
    );
    // The added reference uses the same path and checksum boundary as crops.
    expected["visualElements"][0]["sourceRef"]["objectKey"] = json!("../escape.png");
    s.preview(serde_json::to_vec(&expected).unwrap(), "bad source".into())
        .unwrap();
    assert!(s.resources(dir.path()).is_err());
}

#[test]
fn source_image_upload_limit_survives_import_and_backup() {
    let (dir, mut s) = store();
    // A valid fixture image with trailing padding exercises the exact byte limit.
    let mut image = include_bytes!("../../fixtures/rich-content/resources/chart.png").to_vec();
    image.resize(25 * 1024 * 1024, 0);
    let digest = crate::store::hash(&image);
    std::fs::write(dir.path().join("page.png"), &image).unwrap();
    let mut raw: Value = serde_json::from_slice(&sample()).unwrap();
    raw["visualElements"] = json!([{"kind":"image","description":"Full page","questionIndexes":[0],
        "sourceRef":{"objectKey":"page.png","sha256":digest,"sizeBytes":image.len(),"mediaType":"image/png"}}]);
    let preview = s
        .preview(serde_json::to_vec(&raw).unwrap(), "Source page".into())
        .unwrap();
    s.resources(dir.path()).unwrap();
    let imported = s
        .import(text(&preview, "ticket"), None, "Source page")
        .unwrap();
    let rows = s
        .questions(Some(text(&imported, "bankId")), "", "", "")
        .unwrap();
    assert_eq!(rows[0]["missingAssets"], false);
    let backup = dir.path().join("source.zip");
    s.backup(&backup).unwrap();
    let (_fresh, mut restored) = store();
    restored.restore(&backup).unwrap();
    assert_eq!(
        restored.read_asset(&digest, image.len() as u64).unwrap(),
        image
    );
    image.push(0);
    std::fs::write(dir.path().join("page.png"), &image).unwrap();
    raw["visualElements"][0]["sourceRef"]["sizeBytes"] = json!(image.len());
    raw["visualElements"][0]["sourceRef"]["sha256"] = json!(crate::store::hash(&image));
    s.preview(serde_json::to_vec(&raw).unwrap(), "Too large".into())
        .unwrap();
    assert!(s.resources(dir.path()).is_err());
    assert!(s.write_asset(&crate::store::hash(&image), &image).is_err());
}

#[test]
fn exam_filters_answer_table_and_crop_then_restores_original_snapshot() {
    let (_dir, mut s) = store();
    let mut raw: Value = serde_json::from_slice(&sample()).unwrap();
    raw["questions"][0]["contentBlocks"] = json!([
        {"partType":"table","role":"answer","markdownValue":"| Answer |\n| --- |\n| SECRET |"},
        {"partType":"table","role":"material","markdownValue":"| Input |\n| --- |\n| 3 |"}
    ]);
    raw["visualElements"] = json!([
        {"kind":"table","role":"answer","description":"SECRET","extractedText":"SECRET","questionIndexes":[0]},
        {"kind":"table","role":"material","description":"Input table","questionIndexes":[0]}
    ]);
    let preview = s
        .preview(serde_json::to_vec(&raw).unwrap(), "Answer table".into())
        .unwrap();
    let imported = s
        .import(text(&preview, "ticket"), None, "Answer table")
        .unwrap();
    let rows = s
        .questions(Some(text(&imported, "bankId")), "", "", "")
        .unwrap();
    let exam = s
        .start_paper(crate::exams::Paper {
            question_ids: vec![text(&rows[0], "id").into()],
            kind: "self_test".into(),
            minutes: None,
            scores: vec![100],
            total_cents: 100,
        })
        .unwrap();
    let snapshot = &exam["attempts"][0]["snapshot"];
    assert!(!snapshot.to_string().contains("SECRET"));
    assert_eq!(
        snapshot["question"]["contentBlocks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(snapshot["visuals"].as_array().unwrap().len(), 1);
    let submitted = s.submit_paper(text(&exam, "id"), true).unwrap();
    assert_eq!(
        submitted["attempts"][0]["snapshot"]["question"],
        rows[0]["question"]
    );
    assert_eq!(
        submitted["attempts"][0]["snapshot"]["visuals"],
        rows[0]["visuals"]
    );
}

#[test]
fn missing_optional_source_page_does_not_disable_grading() {
    for missing_crop in [false, true] {
        let (_dir, mut s) = store();
        let mut raw: Value = serde_json::from_slice(&sample()).unwrap();
        let crop: Value = serde_json::from_slice::<Value>(include_bytes!(
            "../../fixtures/rich-content/expected.json"
        ))
        .unwrap()["visualElements"][0]["imageRef"]
            .clone();
        let mut source = crop.clone();
        source["objectKey"] = json!("absent-page.png");
        source["sha256"] = json!("a".repeat(64));
        raw["visualElements"] = json!([{"kind":"chart","description":"Required crop","questionIndexes":[0],"imageRef":crop,"sourceRef":source}]);
        if missing_crop {
            raw["visualElements"][0]["imageRef"]["objectKey"] = json!("absent-crop.png");
        }
        let preview = s
            .preview(serde_json::to_vec(&raw).unwrap(), "Optional page".into())
            .unwrap();
        let resources = s
            .resources(
                &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/rich-content/resources"),
            )
            .unwrap();
        assert!(resources["missingAssets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "absent-page.png"));
        let bank = s
            .import(text(&preview, "ticket"), None, "Optional page")
            .unwrap();
        let rows = s
            .questions(Some(text(&bank, "bankId")), "", "", "")
            .unwrap();
        assert_eq!(rows[0]["missingAssets"], missing_crop);
        assert!(rows[1]["visuals"].as_array().unwrap().is_empty());
        let session = practice(&s, rows, 1);
        let graded = s
            .save_attempt(
                (text(&session, "id"), 0),
                json!({"correctOption":"A"}),
                1,
                true,
                false,
                None,
            )
            .unwrap();
        let result = &graded["attempts"][0]["autoResult"];
        if missing_crop {
            assert!(result.is_null());
        } else {
            assert!(result.is_boolean());
        }
    }
}
