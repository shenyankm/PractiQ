use crate::{
    ai_work::{self, WorkState},
    contract::{self, Result},
    store::{self, ImportSource, Pending, Store},
    AppError, Shared,
};
use reqwest::{
    blocking::{Client, Response},
    Method,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AiRequest {
    Grade {
        id: String,
        ordinal: usize,
        retry: bool,
    },
    List {
        offset: usize,
    },
    Get {
        id: String,
    },
    PickDocument,
    Control {
        id: String,
        action: String,
        run_id: Option<String>,
        checkpoint_id: Option<String>,
        units: Option<Value>,
    },
    Preview {
        id: String,
    },
    Review {
        id: String,
    },
    ReviewAsset {
        id: String,
        checkpoint_id: String,
        unit: usize,
        visual: Option<usize>,
    },
    Operations,
    Replay {
        request_id: String,
    },
    Batches,
    PrepareBatch {
        ids: Vec<String>,
    },
    RunBatch {
        id: String,
        titles: Option<Vec<String>>,
    },
    CancelBatch {
        id: String,
    },
}
type AiResult<T> = std::result::Result<T, AppError>;
pub type AiState = Mutex<Option<Process>>;
pub struct Process {
    child: Child,
    input: Option<ChildStdin>,
    endpoint: Endpoint,
    stderr: Arc<Mutex<StderrTail>>,
    stderr_done: std::sync::mpsc::Receiver<()>,
    diagnostic_path: PathBuf,
}
#[derive(Clone)]
pub(crate) struct Endpoint {
    client: Client,
    origin: String,
    token: String,
}
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}
const STDERR_LIMIT: usize = 16 * 1024;
fn replace_all(haystack: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() {
        return haystack.to_vec();
    }
    let mut output = Vec::with_capacity(haystack.len());
    let mut start = 0;
    while let Some(position) = haystack[start..]
        .windows(needle.len())
        .position(|window| window == needle)
    {
        output.extend_from_slice(&haystack[start..start + position]);
        output.extend_from_slice(replacement);
        start += position + needle.len();
    }
    output.extend_from_slice(&haystack[start..]);
    output
}
// Redact while ingesting, before bytes are committed or truncated: a secret
// split by a read or by the retained-tail boundary can then never leave a
// partial credential in the diagnostic.
struct StderrTail {
    output: Vec<u8>,
    pending: Vec<u8>,
    guard: usize,
}
impl StderrTail {
    fn new(secrets: &[String]) -> Self {
        Self {
            output: Vec::new(),
            pending: Vec::new(),
            guard: secrets
                .iter()
                .map(String::len)
                .max()
                .unwrap_or(0)
                .saturating_sub(1),
        }
    }
    fn append(&mut self, chunk: &[u8], secrets: &[String]) {
        self.pending.extend_from_slice(chunk);
        for secret in secrets {
            if !secret.is_empty() {
                self.pending = replace_all(&self.pending, secret.as_bytes(), b"[redacted]");
            }
        }
        let keep = self.pending.len().saturating_sub(self.guard);
        if keep == 0 {
            return;
        }
        self.output.extend_from_slice(&self.pending[..keep]);
        self.pending.drain(..keep);
        if self.output.len() > STDERR_LIMIT {
            self.output.drain(..self.output.len() - STDERR_LIMIT);
        }
    }
    fn diagnostic(&mut self) -> String {
        self.output.extend_from_slice(&self.pending);
        self.pending.clear();
        if self.output.len() > STDERR_LIMIT {
            self.output.drain(..self.output.len() - STDERR_LIMIT);
        }
        String::from_utf8_lossy(&self.output).into_owned()
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.input.take();
        let until = Instant::now() + Duration::from_secs(13);
        let mut exited = false;
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !exited {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(250));
        if let Ok(mut tail) = self.stderr.lock() {
            let diagnostic = tail.diagnostic();
            if !diagnostic.is_empty() {
                if let Some(dir) = self.diagnostic_path.parent() {
                    if fs::create_dir_all(dir).is_ok() {
                        if let Ok(mut file) = tempfile::NamedTempFile::new_in(dir) {
                            let _ = file.write_all(diagnostic.as_bytes());
                            let _ = file.persist(&self.diagnostic_path);
                        }
                    }
                }
            }
        }
    }
}
impl Process {
    fn start(app: &tauri::AppHandle, store: &Store) -> Result<Self> {
        let config = store.connection_settings()?.validate()?;
        let base = config.base_url.as_deref().ok_or(crate::language::error(
            "LOCAL_MODEL_URL_REQUIRED",
            serde_json::json!({}),
        ))?;
        let model = config.model_id.as_deref().ok_or(crate::language::error(
            "LOCAL_MODEL_ID_REQUIRED",
            serde_json::json!({}),
        ))?;
        let key = store.model_secret(&app.config().identifier, base)?;
        let resources = app.path().resource_dir().map_err(err)?;
        let bundle = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bundled")
        } else {
            resources.join("bundled")
        };
        let executable = bundle.join("python/practiq-ai");
        if !executable.is_file() {
            return Err(crate::language::error(
                "LOCAL_BUNDLE_MISSING",
                serde_json::json!({}),
            ));
        }
        let token = format!("{}{}", store::id(), store::id());
        let redactions = vec![token.clone(), key.clone()];
        let _ = fs::remove_file(store.dir.join("ai/parser-stderr.log"));
        let bootstrap = json!({"AI_SERVICE_TOKEN":token,"LLM_API_KEY":key,"LLM_BASE_URL":base,"LLM_MODEL":model,
            "AI_DATABASE_DIR":store.dir.join("ai/database"),"AI_STORAGE_DIR":store.dir.join("ai/files")});
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(err)?;
        let mut child = Command::new(executable)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| {
                crate::language::error("LOCAL_BUNDLE_START_FAILED", serde_json::json!({}))
            })?;
        let mut stderr = child.stderr.take().ok_or(crate::language::error(
            "LOCAL_STATUS_PIPE_FAILED",
            serde_json::json!({}),
        ))?;
        let tail = Arc::new(Mutex::new(StderrTail::new(&redactions)));
        let writer = tail.clone();
        let secrets = redactions.clone();
        let (done, stderr_done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                if let Ok(mut tail) = writer.lock() {
                    tail.append(&buffer[..count], &secrets);
                }
            }
            let _ = done.send(());
        });
        let mut process = Self {
            child,
            input: None,
            stderr: tail,
            stderr_done,
            diagnostic_path: store.dir.join("ai/parser-stderr.log"),
            endpoint: Endpoint {
                client,
                origin: String::new(),
                token,
            },
        };
        let mut input = process.child.stdin.take().ok_or(crate::language::error(
            "LOCAL_INPUT_PIPE_FAILED",
            serde_json::json!({}),
        ))?;
        writeln!(input, "{bootstrap}").map_err(|_| {
            crate::language::error("LOCAL_BUNDLE_INIT_FAILED", serde_json::json!({}))
        })?;
        input.flush().map_err(err)?;
        process.input = Some(input);
        let stdout = process.child.stdout.take().ok_or(crate::language::error(
            "LOCAL_STATUS_PIPE_FAILED",
            serde_json::json!({}),
        ))?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let ready =
                reader.by_ref().take(4097).read_line(&mut line).is_ok() && line.len() <= 4096;
            let _ = tx.send(if ready {
                serde_json::from_str::<Value>(&line).ok()
            } else {
                None
            });
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        let ready = rx
            .recv_timeout(Duration::from_secs(45))
            .map_err(|_| crate::language::error("LOCAL_BUNDLE_TIMEOUT", serde_json::json!({})))?
            .ok_or(crate::language::error(
                "LOCAL_BUNDLE_INIT_FAILED",
                serde_json::json!({}),
            ))?;
        let port = ready["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or(crate::language::error(
                "LOCAL_BUNDLE_PORT_INVALID",
                serde_json::json!({}),
            ))?;
        process.endpoint.origin = format!("http://127.0.0.1:{port}");
        let status = process
            .endpoint
            .client
            .get(format!("{}/ready", process.endpoint.origin))
            .send()
            .map_err(|_| crate::language::error("LOCAL_BUNDLE_NOT_READY", serde_json::json!({})))?;
        if !status.status().is_success() {
            return Err(crate::language::error(
                "LOCAL_BUNDLE_NOT_READY",
                serde_json::json!({}),
            ));
        }
        Ok(process)
    }
}
impl Endpoint {
    #[cfg(test)]
    pub(crate) fn test(origin: String) -> Self {
        Self {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            origin,
            token: "test".into(),
        }
    }
    fn send(&self, method: Method, path: &str, body: Option<&Value>) -> AiResult<Response> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin))
            .bearer_auth(&self.token);
        if path == "/api/subjective-grades" {
            request = request.timeout(Duration::from_secs(900));
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(|_| {
            AppError::new(
                "LOCAL_SERVICE_UNAVAILABLE",
                "本地解析服务连接中断，请重试待确认操作",
            )
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let value = read_json(response)?;
            let mut error = AppError::new(
                value["detail"]["code"].as_str().unwrap_or("SERVICE_ERROR"),
                value["detail"]["message"]
                    .as_str()
                    .unwrap_or("请检查配置或刷新任务状态"),
            );
            error.http_status = Some(status.as_u16());
            return Err(error);
        }
        Ok(response)
    }
    pub(crate) fn json(&self, method: Method, path: &str, body: Option<&Value>) -> AiResult<Value> {
        read_json(self.send(method, path, body)?)
    }
}
fn read_json(response: Response) -> Result<Value> {
    let mut bytes = Vec::new();
    response
        .take(contract::MAX_JSON as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > contract::MAX_JSON {
        return Err(crate::language::error(
            "LOCAL_RESPONSE_TOO_LARGE",
            serde_json::json!({}),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| crate::language::error("LOCAL_RESPONSE_INVALID", serde_json::json!({})))
}
pub(crate) fn task_path(id: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| crate::language::error("LOCAL_TASK_ID_INVALID", serde_json::json!({})))?;
    Ok(format!("/api/document-tasks/{id}"))
}
pub fn stop(app: &tauri::AppHandle) -> Result<()> {
    app.state::<AiState>()
        .lock()
        .map_err(|_| {
            crate::language::error("LOCAL_PARSER_STATE_UNAVAILABLE", serde_json::json!({}))
        })?
        .take();
    Ok(())
}
fn document_format(path: &std::path::Path) -> Result<(&'static str, &'static str)> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(match extension.as_str() {
        "txt" => ("text", "text/plain"),
        "csv" => ("csv", "text/csv"),
        "pdf" => ("pdf", "application/pdf"),
        "doc" | "docx" => {
            return Err(crate::language::error(
                "LOCAL_WORD_UNSUPPORTED",
                serde_json::json!({}),
            ))
        }
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        _ => {
            return Err(crate::language::error(
                "LOCAL_DOCUMENT_UNSUPPORTED",
                serde_json::json!({}),
            ))
        }
    })
}

fn confirm_document(
    path: &std::path::Path,
    config: crate::settings::ConnectionSettings,
    locale: crate::language::Locale,
    confirm: impl FnOnce(String) -> bool,
) -> Result<Option<Vec<u8>>> {
    document_format(path)?;
    let bytes = store::read_bounded(path, 25 * 1024 * 1024)?;
    let config = config.validate()?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(crate::language::error(
            "LOCAL_FILENAME_INVALID",
            serde_json::json!({}),
        ))?;
    let size = bytes.len() as f64 / (1024.0 * 1024.0);
    let base = config.base_url.as_deref().ok_or(crate::language::error(
        "LOCAL_MODEL_URL_REQUIRED",
        json!({}),
    ))?;
    let model = config
        .model_id
        .as_deref()
        .ok_or(crate::language::error("LOCAL_MODEL_ID_REQUIRED", json!({})))?;
    let message = if locale == crate::language::Locale::Chinese {
        format!("文件：{file_name}\n大小：{size:.2} MiB\n模型服务：{base}\n模型 ID：{model}\n\n解析内容将发送给此模型服务，可能产生费用。仅提取原文提供的答案，不会生成答案。")
    } else {
        format!("File: {file_name}\nSize: {size:.2} MiB\nModel service: {base}\nModel ID: {model}\n\nContent will be sent to this model service and may incur charges. Only answers supplied in the source are extracted; no answers are generated.")
    };
    // Upload exactly the bytes the user confirmed, not a later replacement of the file.
    Ok(confirm(message).then_some(bytes))
}

fn active_endpoint(app: &tauri::AppHandle, dir: &std::path::Path) -> AiResult<Endpoint> {
    let state = app.state::<AiState>();
    let mut state = state.lock().map_err(|_| {
        crate::language::error("LOCAL_PARSER_STATE_UNAVAILABLE", serde_json::json!({}))
    })?;
    if state
        .as_mut()
        .is_some_and(|p| p.child.try_wait().ok().flatten().is_some())
    {
        state.take();
    }
    if state.is_none() {
        *state = Some(
            Process::start(
                app,
                &Store {
                    locale: Default::default(),
                    dir: dir.to_owned(),
                    pending: None,
                    staged_audio: std::collections::HashMap::new(),
                },
            )
            .map_err(|mut error| {
                let path = dir.join("ai/parser-stderr.log");
                if path.exists() {
                    error.context = Some(path.display().to_string());
                }
                error
            })?,
        );
    }
    Ok(state
        .as_ref()
        .ok_or(crate::language::error(
            "LOCAL_PARSER_UNAVAILABLE",
            serde_json::json!({}),
        ))?
        .endpoint
        .clone())
}

fn review_reference(
    process: &Endpoint,
    id: &str,
    checkpoint_id: &str,
    unit: usize,
    visual: Option<usize>,
) -> AiResult<(Value, String)> {
    let review = process.review(id)?;
    if review["checkpointId"] != checkpoint_id {
        return Err(AppError::new("STALE_CHECKPOINT", "任务已变化，请刷新预览"));
    }
    let unit = review["units"].get(unit).ok_or(crate::language::error(
        "LOCAL_PREVIEW_UNIT_MISSING",
        serde_json::json!({}),
    ))?;
    let reference = match visual {
        Some(index) => &unit["visualElements"]
            .get(index)
            .ok_or(crate::language::error(
                "LOCAL_IMAGE_MISSING",
                serde_json::json!({}),
            ))?["imageRef"],
        None => &unit["sourceRef"],
    };
    Ok((
        reference.clone(),
        contract::text(reference, "mediaType").to_owned(),
    ))
}

pub fn read_review_image(
    app: tauri::AppHandle,
    shared: Shared,
    id: String,
    checkpoint_id: String,
    unit: usize,
    visual: Option<usize>,
) -> AiResult<Vec<u8>> {
    let dir = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?
        .dir
        .clone();
    let work = app.state::<WorkState>();
    let _request = work.enter()?;
    let process = active_endpoint(&app, &dir)?;
    let (reference, media) = review_reference(&process, &id, &checkpoint_id, unit, visual)?;
    if !media.starts_with("image/") {
        return Err(crate::language::error(
            "LOCAL_IMAGE_FORMAT_MISMATCH",
            json!({}),
        ));
    }
    process.image(
        &reference,
        &Store {
            locale: Default::default(),
            dir,
            pending: None,
            staged_audio: std::collections::HashMap::new(),
        },
    )
}

pub fn request(app: tauri::AppHandle, shared: Shared, request: AiRequest) -> AiResult<Value> {
    let (dir, locale) = {
        let store = shared
            .lock()
            .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?;
        (store.dir.clone(), store.locale)
    };
    let work = app.state::<WorkState>();
    let _request = work.enter()?;
    // Local recovery controls must remain available even without model settings.
    match &request {
        AiRequest::Operations => return ai_work::operations(&dir),
        AiRequest::Batches => return ai_work::batches(&dir, &work),
        AiRequest::CancelBatch { id } => return ai_work::cancel_batch(&dir, &work, id),
        _ => {}
    }
    let selected = if matches!(request, AiRequest::PickDocument) {
        let file = app
            .dialog()
            .file()
            .add_filter(
                locale.text("文档", "Documents"),
                &["txt", "csv", "pdf", "png", "jpg", "jpeg"],
            )
            .blocking_pick_file();
        match file {
            None => return Ok(Value::Null),
            Some(f) => {
                let path = f.into_path().map_err(err)?;
                let config = shared
                    .lock()
                    .map_err(|_| {
                        crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({}))
                    })?
                    .connection_settings()?;
                let Some(bytes) = confirm_document(&path, config, locale, |message| {
                    app.dialog()
                        .message(message)
                        .title(locale.text("确认解析文档", "Confirm document parsing"))
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            locale.text("开始解析", "Start parsing").into(),
                            locale.text("取消", "Cancel").into(),
                        ))
                        .blocking_show()
                })?
                else {
                    return Ok(Value::Null);
                };
                Some((path, bytes))
            }
        }
    } else {
        None
    };
    let process = active_endpoint(&app, &dir)?;
    match request {
        AiRequest::Grade { id, ordinal, retry } => {
            let payload = shared
                .lock()
                .map_err(|_| {
                    crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({}))
                })?
                .prepare_grade(&id, ordinal, retry)?;
            let response = match process.json(
                Method::POST,
                "/api/subjective-grades",
                Some(&payload),
            ) {
                Ok(value) => value,
                Err(error) => {
                    serde_json::json!({"status":"unknown","error":error.message,"appError":error,"usageStatus":"unknown"})
                }
            };
            Ok(shared
                .lock()
                .map_err(|_| {
                    crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({}))
                })?
                .record_grade(
                    &id,
                    ordinal,
                    contract::text(&payload, "requestId"),
                    &response,
                )?)
        }
        AiRequest::List { offset } => {
            if offset > 1_000_000 {
                return Err(crate::language::error(
                    "LOCAL_PAGE_INVALID",
                    serde_json::json!({}),
                ));
            }
            let mut result = process.json(
                Method::GET,
                &format!("/api/document-tasks?limit=20&offset={offset}"),
                None,
            )?;
            let store = shared.lock().map_err(|_| {
                crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({}))
            })?;
            for item in result["items"]
                .as_array_mut()
                .ok_or(crate::language::error(
                    "LOCAL_TASK_LIST_INVALID",
                    serde_json::json!({}),
                ))?
            {
                contract::validate_workflow(item, false)?;
                let id = contract::text(item, "threadId");
                let bank = store.imported_ai(id, None, item["checkpointId"].as_str())?;
                let previous = store.imported_ai(id, None, None)?.is_some();
                item["importedBankId"] = json!(bank);
                item["previouslyImported"] = json!(previous);
            }
            Ok(result)
        }
        AiRequest::Get { id } => process.json(Method::GET, &task_path(&id)?, None),
        AiRequest::Control {
            id,
            action,
            run_id,
            checkpoint_id,
            units,
        } => {
            if ![
                "pause",
                "resume",
                "interrupt",
                "retry_failed",
                "accept_partial",
            ]
            .contains(&action.as_str())
            {
                return Err(crate::language::error(
                    "LOCAL_ACTION_INVALID",
                    serde_json::json!({}),
                ));
            }
            let body = json!({"requestId":store::id(),"action":action,"runId":run_id,"checkpointId":checkpoint_id,"units":units.unwrap_or(json!([]))});
            ai_work::submit_operation(
                &dir,
                &work,
                &process,
                &format!("{}/control", task_path(&id)?),
                body,
                &action,
            )
        }
        AiRequest::PickDocument => {
            let (path, bytes) = selected.ok_or(crate::language::error(
                "LOCAL_DOCUMENT_NOT_SELECTED",
                serde_json::json!({}),
            ))?;
            let (kind, media) = document_format(&path)?;
            let body = json!({"sourceType":kind,"fileName":path.file_name().and_then(|s|s.to_str()).ok_or(crate::language::error("LOCAL_FILENAME_INVALID", serde_json::json!({})))?,"mediaType":media,"sha256":store::hash(&bytes),"sizeBytes":bytes.len()});
            let prepared = process.json(Method::POST, "/api/uploads", Some(&body))?;
            if !prepared["upload"].is_null() {
                let relative = prepared["upload"]["url"]
                    .as_str()
                    .ok_or(crate::language::error(
                        "LOCAL_UPLOAD_URL_INVALID",
                        serde_json::json!({}),
                    ))?;
                if !relative.starts_with("/api/uploads/content?") {
                    return Err(crate::language::error(
                        "LOCAL_UPLOAD_URL_OUTSIDE",
                        serde_json::json!({}),
                    ));
                }
                let response = process
                    .client
                    .put(format!("{}{relative}", process.origin))
                    .bearer_auth(&process.token)
                    .body(bytes)
                    .send()
                    .map_err(|_| {
                        crate::language::error("LOCAL_UPLOAD_FAILED", serde_json::json!({}))
                    })?;
                if !response.status().is_success() {
                    return Err(crate::language::error(
                        "LOCAL_UPLOAD_RETRY",
                        serde_json::json!({}),
                    ));
                }
            }
            ai_work::submit_operation(
                &dir,
                &work,
                &process,
                "/api/document-tasks",
                json!({"requestId":store::id(),"document":prepared["document"],"failurePolicy":"review"}),
                body["fileName"]
                    .as_str()
                    .unwrap_or(locale.text("解析文档", "Parsed document")),
            )
        }
        AiRequest::Preview { id } => {
            let mut pending = process.pending(&id)?;
            let store = Store {
                locale: Default::default(),
                dir,
                pending: None,
                staged_audio: std::collections::HashMap::new(),
            };
            process.load_assets(&mut pending, &store)?;
            let mut store = shared.lock().map_err(|_| {
                crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({}))
            })?;
            store.pending = Some(pending);
            Ok(store.preview_value()?)
        }
        AiRequest::Review { id } => process.review(&id),
        AiRequest::ReviewAsset {
            id,
            checkpoint_id,
            unit,
            visual,
        } => {
            let (reference, media) = review_reference(&process, &id, &checkpoint_id, unit, visual)?;
            let content = if media == "text/plain" || media.starts_with("text/plain;") {
                let mut bytes = Vec::new();
                process
                    .send(Method::POST, "/api/artifacts/read", Some(&reference))?
                    .take(contract::MAX_JSON as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(err)?;
                if bytes.len() > contract::MAX_JSON
                    || reference["sizeBytes"].as_u64() != Some(bytes.len() as u64)
                    || store::hash(&bytes) != contract::text(&reference, "sha256")
                {
                    return Err(AppError::new("ARTIFACT_INVALID", "来源文本校验失败"));
                }
                String::from_utf8(bytes).map_err(|_| {
                    crate::language::error("LOCAL_SOURCE_ENCODING_INVALID", serde_json::json!({}))
                })?
            } else {
                return Err(crate::language::error(
                    "LOCAL_IMAGE_FORMAT_MISMATCH",
                    json!({}),
                ));
            };
            Ok(json!({"mediaType":media,"content":content}))
        }
        AiRequest::Replay { request_id } => {
            ai_work::replay_operation(&dir, &work, &process, &request_id)
        }
        AiRequest::PrepareBatch { ids } => ai_work::prepare_batch(&dir, &process, &ids),
        AiRequest::RunBatch { id, titles } => {
            ai_work::run_batch(&dir, &work, &process, &shared, &id, titles)
        }
        AiRequest::Operations | AiRequest::Batches | AiRequest::CancelBatch { .. } => {
            unreachable!("handled before service startup")
        }
    }
}

