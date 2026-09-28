use super::*;

fn archive_database(database: &Path, archive: &Path) {
    let (size, digest) = file_digest(database).unwrap();
    let mut zip = ZipWriter::new(fs::File::create(archive).unwrap());
    let options = SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(
        json!({"format":"practiq-backup","version":4,"schemaVersion":10,
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
fn schema_ten_column_combinations_restore_before_and_after_startup() {
    for missing in 0..16 {
        let source_dir = tempfile::tempdir().unwrap();
        let source_path = source_dir.path().join("practiq.sqlite");
        let mut schema = include_str!("schema.sql").to_owned();
        for (bit, column) in [
            (
                1,
                ",document_level INTEGER NOT NULL CHECK(document_level IN(0,1))",
            ),
            (
                2,
                ",active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_elapsed_ms>=0)",
            ),
            (4, ", last_active_at INTEGER"),
        ] {
            if missing & bit != 0 {
                schema = schema.replace(column, "");
            }
        }
        if missing & 8 != 0 {
            schema = schema
                .lines()
                .filter(|line| !line.starts_with("CREATE TABLE question_reviews("))
                .collect::<Vec<_>>()
                .join("\n");
        }
        let db = Connection::open(&source_path).unwrap();
        db.execute_batch(&schema).unwrap();
        db.execute_batch("INSERT INTO banks VALUES('legacy-bank','Legacy','Preserved',1); INSERT INTO sessions(id,bank_title,created_at,finished_at,position,mode) VALUES('legacy-session','Legacy',7,11,0,'ordered');").unwrap();
        let snapshot = json!({"schemaVersion":3,"questions":[],"groups":[],"visuals":[]});
        db.execute(
            "INSERT INTO session_documents VALUES('legacy-session',?1)",
            [snapshot.to_string()],
        )
        .unwrap();
        drop(db);
        let old_archive = source_dir.path().join("before-startup.zip");
        archive_database(&source_path, &old_archive);
        let target_dir = tempfile::tempdir().unwrap();
        let mut target = Store::new(target_dir.path().to_owned()).unwrap();
        target
            .restore(&old_archive)
            .unwrap_or_else(|error| panic!("legacy combination {missing}: {error}"));

        let source = Store::new(source_dir.path().to_owned()).unwrap();
        source.connect().unwrap(); // Migration remains repeatable.
        let upgraded_archive = source_dir.path().join("after-startup.zip");
        source.backup(&upgraded_archive).unwrap();
        target
            .restore(&upgraded_archive)
            .unwrap_or_else(|error| panic!("migrated combination {missing}: {error}"));
        assert_eq!(target.banks().unwrap()[0]["id"], "legacy-bank");
        let restored: String = target
            .connect()
            .unwrap()
            .query_row(
                "SELECT content FROM session_documents WHERE session_id='legacy-session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&restored).unwrap(), snapshot);
        if missing & 4 != 0 {
            assert_eq!(
                target
                    .connect()
                    .unwrap()
                    .query_row(
                        "SELECT last_active_at FROM sessions WHERE id='legacy-session'",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                11
            );
        }
    }
}

#[test]
fn schema_compatibility_does_not_accept_unrecognized_definitions_or_change_live_data() {
    for alteration in [
        "ALTER TABLE visuals ADD COLUMN extra TEXT;",
        "CREATE TRIGGER unexpected AFTER INSERT ON banks BEGIN DELETE FROM banks; END;",
        "CREATE INDEX visuals_bank ON visuals(content);",
        "DROP TABLE IF EXISTS question_reviews; CREATE TABLE question_reviews(question_id TEXT PRIMARY KEY);",
    ] {
        let source_dir = tempfile::tempdir().unwrap();
        let source_path = source_dir.path().join("practiq.sqlite");
        let db = Connection::open(&source_path).unwrap();
        db.execute_batch(include_str!("schema.sql")).unwrap();
        db.execute_batch(alteration).unwrap();
        drop(db);
        let archive = source_dir.path().join("invalid.zip");
        archive_database(&source_path, &archive);
        let target_dir = tempfile::tempdir().unwrap();
        let mut target = Store::new(target_dir.path().to_owned()).unwrap();
        target.save_bank(Some("keep".into()), "Keep", "").unwrap();
        let before = fs::read(target.db_path()).unwrap();
        assert_eq!(
            target.restore(&archive).unwrap_err().code,
            "LOCAL_BACKUP_SCHEMA_UNSUPPORTED"
        );
        assert_eq!(fs::read(target.db_path()).unwrap(), before);
        assert_eq!(target.banks().unwrap()[0]["id"], "keep");
    }
}
