//! Native picker authorization stays private; document providers are copied into
//! bounded, seekable snapshots before the existing import and restore validators.
use crate::contract::Result;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::FilePath;

#[cfg(any(target_os = "android", test))]
fn error(code: &str) -> crate::AppError {
    crate::language::error(code, serde_json::json!({}))
}

pub struct SelectedFile {
    path: PathBuf,
    _snapshot: Option<tempfile::NamedTempFile>,
    #[cfg(any(target_os = "android", test))]
    _output_directory: Option<tempfile::TempDir>,
    #[cfg(target_os = "android")]
    destination: Option<String>,
}

impl SelectedFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn input(app: &tauri::AppHandle, selected: FilePath, limit: u64) -> Result<Self> {
        #[cfg(target_os = "android")]
        {
            let source = document(app, selected, false)?;
            snapshot(source, &private_directory(app)?, limit)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, limit);
            Ok(Self {
                path: selected.into_path().map_err(|error| error.to_string())?,
                _snapshot: None,
                #[cfg(test)]
                _output_directory: None,
            })
        }
    }

    pub fn output(app: &tauri::AppHandle, selected: FilePath) -> Result<Self> {
        #[cfg(target_os = "android")]
        {
            output_file(&private_directory(app)?, content_uri(selected)?)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(Self {
                path: selected.into_path().map_err(|error| error.to_string())?,
                _snapshot: None,
                #[cfg(test)]
                _output_directory: None,
            })
        }
    }

    pub fn publish(self, app: &tauri::AppHandle, result: Value) -> Result<Value> {
        #[cfg(target_os = "android")]
        if let Some(uri) = &self.destination {
            // Open the complete generated package before touching the provider's target.
            let source = std::fs::File::open(self.path())
                .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
            let target = open_document(app, uri, true)?;
            write_document(source, target, |file| file.sync_all())?;
            let mut result = result;
            result["path"] = uri.clone().into();
            return Ok(result);
        }
        let _ = app;
        Ok(result)
    }
}

#[cfg(any(target_os = "android", test))]
fn output_file(directory: &Path, destination: String) -> Result<SelectedFile> {
    #[cfg(not(target_os = "android"))]
    let _ = destination;
    let directory = tempfile::Builder::new()
        .prefix("practiq-export-")
        .tempdir_in(directory)
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    Ok(SelectedFile {
        // The bank exporter deliberately refuses an existing destination.
        path: directory.path().join("export.zip"),
        _snapshot: None,
        _output_directory: Some(directory),
        #[cfg(target_os = "android")]
        destination: Some(destination),
    })
}

#[cfg(target_os = "android")]
fn private_directory(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    std::fs::create_dir_all(&directory).map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    Ok(directory)
}

#[cfg(target_os = "android")]
fn content_uri(selected: FilePath) -> Result<String> {
    match selected {
        FilePath::Url(uri) if uri.scheme() == "content" && uri.host_str().is_some() => {
            Ok(uri.to_string())
        }
        _ => Err(error("LOCAL_DOCUMENT_UNAVAILABLE")),
    }
}

#[cfg(target_os = "android")]
fn document(app: &tauri::AppHandle, selected: FilePath, write: bool) -> Result<std::fs::File> {
    open_document(app, &content_uri(selected)?, write)
}

#[cfg(target_os = "android")]
fn open_document(app: &tauri::AppHandle, uri: &str, write: bool) -> Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let fd = crate::credentials::open_document(app, uri, write)?;
    if fd < 0 {
        return Err(error("LOCAL_DOCUMENT_UNAVAILABLE"));
    }
    // The native plugin transfers an owned descriptor with detachFd, exactly once.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(any(target_os = "android", test))]
fn snapshot(source: impl std::io::Read, directory: &Path, limit: u64) -> Result<SelectedFile> {
    let mut file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    let copied = std::io::copy(&mut source.take(limit.saturating_add(1)), &mut file)
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?;
    if copied > limit {
        return Err(error("LOCAL_DOCUMENT_TOO_LARGE"));
    }
    Ok(SelectedFile {
        path: file.path().into(),
        _snapshot: Some(file),
        _output_directory: None,
        #[cfg(target_os = "android")]
        destination: None,
    })
}

