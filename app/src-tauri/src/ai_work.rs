//! Desktop receipts and import manifests. No credentials or automatic model retries.
use crate::{
    ai::{task_path, Endpoint},
    contract,
    store::{self, Store},
    AppError, Shared,
};
use reqwest::Method;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

type Result<T> = std::result::Result<T, AppError>;
fn err(e: impl std::fmt::Display) -> AppError {
    e.to_string().into()
}

#[derive(Default)]
pub struct WorkState(Mutex<HashMap<String, Arc<AtomicBool>>>);
pub(crate) struct Lease<'a> {
    state: &'a WorkState,
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.0.lock() {
            active.remove(&self.id);
        }
    }
}
impl WorkState {
    fn claim(&self, id: &str) -> Result<Lease<'_>> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
        self.claim_locked(id, &mut active)
    }
    fn claim_locked<'a>(
        &'a self,
        id: &str,
        active: &mut HashMap<String, Arc<AtomicBool>>,
    ) -> Result<Lease<'a>> {
        if active.contains_key(id) || active.contains_key("restore") {
            return Err(AppError::new("OPERATION_BUSY", "操作正在执行，请查看进度"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(id.into(), cancelled.clone());
        Ok(Lease {
            state: self,
            id: id.into(),
            cancelled,
        })
    }
    pub(crate) fn enter(&self) -> Result<Lease<'_>> {
        self.claim(&store::id())
    }
    pub(crate) fn restore(&self) -> Result<Lease<'_>> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
        if !active.is_empty() {
            return Err(AppError::new(
                "OPERATION_BUSY",
                "请先等待当前 AI 请求结束或停止导入批次，再恢复备份",
            ));
        }
        self.claim_locked("restore", &mut active)
    }
}

