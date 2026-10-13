//! Search regression coverage and an opt-in workload using temporary databases.
use super::*;
use std::time::Instant;

fn seed(count: usize) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().into()).unwrap();
    let mut db = store.connect().unwrap();
    let tx = db.transaction().unwrap();
    tx.execute("INSERT INTO banks VALUES('bank','Bank','',1)", [])
        .unwrap();
    for i in 0..count {
        let id = format!("q{i:05}");
        tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?1,'bank',?2,?3,'true_false','[]',1,0,'[]')", params![id,i,format!("中文 MiXeD Question {i}")]).unwrap();
        tx.execute("INSERT INTO true_false_questions VALUES(?1,'true')", [id])
            .unwrap();
    }
    tx.commit().unwrap();
    (dir, store)
}

#[test]
fn plain_pages_preserve_filters_order_totals_and_clamped_offsets() {
    let (_dir, store) = seed(73);
    let db = store.connect().unwrap();
    db.execute("INSERT INTO banks VALUES('other','Other','',2)", [])
        .unwrap();
    db.execute("INSERT INTO banks VALUES('tie','Tie','',2)", [])
        .unwrap();
    db.execute(
        "UPDATE questions SET bank_id='other',position=0 WHERE id>'q00060'",
        [],
    )
    .unwrap();
    db.execute("UPDATE questions SET bank_id='tie' WHERE id>'q00069'", [])
        .unwrap();
    db.execute(
        "UPDATE questions SET favorite=1 WHERE id IN ('q00002','q00062')",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE questions SET needs_review=1 WHERE id IN ('q00003','q00063')",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO question_reviews VALUES('q00063',1)", [])
        .unwrap();
    db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES('session','Session',1,0,'ordered')", []).unwrap();
    for (ordinal, id, result) in [(0, "q00004", 0), (1, "q00005", 0), (2, "q00005", 1)] {
        db.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,submitted_at,result) VALUES('session',?1,?2,?2,?1+1,?3)", params![ordinal,id,result]).unwrap();
    }
    for banks in [
        vec![],
        vec!["bank".into()],
        vec!["other".into()],
        vec!["bank".into(), "other".into()],
        vec!["tie".into(), "other".into()],
    ] {
        for mode in ["", "true_false", "reading"] {
            for filter in ["", "favorite", "review", "wrong", "unattempted"] {
                for offset in [0, 3, 30, 60, 73, 1000] {
                    let page = store
                        .query_questions(&banks, ("", mode, filter), Some((30, offset)))
                        .unwrap();
                    let mut with_stats = store
                        .questions_with_stats(&banks, ("", mode, filter), (30, offset))
                        .unwrap();
                    with_stats.as_object_mut().unwrap().remove("stats");
                    assert_eq!(page, with_stats, "{banks:?} {mode} {filter} {offset}");
                }
            }
        }
    }
    let page = store
        .query_questions(&[], ("", "", ""), Some((30, 1000)))
        .unwrap();
    assert_eq!(page["total"], 73);
    assert_eq!(page["offset"], 60);
    assert_eq!(list(&page, "items").len(), 13);
    let first = store
        .query_questions(&[], ("", "", ""), Some((30, 0)))
        .unwrap();
    let (ids, total) = crate::questions::matching_roots(&db, &[], "", "", Some((30, 0))).unwrap();
    assert_eq!(total, 73);
    assert_eq!(ids.len(), 30);
    assert_eq!(ids[0], "q00061");
    assert_eq!(first["items"][0]["id"], "q00061");
    assert_eq!(first["items"][11]["id"], "q00072");
    assert_eq!(first["items"][12]["id"], "q00000");
    for page in [(0, 0), (101, 0), (30, usize::MAX)] {
        assert!(store
            .query_questions(&[], ("", "", ""), Some(page))
            .is_err());
    }
    let (_dir, empty) = seed(0);
    assert_eq!(
        empty
            .query_questions(&[], ("", "", ""), Some((30, 1000)))
            .unwrap(),
        json!({"items":[],"total":0,"offset":0})
    );
}