#[cfg(any(target_os = "android", test))]
fn write_document<W: std::io::Write>(
    source: std::fs::File,
    mut destination: W,
    finalize: impl FnOnce(&mut W) -> std::io::Result<()>,
) -> Result<()> {
    use std::io::Read;
    let size = source
        .metadata()
        .map_err(|_| error("LOCAL_DOCUMENT_UNAVAILABLE"))?
        .len();
    let copied = std::io::copy(&mut source.take(size.saturating_add(1)), &mut destination)
        .map_err(|_| error("LOCAL_DOCUMENT_SAVE_FAILED"))?;
    if copied != size {
        return Err(error("LOCAL_DOCUMENT_SAVE_FAILED"));
    }
    destination
        .flush()
        .map_err(|_| error("LOCAL_DOCUMENT_SAVE_FAILED"))?;
    finalize(&mut destination).map_err(|_| error("LOCAL_DOCUMENT_SAVE_FAILED"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor, Read, Write};

    #[test]
    fn oversized_document_is_rejected_and_its_private_partial_copy_removed() {
        let directory = tempfile::tempdir().unwrap();
        assert!(snapshot(Cursor::new(b"12345"), directory.path(), 4).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn exact_limit_snapshot_is_immutable_and_removed_after_use() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("selected.zip");
        std::fs::write(&original, b"1234").unwrap();
        let selected =
            snapshot(std::fs::File::open(&original).unwrap(), directory.path(), 4).unwrap();
        let private = selected.path().to_owned();
        std::fs::write(&original, b"changed provider content").unwrap();
        assert_eq!(std::fs::read(&private).unwrap(), b"1234");
        drop(selected);
        assert!(!private.exists());
        assert_eq!(
            std::fs::read(&original).unwrap(),
            b"changed provider content"
        );
    }

    #[test]
    fn provider_read_failure_does_not_keep_a_partial_import() {
        struct BrokenProvider;
        impl Read for BrokenProvider {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::ErrorKind::PermissionDenied.into())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        assert!(snapshot(BrokenProvider, directory.path(), 100).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn streamed_bank_and_backup_use_the_real_import_and_restore_validators() {
        let directory = tempfile::tempdir().unwrap();
        let mut source = crate::store::Store::new(directory.path().join("source")).unwrap();
        source.add_example_bank().unwrap();
        let archive = directory.path().join("backup.zip");
        source.backup(&archive).unwrap();
        let copied = snapshot(
            std::fs::File::open(&archive).unwrap(),
            directory.path(),
            crate::backup::ARCHIVE_LIMIT,
        )
        .unwrap();
        let mut restored = crate::store::Store::new(directory.path().join("restored")).unwrap();
        restored.restore(copied.path()).unwrap();
        assert_eq!(restored.banks().unwrap(), source.banks().unwrap());
        let media = include_bytes!("../../fixtures/service-export/partial-media-bank.zip");
        let copied = snapshot(Cursor::new(media), directory.path(), media.len() as u64).unwrap();
        let preview = restored.preview_bank_zip(copied.path()).unwrap();
        let bank = restored
            .import(
                crate::contract::text(&preview, "ticket"),
                None,
                "SAF partial media",
            )
            .unwrap();
        let bank = bank["bankId"].as_str().unwrap();
        let exported = directory.path().join("bank.zip");
        restored.export_bank(bank, &exported).unwrap();
        let mut output = Vec::new();
        write_document(std::fs::File::open(&exported).unwrap(), &mut output, |_| {
            Ok(())
        })
        .unwrap();
        assert_eq!(output, std::fs::read(&exported).unwrap());
    }

    #[test]
    fn authorized_bank_export_generates_complete_private_zip_before_provider_write() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = crate::store::Store::new(directory.path().join("store")).unwrap();
        let preview = store
            .preview_bank_zip(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/service-export/partial-media-bank.zip"),
            )
            .unwrap();
        let bank = store
            .import(
                crate::contract::text(&preview, "ticket"),
                None,
                "SAF export",
            )
            .unwrap();
        let bank_id = bank["bankId"].as_str().unwrap();
        let selected = output_file(
            directory.path(),
            "content://provider/selected-bank.zip".into(),
        )
        .unwrap();
        let receipt = store.export_bank(bank_id, selected.path()).unwrap();
        let bytes = std::fs::read(selected.path()).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        assert!(archive.by_name("questions.json").is_ok());
        assert!(receipt["path"].as_str().is_some());
        let provider = directory.path().join("provider-bank.zip");
        write_document(
            std::fs::File::open(selected.path()).unwrap(),
            std::fs::File::create(&provider).unwrap(),
            |file| file.sync_all(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&provider).unwrap(), bytes);
        let private = selected.path().to_owned();
        drop(selected);
        assert!(!private.exists());
        assert!(!private.parent().unwrap().exists());
        assert_eq!(std::fs::read(&provider).unwrap(), bytes);
        let rejected = output_file(
            directory.path(),
            "content://provider/rejected-bank.zip".into(),
        )
        .unwrap();
        let partial = rejected.path().to_owned();
        assert!(store.export_bank("missing-bank", rejected.path()).is_err());
        drop(rejected);
        assert!(!partial.parent().unwrap().exists());
    }

    #[test]
    fn provider_write_and_flush_failures_never_report_success() {
        struct BrokenProvider {
            flush: bool,
        }
        impl Write for BrokenProvider {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.flush {
                    Ok(bytes.len())
                } else {
                    Err(io::ErrorKind::PermissionDenied.into())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::ErrorKind::BrokenPipe.into())
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("validated.zip");
        std::fs::write(&source, b"complete validated ZIP").unwrap();
        for flush in [false, true] {
            assert!(write_document(
                std::fs::File::open(&source).unwrap(),
                BrokenProvider { flush },
                |_| Ok(())
            )
            .is_err());
            assert_eq!(std::fs::read(&source).unwrap(), b"complete validated ZIP");
        }
    }

    #[test]
    fn provider_sync_failure_after_complete_file_write_never_reports_success() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("validated.zip");
        let destination = directory.path().join("provider.zip");
        std::fs::write(&source, b"complete validated ZIP").unwrap();
        let result = write_document(
            std::fs::File::open(&source).unwrap(),
            std::fs::File::create(&destination).unwrap(),
            |_| Err(std::io::ErrorKind::WriteZero.into()),
        );
        assert_eq!(result.unwrap_err().code, "LOCAL_DOCUMENT_SAVE_FAILED");
        assert_eq!(std::fs::read(&source).unwrap(), b"complete validated ZIP");
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"complete validated ZIP"
        );
    }
}
