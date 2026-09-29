//! Test-only faults; subprocesses and databases are disposable.
use super::*;
use crate::contract::text;
use std::{
    io::ErrorKind,
    process::Command,
    time::{Duration, Instant},
};

pub(super) fn checkpoint(phase: &str) {
    if std::env::var("PRACTIQ_RESTORE_KILL_PHASE").as_deref() == Ok(phase) {
        let marker = std::env::var("PRACTIQ_RESTORE_MARKER").unwrap();
        fs::write(marker, phase).unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    if phase == "after-publish" {
        // Set only after the recovery archive has been synced.
        crate::filesystem::FAILURE.with(|f| {
            if f.get().is_some_and(|(name, _)| name == "restore-sync") {
                f.set(Some(("sync", ErrorKind::StorageFull)));
            }
        });
    }
}

fn populated(path: &Path, title: &str) -> Store {
    let mut store = Store::new(path.to_owned()).unwrap();
    let preview = store
        .preview(
            include_bytes!("../../fixtures/sample.json").to_vec(),
            title.into(),
        )
        .unwrap();
    store
        .resources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources"))
        .unwrap();
    store.import(text(&preview, "ticket"), None, title).unwrap();
    let bank = store.banks().unwrap()[0]["id"].as_str().unwrap().to_owned();
    let preview = store
        .preview(
            include_bytes!("../../fixtures/english.json").to_vec(),
            title.into(),
        )
        .unwrap();
    store
        .resources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/resources"))
        .unwrap();
    store
        .import(text(&preview, "ticket"), Some(bank), title)
        .unwrap();
    let rows = store.question_rows().unwrap();
    let ids = rows
        .iter()
        .filter(|row| row["question"]["parentId"].is_null())
        .map(|row| text(row, "id").to_owned())
        .collect::<Vec<_>>();
    let selected = crate::paper::selected_rows(&rows, &ids).unwrap();
    store
        .start_paper(crate::exams::Paper {
            question_ids: ids,
            digest: crate::paper::digest(&selected).unwrap(),
            kind: "practice".into(),
            minutes: None,
            scores: vec![],
            total_cents: 0,
        })
        .unwrap();
    store
}

fn assert_intact(store: &Store, title: &str) {
    assert_eq!(store.banks().unwrap()[0]["title"], title);
    let db = store.connect().unwrap();
    let sid = db
        .query_row("SELECT id FROM sessions", [], |r| r.get::<_, String>(0))
        .unwrap();
    assert!(!crate::contract::list(&store.session(&sid).unwrap(), "attempts").is_empty());
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    let mut stmt = db.prepare("SELECT hash,size FROM assets").unwrap();
    for row in stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)))
        .unwrap()
    {
        let (hash, size) = row.unwrap();
        store.read_asset(&hash, size).unwrap();
    }
}

#[test]
#[ignore = "reads the real 512 MiB boundary; run explicitly with --ignored"]
fn backup_size_boundary_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sparse");
    fs::File::create(&path)
        .unwrap()
        .set_len(LIMIT as u64)
        .unwrap();
    assert_eq!(file_digest(&path).unwrap().0, LIMIT as u64);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(LIMIT as u64 + 1)
        .unwrap();
    assert_eq!(
        file_digest(&path).unwrap_err().code,
        "LOCAL_BACKUP_TOO_LARGE"
    );
}

#[test]
fn publication_errors_preserve_backup_and_restore_generation() {
    let dir = tempfile::tempdir().unwrap();
    let mut current = populated(&dir.path().join("current"), "Old");
    let incoming = populated(&dir.path().join("incoming"), "New");
    let archive = dir.path().join("incoming.zip");
    incoming.backup(&archive).unwrap();
    let existing = dir.path().join("saved.zip");
    fs::write(&existing, b"previous backup").unwrap();
    for kind in [ErrorKind::StorageFull, ErrorKind::PermissionDenied] {
        crate::filesystem::FAILURE.with(|f| f.set(Some(("persist", kind))));
        assert!(current.backup(&existing).is_err());
        assert_eq!(fs::read(&existing).unwrap(), b"previous backup");
        crate::filesystem::FAILURE.with(|f| f.set(Some(("persist", kind))));
        assert!(current.restore(&archive).is_err());
        assert_intact(&Store::new(current.dir.clone()).unwrap(), "Old");
    }
    crate::filesystem::FAILURE.with(|f| f.set(Some(("restore-sync", ErrorKind::StorageFull))));
    assert!(current.restore(&archive).is_err());
    assert_intact(&Store::new(current.dir.clone()).unwrap(), "Old");
    current.restore(&archive).unwrap();
    assert_intact(&current, "New");
}

#[test]
fn locked_database_rejects_write_without_losing_saved_data() {
    let dir = tempfile::tempdir().unwrap();
    let store = populated(dir.path(), "Old");
    let db = store.connect().unwrap();
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(store.save_bank(None, "Blocked", "").is_err());
    db.execute_batch("ROLLBACK").unwrap();
    assert_intact(&Store::new(dir.path().to_owned()).unwrap(), "Old");
}

#[test]
fn restore_child() {
    let Ok(root) = std::env::var("PRACTIQ_RESTORE_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    Store::new(root.join("current"))
        .unwrap()
        .restore(&root.join("incoming.zip"))
        .unwrap();
}

#[test]
fn killed_restore_reopens_a_complete_generation() {
    for phase in ["before-publish", "after-publish"] {
        let dir = tempfile::tempdir().unwrap();
        populated(&dir.path().join("current"), "Old");
        populated(&dir.path().join("incoming"), "New")
            .backup(&dir.path().join("incoming.zip"))
            .unwrap();
        let marker = dir.path().join("ready");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup::fault_tests::restore_child",
                "--nocapture",
            ])
            .env("PRACTIQ_RESTORE_TEST_ROOT", dir.path())
            .env("PRACTIQ_RESTORE_KILL_PHASE", phase)
            .env("PRACTIQ_RESTORE_MARKER", &marker)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !marker.exists() && start.elapsed() < Duration::from_secs(20) {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let reached = marker.exists();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(reached, "restore did not reach {phase}");
        let mut store = Store::new(dir.path().join("current")).unwrap();
        assert_intact(
            &store,
            if phase == "before-publish" {
                "Old"
            } else {
                "New"
            },
        );
        let recovery = fs::read_dir(store.dir.join("recoveries"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        store.restore(&recovery).unwrap();
        assert_intact(&store, "Old");
    }
}
