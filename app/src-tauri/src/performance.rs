//! Opt-in repeatable synthetic workload; never opens a user's database.
use crate::{
    contract::{list, text},
    store::Store,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Instant;

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
        entries.insert(entry.name().to_owned(), crate::store::hash(&data));
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
    let mut report = json!({"method":"Release Rust; disposable database; synthetic valid reading groups; 3 sequential samples; excludes IPC/WebView","compositeLists":[],"subsetCounts":[]});
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
        let weights = vec![1usize; count];
        let measured = measure(|| {
            let counts = crate::paper::feasible_counts(&weights);
            assert_eq!(counts, (1..=1000).collect::<Vec<_>>());
            json!(counts)
        });
        report["subsetCounts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"roots":count,"weight":1,"measurement":measured}));
    }
    std::fs::write(
        std::env::var("PRACTIQ_BENCH_OUTPUT").expect("set PRACTIQ_BENCH_OUTPUT"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", report);
}
