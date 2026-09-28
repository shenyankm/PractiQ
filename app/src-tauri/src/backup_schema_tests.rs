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