#[test]
fn search_pages_and_stats_do_not_construct_unselected_details() {
    let (_dir, store) = seed(60);
    store
        .connect()
        .unwrap()
        .execute(
            "DELETE FROM true_false_questions WHERE question_id='q00059'",
            [],
        )
        .unwrap();
    let page = store
        .query_questions(&["bank".into()], ("文 mix", "", ""), Some((30, 0)))
        .unwrap();
    assert_eq!(page["total"], 60);
    assert_eq!(list(&page, "items").len(), 30);
    assert_eq!(
        store
            .question_stats(&["bank".into()], ("文 mix", "", ""))
            .unwrap()["count"],
        60
    );
    let second = store
        .query_questions(&["bank".into()], ("文 mix", "", ""), Some((30, 30)))
        .unwrap();
    assert_eq!(list(&second, "items").len(), 30);
    assert!(store.question_detail("q00059").is_err());
}

#[test]
fn search_projection_preserves_text_fields_associations_and_unicode() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let mut raw: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
    for (field, value) in [
        ("stem", "中文 MiXeD"),
        ("instructions", "instructionneedle"),
        ("analysis", "analysisneedle"),
        ("sourceText", "sourceneedle"),
        ("scoringRubric", "rubricneedle"),
        ("scoreSourceText", "scoreneedle"),
    ] {
        raw["questions"][0][field] = json!(value);
    }
    raw["questions"][0]["contentBlocks"] = json!([
        {"partType":"text","textValue":"blockneedle"},
        {"partType":"table","jsonValue":{"cells":[["structuredneedle"]]}}
    ]);
    raw["questions"][0]["passage"] = json!([
        {"partType":"text","textValue":"passageneedle"},
        {"partType":"markdown","markdownValue":"markdownneedle"},
        {"partType":"formula","latexValue":"latexneedle"}
    ]);
    raw["questions"][1]["options"][0]["content"] = json!("optionneedle");
    raw["questions"][2]["answerPayload"]["text"] = json!("answerneedle");
    raw["groups"][0]["title"] = json!("groupneedle");
    raw["groups"][0]["instructions"] = json!("groupinstructionneedle");
    let preview = store
        .preview(serde_json::to_vec(&raw).unwrap(), "Search".into())
        .unwrap();
    let imported = store
        .import(text(&preview, "ticket"), None, "Search")
        .unwrap();
    let bank = text(&imported, "bankId").to_owned();
    let full = store
        .query_questions(std::slice::from_ref(&bank), ("", "", ""), None)
        .unwrap();
    let root = text(&full[0], "id");
    let child = text(&full[0]["children"][0], "id");
    let db = store.connect().unwrap();
    db.execute(
        "INSERT INTO question_items VALUES(?1,0,1,'left','itemneedle','itemlabelneedle')",
        [child],
    )
    .unwrap();
    for (id, bank_id, document_level, target, content) in [
        (
            "visual",
            bank.as_str(),
            false,
            Some(child),
            json!({"description":"visualneedle","extractedText":"extractedneedle","label":"visuallabelneedle"}),
        ),
        (
            "global",
            bank.as_str(),
            true,
            None,
            json!({"description":"globalneedle"}),
        ),
        (
            "document",
            bank.as_str(),
            true,
            None,
            json!({"description":"documentonlyneedle","documentOnly":true}),
        ),
    ] {
        db.execute(
            "INSERT INTO visuals VALUES(?1,?2,?3,?4)",
            params![id, bank_id, content.to_string(), document_level],
        )
        .unwrap();
        if let Some(target) = target {
            db.execute(
                "INSERT INTO question_visuals VALUES(?1,?2)",
                params![id, target],
            )
            .unwrap();
        }
    }
    db.execute("INSERT INTO banks VALUES('other','Other','',2)", [])
        .unwrap();
    db.execute(
        "INSERT INTO visuals VALUES('foreign','other','{\"description\":\"foreignneedle\"}',1)",
        [],
    )
    .unwrap();
    for term in [
        "文 mix",
        "中",
        "instructionneedle",
        "analysisneedle",
        "sourceneedle",
        "rubricneedle",
        "scoreneedle",
        "blockneedle",
        "structuredneedle",
        "passageneedle",
        "markdownneedle",
        "latexneedle",
        "optionneedle",
        "answerneedle",
        "groupneedle",
        "groupinstructionneedle",
        "itemneedle",
        "itemlabelneedle",
        "visualneedle",
        "extractedneedle",
        "visuallabelneedle",
        "globalneedle",
    ] {
        let page = store
            .query_questions(
                std::slice::from_ref(&bank),
                (term, "reading", ""),
                Some((1, 0)),
            )
            .unwrap();
        assert_eq!(page["total"], 1, "{term}");
        assert_eq!(page["items"][0]["id"], root, "{term}");
        assert!(page["items"][0]["children"].is_null());
        assert_eq!(
            page["items"][0]["answerableCount"], full[0]["answerableCount"],
            "{term}"
        );
        assert_eq!(
            store
                .question_stats(std::slice::from_ref(&bank), (term, "reading", ""))
                .unwrap()["count"],
            full[0]["answerableCount"],
            "{term}"
        );
    }
    for term in [
        "documentonlyneedle",
        "foreignneedle",
        "questionIds",
        "partType",
        "needsReview",
        "false",
        "null",
        "textValue",
    ] {
        assert_eq!(
            store
                .query_questions(std::slice::from_ref(&bank), (term, "", ""), Some((30, 0)))
                .unwrap()["total"],
            0,
            "{term}"
        );
    }
}