impl Endpoint {
    fn review(&self, id: &str) -> AiResult<Value> {
        let result = self.json(Method::GET, &format!("{}/preview", task_path(id)?), None)?;
        contract::validate_workflow(&result, true)?;
        Ok(result)
    }
    pub(crate) fn pending(&self, id: &str) -> AiResult<Pending> {
        let result = self.json(Method::GET, &task_path(id)?, None)?;
        if result["threadId"] != id || result["state"] != "COMPLETED" {
            return Err(AppError::new(
                "TASK_NOT_COMPLETED",
                "请先完成解析或接受部分结果",
            ));
        }
        let checkpoint = result["checkpointId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(crate::language::error(
                "LOCAL_RESULT_VERSION_MISSING",
                serde_json::json!({}),
            ))?
            .to_owned();
        let title = std::path::Path::new(result["fileName"].as_str().unwrap_or("PractiQ"))
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("PractiQ")
            .to_owned();
        // Store portable document output, not run state or model-call logs, in practice backups.
        let mut output = json!({"status":result["status"],"result":result["result"]});
        if !result["processing"].is_null() {
            output["processing"] = result["processing"].clone();
        }
        let mut pending = Pending::new(serde_json::to_vec(&output).map_err(err)?, title)?;
        if contract::list(contract::result(&pending.root), "questions").is_empty() {
            return Err(crate::language::error(
                "LOCAL_RESULT_EMPTY",
                serde_json::json!({}),
            ));
        }
        pending.source = Some(ImportSource {
            thread_id: id.into(),
            checkpoint_id: checkpoint,
        });
        Ok(pending)
    }
    fn image(&self, reference: &Value, store: &Store) -> AiResult<Vec<u8>> {
        let digest = contract::text(reference, "sha256");
        let media = contract::text(reference, "mediaType");
        let size = reference["sizeBytes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= crate::assets::LIMIT as u64)
            .ok_or(crate::language::error(
                "LOCAL_IMAGE_SIZE_OUTSIDE",
                serde_json::json!({}),
            ))?;
        let path = store.asset_path(digest)?;
        let bytes = if path.exists() {
            store.read_asset(digest, size)?
        } else {
            let response = self.send(Method::POST, "/api/artifacts/read", Some(reference))?;
            let mut bytes = Vec::new();
            response
                .take(crate::assets::LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(err)?;
            bytes
        };
        if bytes.len() as u64 != size
            || store::hash(&bytes) != digest
            || !store::valid_image(&bytes, media)
        {
            return Err(AppError::new("ARTIFACT_INVALID", "解析图片缺失或校验失败"));
        }
        Ok(bytes)
    }
    pub(crate) fn load_assets(&self, pending: &mut Pending, store: &Store) -> AiResult<()> {
        let mut total = 0usize;
        for reference in contract::list(contract::result(&pending.root), "visualElements")
            .iter()
            .flat_map(contract::visual_refs)
        {
            let digest = contract::text(reference, "sha256");
            if pending.assets.contains_key(digest) {
                continue;
            }
            let bytes = self.image(reference, store)?;
            total += bytes.len();
            if total > 256 * 1024 * 1024 {
                return Err(crate::language::error(
                    "LOCAL_RESOURCES_TOO_LARGE",
                    serde_json::json!({}),
                ));
            }
            pending.assets.insert(
                digest.into(),
                (contract::text(reference, "mediaType").into(), bytes),
            );
        }
        pending.missing.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{document_format, StderrTail};
    use std::path::Path;

    #[test]
    fn stderr_diagnostics_are_bounded_and_redacted() {
        let secrets = ["key-123".to_string(), "token-456".to_string()];
        let mut tail = StderrTail::new(&secrets);
        tail.append(&vec![b'x'; 20 * 1024], &secrets);
        tail.append(b" key-123 token-456", &secrets);
        let diagnostic = tail.diagnostic();
        assert!(diagnostic.len() <= 16 * 1024);
        assert!(!diagnostic.contains("key-123"));
        assert!(!diagnostic.contains("token-456"));
        assert!(diagnostic.contains("[redacted]"));
    }

    #[test]
    fn stderr_secrets_split_across_reads_stay_redacted() {
        let secrets = ["token-789".to_string()];
        let mut tail = StderrTail::new(&secrets);
        tail.append(b"error: token-", &secrets);
        tail.append(b"789 done", &secrets);
        let diagnostic = tail.diagnostic();
        assert!(!diagnostic.contains("token-789"));
        assert!(diagnostic.contains("[redacted] done"));
    }

    #[test]
    fn stderr_secrets_at_the_truncation_boundary_stay_redacted() {
        let secrets = ["key-123456".to_string()];
        let mut tail = StderrTail::new(&secrets);
        let mut first = vec![b'x'; 16];
        first.extend_from_slice(b"key-");
        tail.append(&first, &secrets);
        let mut second = b"123456".to_vec();
        second.resize(16 * 1024, b'y');
        tail.append(&second, &secrets);
        let diagnostic = tail.diagnostic();
        assert!(diagnostic.len() <= 16 * 1024);
        assert!(!diagnostic.contains("key-123456"));
        assert!(!diagnostic.contains("123456"));
        assert!(!diagnostic.contains("key-"));
    }

    #[test]
    fn document_confirmation_is_required_and_freezes_validated_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quiz.txt");
        std::fs::write(&path, b"original").unwrap();
        let config = crate::settings::ConnectionSettings {
            base_url: Some("https://example.com/v1".into()),
            model_id: Some("unified-model".into()),
            ..Default::default()
        };
        assert!(super::confirm_document(
            &path,
            config.clone(),
            crate::language::Locale::Chinese,
            |_| false
        )
        .unwrap()
        .is_none());
        assert!(super::confirm_document(
            &path,
            config.clone(),
            crate::language::Locale::English,
            |message| {
                assert!(message.contains("may incur charges"));
                assert!(message.contains("no answers are generated"));
                assert!(message.contains("Model ID:"));
                false
            }
        )
        .unwrap()
        .is_none());
        let bytes = super::confirm_document(
            &path,
            config.clone(),
            crate::language::Locale::Chinese,
            |message| {
                assert!(message.contains("quiz.txt") && message.contains("unified-model"));
                assert!(message.contains("可能产生费用"));
                assert!(!message.contains(dir.path().to_str().unwrap()));
                std::fs::write(&path, b"changed").unwrap();
                true
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(bytes, b"original");
        let oversized = std::fs::File::create(&path).unwrap();
        oversized.set_len(25 * 1024 * 1024 + 1).unwrap();
        assert!(super::confirm_document(
            &path,
            config,
            crate::language::Locale::Chinese,
            |_| panic!("oversized file reached confirmation")
        )
        .is_err());
    }

    #[test]
    fn supported_formats_and_word_guidance() {
        for extension in ["txt", "csv", "pdf", "png", "jpg", "jpeg"] {
            assert!(document_format(Path::new(&format!("quiz.{extension}"))).is_ok());
        }
        assert_eq!(
            document_format(Path::new("quiz.PDF")).unwrap(),
            ("pdf", "application/pdf")
        );
        for extension in ["doc", "DOCX"] {
            assert!(document_format(Path::new(&format!("quiz.{extension}")))
                .unwrap_err()
                .message
                .contains("PDF"));
        }
        for extension in ["exe", "webp", "gif"] {
            assert!(document_format(Path::new(&format!("quiz.{extension}"))).is_err());
        }
    }
}
