use crate::{
    contract::{list, text},
    exams::Paper,
    store::Store,
};
use serde_json::{json, Value};
use std::io::Read;

fn setup() -> (tempfile::TempDir, Store, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(dir.path().to_owned()).unwrap();
    let mut document: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
    let child = document["questions"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|question| question["id"] == "words1")
        .unwrap();
    child["stem"] = json!("leaf-review-marker");
    child["answerPayload"] = Value::Null;
    child["needsReview"] = json!(true);
    child["missingFields"] = json!(["answerPayload"]);
    let preview = store
        .preview(serde_json::to_vec(&document).unwrap(), "Review".into())
        .unwrap();
    let receipt = store
        .import(text(&preview, "ticket"), None, "Review")
        .unwrap();
    let bank = text(&receipt, "bankId").to_owned();
    let roots = store.questions(Some(&bank), "", "", "").unwrap();
    let root = roots
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["question"]["answerMode"] == "reading")
        .unwrap();
    assert_eq!(root["question"]["needsReview"], false);
    (dir, store, bank, text(root, "id").to_owned())
}

#[test]
fn confirmation_filters_complete_trees_and_persists_without_changing_source_flags() {
    let (dir, store, bank, root) = setup();
    let before = store.question_rows().unwrap();
    let index = crate::questions::Index::new(&before);
    let tree_ids: Vec<_> = index.trees[root.as_str()]
        .iter()
        .map(|row| text(row, "id").to_owned())
        .collect();
    let pending = store.questions(Some(&bank), "", "", "review").unwrap();
    assert_eq!(pending.as_array().unwrap().len(), 1);
    assert_eq!(pending[0]["id"], root);
    assert_eq!(list(&pending[0], "children").len() + 1, tree_ids.len());
    assert_eq!(
        store
            .questions(Some(&bank), "leaf-review-marker", "", "review")
            .unwrap(),
        pending
    );
    let page = store
        .query_questions(
            std::slice::from_ref(&bank),
            ("", "", "review"),
            Some((1, 0)),
        )
        .unwrap();
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["id"], pending[0]["id"]);
    assert_eq!(page["items"][0]["reviewRequired"], true);
    assert!(
        store
            .question_stats(std::slice::from_ref(&bank), ("", "", "review"))
            .unwrap()["count"]
            .as_u64()
            .unwrap()
            > 0
    );

    let reviewed_at = store.review_question(&root, true).unwrap();
    assert!(reviewed_at.as_i64().is_some_and(|timestamp| timestamp >= 0));
    for row in store.question_rows().unwrap() {
        assert_eq!(
            row["reviewedAt"],
            if tree_ids.contains(&text(&row, "id").to_owned()) {
                reviewed_at.clone()
            } else {
                Value::Null
            }
        );
    }
    assert_eq!(
        store
            .question_rows()
            .unwrap()
            .iter()
            .map(|row| &row["question"])
            .collect::<Vec<_>>(),
        before
            .iter()
            .map(|row| &row["question"])
            .collect::<Vec<_>>()
    );
    drop(store);
    let reopened = Store::new(dir.path().to_owned()).unwrap();
    for search in ["", "leaf-review-marker"] {
        assert_eq!(
            reopened
                .questions(Some(&bank), search, "", "review")
                .unwrap(),
            json!([])
        );
    }
    assert_eq!(
        reopened
            .question_stats(std::slice::from_ref(&bank), ("", "", "review"))
            .unwrap()["count"],
        0
    );
    let roots = reopened.questions(Some(&bank), "", "", "").unwrap();
    assert_eq!(
        roots
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == root)
            .unwrap()["reviewedAt"],
        reviewed_at
    );
    assert!(reopened.review_question(&root, false).unwrap().is_null());
    assert_eq!(
        reopened.questions(Some(&bank), "", "", "review").unwrap(),
        pending
    );
}