fn path(dir: &Path, kind: &str, id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| crate::language::error("LOCAL_OPERATION_ID_INVALID", serde_json::json!({})))?;
    Ok(dir.join("ai").join(kind).join(format!("{id}.json")))
}
fn save<T: Serialize>(dir: &Path, kind: &str, id: &str, value: &T) -> Result<()> {
    let path = path(dir, kind, id)?;
    let parent = path.parent().ok_or(crate::language::error(
        "LOCAL_WORK_DIRECTORY_INVALID",
        serde_json::json!({}),
    ))?;
    fs::create_dir_all(parent).map_err(err)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    file.write_all(&serde_json::to_vec(value).map_err(err)?)
        .map_err(err)?;
    file.as_file().sync_all().map_err(err)?;
    file.persist(&path).map_err(err)?;
    fs::File::open(parent)
        .map_err(err)?
        .sync_all()
        .map_err(err)?;
    Ok(())
}
fn read<T: DeserializeOwned>(dir: &Path, kind: &str, id: &str) -> Result<T> {
    serde_json::from_slice(&store::read_bounded(
        &path(dir, kind, id)?,
        contract::MAX_JSON,
    )?)
    .map_err(err)
}
fn all<T: DeserializeOwned>(dir: &Path, kind: &str) -> Result<Vec<T>> {
    // ponytail: scan local manifests; index or archive them if desktop history becomes large.
    let directory = dir.join("ai").join(kind);
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in fs::read_dir(directory).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.extension().is_some_and(|s| s == "json") {
            result.push(read(
                dir,
                kind,
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or(crate::language::error(
                        "LOCAL_WORK_FILENAME_INVALID",
                        serde_json::json!({}),
                    ))?,
            )?);
        }
    }
    Ok(result)
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum OperationStatus {
    Pending,
    Accepted,
    Rejected,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    id: String,
    identity: String,
    path: String,
    body: Value,
    label: String,
    status: OperationStatus,
    receipt: Option<Value>,
    error: Option<AppError>,
}
fn validate_operation(op: &Operation) -> Result<()> {
    uuid::Uuid::parse_str(&op.id)
        .map_err(|_| crate::language::error("LOCAL_OPERATION_ID_INVALID", serde_json::json!({})))?;
    if op.body["requestId"] != op.id {
        return Err(crate::language::error(
            "LOCAL_RECEIPT_MISMATCH",
            serde_json::json!({}),
        ));
    }
    if op.path != "/api/document-tasks" {
        let id = op
            .path
            .strip_prefix("/api/document-tasks/")
            .and_then(|s| s.strip_suffix("/control"))
            .ok_or(crate::language::error(
                "LOCAL_OPERATION_PATH_INVALID",
                serde_json::json!({}),
            ))?;
        if op.path != format!("{}/control", task_path(id)?) {
            return Err(crate::language::error(
                "LOCAL_OPERATION_PATH_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    Ok(())
}
pub fn operations(dir: &Path) -> Result<Value> {
    let mut result = vec![];
    for op in all::<Operation>(dir, "requests")? {
        validate_operation(&op)?;
        if op.status == OperationStatus::Pending {
            result.push(json!({"id":op.id,"label":op.label,"error":op.error}));
        }
    }
    Ok(json!(result))
}
pub fn submit_operation(
    dir: &Path,
    work: &WorkState,
    endpoint: &Endpoint,
    path: &str,
    body: Value,
    label: &str,
) -> Result<Value> {
    let mut unsigned = body.clone();
    unsigned
        .as_object_mut()
        .ok_or(crate::language::error(
            "LOCAL_REQUEST_INVALID",
            serde_json::json!({}),
        ))?
        .remove("requestId");
    let identity = store::hash(&serde_json::to_vec(&json!([path, unsigned])).map_err(err)?);
    let mut active = work
        .0
        .lock()
        .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
    let previous = all::<Operation>(dir, "requests")?
        .into_iter()
        .find(|op| op.identity == identity && op.status == OperationStatus::Pending);
    let op = previous.unwrap_or_else(|| Operation {
        id: contract::text(&body, "requestId").into(),
        identity,
        path: path.into(),
        body,
        label: label.into(),
        status: OperationStatus::Pending,
        receipt: None,
        error: None,
    });
    validate_operation(&op)?;
    save(dir, "requests", &op.id, &op)?;
    let lease = work.claim_locked(&op.id, &mut active)?;
    drop(active);
    execute_operation(dir, endpoint, op, lease)
}
pub fn replay_operation(
    dir: &Path,
    work: &WorkState,
    endpoint: &Endpoint,
    id: &str,
) -> Result<Value> {
    let lease = work.claim(id)?;
    let op: Operation = read(dir, "requests", id)?;
    if op.id != id {
        return Err(crate::language::error(
            "LOCAL_OPERATION_ID_MISMATCH",
            serde_json::json!({}),
        ));
    }
    execute_operation(dir, endpoint, op, lease)
}
fn execute_operation(
    dir: &Path,
    endpoint: &Endpoint,
    mut op: Operation,
    _lease: Lease<'_>,
) -> Result<Value> {
    validate_operation(&op)?;
    if op.status == OperationStatus::Accepted {
        return op
            .receipt
            .ok_or_else(|| crate::language::error("LOCAL_RECEIPT_MISSING", serde_json::json!({})));
    }
    if op.status == OperationStatus::Rejected {
        return Err(op.error.unwrap_or_else(|| {
            crate::language::error("LOCAL_OPERATION_REJECTED", serde_json::json!({}))
        }));
    }
    save(dir, "requests", &op.id, &op)?; // Durable identity before the first POST.
    let result = endpoint
        .json(Method::POST, &op.path, Some(&op.body))
        .and_then(|receipt| {
            if receipt["requestId"] != op.id || receipt["accepted"] != true {
                return Err(AppError::new(
                    "INVALID_RECEIPT",
                    "服务回执不完整，请重试待确认操作",
                ));
            }
            Ok(receipt)
        });
    match &result {
        Ok(receipt) => {
            op.status = OperationStatus::Accepted;
            op.receipt = Some(receipt.clone());
            op.error = None;
        }
        Err(error) => {
            if error
                .http_status
                .is_some_and(|s| (400..500).contains(&s) && s != 408)
            {
                op.status = OperationStatus::Rejected;
            }
            op.error = Some(error.clone());
        }
    }
    if let Err(mut error) = save(dir, "requests", &op.id, &op) {
        error.request_id = Some(op.id);
        return Err(error);
    }
    result.map_err(|mut error| {
        error.request_id = Some(op.id);
        error
    })
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum BatchStatus {
    Ready,
    Running,
    Paused,
    Completed,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ItemStatus {
    Pending,
    Imported,
    Failed,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchItem {
    thread_id: String,
    checkpoint_id: String,
    digest: String,
    title: String,
    question_count: usize,
    review_count: usize,
    partial: bool,
    previous_version: bool,
    status: ItemStatus,
    bank_id: Option<String>,
    error: Option<AppError>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    id: String,
    created_at: i64,
    status: BatchStatus,
    items: Vec<BatchItem>,
}
fn validate_batch(batch: &Batch) -> Result<()> {
    uuid::Uuid::parse_str(&batch.id)
        .map_err(|_| crate::language::error("LOCAL_BATCH_ID_INVALID", serde_json::json!({})))?;
    if batch.items.is_empty() || batch.items.len() > 100 {
        return Err(crate::language::error(
            "LOCAL_BATCH_SIZE_INVALID",
            serde_json::json!({}),
        ));
    }
    let mut seen = HashSet::new();
    for item in &batch.items {
        task_path(&item.thread_id)?;
        if !seen.insert(&item.thread_id)
            || item.checkpoint_id.is_empty()
            || item.checkpoint_id.len() > 128
            || item.digest.len() != 64
            || !item
                .digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || item.title.trim().is_empty()
            || item.title.chars().count() > 200
        {
            return Err(crate::language::error(
                "LOCAL_BATCH_ITEM_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    Ok(())
}
pub fn prepare_batch(dir: &Path, endpoint: &Endpoint, ids: &[String]) -> Result<Value> {
    if ids.is_empty() || ids.len() > 100 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(crate::language::error(
            "LOCAL_BATCH_SELECTION_INVALID",
            serde_json::json!({}),
        ));
    }
    let store = Store {
        locale: Default::default(),
        dir: dir.into(),
        pending: None,
    };
    let mut batch = Batch {
        id: store::id(),
        created_at: store::now(),
        status: BatchStatus::Ready,
        items: vec![],
    };
    for id in ids {
        let pending = endpoint.pending(id)?;
        let source = pending.source.as_ref().ok_or(crate::language::error(
            "LOCAL_TASK_SOURCE_MISSING",
            serde_json::json!({}),
        ))?;
        let digest = pending.digest()?;
        let bank = store.imported_ai(id, Some(&digest), None)?;
        let previous = bank.is_none() && store.imported_ai(id, None, None)?.is_some();
        let questions = contract::list(contract::result(&pending.root), "questions");
        batch.items.push(BatchItem {
            thread_id: id.clone(),
            checkpoint_id: source.checkpoint_id.clone(),
            digest,
            title: pending.title,
            question_count: questions
                .iter()
                .filter(|q| !crate::questions::composite(q))
                .count(),
            review_count: questions
                .iter()
                .filter(|q| q["needsReview"] == true && !crate::questions::composite(q))
                .count(),
            partial: pending.root["status"] == "PARTIAL",
            previous_version: previous,
            status: if bank.is_some() {
                ItemStatus::Imported
            } else {
                ItemStatus::Pending
            },
            bank_id: bank,
            error: None,
        });
    }
    validate_batch(&batch)?;
    save(dir, "import-batches", &batch.id, &batch)?;
    Ok(json!(batch))
}
pub fn batches(dir: &Path, work: &WorkState) -> Result<Value> {
    let mut batches = all::<Batch>(dir, "import-batches")?;
    let active = work
        .0
        .lock()
        .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
    for batch in &mut batches {
        validate_batch(batch)?;
        if batch.status == BatchStatus::Running && !active.contains_key(&batch.id) {
            batch.status = BatchStatus::Paused;
        }
    }
    batches.sort_by_key(|batch| std::cmp::Reverse(batch.created_at));
    Ok(json!(batches))
}
pub fn cancel_batch(dir: &Path, work: &WorkState, id: &str) -> Result<Value> {
    let active = work
        .0
        .lock()
        .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
    let mut batch: Batch = read(dir, "import-batches", id)?;
    validate_batch(&batch)?;
    if let Some(cancelled) = active.get(id) {
        cancelled.store(true, Ordering::SeqCst);
    } else {
        batch.status = BatchStatus::Paused;
        save(dir, "import-batches", id, &batch)?;
    }
    Ok(json!(batch))
}
pub fn run_batch(
    dir: &Path,
    work: &WorkState,
    endpoint: &Endpoint,
    shared: &Shared,
    id: &str,
    titles: Option<Vec<String>>,
) -> Result<Value> {
    let lease = work.claim(id)?;
    let mut batch: Batch = read(dir, "import-batches", id)?;
    if batch.id != id {
        return Err(crate::language::error(
            "LOCAL_BATCH_ID_MISMATCH",
            serde_json::json!({}),
        ));
    }
    if let Some(titles) = titles {
        if batch.status != BatchStatus::Ready || titles.len() != batch.items.len() {
            return Err(crate::language::error(
                "LOCAL_BATCH_STARTED",
                serde_json::json!({}),
            ));
        }
        for (item, title) in batch.items.iter_mut().zip(titles) {
            item.title = title.trim().into();
        }
    }
    validate_batch(&batch)?;
    batch.status = BatchStatus::Running;
    save(dir, "import-batches", id, &batch)?;
    for index in 0..batch.items.len() {
        if lease.cancelled.load(Ordering::SeqCst) {
            batch.status = BatchStatus::Paused;
            break;
        }
        let item = &mut batch.items[index];
        // The practice database, not the manifest, decides whether a commit happened.
        let result = import_item(dir, endpoint, shared, item);
        match result {
            Ok(bank) => {
                item.status = ItemStatus::Imported;
                item.bank_id = Some(bank);
                item.error = None;
            }
            Err(error) => {
                item.status = ItemStatus::Failed;
                item.bank_id = None;
                item.error = Some(error);
            }
        }
        save(dir, "import-batches", id, &batch)?;
    }
    if batch.status == BatchStatus::Running {
        batch.status = BatchStatus::Completed;
    }
    save(dir, "import-batches", id, &batch)?;
    Ok(json!(batch))
}
fn import_item(
    dir: &Path,
    endpoint: &Endpoint,
    shared: &Shared,
    item: &BatchItem,
) -> Result<String> {
    if let Some(bank) = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({})))?
        .imported_ai(&item.thread_id, Some(&item.digest), None)?
    {
        return Ok(bank);
    }
    let mut pending = endpoint.pending(&item.thread_id)?;
    if pending.source.as_ref().map(|s| s.checkpoint_id.as_str())
        != Some(item.checkpoint_id.as_str())
        || pending.digest()? != item.digest
    {
        return Err(AppError::new(
            "STALE_CHECKPOINT",
            "结果版本已变化，请重新选择该任务创建批次",
        ));
    }
    endpoint.load_assets(
        &mut pending,
        &Store {
            locale: Default::default(),
            dir: dir.into(),
            pending: None,
        },
    )?;
    let result = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({})))?
        .import_pending(&pending, None, &item.title)?;
    Ok(contract::text(&result, "bankId").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read},
        net::TcpListener,
        thread,
    };

    // Bounded loopback server; dropping a response simulates a committed but lost receipt.
    fn server(
        count: usize,
        mut handler: impl FnMut(&str, Value) -> Option<(u16, Vec<u8>)> + Send + 'static,
    ) -> (Endpoint, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = Endpoint::test(format!("http://{}", listener.local_addr().unwrap()));
        let worker = thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            for _ in 0..count {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "missing expected request"
                            );
                            thread::sleep(std::time::Duration::from_millis(5));
                        }
                        Err(e) => panic!("{e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                if let Some((status, bytes)) =
                    handler(first.split_whitespace().nth(1).unwrap(), body)
                {
                    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n", bytes.len()).unwrap();
                    stream.write_all(&bytes).unwrap();
                }
            }
        });
        (endpoint, worker)
    }
    fn response(value: Value) -> Option<(u16, Vec<u8>)> {
        Some((200, serde_json::to_vec(&value).unwrap()))
    }
    fn task(id: &str, image: bool) -> Value {
        let mut result: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
        if !image {
            result["visualElements"] = json!([]);
        }
        json!({"threadId":id,"checkpointId":"checkpoint-1","fileName":"quiz.pdf","state":"COMPLETED","status":"PARTIAL","result":result})
    }
    fn shared(dir: &Path) -> Shared {
        Arc::new(Mutex::new(Store::new(dir.into()).unwrap()))
    }

    #[test]
    fn uncertain_post_replays_original_identity_after_restart_and_preserves_errors() {
        let dir = tempfile::tempdir().unwrap();
        let id = store::id();
        let expected = id.clone();
        let mut calls = 0;
        let (endpoint, worker) = server(2, move |path, body| {
            assert_eq!(path, "/api/document-tasks");
            assert_eq!(body["requestId"], expected);
            calls += 1;
            if calls == 1 {
                None
            } else {
                response(json!({"requestId":expected,"accepted":true,"threadId":"one-task"}))
            }
        });
        let error = submit_operation(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            "/api/document-tasks",
            json!({"requestId":id,"document":{"key":"same"}}),
            "quiz",
        )
        .unwrap_err();
        assert_eq!(error.request_id.as_deref(), Some(id.as_str()));
        assert_eq!(operations(dir.path()).unwrap().as_array().unwrap().len(), 1);
        let result = replay_operation(dir.path(), &WorkState::default(), &endpoint, &id).unwrap();
        assert_eq!(result["threadId"], "one-task");
        assert!(operations(dir.path())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            replay_operation(dir.path(), &WorkState::default(), &endpoint, &id).unwrap(),
            result
        ); // no HTTP
        worker.join().unwrap();
        let (endpoint, worker) = server(1, |_, _| {
            Some((
                409,
                serde_json::to_vec(
                    &json!({"detail":{"code":"STALE_CHECKPOINT","message":"refresh"}}),
                )
                .unwrap(),
            ))
        });
        let error = submit_operation(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            "/api/document-tasks",
            json!({"requestId":store::id()}),
            "rejected",
        )
        .unwrap_err();
        assert_eq!(error.code, "STALE_CHECKPOINT");
        assert_eq!(error.http_status, Some(409));
        assert!(operations(dir.path())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        worker.join().unwrap();
    }

    #[test]
    fn batch_isolates_corrupt_images_and_resumes_from_database_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        let work = WorkState::default();
        let ids = vec![store::id(), store::id(), store::id()];
        let expected = ids.clone();
        let (endpoint, worker) = server(7, move |path, _| {
            if path == "/api/artifacts/read" {
                return Some((200, b"corrupt".to_vec()));
            }
            let id = path.rsplit('/').next().unwrap();
            response(task(id, id == expected[1]))
        });
        let preview = prepare_batch(dir.path(), &endpoint, &ids).unwrap();
        let id = contract::text(&preview, "id");
        let result = run_batch(
            dir.path(),
            &work,
            &endpoint,
            &shared,
            id,
            Some(vec!["一".into(), "二".into(), "三".into()]),
        )
        .unwrap();
        assert_eq!(result["items"][0]["status"], "imported");
        assert_eq!(result["items"][1]["error"]["code"], "ARTIFACT_INVALID");
        assert_eq!(result["items"][2]["status"], "imported");
        worker.join().unwrap();
        let db = shared.lock().unwrap().connect().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM banks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let (endpoint, worker) = server(2, |path, _| {
            if path == "/api/artifacts/read" {
                return Some((200, include_bytes!("../../fixtures/resources/practiq-agent/artifacts/194d631965b1f86c4cf32eac39eee06a6a0523a127204b3995999240546deeaa/fixture/0-194d631965b1f86c4cf32eac39eee06a6a0523a127204b3995999240546deeaa.png").to_vec()));
            }
            response(task(path.rsplit('/').next().unwrap(), true))
        });
        let recovered = run_batch(dir.path(), &work, &endpoint, &shared, id, None).unwrap();
        worker.join().unwrap();
        assert_eq!(recovered["items"][1]["status"], "imported");
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!db
            .prepare("PRAGMA table_info(imports)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == "raw"));
        // Simulate exit after DB commit but before the manifest records success.
        let mut interrupted: Batch = read(dir.path(), "import-batches", id).unwrap();
        interrupted.items[0].status = ItemStatus::Pending;
        interrupted.items[0].bank_id = None;
        interrupted.status = BatchStatus::Running;
        save(dir.path(), "import-batches", id, &interrupted).unwrap();
        assert_eq!(
            batches(dir.path(), &WorkState::default()).unwrap()[0]["status"],
            "paused"
        );
        let offline = Endpoint::test("http://127.0.0.1:1".into());
        let resumed = run_batch(
            dir.path(),
            &WorkState::default(),
            &offline,
            &shared,
            id,
            None,
        )
        .unwrap();
        assert!(resumed["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["status"] == "imported"));
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM banks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn cancel_stops_after_current_item_and_explicit_continue_imports_remaining() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        let work = Arc::new(WorkState::default());
        let ids = vec![store::id(), store::id()];
        let (endpoint, worker) = server(2, |path, _| {
            response(task(path.rsplit('/').next().unwrap(), false))
        });
        let preview = prepare_batch(dir.path(), &endpoint, &ids).unwrap();
        worker.join().unwrap();
        let id = contract::text(&preview, "id").to_owned();
        let cancel_dir = dir.path().to_owned();
        let cancel_id = id.clone();
        let cancel_work = work.clone();
        let (endpoint, worker) = server(1, move |path, _| {
            cancel_batch(&cancel_dir, &cancel_work, &cancel_id).unwrap();
            response(task(path.rsplit('/').next().unwrap(), false))
        });
        let paused = run_batch(dir.path(), &work, &endpoint, &shared, &id, None).unwrap();
        worker.join().unwrap();
        assert_eq!(paused["status"], "paused");
        assert_eq!(paused["items"][0]["status"], "imported");
        assert_eq!(paused["items"][1]["status"], "pending");
        let (endpoint, worker) = server(1, |path, _| {
            response(task(path.rsplit('/').next().unwrap(), false))
        });
        let done = run_batch(dir.path(), &work, &endpoint, &shared, &id, None).unwrap();
        worker.join().unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(done["items"][1]["status"], "imported");
    }

    #[test]
    fn changed_checkpoint_is_not_silently_imported() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        let id = store::id();
        let mut calls = 0;
        let (endpoint, worker) = server(2, move |path, _| {
            let mut result = task(path.rsplit('/').next().unwrap(), false);
            calls += 1;
            if calls == 2 {
                result["checkpointId"] = json!("new-checkpoint");
            }
            response(result)
        });
        let batch = prepare_batch(dir.path(), &endpoint, &[id]).unwrap();
        let result = run_batch(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            &shared,
            contract::text(&batch, "id"),
            None,
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(result["items"][0]["error"]["code"], "STALE_CHECKPOINT");
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM banks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[cfg(test)]
#[test]
fn restore_excludes_inflight_requests_in_both_directions() {
    let work = WorkState::default();
    let request = work.enter().unwrap();
    assert!(work.restore().is_err());
    drop(request);
    let restore = work.restore().unwrap();
    assert!(work.enter().is_err());
    drop(restore);
    assert!(work.enter().is_ok());
}
