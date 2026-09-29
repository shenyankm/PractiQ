//! Native file authorization and the desktop-only LibreOffice sidecar command.
use crate::{contract::Result, language::Locale, store, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub const LIMIT: usize = 25 * 1024 * 1024;
#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Pdf,
    Text,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Convert { mode: Mode },
    Cancel,
}
#[derive(Default)]
pub struct OfficeState {
    active: Mutex<Option<Arc<AtomicBool>>>,
    detected: Mutex<Option<Detection>>,
}
struct Detection {
    engine: Option<String>,
    identity: (PathBuf, u64, SystemTime),
    result: Value,
    checked: Instant,
}
fn identity(result: &Value) -> Option<(PathBuf, u64, SystemTime)> {
    let path = fs::canonicalize(result["path"].as_str()?).ok()?;
    let info = fs::metadata(&path).ok()?;
    info.is_file()
        .then_some((path, info.len(), info.modified().ok()?))
}
struct Lease<'a>(&'a OfficeState, Arc<AtomicBool>);
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.active.lock() {
            *state = None;
        }
    }
}
fn error(code: &str) -> AppError {
    crate::language::error(code, json!({}))
}
fn err(e: impl std::fmt::Display) -> AppError {
    e.to_string().into()
}
impl OfficeState {
    fn invalidate(&self) {
        if let Ok(mut cached) = self.detected.lock() {
            *cached = None;
        }
    }
    fn detect(&self, engine: Option<String>, run: impl FnOnce() -> Result<Value>) -> Result<Value> {
        if let Some(cached) = self.detected.lock().map_err(err)?.as_ref() {
            if cached.engine == engine
                && cached.checked.elapsed() < Duration::from_secs(300)
                && identity(&cached.result).as_ref() == Some(&cached.identity)
            {
                return Ok(cached.result.clone());
            }
        }
        self.invalidate();
        let result = run()?;
        if let Some(identity) = identity(&result) {
            *self.detected.lock().map_err(err)? = Some(Detection {
                engine,
                identity,
                result: result.clone(),
                checked: Instant::now(),
            });
        }
        Ok(result)
    }
    fn enter(&self) -> Result<Lease<'_>> {
        let mut state = self.active.lock().map_err(err)?;
        if state.is_some() {
            return Err(error("OFFICE_BUSY"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *state = Some(cancel.clone());
        Ok(Lease(self, cancel))
    }
    pub fn cancel(&self) {
        if let Ok(state) = self.active.lock() {
            if let Some(cancel) = &*state {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
    pub fn shutdown(&self) {
        self.cancel();
        // Let the worker close its Job Object and release temporary files before app exit.
        for _ in 0..150 {
            if self.active.lock().map(|s| s.is_none()).unwrap_or(true) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
struct Worker {
    child: Child,
    input: Option<ChildStdin>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.input.take(); // EOF invokes worker cleanup, including LibreOffice descendants.
        for _ in 0..100 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn worker(app: &tauri::AppHandle, request: Value) -> Result<Value> {
    let state = app.state::<OfficeState>();
    let lease = state.enter()?;
    let scratch = tempfile::Builder::new()
        .prefix("practiq-office-")
        .tempdir()
        .map_err(err)?;
    worker_in(app, request, scratch.path(), &lease.1)
}
fn worker_in(
    app: &tauri::AppHandle,
    request: Value,
    scratch: &Path,
    cancel: &AtomicBool,
) -> Result<Value> {
    // Native ownership also removes worker profiles/logs after cancellation or a crash.
    let mut command = Command::new(crate::ai::executable(app)?);
    for name in ["TMPDIR", "TEMP", "TMP"] {
        command.env(name, scratch);
    }
    command.env("PRACTIQ_OFFICE_WORKSPACE", scratch);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .arg("office")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(err)?;
    let mut process = Worker { child, input: None };
    process.input = process.child.stdin.take();
    writeln!(
        process
            .input
            .as_mut()
            .ok_or_else(|| error("OFFICE_WORKER_FAILED"))?,
        "{request}"
    )
    .map_err(err)?;
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| error("OFFICE_WORKER_FAILED"))?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes)
    });
    let start = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) {
            break Err(error("OFFICE_CANCELLED"));
        }
        if start.elapsed() > Duration::from_secs(190) {
            break Err(error("OFFICE_TIMEOUT"));
        }
        match process.child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(error("OFFICE_WORKER_FAILED"))
                }
            }
            Err(e) => break Err(err(e)),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    drop(process);
    let bytes = reader
        .join()
        .map_err(|_| error("OFFICE_WORKER_FAILED"))?
        .map_err(err)?;
    result?;
    if bytes.len() > 65536 {
        return Err(error("OFFICE_OUTPUT_INVALID"));
    }
    let result: Value =
        serde_json::from_slice(&bytes).map_err(|_| error("OFFICE_WORKER_FAILED"))?;
    if let Some(code) = result["error"].as_str() {
        return Err(error(match code {
            "OFFICE_NOT_FOUND" | "OFFICE_ENGINE_INVALID" => "OFFICE_NOT_FOUND",
            "OFFICE_TIMEOUT" => "OFFICE_TIMEOUT",
            "OFFICE_OUTPUT_LIMIT" => "OFFICE_OUTPUT_LIMIT",
            "OFFICE_OUTPUT_INVALID" => "OFFICE_OUTPUT_INVALID",
            "OFFICE_FORMAT_UNSUPPORTED" => "OFFICE_FORMAT_UNSUPPORTED",
            "OFFICE_INPUT_INVALID" => "OFFICE_INPUT_INVALID",
            _ => "OFFICE_CONVERSION_FAILED",
        }));
    }
    result
        .get("result")
        .cloned()
        .ok_or_else(|| error("OFFICE_WORKER_FAILED"))
}
pub fn is_office(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| ["doc", "docx", "xls", "xlsx"].contains(&s.to_ascii_lowercase().as_str()))
}
fn bundled_engine(bundle: &Path) -> Result<PathBuf> {
    let root = bundle
        .join("office")
        .canonicalize()
        .map_err(|_| error("OFFICE_NOT_FOUND"))?;
    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join("manifest.json")).map_err(|_| error("OFFICE_NOT_FOUND"))?,
    )
    .map_err(|_| error("OFFICE_NOT_FOUND"))?;
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let lock: Value = serde_json::from_str(include_str!("../../scripts/libreoffice.lock.json"))
        .map_err(|_| error("OFFICE_NOT_FOUND"))?;
    let artifact = &lock["artifacts"][format!("{platform}-{}", std::env::consts::ARCH)];
    let executable = artifact["executable"]
        .as_str()
        .ok_or_else(|| error("OFFICE_NOT_FOUND"))?;
    if manifest["platform"] != platform
        || manifest["architecture"] != std::env::consts::ARCH
        || manifest["version"] != lock["version"]
        || ["executable", "sha256", "url"]
            .iter()
            .any(|key| manifest[key] != artifact[key])
    {
        return Err(error("OFFICE_NOT_FOUND"));
    }
    let path = root
        .join(executable)
        .canonicalize()
        .map_err(|_| error("OFFICE_NOT_FOUND"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(error("OFFICE_NOT_FOUND"));
    }
    Ok(path)
}
pub fn status(app: &tauri::AppHandle) -> Result<Value> {
    let path = bundled_engine(&crate::ai::bundle_dir(app)?)?;
    app.state::<OfficeState>()
        .detect(Some(path.to_string_lossy().into_owned()), || {
            worker(app, json!({"type":"detect", "engine":path}))
        })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Origin {
    pub file_name: String,
    pub source_sha256: String,
    pub mode: Mode,
    pub version: String,
    pub artifact_sha256: String,
}
pub struct Artifact {
    pub name: String,
    pub bytes: Vec<u8>,
    pub origin: Origin,
    pub has_content: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    name: String,
    sha256: String,
    size_bytes: usize,
    has_content: bool,
}
fn artifact_name(original: &str, suffix: &str) -> Result<String> {
    let name = format!("{original}{suffix}");
    if name.len() <= 255 {
        return Ok(name);
    }
    // A byte bound also fits Windows' UTF-16 component limit. Keep the sheet suffix intact.
    let tail = format!("-{}{suffix}", &store::hash(name.as_bytes())[..16]);
    let mut end = 255usize
        .checked_sub(tail.len())
        .ok_or_else(|| error("OFFICE_OUTPUT_INVALID"))?;
    while !original.is_char_boundary(end) {
        end -= 1;
    }
    Ok(format!("{}{tail}", &original[..end]))
}
fn export_destination(mut path: PathBuf, extension: &str) -> Result<PathBuf> {
    if !path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(extension))
    {
        path.set_extension(extension);
    }
    if path
        .file_name()
        .is_none_or(|s| s.as_encoded_bytes().len() > 255)
    {
        return Err(error("OFFICE_OUTPUT_INVALID"));
    }
    Ok(path)
}
fn read_artifacts(
    root: &Path,
    response: Value,
    original: &Path,
    bytes: &[u8],
    mode: Mode,
    version: &str,
) -> Result<Vec<Artifact>> {
    let files: Vec<Manifest> =
        serde_json::from_value(response["artifacts"].clone()).map_err(err)?;
    if files.is_empty() || files.len() > 100 {
        return Err(error("OFFICE_OUTPUT_INVALID"));
    }
    let original_name = original
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| error("OFFICE_INPUT_INVALID"))?;
    let expected = if mode == Mode::Pdf {
        "pdf"
    } else if original
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("xls") || s.eq_ignore_ascii_case("xlsx"))
    {
        "csv"
    } else {
        "txt"
    };
    let mut artifacts = Vec::new();
    let mut total = 0;
    let mut seen = std::collections::HashSet::new();
    for file in files {
        let path = Path::new(&file.name);
        if path.components().count() != 1
            || file.name.contains(['/', '\\', ':'])
            || !seen.insert(file.name.clone())
            || path.extension().and_then(|s| s.to_str()) != Some(expected)
        {
            return Err(error("OFFICE_OUTPUT_INVALID"));
        }
        let path = root.join(path);
        let metadata = fs::symlink_metadata(&path).map_err(err)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(error("OFFICE_OUTPUT_INVALID"));
        }
        let payload = store::read_bounded(&path, LIMIT)?;
        if payload.len() != file.size_bytes || store::hash(&payload) != file.sha256 {
            return Err(error("OFFICE_OUTPUT_INVALID"));
        }
        total += payload.len();
        if total > 100 * 1024 * 1024 {
            return Err(error("OFFICE_OUTPUT_LIMIT"));
        }
        // Worker inputs have a fixed safe basename; only display names contain the original name.
        let suffix = file
            .name
            .strip_prefix("source")
            .ok_or_else(|| error("OFFICE_OUTPUT_INVALID"))?;
        let name = artifact_name(original_name, suffix)?;
        artifacts.push(Artifact {
            name,
            bytes: payload,
            has_content: file.has_content,
            origin: Origin {
                file_name: original_name.into(),
                source_sha256: store::hash(bytes),
                mode,
                version: version.into(),
                artifact_sha256: file.sha256,
            },
        });
    }
    Ok(artifacts)
}
pub fn prepare(
    app: &tauri::AppHandle,
    path: &Path,
    bytes: &[u8],
    mode: Mode,
    engine: Option<&Value>,
) -> Result<Vec<Artifact>> {
    if !is_office(path) || bytes.is_empty() || bytes.len() > LIMIT {
        return Err(error("OFFICE_INPUT_INVALID"));
    }
    let detected;
    let engine = if let Some(engine) = engine {
        engine
    } else {
        detected = status(app)?;
        &detected
    };
    let executable = engine["path"]
        .as_str()
        .ok_or_else(|| error("OFFICE_NOT_FOUND"))?;
    let version = engine["version"]
        .as_str()
        .ok_or_else(|| error("OFFICE_NOT_FOUND"))?;
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let capability = format!(
        "{}_{}",
        if extension.starts_with("doc") {
            "writer"
        } else {
            "calc"
        },
        if mode == Mode::Pdf { "pdf" } else { "text" }
    );
    if engine["capabilities"][&capability] != true {
        return Err(error("OFFICE_CAPABILITY_MISSING"));
    }
    let state = app.state::<OfficeState>();
    let lease = state.enter()?;
    let directory = tempfile::Builder::new()
        .prefix("practiq-office-")
        .tempdir()
        .map_err(err)?;
    let source = directory.path().join(format!("source.{extension}"));
    fs::write(&source, bytes).map_err(err)?;
    let output = directory.path().join("output");
    let response = worker_in(
        app,
        json!({"type":"convert", "engine":executable, "version":version, "source":source, "output":output, "mode":mode}),
        directory.path(),
        &lease.1,
    ).inspect_err(|_| state.invalidate())?;
    read_artifacts(&output, response, path, bytes, mode, version)
}
pub fn request(app: tauri::AppHandle, request: Request, locale: Locale) -> Result<Value> {
    if matches!(request, Request::Cancel) {
        app.state::<OfficeState>().cancel();
        return Ok(Value::Null);
    }
    let work = app.state::<crate::ai_work::WorkState>();
    let _lease = work.enter()?;
    match request {
        Request::Status => {
            app.state::<OfficeState>().invalidate();
            status(&app)
        }
        Request::Convert { mode } => {
            let Some(path) = app
                .dialog()
                .file()
                .add_filter("Word / Excel", &["doc", "docx", "xls", "xlsx"])
                .blocking_pick_file()
            else {
                return Ok(Value::Null);
            };
            let path = path.into_path().map_err(err)?;
            let bytes = store::read_bounded(&path, LIMIT)?;
            let artifacts = prepare(&app, &path, &bytes, mode, None)?;
            let count = artifacts.len();
            let mut destinations = Vec::new();
            let directory = if count > 1 {
                let Some(folder) = app.dialog().file().blocking_pick_folder() else {
                    return Ok(Value::Null);
                };
                let directory = folder
                    .into_path()
                    .map_err(err)?
                    .join(format!("PractiQ-{}", store::id()));
                fs::create_dir(&directory).map_err(err)?;
                Some(directory)
            } else {
                None
            };
            for artifact in artifacts {
                let extension = Path::new(&artifact.name)
                    .extension()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| error("OFFICE_OUTPUT_INVALID"))?;
                let destination = if let Some(directory) = &directory {
                    directory.join(&artifact.name)
                } else {
                    let Some(file) = app
                        .dialog()
                        .file()
                        .add_filter(extension.to_ascii_uppercase(), &[extension])
                        .set_file_name(&artifact.name)
                        .blocking_save_file()
                    else {
                        return Ok(Value::Null);
                    };
                    export_destination(file.into_path().map_err(err)?, extension)?
                };
                if destination == path
                    || (destination.exists()
                        && fs::canonicalize(&destination).ok() == fs::canonicalize(&path).ok())
                {
                    return Err(error("OFFICE_SOURCE_OVERWRITE"));
                }
                if destination.exists()
                    && !app
                        .dialog()
                        .message(locale.text(
                            "目标文件已存在，是否替换？",
                            "The destination exists. Replace it?",
                        ))
                        .buttons(MessageDialogButtons::OkCancel)
                        .blocking_show()
                {
                    return Ok(Value::Null);
                }
                let mut file = tempfile::NamedTempFile::new_in(
                    destination
                        .parent()
                        .ok_or_else(|| error("OFFICE_OUTPUT_INVALID"))?,
                )
                .map_err(err)?;
                file.write_all(&artifact.bytes).map_err(err)?;
                crate::filesystem::persist(file, &destination, true).map_err(err)?;
                destinations.push(destination);
            }
            Ok(json!({"paths":destinations, "count":count}))
        }
        Request::Cancel => Ok(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detection_cache_rechecks_changed_missing_and_expired_executables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("soffice");
        fs::write(&path, "version one").unwrap();
        let state = OfficeState::default();
        let calls = std::cell::Cell::new(0);
        let detect = || {
            calls.set(calls.get() + 1);
            Ok(json!({"path":path,"version":"LibreOffice 26"}))
        };
        state.detect(None, detect).unwrap();
        state.detect(None, detect).unwrap();
        assert_eq!(calls.get(), 1);
        fs::write(&path, "replacement executable").unwrap();
        state.detect(None, detect).unwrap();
        state.detect(Some("new preference".into()), detect).unwrap();
        state.invalidate();
        state.detect(None, detect).unwrap();
        state.detected.lock().unwrap().as_mut().unwrap().checked -= Duration::from_secs(301);
        state.detect(None, detect).unwrap();
        assert_eq!(calls.get(), 5);
        fs::remove_file(path).unwrap();
        for _ in 0..2 {
            state
                .detect(None, || {
                    calls.set(calls.get() + 1);
                    Ok(json!({"path":null}))
                })
                .unwrap();
        }
        assert_eq!(calls.get(), 7);
    }
    #[test]
    fn generated_names_fit_utf8_filesystem_limits_and_keep_unique_sheet_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        let original = format!("{}.xlsx", "中".repeat(83));
        let mut names = std::collections::HashSet::new();
        for suffix in [".pdf", "-中文工作表.csv", "-隐藏工作表.csv"] {
            let name = artifact_name(&original, suffix).unwrap();
            assert!(name.len() <= 255);
            assert!(name.ends_with(suffix));
            assert!(names.insert(name.clone()));
            fs::write(dir.path().join(name), b"converted").unwrap();
        }
        assert_ne!(
            artifact_name(&format!("{}a.xlsx", "中".repeat(80)), ".pdf").unwrap(),
            artifact_name(&format!("{}b.xlsx", "中".repeat(80)), ".pdf").unwrap()
        );
        assert_eq!(
            artifact_name("短文件.xlsx", "-工作表.csv").unwrap(),
            "短文件.xlsx-工作表.csv"
        );
        assert!(artifact_name(&original, &format!("-{}.csv", "中".repeat(100))).is_err());
    }
    #[test]
    fn save_destinations_keep_the_artifact_extension() {
        let dir = tempfile::tempdir().unwrap();
        for extension in ["pdf", "txt", "csv"] {
            for name in ["中文", "中文.docx", "中文."] {
                let path = export_destination(dir.path().join(name), extension).unwrap();
                assert_eq!(path.extension().unwrap(), extension);
                assert_eq!(path.parent(), Some(dir.path()));
            }
            let uppercase = dir
                .path()
                .join(format!("中文.{}", extension.to_ascii_uppercase()));
            assert_eq!(
                export_destination(uppercase.clone(), extension).unwrap(),
                uppercase
            );
        }
        assert!(export_destination(dir.path().join("中".repeat(85)), "pdf").is_err());
    }
    #[test]
    fn frontend_cannot_supply_executable_or_document_paths() {
        for value in [
            json!({"type":"convert","mode":"pdf","path":"/private/file.docx"}),
            json!({"type":"convert","mode":"pdf","engine":"/bin/sh"}),
            json!({"type":"convert","mode":"shell"}),
            json!({"type":"pick_executable"}),
            json!({"type":"reset_executable"}),
            json!({"type":"installation_guide"}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(serde_json::from_value::<Request>(json!({"type":"status"})).is_ok());
    }
    #[test]
    fn output_manifest_rejects_paths_hashes_and_wrong_formats() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("source.txt"), b"text").unwrap();
        let valid = json!({"artifacts":[{"name":"source.txt","sha256":store::hash(b"text"),"sizeBytes":4,"hasContent":true}]});
        let output = read_artifacts(
            dir.path(),
            valid.clone(),
            Path::new("测试.docx"),
            b"input",
            Mode::Text,
            "LibreOffice",
        )
        .unwrap();
        assert_eq!(output[0].name, "测试.docx.txt");
        assert_eq!(output[0].origin.source_sha256, store::hash(b"input"));
        for name in [
            "../source.txt",
            "..\\source.txt",
            "source.exe",
            "C:source.txt",
        ] {
            let mut bad = valid.clone();
            bad["artifacts"][0]["name"] = json!(name);
            assert!(read_artifacts(
                dir.path(),
                bad,
                Path::new("source.docx"),
                b"input",
                Mode::Text,
                "v"
            )
            .is_err());
        }
        let mut bad = valid.clone();
        bad["artifacts"][0]["sha256"] = json!("bad");
        assert!(read_artifacts(
            dir.path(),
            bad,
            Path::new("source.docx"),
            b"input",
            Mode::Text,
            "v"
        )
        .is_err());
        assert!(read_artifacts(
            dir.path(),
            valid,
            Path::new("source.docx"),
            b"input",
            Mode::Pdf,
            "v"
        )
        .is_err());
    }
    #[test]
    fn conversion_serializes_cancellation_and_resets_state() {
        let state = OfficeState::default();
        let lease = state.enter().unwrap();
        assert!(state.enter().is_err());
        state.cancel();
        assert!(lease.1.load(Ordering::SeqCst));
        drop(lease);
        assert!(!state.enter().unwrap().1.load(Ordering::SeqCst));
    }
    #[test]
    fn bundled_engine_rejects_missing_and_wrong_architecture() {
        let dir = tempfile::tempdir().unwrap();
        assert!(bundled_engine(dir.path()).is_err());
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let lock: Value =
            serde_json::from_str(include_str!("../../scripts/libreoffice.lock.json")).unwrap();
        let artifact = &lock["artifacts"][format!("{platform}-{}", std::env::consts::ARCH)];
        let executable = artifact["executable"].as_str().unwrap();
        let root = dir.path().join("office");
        let engine = root.join(executable);
        fs::create_dir_all(engine.parent().unwrap()).unwrap();
        fs::write(&engine, "fixture").unwrap();
        let mut manifest = artifact.clone();
        manifest["platform"] = json!(platform);
        manifest["architecture"] = json!(std::env::consts::ARCH);
        manifest["version"] = lock["version"].clone();
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
        assert_eq!(
            bundled_engine(dir.path()).unwrap(),
            engine.canonicalize().unwrap()
        );
        manifest["architecture"] = json!("wrong");
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
        assert!(bundled_engine(dir.path()).is_err());
    }
}