#[test]
fn review_search_matches_other_nodes_and_shared_content_in_a_pending_tree() {
    let (_dir, store, bank, root) = setup();
    let pending = store.questions(Some(&bank), "", "", "review").unwrap();
    let stats = store
        .question_stats(std::slice::from_ref(&bank), ("", "", "review"))
        .unwrap();
    assert_eq!(stats["count"], 6);
    let searches = ["reading", "seasons change", "r-choice", "Composite section"];
    for search in searches {
        assert_eq!(
            store.questions(Some(&bank), search, "", "review").unwrap(),
            pending,
            "search {search:?} must keep the complete pending tree"
        );
        let page = store
            .query_questions(
                std::slice::from_ref(&bank),
                (search, "reading", "review"),
                Some((1, 0)),
            )
            .unwrap();
        assert_eq!(page["items"][0]["id"], pending[0]["id"]);
        assert_eq!(page["items"][0]["reviewRequired"], true);
        assert_eq!(page["total"], 1);
        assert_eq!(
            store
                .question_stats(std::slice::from_ref(&bank), (search, "reading", "review"))
                .unwrap(),
            stats
        );
    }
    // A match in a different, already complete tree cannot satisfy the pending filter.
    assert_eq!(
        store
            .questions(Some(&bank), "words-root", "", "review")
            .unwrap(),
        json!([])
    );
    store.review_question(&root, true).unwrap();
    for search in searches {
        assert_eq!(
            store.questions(Some(&bank), search, "", "review").unwrap(),
            json!([])
        );
        assert_eq!(
            store
                .question_stats(std::slice::from_ref(&bank), (search, "", "review"))
                .unwrap()["count"],
            0
        );
    }
}

#[test]
fn review_rejects_missing_or_child_ids_and_editing_clears_tree_confirmation() {
    let (_dir, store, bank, root) = setup();
    let rows = store.question_rows().unwrap();
    let leaf = rows
        .iter()
        .find(|row| row["question"]["stem"] == "leaf-review-marker")
        .unwrap();
    for id in ["", "missing-question", text(leaf, "id")] {
        assert!(store.review_question(id, true).is_err());
        assert!(store.review_question(id, false).is_err());
    }
    assert!(store
        .question_rows()
        .unwrap()
        .iter()
        .all(|row| row["reviewedAt"].is_null()));
    store.review_question(&root, true).unwrap();
    let index = crate::questions::Index::new(&rows);
    let mut tree: Vec<_> = index.trees[root.as_str()]
        .iter()
        .map(|row| row["question"].clone())
        .collect();
    tree[0]["stem"] = json!("Edited reading material");
    store.save_question_tree(&bank, Some(&root), tree).unwrap();
    assert!(store
        .question_rows()
        .unwrap()
        .iter()
        .all(|row| row["reviewedAt"].is_null()));
    let pending = store
        .questions(Some(&bank), "leaf-review-marker", "", "review")
        .unwrap();
    assert_eq!(pending[0]["id"], root);
    assert_eq!(pending[0]["question"]["stem"], "Edited reading material");
    let child = list(&pending[0], "children")
        .iter()
        .find(|row| row["question"]["stem"] == "leaf-review-marker")
        .unwrap();
    assert_eq!(child["question"]["needsReview"], true);
    assert!(list(&child["question"], "missingFields").contains(&json!("answerPayload")));
}