#[test]
fn search_filters_require_content_and_selection_on_the_same_node() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().into()).unwrap();
    let preview = store
        .preview(
            include_bytes!("../../fixtures/composite.json").to_vec(),
            "Search".into(),
        )
        .unwrap();
    let imported = store
        .import(text(&preview, "ticket"), None, "Search")
        .unwrap();
    let bank = text(&imported, "bankId").to_owned();
    let full = store
        .query_questions(std::slice::from_ref(&bank), ("", "", ""), None)
        .unwrap();
    let root = text(&full[0], "id");
    let children = list(&full[0], "children");
    let child = children
        .iter()
        .find(|row| text(&row["question"], "stem") == "r-short")
        .unwrap();
    let child_id = text(child, "id");
    let db = store.connect().unwrap();
    db.execute(
        "UPDATE questions SET stem='parentneedle' WHERE id=?1",
        [root],
    )
    .unwrap();
    db.execute(
        "UPDATE questions SET stem='childneedle',favorite=1 WHERE id=?1",
        [child_id],
    )
    .unwrap();
    db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES('session','Session',1,0,'ordered')", []).unwrap();
    db.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,submitted_at,result) VALUES('session',0,?1,?1,1,0)", [child_id]).unwrap();
    for filter in ["favorite", "wrong", "unattempted"] {
        assert_eq!(
            store
                .query_questions(
                    std::slice::from_ref(&bank),
                    ("parentneedle", "reading", filter),
                    Some((1, 0))
                )
                .unwrap()["total"],
            0,
            "{filter}"
        );
    }
    for filter in ["favorite", "wrong"] {
        assert_eq!(
            store
                .query_questions(
                    std::slice::from_ref(&bank),
                    ("", "reading", filter),
                    Some((1, 0))
                )
                .unwrap()["total"],
            1,
            "{filter}"
        );
        assert_eq!(
            store
                .query_questions(
                    std::slice::from_ref(&bank),
                    ("childneedle", "reading", filter),
                    Some((1, 0))
                )
                .unwrap()["total"],
            1,
            "{filter}"
        );
    }
    assert_eq!(
        store
            .query_questions(
                std::slice::from_ref(&bank),
                ("childneedle", "reading", "unattempted"),
                Some((1, 0))
            )
            .unwrap()["total"],
        0
    );
    // A latest correct result takes the node out of wrong-search, even if an older result was wrong.
    db.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,submitted_at,result) VALUES('session',1,?1,?1,2,1)", [child_id]).unwrap();
    assert_eq!(
        store
            .query_questions(
                std::slice::from_ref(&bank),
                ("childneedle", "reading", "wrong"),
                Some((1, 0))
            )
            .unwrap()["total"],
        0
    );
    // Pending review is a root-level eligibility condition: any node may match its content.
    db.execute(
        "UPDATE questions SET needs_review=1 WHERE id=?1",
        [child_id],
    )
    .unwrap();
    assert_eq!(
        store
            .query_questions(
                std::slice::from_ref(&bank),
                ("parentneedle", "reading", "review"),
                Some((1, 0))
            )
            .unwrap()["total"],
        1
    );
    // Shared options are searched on their owner, rather than inherited onto a favorite child.
    let owner = children
        .iter()
        .find(|row| text(&row["question"], "stem") == "words")
        .unwrap();
    let borrowing_child = children
        .iter()
        .find(|row| text(&row["question"], "stem") == "words1")
        .unwrap();
    db.execute(
        "UPDATE question_options SET content='sharedneedle' WHERE owner_id=?1 AND position=0",
        [text(owner, "id")],
    )
    .unwrap();
    db.execute(
        "UPDATE questions SET favorite=1 WHERE id=?1",
        [text(borrowing_child, "id")],
    )
    .unwrap();
    assert_eq!(
        store
            .query_questions(
                std::slice::from_ref(&bank),
                ("sharedneedle", "reading", "favorite"),
                Some((1, 0))
            )
            .unwrap()["total"],
        0
    );
    db.execute(
        "UPDATE questions SET favorite=1 WHERE id=?1",
        [text(owner, "id")],
    )
    .unwrap();
    assert_eq!(
        store
            .query_questions(
                std::slice::from_ref(&bank),
                ("sharedneedle", "reading", "favorite"),
                Some((1, 0))
            )
            .unwrap()["total"],
        1
    );
}

