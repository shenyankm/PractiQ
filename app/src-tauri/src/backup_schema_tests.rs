use super::*;

fn archive_database(database: &Path, archive: &Path) {
    let (size, digest) = file_digest(database).unwrap();
    let mut zip = ZipWriter::new(fs::File::create(archive).unwrap());
    let options = SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        json!({"format":"practiq-backup","version":4,"schemaVersion":Connection::open(database).unwrap().query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(),
            "database":{"file":"practiq.sqlite","sha256":digest,"sizeBytes":size},"assets":[]})
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    zip.start_file("practiq.sqlite", options).unwrap();
    zip.write_all(&fs::read(database).unwrap()).unwrap();
    zip.finish().unwrap();
}

#[test]
fn restore_preserves_multi_bank_composites_review_flags_and_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Store::new(dir.path().join("source")).unwrap();
    let mut document: Value =
        serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
    document["questions"].as_array_mut().unwrap().push(json!({"id":"incomplete","stem":"Missing material","answerMode":"reading","questionTypeId":"reading","analysis":"Synthetic explanation","needsReview":true,"missingFields":["sourceText"]}));
    for bank in 0..4 {
        let preview = source
            .preview(
                serde_json::to_vec(&document).unwrap(),
                format!("Bank {bank}"),
            )
            .unwrap();
        source
            .import(
                crate::contract::text(&preview, "ticket"),
                None,
                &format!("Bank {bank}"),
            )
            .unwrap();
    }
    let rows = source.question_rows().unwrap();
    let session = source
        .start_paper(crate::exams::Paper {
            question_ids: rows
                .iter()
                .filter(|r| {
                    crate::contract::text(&r["question"], "parentId").is_empty()
                        && r["question"]["stem"] != "Missing material"
                })
                .map(|r| crate::contract::text(r, "id").to_owned())
                .collect(),
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(
                &rows
                    .iter()
                    .filter(|r| r["question"]["stem"] != "Missing material")
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        })
        .unwrap();
    let sid = crate::contract::text(&session, "id");
    let db = source.connect().unwrap();
    let frozen: String = db
        .query_row(
            "SELECT content FROM session_documents WHERE session_id=?1",
            [sid],
            |r| r.get(0),
        )
        .unwrap();
    db.execute("UPDATE questions SET stem='Edited current material' WHERE mode='reading' AND stem!='Missing material'", []).unwrap();
    let expected = source.question_rows().unwrap();
    let incomplete: Vec<_> = expected
        .iter()
        .filter(|r| r["question"]["stem"] == "Missing material")
        .collect();
    assert_eq!(incomplete.len(), 4);
    for row in incomplete {
        assert_eq!(row["question"]["needsReview"], true);
        assert_eq!(
            row["question"]["missingFields"],
            json!(["sourceText", "material"])
        );
    }
    let archive = dir.path().join("multi-bank.zip");
    source.backup(&archive).unwrap();
    let mut restored = Store::new(dir.path().join("restored")).unwrap();
    restored.restore(&archive).unwrap();
    assert_eq!(restored.banks().unwrap().as_array().unwrap().len(), 4);
    assert_eq!(restored.question_rows().unwrap(), expected);
    assert_eq!(
        restored
            .connect()
            .unwrap()
            .query_row(
                "SELECT content FROM session_documents WHERE session_id=?1",
                [sid],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        frozen
    );
    assert_eq!(
        source
            .connect()
            .unwrap()
            .query_row(
                "SELECT content FROM session_documents WHERE session_id=?1",
                [sid],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        frozen
    );
}

#[test]
fn regression_restore_rejects_invalid_session_navigation_without_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Store::new(dir.path().join("source")).unwrap();
    let raw = json!({"schemaVersion":3,"questions":[{"id":"q0","stem":"First","answerMode":"short_answer","answerPayload":null},{"id":"q1","stem":"Last","answerMode":"short_answer","answerPayload":null}],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0});
    let preview = source
        .preview(serde_json::to_vec(&raw).unwrap(), "Source".into())
        .unwrap();
    source
        .import(crate::contract::text(&preview, "ticket"), None, "Source")
        .unwrap();
    let rows = source.question_rows().unwrap();
    let ids = rows
        .iter()
        .map(|r| crate::contract::text(r, "id").to_owned())
        .collect::<Vec<_>>();
    let session = source
        .start_paper(crate::exams::Paper {
            question_ids: ids,
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(&rows).unwrap(),
        })
        .unwrap();
    let sid = crate::contract::text(&session, "id");
    source.position(sid, 1, None).unwrap();
    for (case, mutation) in [
        ("valid", ""),
        ("negative-position", "UPDATE sessions SET position=-1"),
        ("fractional-position", "UPDATE sessions SET position=0.5"),
        ("past-end-position", "UPDATE sessions SET position=2"),
        (
            "negative-ordinal",
            "UPDATE attempts SET ordinal=-1 WHERE ordinal=0",
        ),
        (
            "gapped-ordinal",
            "UPDATE attempts SET ordinal=2 WHERE ordinal=1",
        ),
        ("empty-attempts", "DELETE FROM attempts"),
    ] {
        let candidate = dir.path().join(format!("{case}.sqlite"));
        source
            .connect()
            .unwrap()
            .backup(rusqlite::MAIN_DB, &candidate, None)
            .unwrap();
        Connection::open(&candidate)
            .unwrap()
            .execute_batch(mutation)
            .unwrap();
        let archive = dir.path().join(format!("{case}.zip"));
        archive_database(&candidate, &archive);
        for recover_assets in [false, true] {
            let target_dir = tempfile::tempdir().unwrap();
            let mut target = Store::new(target_dir.path().into()).unwrap();
            target.save_bank(Some("keep".into()), "Keep", "").unwrap();
            let before = fs::read(target.db_path()).unwrap();
            let outcome = if recover_assets {
                target.restore_recovering(&archive)
            } else {
                target.restore(&archive)
            };
            if case == "valid" {
                outcome.unwrap();
                assert_eq!(target.session(sid).unwrap()["position"], 1);
            } else {
                assert_eq!(
                    outcome.unwrap_err().code,
                    "LOCAL_BACKUP_RELATIONS",
                    "{case}, recovery={recover_assets}"
                );
                assert_eq!(fs::read(target.db_path()).unwrap(), before);
                assert_eq!(target.banks().unwrap()[0]["id"], "keep");
            }
        }
    }
}

#[test]
fn restore_validates_saved_answers_against_frozen_questions_before_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Store::new(dir.path().join("source")).unwrap();
    let raw = json!({"schemaVersion":3,"questions":[
        {"id":"q0","stem":"Choose","answerMode":"choice","choiceVariant":"single","options":[{"label":"A","content":"First"},{"label":"B","content":"Second"}],"answerPayload":{"correct":["A"]}},
        {"id":"words","stem":"Shared words","answerMode":"word_bank","passage":[{"partType":"blank","questionId":"gap"},{"partType":"blank","questionId":"gap2"}],"options":[{"label":"A","content":"First"},{"label":"B","content":"Second"}]},
        {"id":"gap","stem":"Gap","parentId":"words","optionSourceId":"words","answerMode":"choice","choiceVariant":"single","answerPayload":{"correct":["A"]}},
        {"id":"gap2","stem":"Second gap","parentId":"words","optionSourceId":"words","answerMode":"choice","choiceVariant":"single","answerPayload":{"correct":["B"]}},
        {"id":"incomplete","stem":"Incomplete choice","answerMode":"choice","choiceVariant":"single","options":[],"answerPayload":null},
        {"id":"text","stem":"Explain","answerMode":"short_answer","answerPayload":null}
    ],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0});
    let preview = source
        .preview(serde_json::to_vec(&raw).unwrap(), "Source".into())
        .unwrap();
    source
        .import(crate::contract::text(&preview, "ticket"), None, "Source")
        .unwrap();
    let rows = source.question_rows().unwrap();
    let session = source
        .start_paper(crate::exams::Paper {
            question_ids: rows
                .iter()
                .filter(|row| crate::contract::text(&row["question"], "parentId").is_empty())
                .map(|row| crate::contract::text(row, "id").into())
                .collect(),
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
            digest: crate::paper::digest(&rows).unwrap(),
        })
        .unwrap();
    let sid = crate::contract::text(&session, "id");
    // Live edits must not invalidate a saved answer to the frozen B option.
    source
        .connect()
        .unwrap()
        .execute("UPDATE question_options SET label='C' WHERE label='B' AND owner_id=(SELECT option_set_id FROM choice_questions WHERE question_id=(SELECT snapshot_question_id FROM attempts WHERE session_id=?1 AND ordinal=0))", [sid])
        .unwrap();
    let original_doc: String = source
        .connect()
        .unwrap()
        .query_row(
            "SELECT content FROM session_documents WHERE session_id=?1",
            [sid],
            |r| r.get(0),
        )
        .unwrap();
    let mut failures = Vec::new();
    for (case, ordinal, answer, valid) in [
        ("null", 0, Value::Null, true),
        ("empty", 0, json!({"correct":[]}), true),
        ("frozen-option", 0, json!({"correct":["B"]}), true),
        ("shared-option", 1, json!({"correct":["B"]}), true),
        (
            "free-text",
            3,
            json!({"text":"Draft for an incomplete question"}),
            true,
        ),
        ("wrong-type", 0, json!({"correct":42}), false),
        (
            "foreign-field",
            0,
            json!({"correct":["A"],"matches":42}),
            false,
        ),
        ("unknown-option", 0, json!({"correct":["Z"]}), false),
        ("unknown-shared-option", 1, json!({"correct":["Z"]}), false),
        ("string", 0, json!("A"), false),
        ("forged-missing-options", 0, json!({"text":"Bypass"}), false),
        ("exclusive-word", 1, json!({"correct":["B"]}), false),
        ("reusable-word", 1, json!({"correct":["B"]}), true),
        ("distinct-words", 1, json!({"correct":["B"]}), true),
        (
            "multibyte-limit",
            4,
            json!({"text":"😀".repeat(70_000)}),
            false,
        ),
        (
            "multibyte-within-limit",
            4,
            json!({"text":"😀".repeat(65_000)}),
            true,
        ),
        ("duplicate-leaf", 0, Value::Null, false),
        ("composite-attempt", 0, Value::Null, false),
        ("missing-leaf", 0, Value::Null, false),
        (
            "bounded-answer-validation",
            0,
            json!({"text":"😀".repeat(70_000)}),
            false,
        ),
    ] {
        let candidate = dir.path().join(format!("{case}.sqlite"));
        source
            .connect()
            .unwrap()
            .backup(rusqlite::MAIN_DB, &candidate, None)
            .unwrap();
        let db = Connection::open(&candidate).unwrap();
        db.execute(
            "UPDATE attempts SET answer=?1 WHERE ordinal=?2",
            rusqlite::params![answer.to_string(), ordinal],
        )
        .unwrap();
        let mut doc: Value = serde_json::from_str(&original_doc).unwrap();
        let qid: String = db
            .query_row(
                "SELECT snapshot_question_id FROM attempts WHERE ordinal=0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let owner = doc["questions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["question"]["answerMode"] == "word_bank")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        match case {
            "forged-missing-options" => {
                let row = doc["questions"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|r| r["id"] == qid)
                    .unwrap();
                row["question"]["missingFields"] = json!(["options"]);
            }
            "exclusive-word" | "reusable-word" | "distinct-words" => {
                db.execute(
                    "UPDATE attempts SET answer=?1 WHERE ordinal=2",
                    [
                        json!({"correct":[if case == "distinct-words" { "A" } else { "b" }]})
                            .to_string(),
                    ],
                )
                .unwrap();
                if case == "reusable-word" {
                    let row = doc["questions"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|r| r["id"] == owner)
                        .unwrap();
                    row["question"]["allowReuse"] = json!(true);
                }
            }
            "duplicate-leaf" => {
                db.execute(
                    "UPDATE attempts SET snapshot_question_id=?1 WHERE ordinal=1",
                    [&qid],
                )
                .unwrap();
            }
            "composite-attempt" => {
                db.execute(
                    "UPDATE attempts SET snapshot_question_id=?1 WHERE ordinal=1",
                    [&owner],
                )
                .unwrap();
            }
            "missing-leaf" => {
                db.execute("DELETE FROM attempts WHERE ordinal=4", [])
                    .unwrap();
            }
            "bounded-answer-validation" => {
                // A later unreadable value must not hide the first answer's size failure.
                db.execute(
                    "UPDATE attempts SET answer=CAST('null' AS BLOB) WHERE ordinal=4",
                    [],
                )
                .unwrap();
            }
            _ => {}
        }
        db.execute("UPDATE session_documents SET content=?1", [doc.to_string()])
            .unwrap();
        drop(db);
        let archive = dir.path().join(format!("{case}.zip"));
        archive_database(&candidate, &archive);
        for repair in [false, true] {
            let target_dir = tempfile::tempdir().unwrap();
            let mut target = Store::new(target_dir.path().into()).unwrap();
            target.save_bank(Some("keep".into()), "Keep", "").unwrap();
            let before = fs::read(target.db_path()).unwrap();
            let outcome = if repair {
                target.restore_recovering(&archive)
            } else {
                target.restore(&archive)
            };
            if outcome.is_ok() != valid {
                failures.push(format!("{case}, repair={repair}: {outcome:?}"));
                continue;
            }
            if valid {
                assert_eq!(
                    target.session(sid).unwrap()["attempts"][ordinal]["answer"],
                    answer
                );
            } else {
                let code = match case {
                    "wrong-type" => "LOCAL_ANSWER_FIELD_INVALID",
                    "foreign-field" | "forged-missing-options" => "LOCAL_ANSWER_MODE_MISMATCH",
                    "unknown-option" | "unknown-shared-option" => "LOCAL_OPTION_REFERENCE_INVALID",
                    "string" => "LOCAL_SCHEMA_INVALID",
                    "exclusive-word" => "LOCAL_WORD_REUSED",
                    "multibyte-limit" | "bounded-answer-validation" => "LOCAL_ANSWER_INVALID",
                    "duplicate-leaf" | "composite-attempt" | "missing-leaf" => {
                        "LOCAL_BACKUP_RELATIONS"
                    }
                    _ => unreachable!(),
                };
                assert_eq!(outcome.unwrap_err().code, code, "{case}, repair={repair}");
                assert_eq!(fs::read(target.db_path()).unwrap(), before);
                assert_eq!(target.banks().unwrap()[0]["id"], "keep");
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn restores_backups_with_the_pre_zh_tw_locale_constraint() {
    let source_dir = tempfile::tempdir().unwrap();
    let path = source_dir.path().join("practiq.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(&include_str!("schema.sql").replace("'zh-CN','zh-TW','en'", "'zh-CN','en'"))
        .unwrap();
    db.execute_batch("INSERT INTO banks VALUES('old','Old','',1); UPDATE settings SET locale='en',model_id='keep-model',base_url='http://127.0.0.1:8000';")
        .unwrap();
    drop(db);
    let original = fs::read(&path).unwrap();
    let archive = source_dir.path().join("old.zip");
    archive_database(&path, &archive);
    let target_dir = tempfile::tempdir().unwrap();
    let mut store = Store::new(target_dir.path().to_path_buf()).unwrap();
    store.restore(&archive).unwrap();
    assert_eq!(store.banks().unwrap()[0]["id"], "old");
    assert_eq!(
        store.language().unwrap(),
        Some(crate::language::Locale::English)
    );
    assert_eq!(
        store.connection_settings().unwrap().model_id.as_deref(),
        Some("keep-model")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    store
        .save_language(crate::language::Locale::TraditionalChinese)
        .unwrap();
    assert_eq!(
        store.language().unwrap(),
        Some(crate::language::Locale::TraditionalChinese)
    );
    let roundtrip = target_dir.path().join("traditional.zip");
    store.backup(&roundtrip).unwrap();
    store
        .save_language(crate::language::Locale::Chinese)
        .unwrap();
    store.restore_recovering(&roundtrip).unwrap();
    let reopened = Store::new(target_dir.path().to_path_buf()).unwrap();
    assert_eq!(
        reopened.language().unwrap(),
        Some(crate::language::Locale::TraditionalChinese)
    );
    assert_eq!(reopened.banks().unwrap()[0]["id"], "old");
    assert_eq!(
        reopened.connection_settings().unwrap().model_id.as_deref(),
        Some("keep-model")
    );
}

#[test]
fn backups_restore_across_lf_and_crlf_schema_sources() {
    for line_ending in ["\n", "\r\n"] {
        let source_dir = tempfile::tempdir().unwrap();
        let source_path = source_dir.path().join("practiq.sqlite");
        let schema = include_str!("schema.sql")
            .lines()
            .collect::<Vec<_>>()
            .join(line_ending);
        let db = Connection::open(&source_path).unwrap();
        db.execute_batch(&schema).unwrap();
        db.execute_batch("INSERT INTO banks VALUES('portable','Portable','Preserved',1);")
            .unwrap();
        let stored: String = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='questions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored.contains("\r\n"), line_ending == "\r\n");
        drop(db);
        let archive = source_dir.path().join("portable.zip");
        archive_database(&source_path, &archive);
        let target_dir = tempfile::tempdir().unwrap();
        let mut target = Store::new(target_dir.path().to_owned()).unwrap();
        target
            .restore(&archive)
            .unwrap_or_else(|error| panic!("line ending {line_ending:?}: {error}"));
        assert_eq!(target.banks().unwrap()[0]["id"], "portable");
        let again = target_dir.path().join("portable-again.zip");
        target.backup(&again).unwrap();
        target.restore(&again).unwrap();
        assert_eq!(target.banks().unwrap()[0]["id"], "portable");
    }
}

#[test]
fn startup_and_restore_reject_noncurrent_schemas_without_changing_data() {
    let alterations = [
        "PRAGMA user_version=10;",
        "PRAGMA user_version=0;",
        "DROP INDEX visuals_bank; ALTER TABLE visuals DROP COLUMN document_level;",
        "ALTER TABLE listening_playback DROP COLUMN active_elapsed_ms;",
        "DROP INDEX sessions_activity_order; ALTER TABLE sessions DROP COLUMN last_active_at;",
        "DROP TABLE question_reviews;",
        "ALTER TABLE settings ADD COLUMN libreoffice_path TEXT; UPDATE settings SET libreoffice_path='/untrusted/program';",
        "ALTER TABLE settings ADD COLUMN oss_url TEXT;",
        "DROP INDEX banks_created_order;",
        "ALTER TABLE visuals ADD COLUMN extra TEXT;",
        "CREATE TABLE sqliteShadow(value TEXT);",
        "CREATE TRIGGER unexpected AFTER INSERT ON banks BEGIN DELETE FROM banks; END;",
        "DROP INDEX visuals_bank; CREATE INDEX visuals_bank ON visuals(content);",
        "DROP TABLE IF EXISTS question_reviews; CREATE TABLE question_reviews(question_id TEXT PRIMARY KEY);",
    ];
    for legacy_settings in [false, true] {
        for line_ending in ["\n", "\r\n"] {
            for alteration in alterations {
                let source_dir = tempfile::tempdir().unwrap();
                let source_path = source_dir.path().join("practiq.sqlite");
                let db = Connection::open(&source_path).unwrap();
                db.execute_batch(
                    &include_str!("schema.sql")
                        .replace("\r\n", "\n")
                        .replace('\n', line_ending),
                )
                .unwrap();
                if legacy_settings {
                    db.execute_batch("DROP TABLE settings;").unwrap();
                    db.execute_batch(crate::store::OLD_SETTINGS_SQL).unwrap();
                    db.execute_batch("INSERT INTO settings VALUES(1,NULL,NULL,NULL);")
                        .unwrap();
                }
                db.execute_batch(alteration).unwrap();
                drop(db);
                let original = fs::read(&source_path).unwrap();
                assert!(
                    Store::new(source_dir.path().to_owned()).is_err(),
                    "{alteration}"
                );
                assert_eq!(fs::read(&source_path).unwrap(), original);
                let archive = source_dir.path().join("invalid.zip");
                archive_database(&source_path, &archive);
                let target_dir = tempfile::tempdir().unwrap();
                let mut target = Store::new(target_dir.path().to_owned()).unwrap();
                target.save_bank(Some("keep".into()), "Keep", "").unwrap();
                let before = fs::read(target.db_path()).unwrap();
                assert_eq!(
                    target.restore(&archive).unwrap_err().code,
                    if alteration.starts_with("PRAGMA user_version") {
                        "LOCAL_BACKUP_DATABASE_VERSION"
                    } else {
                        "LOCAL_BACKUP_SCHEMA_UNSUPPORTED"
                    }
                );
                assert_eq!(fs::read(target.db_path()).unwrap(), before);
                assert_eq!(target.banks().unwrap()[0]["id"], "keep");
            }
        }
    }
}
