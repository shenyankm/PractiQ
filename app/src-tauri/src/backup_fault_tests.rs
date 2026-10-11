//! Test-only faults; subprocesses and databases are disposable.
use super::*;
use crate::contract::text;
use std::{
    io::{BufRead, BufReader, ErrorKind, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

#[test]
fn explicit_recovery_preserves_damaged_bytes_and_repairs_bank_and_history_resources() {
    for history_only in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let source = populated(&dir.path().join("source"), "Incoming");
        let archive = dir.path().join("incoming.zip");
        source.backup(&archive).unwrap();
        let mut target = populated(&dir.path().join("target"), "Previous");
        if history_only {
            let bank = text(&target.banks().unwrap()[0], "id").to_owned();
            target.delete_bank(&bank).unwrap();
        }
        let assets = target
            .connect()
            .unwrap()
            .prepare("SELECT hash,media,size FROM assets ORDER BY hash")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        let image = assets
            .iter()
            .find(|(_, media, _)| media == "image/png")
            .unwrap();
        let audio = assets
            .iter()
            .find(|(_, media, _)| media == "audio/wav")
            .unwrap();
        fs::write(
            target.asset_path(&image.0).unwrap(),
            b"damaged-original-image",
        )
        .unwrap();
        fs::remove_file(target.asset_path(&audio.0).unwrap()).unwrap();
        assert!(target
            .backup(&dir.path().join("invalid-current.zip"))
            .is_err());
        let result = target.restore_recovering(&archive).unwrap();
        let recovery = std::path::PathBuf::from(text(&result, "recoveryPath"));
        let inventory: Value =
            serde_json::from_slice(&fs::read(recovery.join("inventory.json")).unwrap()).unwrap();
        assert_eq!(inventory["format"], "practiq-recovery");
        assert_eq!(
            file_digest(&recovery.join("practiq.sqlite")).unwrap().1,
            inventory["database"]["sha256"]
        );
        let saved = Connection::open(recovery.join("practiq.sqlite")).unwrap();
        assert!(
            saved
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap()
                > 0
        );
        assert_eq!(
            saved
                .query_row("SELECT count(*) FROM banks", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            if history_only { 0 } else { 1 }
        );
        assert_eq!(
            fs::read(recovery.join(format!("assets/{}", image.0))).unwrap(),
            b"damaged-original-image"
        );
        assert!(inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset["sha256"] == image.0 && asset["status"] == "damaged"));
        assert!(inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|asset| asset["sha256"] == audio.0 && asset["status"] == "missing"));
        for (digest, _, size) in &assets {
            assert_eq!(
                crate::store::hash(&target.read_asset(digest, *size).unwrap()),
                *digest
            );
        }
        assert_eq!(target.banks().unwrap()[0]["title"], "Incoming");
        target.backup(&dir.path().join("repaired.zip")).unwrap();
    }
}

