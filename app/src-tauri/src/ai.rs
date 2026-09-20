use crate::{
    ai_work::{self, WorkState},
    contract::{self, Result},
    store::{self, ImportSource, Pending, Store},
    AppError, Shared,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    blocking::{Client, Response},
    Method,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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
}
#[derive(Clone)]
pub(crate) struct Endpoint {
    client: Client,
    origin: String,
    token: String,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
impl Drop for Process {
    fn drop(&mut self) {
        self.input.take();
        let until = Instant::now() + Duration::from_secs(13);
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Process {
    fn start(app: &tauri::AppHandle, store: &Store) -> Result<Self> {
        let config = store.connection_settings()?.validate()?;
        let base = config.base_url.as_deref().ok_or("请先配置模型地址")?;
        let text = config.text_model.as_deref().ok_or("请先配置文本模型")?;
        let vision = config.vision_model.as_deref().ok_or("请先配置视觉模型")?;
        let key = store.model_secret(&app.config().identifier, base)?;
        let resources = app.path().resource_dir().map_err(err)?;
        let bundle = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bundled")
        } else {
            resources.join("bundled")
        };
        let executable = bundle.join("python/practiq-ai");
        if !executable.is_file() {
            return Err("内置解析组件缺失，请重新构建或安装完整应用".into());
        }
        let token = format!("{}{}", store::id(), store::id());
        let bootstrap = json!({"AI_SERVICE_TOKEN":token,"LLM_API_KEY":key,"LLM_BASE_URL":base,"LLM_TEXT_MODEL":text,"LLM_VISION_MODEL":vision,
            "AI_DATABASE_DIR":store.dir.join("ai/database"),"AI_STORAGE_DIR":store.dir.join("ai/files")});
        let child = Command::new(executable)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "无法启动内置解析组件")?;
        let mut process = Self {
            child,
            input: None,
            endpoint: Endpoint {
                client: Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(120))
                    .build()
                    .map_err(err)?,
                origin: String::new(),
                token,
            },
        };
        let mut input = process.child.stdin.take().ok_or("无法打开解析管道")?;
        writeln!(input, "{bootstrap}").map_err(|_| "解析组件初始化失败")?;
        input.flush().map_err(err)?;
        process.input = Some(input);
        let stdout = process.child.stdout.take().ok_or("无法打开状态管道")?;
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
            .map_err(|_| "解析组件启动超时")?
            .ok_or("解析组件初始化失败")?;
        let port = ready["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("解析组件端口无效")?;
        process.endpoint.origin = format!("http://127.0.0.1:{port}");
        let status = process
            .endpoint
            .client
            .get(format!("{}/ready", process.endpoint.origin))
            .send()
            .map_err(|_| "解析组件未就绪")?;
        if !status.status().is_success() {
            return Err("解析组件未就绪".into());
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
        Ok(read_json(self.send(method, path, body)?)?)
    }
}
fn read_json(response: Response) -> Result<Value> {
    let mut bytes = Vec::new();
    response
        .take(contract::MAX_JSON as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > contract::MAX_JSON {
        return Err("解析响应过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "解析服务返回无效数据".into())
}
pub(crate) fn task_path(id: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "任务 ID 不合法")?;
    Ok(format!("/api/document-tasks/{id}"))
}
pub fn stop(app: &tauri::AppHandle) -> Result<()> {
    app.state::<AiState>()
        .lock()
        .map_err(|_| "解析状态不可用")?
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
        "doc" | "docx" => return Err("暂不支持 Word 文件，请转为 PDF 后上传".into()),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        _ => return Err("不支持的文档类型".into()),
    })
}

pub fn request(app: tauri::AppHandle, shared: Shared, request: AiRequest) -> AiResult<Value> {
    let dir = shared.lock().map_err(|_| "数据库不可用")?.dir.clone();
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
            .add_filter("文档", &["txt", "csv", "pdf", "png", "jpg", "jpeg"])
            .blocking_pick_file();
        match file {
            None => return Ok(Value::Null),
            Some(f) => {
                let path = f.into_path().map_err(err)?;
                document_format(&path)?;
                Some(path)
            }
        }
    } else {
        None
    };
    let state = app.state::<AiState>();
    let mut state = state.lock().map_err(|_| "解析状态不可用")?;
    if state
        .as_mut()
        .is_some_and(|p| p.child.try_wait().ok().flatten().is_some())
    {
        state.take();
    }
    if state.is_none() {
        *state = Some(Process::start(
            &app,
            &Store {
                dir: dir.clone(),
                pending: None,
            },
        )?);
    }
    let process = state.as_ref().ok_or("解析服务不可用")?.endpoint.clone();
    drop(state);
    match request {
        AiRequest::Grade { id, ordinal, retry } => {
            let payload = shared
                .lock()
                .map_err(|_| "数据库不可用")?
                .prepare_grade(&id, ordinal, retry)?;
            let response = match process.json(
                Method::POST,
                "/api/subjective-grades",
                Some(&payload),
            ) {
                Ok(value) => value,
                Err(error) => {
                    serde_json::json!({"status":"unknown","error":error.message,"usageStatus":"unknown"})
                }
            };
            Ok(shared.lock().map_err(|_| "数据库不可用")?.record_grade(
                &id,
                ordinal,
                contract::text(&payload, "requestId"),
                &response,
            )?)
        }
        AiRequest::List { offset } => {
            if offset > 1_000_000 {
                return Err("分页参数无效".into());
            }
            let mut result = process.json(
                Method::GET,
                &format!("/api/document-tasks?limit=20&offset={offset}"),
                None,
            )?;
            let store = shared.lock().map_err(|_| "数据库不可用")?;
            for item in result["items"].as_array_mut().ok_or("任务列表格式错误")? {
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
                return Err("操作不合法".into());
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
            let path = selected.ok_or("未选择文档")?;
            let bytes = store::read_bounded(&path, 25 * 1024 * 1024)?;
            let (kind, media) = document_format(&path)?;
            let body = json!({"sourceType":kind,"fileName":path.file_name().and_then(|s|s.to_str()).ok_or("文件名不合法")?,"mediaType":media,"sha256":store::hash(&bytes),"sizeBytes":bytes.len()});
            let prepared = process.json(Method::POST, "/api/uploads", Some(&body))?;
            if !prepared["upload"].is_null() {
                let relative = prepared["upload"]["url"].as_str().ok_or("上传地址无效")?;
                if !relative.starts_with("/api/uploads/content?") {
                    return Err("上传地址越界".into());
                }
                let response = process
                    .client
                    .put(format!("{}{relative}", process.origin))
                    .bearer_auth(&process.token)
                    .body(bytes)
                    .send()
                    .map_err(|_| "上传失败")?;
                if !response.status().is_success() {
                    return Err("上传失败，请重试".into());
                }
            }
            ai_work::submit_operation(
                &dir,
                &work,
                &process,
                "/api/document-tasks",
                json!({"requestId":store::id(),"document":prepared["document"],"failurePolicy":"review"}),
                body["fileName"].as_str().unwrap_or("解析文档"),
            )
        }
        AiRequest::Preview { id } => {
            let mut pending = process.pending(&id)?;
            let store = Store { dir, pending: None };
            process.load_assets(&mut pending, &store)?;
            let mut store = shared.lock().map_err(|_| "数据库不可用")?;
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
            let review = process.review(&id)?;
            if review["checkpointId"] != checkpoint_id {
                return Err(AppError::new("STALE_CHECKPOINT", "任务已变化，请刷新预览"));
            }
            let unit = review["units"].get(unit).ok_or("预览单元不存在")?;
            let reference = match visual {
                Some(index) => &unit["visualElements"].get(index).ok_or("图片不存在")?["imageRef"],
                None => &unit["sourceRef"],
            };
            let media = contract::text(reference, "mediaType");
            let content = if media == "text/plain" || media.starts_with("text/plain;") {
                let mut bytes = Vec::new();
                process
                    .send(Method::POST, "/api/artifacts/read", Some(reference))?
                    .take(contract::MAX_JSON as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(err)?;
                if bytes.len() > contract::MAX_JSON
                    || reference["sizeBytes"].as_u64() != Some(bytes.len() as u64)
                    || store::hash(&bytes) != contract::text(reference, "sha256")
                {
                    return Err(AppError::new("ARTIFACT_INVALID", "来源文本校验失败"));
                }
                String::from_utf8(bytes).map_err(|_| "来源文本编码无效")?
            } else {
                let bytes = process.image(reference, &Store { dir, pending: None })?;
                format!("data:{media};base64,{}", STANDARD.encode(bytes))
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
            .ok_or("任务缺少结果版本")?
            .to_owned();
        let title = std::path::Path::new(result["fileName"].as_str().unwrap_or("解析题库"))
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("解析题库")
            .to_owned();
        // Store portable document output, not run state or model-call logs, in practice backups.
        let mut output = json!({"status":result["status"],"result":result["result"]});
        if !result["processing"].is_null() {
            output["processing"] = result["processing"].clone();
        }
        let mut pending = Pending::new(serde_json::to_vec(&output).map_err(err)?, title)?;
        if contract::list(contract::result(&pending.root), "questions").is_empty() {
            return Err("结果没有可导入题目".into());
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
            .ok_or("图片大小不合法")?;
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
            || !store::image_signature(&bytes, media)
        {
            return Err(AppError::new("ARTIFACT_INVALID", "解析图片缺失或校验失败"));
        }
        Ok(bytes)
    }
    pub(crate) fn load_assets(&self, pending: &mut Pending, store: &Store) -> AiResult<()> {
        let mut total = 0usize;
        for visual in contract::list(contract::result(&pending.root), "visualElements") {
            let reference = &visual["imageRef"];
            if !reference.is_object() {
                continue;
            }
            let digest = contract::text(reference, "sha256");
            if pending.assets.contains_key(digest) {
                continue;
            }
            let bytes = self.image(reference, store)?;
            total += bytes.len();
            if total > 256 * 1024 * 1024 {
                return Err("单次资源总量超过 256 MiB".into());
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
    use super::document_format;
    use std::path::Path;

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
                .contains("PDF"));
        }
        for extension in ["exe", "webp", "gif"] {
            assert!(document_format(Path::new(&format!("quiz.{extension}"))).is_err());
        }
    }
}