fn measure(mut run: impl FnMut() -> Value) -> Value {
    let mut times = Vec::new();
    let mut value = Value::Null;
    for _ in 0..3 {
        let start = Instant::now();
        value = run();
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    let bytes = serde_json::to_vec(&value).unwrap();
    json!({"medianMs":times[1],"maxMs":times[2],"jsonBytes":bytes.len(),"outputSha256":hash(&bytes)})
}

#[test]
#[ignore = "synthetic search workload; run with --release --ignored --nocapture"]
fn search_stress() {
    let (_dir, store) = seed(10000);
    let mut report = json!({"questions":10000,"repetitions":3});
    for (name, offset) in [("plainPage", 0), ("latePage", 9000), ("clampedPage", 20000)] {
        report[name] = measure(|| {
            let page = store
                .query_questions(&[], ("", "", ""), Some((30, offset)))
                .unwrap();
            assert_eq!(page["total"], 10000);
            let offset = offset.min(9990);
            assert_eq!(page["offset"], offset);
            assert_eq!(list(&page, "items").len(), 30.min(10000 - offset));
            assert_eq!(page["items"][0]["id"], format!("q{offset:05}"));
            page
        });
    }
    report["matchingPage"] = measure(|| {
        let page = store
            .query_questions(&[], ("文 mix", "true_false", ""), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 10000);
        assert_eq!(list(&page, "items").len(), 30);
        page
    });
    report["matchingStats"] = measure(|| {
        let stats = store
            .question_stats(&[], ("文 mix", "true_false", ""))
            .unwrap();
        assert_eq!(stats["count"], 10000);
        assert_eq!(stats["types"], json!({"true_false":10000}));
        stats
    });
    report["missingPage"] = measure(|| {
        let page = store
            .query_questions(&[], ("不存在", "", ""), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 0);
        page
    });
    if let Ok(path) = std::env::var("PRACTIQ_SEARCH_PERF_OUTPUT") {
        fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