#[test]
fn explicit_recovery_failures_preserve_original_data_and_durable_inventory() {
    for failure in ["repair-persist", "restore-sync"] {
        let dir = tempfile::tempdir().unwrap();
        let source = populated(&dir.path().join("source"), "Incoming");
        let archive = dir.path().join("incoming.zip");
        source.backup(&archive).unwrap();
        let mut target = populated(&dir.path().join("target"), "Previous");
        let (digest, size): (String, u64) = target
            .connect()
            .unwrap()
            .query_row(
                "SELECT hash,size FROM assets WHERE media='image/png' LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        fs::write(target.asset_path(&digest).unwrap(), b"previous-damage").unwrap();
        crate::filesystem::FAILURE.with(|fault| fault.set(Some((failure, ErrorKind::StorageFull))));
        let error = target.restore_recovering(&archive).unwrap_err();
        assert_eq!(error.code, "LOCAL_RESTORE_RECOVERY_FAILED");
        let recovery = Path::new(error.params["path"].as_str().unwrap());
        assert_eq!(
            fs::read(recovery.join(format!("assets/{digest}"))).unwrap(),
            b"previous-damage"
        );
        assert!(recovery.join("inventory.json").is_file());
        assert_eq!(target.banks().unwrap()[0]["title"], "Previous");
        assert!(target.service_settings_override().is_ok());
        target.save_bank(None, "After failure", "").unwrap();
        if failure == "restore-sync" {
            assert!(target.read_asset(&digest, size).is_ok());
        } else {
            assert!(target.read_asset(&digest, size).is_err());
        }
        target.restore_recovering(&archive).unwrap();
    }
}

#[test]
fn explicit_recovery_rejects_bad_replacement_before_preserving_or_changing_live_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = populated(&dir.path().join("source"), "Incoming");
    let archive = dir.path().join("incoming.zip");
    source.backup(&archive).unwrap();
    let mut target = populated(&dir.path().join("target"), "Previous");
    let orphan = crate::store::hash(b"original unindexed bytes");
    target
        .write_asset(&orphan, b"original unindexed bytes")
        .unwrap();
    let digest: String = target
        .connect()
        .unwrap()
        .query_row(
            "SELECT hash FROM assets WHERE media='image/png' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    fs::write(target.asset_path(&digest).unwrap(), b"original-damage").unwrap();
    let mut input = ZipArchive::new(fs::File::open(&archive).unwrap()).unwrap();
    let bad = dir.path().join("bad.zip");
    let mut output = ZipWriter::new(fs::File::create(&bad).unwrap());
    for index in 0..input.len() {
        let mut entry = input.by_index(index).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        if entry.name() == format!("assets/{digest}") {
            bytes[0] ^= 1;
        }
        output
            .start_file(entry.name(), SimpleFileOptions::default())
            .unwrap();
        output.write_all(&bytes).unwrap();
    }
    output.finish().unwrap();
    let error = target.restore_recovering(&bad).unwrap_err();
    assert_eq!(error.code, "LOCAL_ASSET_CHECKSUM_MISMATCH");
    assert_eq!(
        fs::read(target.asset_path(&digest).unwrap()).unwrap(),
        b"original-damage"
    );
    assert_eq!(target.banks().unwrap()[0]["title"], "Previous");
    assert!(!target.dir.join("recoveries").exists());
    assert_eq!(
        fs::read(target.asset_path(&orphan).unwrap()).unwrap(),
        b"original unindexed bytes"
    );
    target.save_bank(None, "After rejection", "").unwrap();
}

pub(super) fn checkpoint(phase: &str) {
    if phase == "before-resource-repair" {
        crate::filesystem::FAILURE.with(|fault| {
            if fault
                .get()
                .is_some_and(|(name, _)| name == "repair-persist")
            {
                fault.set(Some(("persist", ErrorKind::StorageFull)));
            }
        });
    }
    if std::env::var("PRACTIQ_RESTORE_KILL_PHASE").as_deref() == Ok(phase) {
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "restore checkpoint: {phase}").unwrap();
        stdout.flush().unwrap();
        drop(stdout);
        loop {
            std::thread::park();
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
#[ignore = "subprocess entry point; exercised by killed_restore_reopens_a_complete_generation"]
fn restore_child() {
    let Ok(root) = std::env::var("PRACTIQ_RESTORE_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let mut store = Store::new(root.join("current")).unwrap();
    if std::env::var("PRACTIQ_RESTORE_RECOVER_ASSETS").as_deref() == Ok("1") {
        store
            .restore_recovering(&root.join("incoming.zip"))
            .unwrap();
    } else {
        store.restore(&root.join("incoming.zip")).unwrap();
    }
}

#[test]
fn killed_restore_reopens_a_complete_generation() {
    for (recover, phase) in [
        (false, "before-publish"),
        (false, "after-publish"),
        (true, "before-resource-repair"),
        (true, "before-publish"),
        (true, "after-publish"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let current = populated(&dir.path().join("current"), "Old");
        let damaged: String = current
            .connect()
            .unwrap()
            .query_row(
                "SELECT hash FROM assets WHERE media='image/png' LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if recover {
            fs::write(
                current.asset_path(&damaged).unwrap(),
                b"interrupted-original-damage",
            )
            .unwrap();
        }
        populated(&dir.path().join("incoming"), "New")
            .backup(&dir.path().join("incoming.zip"))
            .unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "backup::fault_tests::restore_child",
                "--nocapture",
                "--ignored",
            ])
            .env("PRACTIQ_RESTORE_TEST_ROOT", dir.path())
            .env("PRACTIQ_RESTORE_KILL_PHASE", phase)
            .env(
                "PRACTIQ_RESTORE_RECOVER_ASSETS",
                if recover { "1" } else { "0" },
            )
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let checkpoint = format!("restore checkpoint: {phase}");
        let (ready, result) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let reached = BufReader::new(stdout)
                .lines()
                .any(|line| line.is_ok_and(|line| line.ends_with(&checkpoint)));
            let _ = ready.send(reached);
        });
        let reached = result
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or(false);
        let _ = child.kill();
        child.wait().unwrap();
        reader.join().unwrap();
        assert!(reached, "restore did not reach {phase}");
        let mut store = Store::new(dir.path().join("current")).unwrap();
        if phase == "before-resource-repair" {
            assert_eq!(store.banks().unwrap()[0]["title"], "Old");
            assert_eq!(
                fs::read(store.asset_path(&damaged).unwrap()).unwrap(),
                b"interrupted-original-damage"
            );
            store.save_bank(None, "After restart", "").unwrap();
        } else {
            assert_intact(
                &store,
                if phase == "after-publish" {
                    "New"
                } else {
                    "Old"
                },
            );
        }
        let recovery = fs::read_dir(store.dir.join("recoveries"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        if recover {
            assert!(recovery.join("inventory.json").is_file());
            assert_eq!(
                fs::read(recovery.join(format!("assets/{damaged}"))).unwrap(),
                b"interrupted-original-damage"
            );
            store
                .restore_recovering(&dir.path().join("incoming.zip"))
                .unwrap();
            assert_intact(&store, "New");
        } else {
            store.restore(&recovery).unwrap();
            assert_intact(&store, "Old");
        }
    }
}