#[test]
fn full_backup_keeps_confirmation_but_shared_copies_and_snapshots_exclude_it() {
    let (dir, store, bank, root) = setup();
    let reviewed_at = store.review_question(&root, true).unwrap();
    let selected =
        crate::paper::selected_rows(&store.question_rows().unwrap(), std::slice::from_ref(&root))
            .unwrap();
    let session = store
        .start_paper(Paper {
            question_ids: vec![root.clone()],
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(&selected).unwrap(),
        })
        .unwrap();
    let frozen: String = store
        .connect()
        .unwrap()
        .query_row(
            "SELECT content FROM session_documents WHERE session_id=?1",
            [text(&session, "id")],
            |row| row.get(0),
        )
        .unwrap();
    let frozen: Value = serde_json::from_str(&frozen).unwrap();
    assert!(list(&frozen, "questions")
        .iter()
        .all(|row| row.get("reviewedAt").is_none()));

    let backup = dir.path().join("review-backup.zip");
    store.backup(&backup).unwrap();
    let target_dir = tempfile::tempdir().unwrap();
    let mut target = Store::new(target_dir.path().to_owned()).unwrap();
    target.restore(&backup).unwrap();
    let restored = target.questions(Some(&bank), "", "", "").unwrap();
    assert_eq!(
        restored
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == root)
            .unwrap()["reviewedAt"],
        reviewed_at
    );
    assert_eq!(
        target.questions(Some(&bank), "", "", "review").unwrap(),
        json!([])
    );

    let package = dir.path().join("review-bank.zip");
    store.export_bank(&bank, &package).unwrap();
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&package).unwrap()).unwrap();
    let mut exported = String::new();
    archive
        .by_name("questions.json")
        .unwrap()
        .read_to_string(&mut exported)
        .unwrap();
    assert!(!exported.contains("reviewedAt"));
    assert!(!exported.contains("reviewed_at"));
    let preview = target.preview_bank_zip(&package).unwrap();
    let imported = target
        .import(text(&preview, "ticket"), None, "Shared")
        .unwrap();
    let imported_bank = text(&imported, "bankId");
    let imported_rows = target
        .questions(Some(imported_bank), "", "", "review")
        .unwrap();
    assert_eq!(imported_rows.as_array().unwrap().len(), 1);
    assert!(imported_rows[0]["reviewedAt"].is_null());

    let other = store.save_bank(None, "Other", "").unwrap();
    let merged = store
        .merge_banks(&[bank, other.as_str().unwrap().to_owned()], "Merged")
        .unwrap();
    let merged_bank = text(&merged, "bankId");
    let merged_pending = store
        .questions(Some(merged_bank), "", "", "review")
        .unwrap();
    assert_eq!(merged_pending.as_array().unwrap().len(), 1);
    assert!(merged_pending[0]["reviewedAt"].is_null());
}

#[test]
fn list_summaries_preserve_child_flags_and_fetch_the_material_only_on_demand() {
    let (_dir, store, bank, root) = setup();
    let detail = store.question_detail(&root).unwrap();
    let child = text(&detail["children"][0], "id");
    store.favorite(child, true).unwrap();
    let db = store.connect().unwrap();
    db.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind) VALUES('summary','Test',1,0,'ordered','practice')",[]).unwrap();
    db.execute(
        "INSERT INTO session_documents VALUES('summary',?1)",
        [crate::questions::freeze(&store.question_rows().unwrap()).to_string()],
    )
    .unwrap();
    db.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,result,submitted_at,max_cents,earned_cents) VALUES('summary',0,?1,?1,0,1,100,50)",[child]).unwrap();
    let page = store
        .questions_with_stats(&[bank], ("", "", ""), (30, 0))
        .unwrap();
    let summary = list(&page, "items")
        .iter()
        .find(|r| r["id"] == root)
        .unwrap();
    assert_eq!(summary["answerableCount"], 6);
    assert_eq!(summary["reviewRequired"], true);
    assert_eq!(summary["favorite"], true);
    assert_eq!(summary["hasWrong"], true);
    assert_eq!(summary["hasPartialScore"], true);
    assert!(summary["children"].is_null() && summary["question"]["passage"].is_null());
    assert_eq!(page["stats"]["count"], 10);
    let full = store.question_detail(&root).unwrap();
    assert_eq!(list(&full, "children").len(), 8);
    assert_eq!(full["question"], detail["question"]);
    assert!(list(&full, "children")
        .iter()
        .all(|row| row["materials"].is_null()));
    assert!(store.question_detail(child).is_err());
    assert!(store.question_detail("missing").is_err());
    store.review_question(&root, true).unwrap();
    let page = store
        .query_questions(&[], ("", "", ""), Some((30, 0)))
        .unwrap();
    assert_eq!(
        list(&page, "items")
            .iter()
            .find(|r| r["id"] == root)
            .unwrap()["reviewRequired"],
        false
    );
}
