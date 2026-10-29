//! Opt-in repeatable synthetic workload; never opens a user's database.
use crate::{
    contract::{list, text},
    store::Store,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Instant;

#[test]
#[ignore = "scoped detail read benchmark; temporary databases, release only"]
fn scoped_detail_read_stress() {
    let mut workloads = Vec::new();
    for mixed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let mut db = store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO banks VALUES('bank','Bank','',1)", [])
            .unwrap();
        for index in 0..10_000 {
            let id = format!("q{index:05}");
            let mode = if mixed && index % 2 == 1 {
                "short_answer"
            } else {
                "true_false"
            };
            tx.prepare_cached("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,?4,'[]',1,0,'[]')").unwrap()
                .execute(params![id,index,format!("Question {index}"),mode]).unwrap();
            if mode == "true_false" {
                tx.prepare_cached("INSERT INTO true_false_questions VALUES(?1,'false')")
                    .unwrap()
                    .execute([id])
                    .unwrap();
            } else {
                tx.prepare_cached("INSERT INTO short_answer_questions(question_id,answer) VALUES(?1,'\"Reference\"')")
                    .unwrap().execute([id]).unwrap();
            }
        }
        tx.commit().unwrap();
        for count in [1, 30, 1000] {
            let ids: Vec<_> = (0..count).map(|index| format!("q{index:05}")).collect();
            let mut times = Vec::new();
            let mut output_hash = None;
            for iteration in 0..8 {
                let started = Instant::now();
                let rows =
                    crate::questions::read_scoped(&db, &["bank".into()], Some(&ids)).unwrap();
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(rows.len(), count);
                for (index, row) in rows.iter().enumerate() {
                    assert_eq!(row["id"], ids[index]);
                    assert_eq!(
                        row["question"]["answerPayload"],
                        if mixed && index % 2 == 1 {
                            json!({"text":"Reference"})
                        } else {
                            json!({"value":false})
                        }
                    );
                }
                let actual = crate::store::hash(&serde_json::to_vec(&rows).unwrap());
                assert!(output_hash
                    .as_ref()
                    .is_none_or(|expected| expected == &actual));
                output_hash = Some(actual);
                if iteration > 0 {
                    times.push(elapsed);
                }
            }
            workloads.push(json!({"mixed":mixed,"selected":count,"bankQuestions":10_000,"samplesMs":times,"outputSha256":output_hash}));
        }
    }
    use std::io::{Cursor, Read};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().into()).unwrap();
    let db = store.connect().unwrap();
    db.execute("INSERT INTO banks VALUES('bank','Bank','',1)", [])
        .unwrap();
    let mut zip =
        zip::ZipArchive::new(Cursor::new(include_bytes!("../../fixtures/all-types.zip"))).unwrap();
    let mut data = String::new();
    zip.by_name("questions.json")
        .unwrap()
        .read_to_string(&mut data)
        .unwrap();
    let document = crate::contract::parse(data.as_bytes()).unwrap();
    let questions = list(&document, "questions");
    let modes: std::collections::HashSet<_> =
        questions.iter().map(|q| text(q, "answerMode")).collect();
    assert_eq!(modes.len(), 11);
    for (index, question) in questions.iter().enumerate() {
        crate::questions::write(&db, question, "bank", None, index as i64, false, false).unwrap();
    }
    let mut times = Vec::new();
    let mut output_hash = None;
    for iteration in 0..8 {
        let started = Instant::now();
        let rows = crate::questions::read_scoped(&db, &[], None).unwrap();
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(rows.len(), questions.len());
        let actual = crate::store::hash(&serde_json::to_vec(&rows).unwrap());
        assert!(output_hash
            .as_ref()
            .is_none_or(|expected| expected == &actual));
        output_hash = Some(actual);
        if iteration > 0 {
            times.push(elapsed);
        }
    }
    workloads.push(json!({"mixed":"all-11-modes","selected":questions.len(),"bankQuestions":questions.len(),"samplesMs":times,"outputSha256":output_hash}));
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&workloads).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "paired bank and sparse draft reads; temporary databases, release only"]
fn runtime_read_stress() {
    fn sample(mut run: impl FnMut() -> Value) -> Value {
        drop(run());
        let mut times = Vec::new();
        let mut output = Value::Null;
        for _ in 0..7 {
            let start = Instant::now();
            output = run();
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        json!({"samplesMs":times,"medianMs":sorted[3],"output":output})
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().to_owned()).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    for i in 0..100 {
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,'',?3)",
            params![format!("b{i:03}"), format!("Bank {i}"), i],
        )
        .unwrap();
    }
    for i in 0..100_000 {
        tx.prepare_cached("INSERT INTO questions(id,bank_id,position,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,?2,?3,?4,'[]',1,0,'[]')").unwrap()
            .execute(params![format!("q{i:06}"),format!("b{:03}",i/1000),i%1000,if i%10==0 {"reading"} else {"true_false"}]).unwrap();
    }
    for session in 0..30 {
        let sid = format!("s{session}");
        tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES(?1,'Exam',1,0,'ordered')", [&sid]).unwrap();
        for i in 0..1000 {
            tx.prepare_cached("INSERT INTO attempts(session_id,ordinal,snapshot_question_id,answer) VALUES(?1,?2,?3,?4)").unwrap()
                .execute(params![sid,i,format!("q{i:06}"),if i%100==0 {"{\"text\":\"draft\"}"} else {"null"}]).unwrap();
        }
    }
    tx.commit().unwrap();
    let legacy_banks = || {
        let db = store.connect().unwrap();
        let mut statement = db.prepare(&format!("SELECT b.id,b.title,COUNT(q.id) FROM banks b LEFT JOIN questions q ON q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN ({})) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC", crate::question_metadata::COMPOSITE_SQL)).unwrap();
        let rows = statement.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"count":r.get::<_,i64>(2)?}))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        json!(rows)
    };
    assert_eq!(legacy_banks(), store.banks().unwrap());
    let draft_pass = |sql: &str| {
        let mut statement = db.prepare(sql).unwrap();
        let mut visited = 0;
        let mut count = 0;
        for session in 0..30 {
            for answer in statement
                .query_map([format!("s{session}")], |r| r.get::<_, String>(0))
                .unwrap()
            {
                visited += 1;
                count += usize::from(crate::exams::has_answer(
                    &serde_json::from_str::<Value>(&answer.unwrap()).unwrap(),
                ));
            }
        }
        json!({"rowsRead":visited,"draftAnswered":count})
    };
    let before = sample(|| {
        draft_pass("SELECT answer FROM attempts WHERE session_id=?1 AND submitted_at IS NULL")
    });
    let after = sample(|| draft_pass(crate::sessions::DRAFT_ANSWERS_SQL));
    assert_eq!(
        before["output"],
        json!({"rowsRead":30_000,"draftAnswered":300})
    );
    assert_eq!(after["output"], json!({"rowsRead":300,"draftAnswered":300}));
    assert_eq!(
        store.sessions_filtered(30, 0, "active").unwrap()["total"],
        30
    );
    let mut legacy = sample(legacy_banks);
    let mut current = sample(|| store.banks().unwrap());
    assert_eq!(legacy["output"], current["output"]);
    for result in [&mut legacy, &mut current] {
        let bytes = serde_json::to_vec(&result["output"]).unwrap();
        result.as_object_mut().unwrap().remove("output");
        result["outputSha256"] = json!(crate::store::hash(&bytes));
    }
    let report = json!({"method":"Release Rust, temporary schema-11 database. One warmup and seven samples. Bank choices include connection setup; draft pass excludes the rest of session summaries. No IPC or WebView measurement.",
        "banks":{"before":legacy,"after":current},"drafts":{"before":before,"after":after}});
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "paired selected snapshot reference index benchmark; release only"]
fn selected_snapshot_references() {
    fn sample(mut run: impl FnMut() -> Vec<Value>) -> Value {
        drop(run());
        let mut times = Vec::new();
        let mut expected = None;
        for _ in 0..7 {
            let start = Instant::now();
            let result = run();
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            let bytes = serde_json::to_vec(&result).unwrap();
            let digest = (bytes.len(), crate::store::hash(&bytes));
            if let Some(expected) = &expected {
                assert_eq!(&digest, expected);
            }
            expected = Some(digest);
        }
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        let (bytes, hash) = expected.unwrap();
        json!({"samplesMs":times,"medianMs":sorted[3],"outputBytes":bytes,"outputSha256":hash})
    }
    let mut report = json!({"probeSha256":crate::store::hash(include_bytes!("performance.rs")),
        "method":"Synthetic version-3 immutable snapshots; one warmup and seven samples, setup/hash/assertions excluded. No SQLite, IPC, WebView or model work.","workloads":[]});
    for (nodes, groups, refs) in [(20, 2, 1), (1000, 1000, 1), (500, 20, 500)] {
        let questions: Vec<_> = (0..nodes).map(|i| json!({"id":format!("q{i}"),"question":{"id":format!("q{i}"),"parentId":null,"answerMode":"short_answer","answerPayload":null}})).collect();
        let metadata: Vec<_> = (0..groups).map(|i| json!({"id":format!("g{i}"),"instructions":null,"questionIds":(0..refs).map(|j|format!("q{}",(i+j)%nodes)).collect::<Vec<_>>()})).collect();
        let doc = json!({"schemaVersion":3,"questions":questions,"groups":metadata,"visuals":[{"id":"global","questionIds":[]}]});
        let before = crate::store::hash(&serde_json::to_vec(&doc).unwrap());
        let full = crate::questions::thaw(&doc).unwrap();
        assert_eq!(
            crate::questions::context_from_document(&doc, "q0").unwrap(),
            vec![full[0].clone()]
        );
        let context = sample(|| crate::questions::context_from_document(&doc, "q0").unwrap());
        let thaw = sample(|| crate::questions::thaw(&doc).unwrap());
        assert_eq!(
            before,
            crate::store::hash(&serde_json::to_vec(&doc).unwrap())
        );
        report["workloads"].as_array_mut().unwrap().push(json!({"nodes":nodes,"groups":groups,"refsPerGroup":refs,"inputSha256":before,"context":context,"thaw":thaw}));
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "synthetic Store lock and archive contention measurement"]
fn archive_contention() {
    use std::{
        io::Read,
        sync::{mpsc, Mutex},
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().join("store")).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO banks VALUES('bank','Synthetic','',1)", [])
        .unwrap();
    for i in 0..500 {
        let id = format!("q{i}");
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,'true_false','[]',1,0,'[]')", params![id,i,format!("Question {i}")]).unwrap();
        tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    let mut assets = Vec::new();
    let mut seed = 42u32;
    for index in 0..16 {
        let pixels = image::RgbImage::from_fn(512, 512, |_, _| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            image::Rgb([(seed >> 24) as u8, (seed >> 16) as u8, (seed >> 8) as u8])
        });
        let mut buffer = std::io::Cursor::new(Vec::new());
        pixels
            .write_to(&mut buffer, image::ImageFormat::Png)
            .unwrap();
        let bytes = buffer.into_inner();
        let hash = crate::store::hash(&bytes);
        store.write_asset(&hash, &bytes).unwrap();
        tx.execute(
            "INSERT INTO assets VALUES(?1,'image/png',?2,?3)",
            params![hash, bytes.len(), format!("assets/{hash}")],
        )
        .unwrap();
        let visual = json!({"kind":"image","description":"Synthetic random pixels","questionIds":["q0"],"imageRef":{"sha256":hash,"objectKey":format!("images/{index}.png"),"sizeBytes":bytes.len(),"mediaType":"image/png"}});
        tx.execute(
            "INSERT INTO visuals VALUES(?1,'bank',?2,0)",
            params![format!("v{index}"), visual.to_string()],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO question_visuals VALUES(?1,'q0')",
            [format!("v{index}")],
        )
        .unwrap();
        assets.push((hash, bytes));
    }
    tx.commit().unwrap();
    let rows = store.question_rows().unwrap();
    let frozen = crate::questions::freeze(&rows[..1]);
    db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind) VALUES('draft','Synthetic',1,0,'ordered','practice')",[]).unwrap();
    db.execute(
        "INSERT INTO session_documents VALUES('draft',?1)",
        [frozen.to_string()],
    )
    .unwrap();
    db.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,max_cents) VALUES('draft',0,'q0','q0',100)",[]).unwrap();
    let mut report = json!({"questions":500,"images":assets.len(),"resourceBytes":assets.iter().map(|(_,b)|b.len()).sum::<usize>(),"repetitions":3,"inputSha256":crate::store::hash(&serde_json::to_vec(&rows).unwrap()),"probeSha256":crate::store::hash(include_bytes!("performance.rs")),"samples":{}});
    report["componentProbes"]["databaseSnapshot"] = measure(|| {
        let snapshot = dir.path().join("snapshot.sqlite");
        db.backup(rusqlite::MAIN_DB, &snapshot, None).unwrap();
        json!({"bytes":std::fs::metadata(snapshot).unwrap().len()})
    });
    report["componentProbes"]["resourceReadHashDecode"] = measure(|| {
        for (hash, bytes) in &assets {
            let data = store.read_asset(hash, bytes.len() as u64).unwrap();
            assert!(crate::audio::valid_media(&data, "image/png"));
        }
        Value::Null
    });
    report["componentProbes"]["questionRead"] = measure(|| json!(store.question_rows().unwrap()));
    let shared = Mutex::new(store);
    for operation in ["idle", "backup", "export", "damagedBackup", "damagedExport"] {
        let damaged = operation.starts_with("damaged");
        if damaged {
            std::fs::write(
                shared.lock().unwrap().asset_path(&assets[0].0).unwrap(),
                b"damaged",
            )
            .unwrap();
        }
        let mut samples = Vec::new();
        for repetition in 0..3 {
            let archive = dir.path().join(format!("{operation}-{repetition}.zip"));
            let sample = std::thread::scope(|scope| {
                let (ready, waiting) = mpsc::channel();
                let shared = &shared;
                let archive = &archive;
                let worker = scope.spawn(move || {
                    let locked = shared.lock().unwrap();
                    let hold = Instant::now();
                    ready.send(()).unwrap();
                    let result = match operation {
                        "backup" | "damagedBackup" => locked.backup(archive),
                        "export" | "damagedExport" => locked.export_bank("bank", archive),
                        _ => Ok(Value::Null),
                    };
                    let hold_ms = hold.elapsed().as_secs_f64() * 1000.0;
                    drop(locked);
                    assert_eq!(result.is_err(), damaged);
                    hold_ms
                });
                waiting.recv().unwrap();
                let begin = Instant::now();
                let locked = shared.lock().unwrap();
                let wait_ms = begin.elapsed().as_secs_f64() * 1000.0;
                locked
                    .save_draft(("draft", 0), json!({"value":repetition%2==0}), 0)
                    .unwrap();
                let save_ms = begin.elapsed().as_secs_f64() * 1000.0;
                drop(locked);
                json!({"lockHoldMs":worker.join().unwrap(),"draftLockWaitMs":wait_ms,"draftTotalMs":save_ms})
            });
            if damaged {
                assert!(!archive.exists());
            } else if operation != "idle" {
                let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
                for index in 0..zip.len() {
                    zip.by_index(index)
                        .unwrap()
                        .read_to_end(&mut Vec::new())
                        .unwrap();
                }
            }
            samples.push(sample);
        }
        report["samples"][operation] = json!(samples);
        if damaged {
            std::fs::write(
                shared.lock().unwrap().asset_path(&assets[0].0).unwrap(),
                &assets[0].1,
            )
            .unwrap();
        }
    }
    assert_eq!(
        Store::new(dir.path().join("store"))
            .unwrap()
            .session("draft")
            .unwrap()["attempts"][0]["answer"],
        json!({"value":true})
    );
    let exported = dir.path().join("export-2.zip");
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&exported).unwrap()).unwrap();
    let mut entries = std::collections::BTreeMap::new();
    let validation = Instant::now();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).unwrap();
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        entries.insert(
            entry.name().unwrap().into_owned(),
            crate::store::hash(&data),
        );
    }
    report["exportCrcValidationMs"] = json!(validation.elapsed().as_secs_f64() * 1000.0);
    report["exportSemanticSha256"] =
        json!(crate::store::hash(&serde_json::to_vec(&entries).unwrap()));
    report["exportBytes"] = json!(std::fs::metadata(exported).unwrap().len());
    report["scope"] = json!("Release/native synthetic mutex contention; component probes are separate, not additive. Excludes picker/IPC/WebView, physical devices and concurrent asset deletion.");
    let output = std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT");
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}

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
#[ignore = "paired batch attempt writes; run in release mode"]
fn batch_attempt_writes() {
    let mut report = json!({"probeSha256":crate::store::hash(include_bytes!("performance.rs")),"scope":"Complete native Store start/submit/retry methods, disposable SQLite, one warmup and seven samples per operation. Setup, assertions, semantic hashes and cleanup excluded. No IPC, WebView or device measurement.","workloads":[]});
    for count in [20usize, 1000] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let mut db = store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO banks VALUES('bank','Synthetic','',1)", [])
            .unwrap();
        let ids: Vec<_> = (0..count).map(|i| format!("q{i:04}")).collect();
        for (i, id) in ids.iter().enumerate() {
            tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,'true_false','[]',1,0,'[]')",params![id,i,format!("Question {i}")]).unwrap();
            tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
                .unwrap();
        }
        tx.commit().unwrap();
        let rows = store.question_rows().unwrap();
        let digest = crate::paper::digest(&rows).unwrap();
        let mut workload = json!({"questions":count,"inputSha256":crate::store::hash(&serde_json::to_vec(&rows).unwrap()),"start":[],"submit":[],"retry":[]});
        for sample in 0..8 {
            let start = Instant::now();
            let session = store
                .start_paper_data(crate::exams::Paper {
                    question_ids: ids.clone(),
                    kind: "self_test".into(),
                    minutes: None,
                    scores: vec![100; count],
                    total_cents: count as i64 * 100,
                    digest: digest.clone(),
                })
                .unwrap();
            let start_ms = start.elapsed().as_secs_f64() * 1000.0;
            let sid = text(&session, "id");
            assert_eq!(list(&session, "attempts").len(), count);
            db.execute("UPDATE attempts SET answer='{\"value\":false}',elapsed_ms=42,flagged=1 WHERE session_id=?1", [sid]).unwrap();
            let start = Instant::now();
            store.submit_paper_data(sid, true).unwrap();
            let submit_ms = start.elapsed().as_secs_f64() * 1000.0;
            let submitted = store.session(sid).unwrap();
            assert!(list(&submitted, "attempts")
                .iter()
                .all(|a| a["result"] == false
                    && a["earnedCents"] == 0
                    && a["elapsedMs"] == 42
                    && a["flagged"] == true));
            let start = Instant::now();
            let retry = store.retry_wrong_data(sid).unwrap();
            let retry_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(list(&retry, "attempts").len(), count);
            let retried = store.session(text(&retry, "id")).unwrap();
            assert!(list(&retried, "attempts")
                .iter()
                .all(|a| a["answer"].is_null() && a["result"].is_null()));
            let mut statement = db.prepare("SELECT ordinal,snapshot_question_id,answer,result,grade_kind,elapsed_ms,max_cents,earned_cents,flagged FROM attempts WHERE session_id=?1 ORDER BY ordinal").unwrap();
            let semantic: Vec<_> = statement
                .query_map([sid], |r| {
                    Ok(json!([
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, bool>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, bool>(8)?
                    ]))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let hash = json!(crate::store::hash(&serde_json::to_vec(&semantic).unwrap()));
            if sample == 0 {
                workload["outputSha256"] = hash;
            } else {
                assert_eq!(workload["outputSha256"], hash);
                for (operation, elapsed) in [
                    ("start", start_ms),
                    ("submit", submit_ms),
                    ("retry", retry_ms),
                ] {
                    workload[operation]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(elapsed));
                }
            }
            db.execute(
                "DELETE FROM sessions WHERE id IN (?1,?2)",
                params![sid, text(&retry, "id")],
            )
            .unwrap();
        }
        assert_eq!(
            db.query_row("SELECT count(*) FROM attempts", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
        report["workloads"].as_array_mut().unwrap().push(workload);
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "synthetic performance workload; run with --release --ignored --nocapture"]
fn desktop_stress() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO banks VALUES('bulk','Bulk','',1)", [])
        .unwrap();
    tx.execute("INSERT INTO banks VALUES('small','Small','',2)", [])
        .unwrap();
    for i in 0..10000 {
        let id = format!("q{i}");
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,?2,?3,?4,'true_false','[]',1,0,'[]')", params![id,if i<20 {"small"} else {"bulk"},i,format!("Question {i}")]).unwrap();
        tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    let mut report = json!({"questions":10000,"attempts":100000,"repetitions":3});
    report["allQuestions"] = measure(|| {
        let rows = store.questions(None, "", "", "").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 10000);
        rows
    });
    report["smallBank"] = measure(|| {
        let rows = store.questions(Some("small"), "", "", "").unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 20);
        rows
    });
    report["firstPage"] = measure(|| {
        let page = store
            .query_questions(&[], ("", "", ""), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 10000);
        assert_eq!(list(&page, "items").len(), 30);
        page
    });
    db.execute(
        "UPDATE questions SET favorite=1 WHERE id IN ('q1','q25')",
        [],
    )
    .unwrap();
    report["filteredSearch"] = measure(|| {
        let page = store
            .query_questions(&[], ("Question", "true_false", "favorite"), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 2);
        page
    });
    report["insert1000"] = measure(|| {
        let tx = db.transaction().unwrap();
        for i in 0..1000 {
            let q = json!({"id":format!("new{i}"),"stem":"New question","answerMode":"true_false","answerPayload":{"value":true},"contentBlocks":[],"missingFields":[]});
            crate::questions::write(&tx, &q, "bulk", None, i, false, false).unwrap();
        }
        tx.rollback().unwrap();
        Value::Null
    });
    let frozen = crate::questions::freeze(&store.question_rows().unwrap()[..1000]);
    let ids: Vec<_> = list(&frozen, "questions")
        .iter()
        .map(|q| text(q, "id").to_owned())
        .collect();
    for i in 0..100 {
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
        let session = store.session_data("exam0", None).unwrap();
        assert_eq!(list(&session, "attempts").len(), 1000);
        assert!(session["attempts"][0]["snapshot"]["question"]["answerPayload"].is_null());
        session
    });
    report["saveAttempt"] = measure(|| {
        store
            .write_attempt(("exam0", 0), json!({"value":true}), 0, false, false)
            .unwrap();
        store.session_data("exam0", None).unwrap()
    });
    let session = store.session("exam0").unwrap();
    let key = text(&session, "snapshotKey");
    report["positionUpdate"] = measure(|| {
        let update = store.position("exam0", 1, Some(key)).unwrap();
        assert!(list(&update, "attempts")
            .iter()
            .all(|a| a.get("snapshot").is_none()));
        update
    });
    report["saveAttemptUpdate"] = measure(|| {
        store
            .write_attempt(("exam0", 0), json!({"value":true}), 0, false, false)
            .unwrap();
        store.session_data("exam0", Some(key)).unwrap()
    });
    let mut cached = store.session_data("exam0", None).unwrap();
    report["positionDelta"] = measure(|| {
        let key = format!(
            "{}:{}",
            text(&cached, "snapshotKey"),
            text(&cached, "attemptKey")
        );
        let update = store.position("exam0", 1, Some(&key)).unwrap();
        assert!(list(&update, "attempts").is_empty());
        cached = update.clone();
        update
    });
    let mut answer = false;
    report["saveAttemptDelta"] = measure(|| {
        let key = format!(
            "{}:{}",
            text(&cached, "snapshotKey"),
            text(&cached, "attemptKey")
        );
        store
            .write_attempt(("exam0", 0), json!({"value":answer}), 0, false, false)
            .unwrap();
        answer = !answer;
        let update = store.session_data("exam0", Some(&key)).unwrap();
        assert_eq!(list(&update, "attempts").len(), 1);
        cached = update.clone();
        update
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
        let session = store.submit_paper_data(&sid, true).unwrap();
        assert!(list(&session, "attempts")
            .iter()
            .all(|a| a["earnedCents"] == 100));
        session
    });
    assert_eq!(
        db.query_row("SELECT count(*) FROM attempts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        100000
    );
    report["historyPage"] = measure(|| {
        let page = store.sessions(30, 0).unwrap();
        assert_eq!(page["total"], 100);
        page
    });
    let archive = dir.path().join("scale.zip");
    report["backup"] = measure(|| store.backup(&archive).unwrap());
    report["backupBytes"] = json!(std::fs::metadata(&archive).unwrap().len());
    report["restore"] = measure(|| store.restore(&archive).unwrap());
    let reopened = Store::new(dir.path().into()).unwrap();
    assert_eq!(
        reopened
            .connect()
            .unwrap()
            .query_row("SELECT count(*) FROM attempts", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        100000
    );
    report["scope"] = json!("Synthetic SQLite + serialization; excludes IPC/WebView, media playback and native accessibility");
    let output =
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT to the report path");
    std::fs::write(output, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{report}");
}

#[test]
#[ignore = "large composite list and subset-sum profile"]
fn list_and_selection_stress() {
    let mut report = json!({"method":"Release Rust; disposable database; synthetic valid reading groups; 3 sequential samples; excludes IPC/WebView. Subset timings cover feasible-count calculation only, excluding assertions and JSON serialization.","compositeLists":[],"subsetCounts":[]});
    for (children, material_bytes) in [(500usize, 50_000usize), (999, 100_000)] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let mut db = store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO banks VALUES('bank','Bank','',1)", [])
            .unwrap();
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES('root','bank',0,'Material','reading','[]',1,0,'[]')",[]).unwrap();
        tx.execute(
            "INSERT INTO reading_questions VALUES('root',?1)",
            [json!([{"partType":"text","textValue":"x".repeat(material_bytes)}]).to_string()],
        )
        .unwrap();
        for i in 0..children {
            let qid = format!("q{i}");
            tx.execute("INSERT INTO questions(id,bank_id,parent_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank','root',?2,?3,'true_false','[]',1,0,'[]')",params![qid,i+1,format!("Child {i}")]).unwrap();
            tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [qid])
                .unwrap();
        }
        tx.commit().unwrap();
        let measured = measure(|| {
            let page = store
                .query_questions(&[], ("", "", ""), Some((30, 0)))
                .unwrap();
            assert_eq!(page["total"], 1);
            assert!(page["items"][0]["children"].is_null());
            assert_eq!(page["items"][0]["answerableCount"], children);
            page
        });
        report["compositeLists"].as_array_mut().unwrap().push(json!({"rootPageLimit":30,"returnedRoots":1,"children":children,"materialBytes":material_bytes,"measurement":measured}));
    }
    for count in [10_000usize, 100_000] {
        for weight in [1usize, 3, 10, 1001, 0] {
            let weights = if weight == 0 {
                (0..count).map(|i| 2 + i % 2).collect::<Vec<_>>()
            } else {
                vec![weight; count]
            };
            let expected: Vec<_> = if let Some(limit) = 1000_usize.checked_div(weight) {
                (1..=count.min(limit)).map(|i| i * weight).collect()
            } else {
                (2..=1000).collect()
            };
            let mut samples = Vec::new();
            let mut output = Vec::new();
            for _ in 0..3 {
                let start = Instant::now();
                let counts = crate::paper::feasible_counts(std::hint::black_box(&weights));
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(counts, expected);
                output = counts;
            }
            let bytes = serde_json::to_vec(&output).unwrap();
            let mut sorted = samples.clone();
            sorted.sort_by(f64::total_cmp);
            let measured = json!({"samplesMs":samples,"medianMs":sorted[1],"maxMs":sorted[2],"jsonBytes":bytes.len(),"outputSha256":crate::store::hash(&bytes)});
            report["subsetCounts"]
                .as_array_mut()
                .unwrap()
                .push(json!({"roots":count,"weight":if weight == 0 { json!([2,3]) } else { json!(weight) },"inputSha256":crate::store::hash(&serde_json::to_vec(&weights).unwrap()),"measurement":measured}));
        }
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", report);
}

#[test]
#[ignore = "large flat-bank count, quota and manual preview profile"]
fn paper_preview_stress() {
    let mut report = json!({"method":"Release Rust Store::preview_paper; temporary SQLite; 3 sequential warm samples per workload; setup, expected-output reads, assertions and JSON serialization excluded; excludes picker, IPC, WebView and physical devices","workloads":[]});
    for count in [10_000usize, 100_000] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let mut db = store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO banks VALUES('bank','Bank','',1)", [])
            .unwrap();
        let input: Vec<_> = (0..count)
            .map(|i| {
                (
                    format!("q{i:06}"),
                    format!("Question {i}"),
                    if i < count / 2 {
                        "true_false"
                    } else {
                        "short_answer"
                    },
                    if i < count / 2 {
                        "true"
                    } else {
                        "\"Reference\""
                    },
                )
            })
            .collect();
        let input_hash = crate::store::hash(&serde_json::to_vec(&input).unwrap());
        for (i, (id, stem, mode, answer)) in input.iter().enumerate() {
            tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,?4,'[]',1,0,'[]')",params![id,i,stem,mode]).unwrap();
            if *mode == "true_false" {
                tx.execute(
                    "INSERT INTO true_false_questions VALUES(?1,?2)",
                    params![id, answer],
                )
                .unwrap();
            } else {
                tx.execute(
                    "INSERT INTO short_answer_questions(question_id,answer) VALUES(?1,?2)",
                    params![id, answer],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
        drop(input);
        for selection in ["count", "quota", "manual-first", "manual-last"] {
            for random in [false, true] {
                let selected_count = if selection == "count" { 20 } else { 1000 };
                let mut order: Vec<_> = (0..count).collect();
                if random {
                    fastrand::seed(7);
                    fastrand::shuffle(&mut order);
                }
                let expected: Vec<_> = if selection == "count" {
                    order.into_iter().take(selected_count).collect()
                } else if selection == "manual-first" {
                    (0..selected_count).rev().collect()
                } else if selection == "manual-last" {
                    (count - selected_count..count).rev().collect()
                } else {
                    let mut taken = [0; 2];
                    order
                        .into_iter()
                        .filter(|&i| {
                            let category = usize::from(i >= count / 2);
                            taken[category] += 1;
                            taken[category] <= 500
                        })
                        .collect()
                };
                let ids: Vec<_> = expected.iter().map(|i| format!("q{i:06}")).collect();
                let rows =
                    crate::questions::read_scoped(&db, &["bank".into()], Some(&ids)).unwrap();
                let expected_digest =
                    crate::paper::digest(&crate::paper::selected_rows(&rows, &ids).unwrap())
                        .unwrap();
                let manual = selection.starts_with("manual");
                let request = json!({"bank_ids":["bank"],"search":"","mode":"","filter":"","selection":if manual {"manual"} else {selection},"count":20,"quotas":if selection == "quota" {json!({"true_false":500,"short_answer":500})} else {json!({})},"question_ids":if manual {json!(ids)} else {json!([])},"random":random,"total_cents":selected_count*100,"budgets":{}});
                let mut samples = Vec::new();
                let mut output_hash = None;
                for _ in 0..3 {
                    let request =
                        serde_json::from_value::<crate::paper::Preview>(request.clone()).unwrap();
                    fastrand::seed(7);
                    let start = Instant::now();
                    let preview = store.preview_paper(request).unwrap();
                    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                    assert_eq!(preview["count"], selected_count);
                    assert_eq!(preview["questionIds"], json!(ids));
                    assert_eq!(preview["digest"], expected_digest);
                    assert_eq!(preview["scores"], json!(vec![100; selected_count]));
                    assert_eq!(list(&preview, "questions").len(), selected_count);
                    for (row, &i) in list(&preview, "questions").iter().zip(&expected) {
                        assert_eq!(row["id"], format!("q{i:06}"));
                        assert_eq!(row["question"]["stem"], format!("Question {i}"));
                        assert_eq!(
                            row["question"]["answerPayload"],
                            if i < count / 2 {
                                json!({"value":true})
                            } else {
                                json!({"text":"Reference"})
                            }
                        );
                    }
                    let bytes = serde_json::to_vec(&preview).unwrap();
                    let digest = crate::store::hash(&bytes);
                    if let Some(previous) = &output_hash {
                        assert_eq!(&digest, previous);
                    }
                    output_hash = Some(digest.clone());
                    samples.push(
                        json!({"elapsedMs":elapsed,"jsonBytes":bytes.len(),"outputSha256":digest}),
                    );
                }
                let mut times: Vec<_> = samples
                    .iter()
                    .map(|s| s["elapsedMs"].as_f64().unwrap())
                    .collect();
                times.sort_by(f64::total_cmp);
                report["workloads"].as_array_mut().unwrap().push(json!({"roots":count,"selection":selection,"selectedCount":selected_count,"random":random,"randomSeed":7,"inputSha256":input_hash,"medianMs":times[1],"maxMs":times[2],"samples":samples}));
            }
        }
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", report);
}

#[test]
#[ignore = "deterministic full backup and restore profile"]
fn backup_restore_stress() {
    fn logical_database(db: &rusqlite::Connection) -> Value {
        use rusqlite::types::ValueRef;
        use sha2::{Digest, Sha256};
        let tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").unwrap().query_map([], |r| r.get::<_,String>(0)).unwrap().collect::<std::result::Result<Vec<_>,_>>().unwrap();
        let mut digest = Sha256::new();
        let mut counts = serde_json::Map::new();
        for table in tables {
            digest.update(table.as_bytes());
            let mut statement = db
                .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                .unwrap();
            let columns = statement.column_count();
            let mut rows = statement.query([]).unwrap();
            let mut count = 0;
            while let Some(row) = rows.next().unwrap() {
                for column in 0..columns {
                    match row.get_ref(column).unwrap() {
                        ValueRef::Null => digest.update([0]),
                        ValueRef::Integer(value) => {
                            digest.update([1]);
                            digest.update(value.to_le_bytes());
                        }
                        ValueRef::Real(value) => {
                            digest.update([2]);
                            digest.update(value.to_bits().to_le_bytes());
                        }
                        ValueRef::Text(bytes) => {
                            digest.update([3]);
                            digest.update((bytes.len() as u64).to_le_bytes());
                            digest.update(bytes);
                        }
                        ValueRef::Blob(bytes) => {
                            digest.update([4]);
                            digest.update((bytes.len() as u64).to_le_bytes());
                            digest.update(bytes);
                        }
                    }
                }
                digest.update([5]);
                count += 1;
            }
            counts.insert(table, json!(count));
        }
        json!({"sha256":crate::store::finish_hash(digest),"tableCounts":counts,"schemaVersion":db.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap()})
    }
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().join("store")).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO banks VALUES('bank','Synthetic','',1)", [])
        .unwrap();
    for i in 0..10_000 {
        let id = format!("q{i:05}");
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,'true_false','[]',1,0,'[]')",params![id,i,format!("Question {i}")]).unwrap();
        tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    let frozen = crate::questions::freeze(&store.question_rows().unwrap()[..1000]).to_string();
    let tx = db.transaction().unwrap();
    for i in 0..100 {
        let sid = format!("exam{i:03}");
        tx.execute("INSERT INTO sessions(id,bank_id,bank_title,created_at,position,mode,kind) VALUES(?1,'bank','Synthetic',1,0,'ordered','self_test')",[&sid]).unwrap();
        tx.execute(
            "INSERT INTO session_documents VALUES(?1,?2)",
            params![sid, frozen],
        )
        .unwrap();
        for ordinal in 0..1000 {
            tx.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,answer,max_cents) VALUES(?1,?2,?3,?3,'{\"value\":true}',100)",params![sid,ordinal,format!("q{ordinal:05}")]).unwrap();
        }
    }
    tx.commit().unwrap();
    let before = logical_database(&db);
    let database_bytes = std::fs::metadata(store.db_path()).unwrap().len();
    drop(db);
    let mut report = json!({"questions":10000,"sessions":100,"snapshotQuestions":1000,"attempts":100000,"assets":0,"inputSha256":before["sha256"],"snapshotSha256":crate::store::hash(frozen.as_bytes()),"databaseBytes":database_bytes,"logicalBefore":before,"scope":"Release complete Store::backup/restore methods with temporary fixed-input SQLite and fsync. Three raw samples; first invocation distinguished from later warm invocations. OS caches are not flushed and setup/logical hashing warms files. Setup, assertions, logical digests and reopen checks excluded. No picker/IPC/WebView/platform-device evidence.","backup":[],"restore":[]});
    let archive = dir.path().join("fixed.zip");
    for repetition in 0..3 {
        let start = Instant::now();
        let result = store.backup(&archive).unwrap();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(result["path"], archive.display().to_string());
        assert_eq!(logical_database(&store.connect().unwrap()), before);
        report["backup"].as_array_mut().unwrap().push(json!({"phase":if repetition == 0 {"firstInvocation"} else {"warm"},"elapsedMs":elapsed,"archiveBytes":std::fs::metadata(&archive).unwrap().len()}));
    }
    for repetition in 0..3 {
        let start = Instant::now();
        let result = store.restore(&archive).unwrap();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let recovery = std::path::Path::new(text(&result, "recoveryPath"));
        assert!(recovery.is_file());
        let after = logical_database(&store.connect().unwrap());
        assert_eq!(after, before);
        let reopened = Store::new(store.dir.clone()).unwrap();
        assert_eq!(logical_database(&reopened.connect().unwrap()), before);
        assert!(reopened.service_settings_override().unwrap().is_none());
        report["restore"].as_array_mut().unwrap().push(json!({"phase":if repetition == 0 {"firstInvocation"} else {"warm"},"elapsedMs":elapsed,"recoveryBytes":std::fs::metadata(recovery).unwrap().len(),"logicalAfter":after,"reopenPreservesAllTables":true}));
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", report);
}

#[test]
#[ignore = "paired snapshot metadata copy benchmark; release only"]
fn snapshot_metadata_copies() {
    fn sample(mut run: impl FnMut() -> Value, mut check: impl FnMut(&mut Value)) -> Value {
        let mut times = Vec::new();
        let mut expected = None;
        let mut size = 0;
        for iteration in 0..8 {
            let start = Instant::now();
            let mut value = run();
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            check(&mut value);
            let bytes = serde_json::to_vec(&value).unwrap();
            size = bytes.len();
            let digest = crate::store::hash(&bytes);
            if let Some(previous) = &expected {
                assert_eq!(&digest, previous);
            } else {
                expected = Some(digest);
            }
            if iteration > 0 {
                times.push(elapsed);
            }
        }
        let mut sorted = times.clone();
        sorted.sort_by(f64::total_cmp);
        json!({"samplesMs":times,"medianMs":sorted[3],"outputBytes":size,"outputSha256":expected})
    }
    let mut report = json!({"probeSha256":crate::store::hash(include_bytes!("performance.rs")),"scope":"Release Rust, disposable SQLite, one warmup and seven samples. Setup, checks, output hashing, response normalization, result destruction and session cleanup are outside timings; excludes IPC/WebView.","workloads":[]});
    for (count, groups, context_bytes) in
        [(20, 0, 0), (20, 2, 1000), (100, 100, 0), (1000, 4, 5000)]
    {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let mut source =
            crate::contract::parse(include_bytes!("../../fixtures/sample.json")).unwrap();
        let template = list(&source, "questions")
            .iter()
            .find(|q| text(q, "answerMode") == "true_false")
            .unwrap()
            .clone();
        let ids: Vec<_> = (0..count).map(|i| format!("q{i:04}")).collect();
        source["questions"] = json!(ids
            .iter()
            .map(|id| {
                let mut q = template.clone();
                q["id"] = json!(id);
                q
            })
            .collect::<Vec<_>>());
        source["groups"] = json!((0..groups).map(|i| json!({"title":format!("Group {i}"),"instructions":"x".repeat(context_bytes),"questionIds":ids})).collect::<Vec<_>>());
        source["visualElements"] = json!([]);
        let source_bytes = serde_json::to_vec(&source).unwrap();
        assert!(source_bytes.len() <= crate::contract::MAX_JSON);
        source = crate::contract::parse(&source_bytes).unwrap();
        let mut db = store.connect().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO banks VALUES('bank','Synthetic','',1)", [])
            .unwrap();
        for (i, q) in list(&source, "questions").iter().enumerate() {
            crate::questions::write(&tx, q, "bank", None, i as i64, false, false).unwrap();
        }
        for (i, group) in list(&source, "groups").iter().enumerate() {
            let gid = format!("g{i}");
            tx.execute(
                "INSERT INTO sections VALUES(?1,'bank',?2,?3)",
                params![gid, text(group, "title"), text(group, "instructions")],
            )
            .unwrap();
            for id in &ids {
                tx.execute(
                    "INSERT INTO section_questions VALUES(?1,?2)",
                    params![gid, id],
                )
                .unwrap();
            }
        }
        tx.commit().unwrap();
        let rows = crate::questions::read_scoped(&db, &[], Some(&ids)).unwrap();
        assert_eq!(rows.len(), count);
        let encoded = serde_json::to_vec(&rows).unwrap();
        let mut workload = json!({"questions":count,"groups":groups,"contextBytes":context_bytes,"sourceBytes":source_bytes.len(),"inputBytes":encoded.len(),"inputSha256":crate::store::hash(&encoded)});
        drop(encoded);
        workload["freeze"] = sample(
            || crate::questions::freeze(std::hint::black_box(&rows)),
            |value| {
                assert_eq!(list(value, "questions").len(), count);
                assert_eq!(list(value, "groups").len(), groups);
            },
        );
        let digest = crate::paper::digest(&rows).unwrap();
        workload["digest"] = sample(
            || json!(crate::paper::digest(std::hint::black_box(&rows)).unwrap()),
            |value| assert_eq!(value, &digest),
        );
        workload["startPaper"] = sample(
            || {
                store
                    .start_paper_data(crate::exams::Paper {
                        question_ids: ids.clone(),
                        kind: "practice".into(),
                        minutes: None,
                        scores: vec![],
                        total_cents: 0,
                        digest: digest.clone(),
                    })
                    .unwrap()
            },
            |value| {
                assert_eq!(list(value, "attempts").len(), count);
                let sid = text(value, "id").to_owned();
                for field in ["id", "createdAt", "snapshotKey", "attemptKey"] {
                    value.as_object_mut().unwrap().remove(field);
                }
                db.execute("DELETE FROM sessions WHERE id=?1", [&sid])
                    .unwrap();
            },
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM attempts", [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
        report["workloads"].as_array_mut().unwrap().push(workload);
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
}

#[test]
#[ignore = "paired cached association INSERT workload; temporary databases, release only"]
fn association_insert_cache_stress() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().into()).unwrap();
    let mut db = store.connect().unwrap();
    db.execute("INSERT INTO banks VALUES('bank','Synthetic','',1)", [])
        .unwrap();
    db.execute(
        "INSERT INTO imports(id,bank_id,digest,created_at) VALUES('import','bank','digest',1)",
        [],
    )
    .unwrap();
    let ids: Vec<_> = (0..200).map(|i| format!("q{i:03}")).collect();
    for (i, id) in ids.iter().enumerate() {
        db.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,'Question','true_false','[]',1,0,'[]')", params![id,i]).unwrap();
        db.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    let result = json!({"questions":ids.iter().map(|id|json!({"id":id})).collect::<Vec<_>>(),
        "warnings":["first","second"],"missingFields":["analysis"],
        "groups":(0..100).map(|i|json!({"title":format!("Group {i}"),"instructions":null,"questionIds":ids})).collect::<Vec<_>>(),
        "visualElements":(0..20).map(|i|json!({"description":format!("Visual {i}"),"questionIds":ids})).collect::<Vec<_>>()});
    let processing = json!({"questionSources":ids.iter().map(|id|json!({"questionId":id,"stage":"document_parse","unitIndex":0})).collect::<Vec<_>>()});
    let mut expected = None;
    let mut report =
        json!({"questions":200,"associationRows":24323,"uniqueInsertSql":6,"samples":[]});
    for capacity in [0, 16] {
        db.set_prepared_statement_cache_capacity(capacity);
        let mut times = Vec::new();
        for _ in 0..3 {
            let tx = db.transaction().unwrap();
            let start = Instant::now();
            crate::questions::put_context(&tx, "bank", &result, &ids, "import", &processing)
                .unwrap();
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            let mut normalized = json!({});
            for (name, sql) in [
                ("groups", "SELECT json_array(s.title,s.instructions,q.position) FROM sections s JOIN section_questions r ON r.section_id=s.id JOIN questions q ON q.id=r.question_id ORDER BY s.rowid,q.position"),
                ("visuals", "SELECT json_array(v.content,v.document_level,q.position) FROM visuals v JOIN question_visuals r ON r.visual_id=v.id JOIN questions q ON q.id=r.question_id ORDER BY v.rowid,q.position"),
                ("warnings", "SELECT json_array(position,message) FROM import_warnings ORDER BY position"),
                ("sources", "SELECT json_array(question_id,stage,unit_index) FROM question_sources ORDER BY question_id,stage,unit_index"),
            ] {
                normalized[name] = json!(tx.prepare(sql).unwrap().query_map([], |row| row.get::<_,String>(0)).unwrap().collect::<std::result::Result<Vec<_>,_>>().unwrap());
            }
            assert_eq!(list(&normalized, "groups").len(), 20_000);
            assert_eq!(list(&normalized, "visuals").len(), 4_000);
            assert_eq!(list(&normalized, "warnings").len(), 3);
            assert_eq!(list(&normalized, "sources").len(), 200);
            assert!(!tx
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .exists([])
                .unwrap());
            let digest = crate::store::hash(&serde_json::to_vec(&normalized).unwrap());
            if let Some(expected) = &expected {
                assert_eq!(&digest, expected);
            }
            expected = Some(digest);
            tx.rollback().unwrap();
        }
        report["samples"]
            .as_array_mut()
            .unwrap()
            .push(json!({"cacheCapacity":capacity,"elapsedMs":times}));
    }
    report["normalizedSha256"] = json!(expected.unwrap());
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[test]
#[ignore = "synthetic composite validation scaling; no timing assertions"]
fn contract_tree_validation_scaling() {
    let mut report = json!({"scope":"validate_tree only; synthetic reading groups with four children, plus childless/incomplete reading groups; three sequential samples per size; setup, cloning and equality checks excluded; no SQLite, IPC or WebView", "workloads":[]});
    for groups in [100usize, 1000, 10_000] {
        for incomplete in [false, true] {
            let mut questions = Vec::new();
            for group in 0..groups {
                let id = format!("bank{}-group{group}", group % 10);
                questions.push(json!({"id":id,"stem":"Material","answerMode":"reading","passage":if incomplete {json!([])} else {json!([{"partType":"text","textValue":"Synthetic material"}])}}));
                if !incomplete {
                    for child in 0..4 {
                        questions.push(json!({"id":format!("{id}-child{child}"),"parentId":id,"stem":"Child","answerMode":"true_false","answerPayload":{"value":false}}));
                    }
                }
            }
            for q in &mut questions {
                crate::contract::validate_question(q).unwrap();
            }
            let mut expected = questions.clone();
            if incomplete {
                for q in &mut expected {
                    q["needsReview"] = json!(true);
                    q["missingFields"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("material"));
                }
            }
            let mut samples = Vec::new();
            for _ in 0..3 {
                let mut candidate = questions.clone();
                let start = Instant::now();
                crate::contract::validate_tree(&mut candidate).unwrap();
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(candidate, expected);
            }
            report["workloads"].as_array_mut().unwrap().push(json!({"groups":groups,"questions":questions.len(),"incomplete":incomplete,"samplesMs":samples,"outputSha256":crate::store::hash(&serde_json::to_vec(&expected).unwrap())}));
        }
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
}
