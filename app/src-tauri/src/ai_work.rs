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

pub(crate) const MAX_SOURCE_FILES: usize = 10;

type Result<T> = std::result::Result<T, AppError>;
fn err(e: impl std::fmt::Display) -> AppError {
    e.to_string().into()
}

#[derive(Default)]
pub struct WorkState(
    Mutex<HashMap<String, Arc<AtomicBool>>>,
    Mutex<Option<(String, Vec<PathBuf>)>>,
);
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
    pub(crate) fn select_documents(&self, paths: Vec<PathBuf>) -> Result<Value> {
        if paths.is_empty() || paths.len() > MAX_SOURCE_FILES {
            return Err(crate::language::error(
                "LOCAL_SOURCE_COUNT_INVALID",
                json!({}),
            ));
        }
        let token = store::id();
        let names: Vec<_> = paths
            .iter()
            .map(|path| {
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        *self.1.lock().map_err(err)? = Some((token.clone(), paths));
        Ok(json!({"token":token,"fileNames":names}))
    }
    pub(crate) fn selected_documents(&self, token: &str) -> Result<Vec<PathBuf>> {
        self.1
            .lock()
            .map_err(err)?
            .as_ref()
            .filter(|(id, _)| id == token)
            .map(|(_, paths)| paths.clone())
            .ok_or_else(|| AppError::new("LOCAL_SOURCE_MISSING", "请重新选择源文件"))
    }
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
        self.exclusive("请先等待当前 AI 请求结束或停止导入批次，再恢复备份")
    }
    pub(crate) fn configure(&self) -> Result<Lease<'_>> {
        self.exclusive("请先等待当前 AI 请求结束或停止导入批次，再更改连接设置")
    }
    fn exclusive(&self, message: &str) -> Result<Lease<'_>> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
        if !active.is_empty() {
            return Err(AppError::new("OPERATION_BUSY", message));
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
    crate::filesystem::persist(file, &path, true).map_err(err)?;
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDetails {
    pub title: String,
    pub description: String,
}
impl ImportDetails {
    pub fn validate(&self) -> Result<()> {
        if self.title.trim().is_empty()
            || self.title.chars().count() > 200
            || self.description.trim().is_empty()
            || self.description.chars().count() > 20_000
        {
            return Err(AppError::new(
                "LOCAL_IMPORT_DETAILS_INVALID",
                "请填写题库名（最多 200 字）和描述（最多 20000 字）",
            ));
        }
        Ok(())
    }
}
pub fn import_details(dir: &Path) -> Result<HashMap<String, ImportDetails>> {
    let mut details = HashMap::new();
    for op in all::<Operation>(dir, "requests")? {
        if let (Some(value), Some(receipt)) = (op.import_details, op.receipt) {
            if let Some(id) = receipt["threadId"].as_str() {
                details.insert(id.to_owned(), value);
            }
        }
    }
    Ok(details)
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    office_source: Option<crate::office::Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    import_details: Option<ImportDetails>,
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
        let (id, action) = op
            .path
            .strip_prefix("/api/document-tasks/")
            .and_then(|s| s.rsplit_once('/'))
            .ok_or(crate::language::error(
                "LOCAL_OPERATION_PATH_INVALID",
                serde_json::json!({}),
            ))?;
        if !matches!(action, "control" | "reparse")
            || op.path != format!("{}/{action}", task_path(id)?)
        {
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
    let office_source = if let Some(id) = path
        .strip_prefix("/api/document-tasks/")
        .and_then(|s| s.strip_suffix("/reparse"))
    {
        office_sources(dir)?.remove(id)
    } else {
        None
    };
    let mut active = work.0.lock().map_err(err)?;
    let mut op = stage_operation(dir, path, body, label, office_source)?;
    if let Some(id) = path
        .strip_prefix("/api/document-tasks/")
        .and_then(|s| s.strip_suffix("/reparse"))
    {
        op.import_details = import_details(dir)?.remove(id);
    }
    let lease = work.claim_locked(&op.id, &mut active)?;
    drop(active);
    execute_operation(dir, endpoint, op, lease)
}
fn stage_operation(
    dir: &Path,
    path: &str,
    body: Value,
    label: &str,
    office_source: Option<crate::office::Origin>,
) -> Result<Operation> {
    let mut unsigned = body.clone();
    unsigned
        .as_object_mut()
        .ok_or(crate::language::error(
            "LOCAL_REQUEST_INVALID",
            serde_json::json!({}),
        ))?
        .remove("requestId");
    let identity = store::hash(&serde_json::to_vec(&json!([path, unsigned])).map_err(err)?);
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
        office_source,
        import_details: None,
    });
    validate_operation(&op)?;
    save(dir, "requests", &op.id, &op)?;
    Ok(op)
}

pub fn stage_document(
    dir: &Path,
    work: &WorkState,
    document: Value,
    label: &str,
    source: Option<crate::office::Origin>,
    details: Option<&ImportDetails>,
) -> Result<()> {
    let _active = work.0.lock().map_err(err)?;
    let mut op = stage_operation(
        dir,
        "/api/document-tasks",
        json!({"requestId":store::id(),"document":document,"failurePolicy":"review"}),
        label,
        source,
    )?;
    if let Some(details) = details {
        details.validate()?;
        op.import_details = Some(details.clone());
        save(dir, "requests", &op.id, &op)?;
    }
    Ok(())
}

pub fn submit_documents(
    dir: &Path,
    work: &WorkState,
    endpoint: &Endpoint,
    documents: Vec<(Value, String, Option<crate::office::Origin>)>,
) -> Result<Vec<Value>> {
    let active = work.0.lock().map_err(err)?;
    let mut staged = Vec::new();
    // Persist every sheet before any POST. A failure leaves the rest explicitly replayable.
    for (document, label, source) in documents {
        staged.push(stage_operation(
            dir,
            "/api/document-tasks",
            json!({"requestId":store::id(),"document":document,"failurePolicy":"review"}),
            &label,
            source,
        )?);
    }
    drop(active);
    staged
        .into_iter()
        .map(|op| {
            let lease = work.claim(&op.id)?;
            execute_operation(dir, endpoint, op, lease)
        })
        .collect()
}

pub fn office_matches(dir: &Path, hash: &str, mode: crate::office::Mode) -> Result<Vec<Value>> {
    let mut matches = Vec::new();
    for op in all::<Operation>(dir, "requests")? {
        validate_operation(&op)?;
        if op
            .office_source
            .as_ref()
            .is_some_and(|s| s.source_sha256 == hash && s.mode == mode)
        {
            if op.status == OperationStatus::Pending {
                let mut error = crate::language::error("OFFICE_IMPORT_PENDING", json!({}));
                error.request_id = Some(op.id);
                return Err(error);
            }
            if let (OperationStatus::Accepted, Some(receipt)) = (op.status, op.receipt) {
                matches.push(receipt);
            }
        }
    }
    Ok(matches)
}

fn office_sources(dir: &Path) -> Result<HashMap<String, crate::office::Origin>> {
    let mut sources = HashMap::new();
    for op in all::<Operation>(dir, "requests")? {
        validate_operation(&op)?;
        if let (Some(source), Some(receipt)) = (op.office_source, op.receipt) {
            if let Some(id) = receipt["threadId"].as_str() {
                sources.insert(id.to_owned(), source);
            }
        }
    }
    Ok(sources)
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
    #[serde(default)]
    bank_id: Option<String>,
    items: Vec<BatchItem>,
}
pub fn delete_task(dir: &Path, work: &WorkState, endpoint: &Endpoint, id: &str) -> Result<Value> {
    let active = work.0.lock().map_err(err)?;
    for batch in all::<Batch>(dir, "import-batches")? {
        if active.contains_key(&batch.id) && batch.items.iter().any(|item| item.thread_id == id) {
            return Err(AppError::new("OPERATION_BUSY", "请先停止导入批次"));
        }
    }
    let result = endpoint.json(Method::DELETE, &task_path(id)?, None)?;
    for op in all::<Operation>(dir, "requests")? {
        if op
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt["threadId"] == id)
        {
            fs::remove_file(path(dir, "requests", &op.id)?).map_err(err)?;
        }
    }
    Ok(result)
}

fn validate_destination(store: &Store, bank_id: Option<&str>) -> Result<()> {
    if let Some(bank_id) = bank_id {
        let exists: bool = store
            .connect()?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)",
                [bank_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            return Err(crate::language::error("LOCAL_BANK_MISSING", json!({})));
        }
    }
    Ok(())
}
fn imported_destination(bank: String, requested: Option<&str>) -> Result<String> {
    if requested.is_some_and(|requested| requested != bank) {
        return Err(AppError::new(
            "AI_RESULT_IMPORTED_ELSEWHERE",
            "该结果已导入其他题库，请打开原题库查看",
        ));
    }
    Ok(bank)
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
pub fn prepare_batch(
    dir: &Path,
    endpoint: &Endpoint,
    ids: &[String],
    bank_id: Option<String>,
) -> Result<Value> {
    if ids.is_empty() || ids.len() > 100 || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(crate::language::error(
            "LOCAL_BATCH_SELECTION_INVALID",
            serde_json::json!({}),
        ));
    }
    let store = Store {
        dir: dir.into(),
        ..Default::default()
    };
    validate_destination(&store, bank_id.as_deref())?;
    let mut batch = Batch {
        id: store::id(),
        created_at: store::now(),
        status: BatchStatus::Ready,
        bank_id,
        items: vec![],
    };
    let db = store.connect()?;
    for id in ids {
        let pending = endpoint.pending(dir, id)?;
        let source = pending.source.as_ref().ok_or(crate::language::error(
            "LOCAL_TASK_SOURCE_MISSING",
            serde_json::json!({}),
        ))?;
        let digest = pending.digest()?;
        let bank = Store::imported_ai_with(&db, id, Some(&digest), None)?
            .map(|bank| imported_destination(bank, batch.bank_id.as_deref()))
            .transpose()?;
        let previous = bank.is_none() && Store::imported_ai_with(&db, id, None, None)?.is_some();
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
pub fn batches(dir: &Path, work: &WorkState, offset: usize, threads: &[String]) -> Result<Value> {
    crate::store::validate_page(20, offset)?;
    if threads.len() > 21 {
        return Err("Too many task IDs".into());
    }
    for thread in threads {
        task_path(thread)?;
    }
    // ponytail: manifests still scan O(history); add an index only if directory reads dominate.
    let mut batches = all::<Batch>(dir, "import-batches")?;
    let active = work
        .0
        .lock()
        .map_err(|_| crate::language::error("LOCAL_WORK_UNAVAILABLE", serde_json::json!({})))?;
    let store = Store {
        dir: dir.into(),
        ..Default::default()
    };
    for batch in &batches {
        validate_batch(batch)?;
    }
    batches.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let mut operations = Vec::new();
    let mut seen = HashSet::new();
    for priority in ["importing", "failed"] {
        for batch in &batches {
            for item in &batch.items {
                if threads.contains(&item.thread_id) {
                    let state = match item.status {
                        ItemStatus::Failed => Some("failed"),
                        ItemStatus::Pending if active.contains_key(&batch.id) => Some("importing"),
                        _ => None,
                    };
                    if let Some(state) = state {
                        if state == priority && seen.insert((&item.thread_id, &item.checkpoint_id))
                        {
                            operations.push(json!({"threadId":item.thread_id,"checkpointId":item.checkpoint_id,"state":state,"error":item.error}));
                        }
                    }
                }
            }
        }
    }
    let (mut running, history): (Vec<_>, Vec<_>) = batches
        .into_iter()
        .partition(|b| active.contains_key(&b.id));
    let total = history.len();
    let offset = offset.min(total.saturating_sub(1) / 20 * 20);
    running.extend(history.into_iter().skip(offset).take(20));
    let mut batches = running;
    let db = store.connect()?;
    for batch in &mut batches {
        // Active writers own their manifests; inactive batches reconcile against restored receipts.
        if !active.contains_key(&batch.id) {
            for item in &mut batch.items {
                if item.status == ItemStatus::Imported {
                    let imported =
                        Store::imported_ai_with(&db, &item.thread_id, Some(&item.digest), None)?
                            .map(|bank| imported_destination(bank, batch.bank_id.as_deref()))
                            .transpose();
                    match imported {
                        Ok(Some(bank)) => item.bank_id = Some(bank),
                        Ok(None) => {
                            item.bank_id = None;
                            item.status = ItemStatus::Pending;
                            item.error = None;
                            batch.status = BatchStatus::Paused;
                        }
                        Err(error) => {
                            item.bank_id = None;
                            item.status = ItemStatus::Failed;
                            item.error = Some(error);
                            batch.status = BatchStatus::Paused;
                        }
                    }
                }
            }
        }
        if batch.status == BatchStatus::Running && !active.contains_key(&batch.id) {
            batch.status = BatchStatus::Paused;
        }
    }
    Ok(json!({"items":batches,"total":total,"offset":offset,"operations":operations}))
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
    validate_destination(
        &*shared
            .lock()
            .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", json!({})))?,
        batch.bank_id.as_deref(),
    )?;
    batch.status = BatchStatus::Running;
    save(dir, "import-batches", id, &batch)?;
    for index in 0..batch.items.len() {
        if lease.cancelled.load(Ordering::SeqCst) {
            batch.status = BatchStatus::Paused;
            break;
        }
        let item = &mut batch.items[index];
        // The practice database, not the manifest, decides whether a commit happened.
        let result = import_item(dir, endpoint, shared, item, batch.bank_id.as_deref());
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
    bank_id: Option<&str>,
) -> Result<String> {
    if let Some(bank) = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({})))?
        .imported_ai(&item.thread_id, Some(&item.digest), None)?
    {
        return imported_destination(bank, bank_id);
    }
    let mut pending = endpoint.pending(dir, &item.thread_id)?;
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
            dir: dir.into(),
            ..Default::default()
        },
    )?;
    let result = shared
        .lock()
        .map_err(|_| crate::language::error("LOCAL_DATABASE_UNAVAILABLE", serde_json::json!({})))?
        .import_pending(&pending, bank_id.map(str::to_owned), &item.title)?;
    imported_destination(contract::text(&result, "bankId").into(), bank_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read},
        net::TcpListener,
        thread,
    };

    #[test]
    fn import_form_metadata_survives_receipts_and_populates_bank() {
        let dir = tempfile::tempdir().unwrap();
        let work = WorkState::default();
        let selected = work
            .select_documents(vec![
                PathBuf::from("/tmp/source.pdf"),
                PathBuf::from("/tmp/second.csv"),
            ])
            .unwrap();
        assert_eq!(
            work.selected_documents(selected["token"].as_str().unwrap())
                .unwrap(),
            vec![
                PathBuf::from("/tmp/source.pdf"),
                PathBuf::from("/tmp/second.csv")
            ]
        );
        assert!(work.selected_documents("/etc/passwd").is_err());
        assert_eq!(selected["fileNames"], json!(["source.pdf", "second.csv"]));
        assert!(work.select_documents(vec![]).is_err());
        assert!(work
            .select_documents(vec![PathBuf::from("/tmp/source.pdf"); 11])
            .is_err());
        assert_eq!(
            work.selected_documents(selected["token"].as_str().unwrap())
                .unwrap()
                .len(),
            2
        );
        let replacement = work
            .select_documents(
                (0..10)
                    .map(|i| PathBuf::from(format!("/tmp/source-{i}.pdf")))
                    .collect(),
            )
            .unwrap();
        assert!(work
            .selected_documents(selected["token"].as_str().unwrap())
            .is_err());
        assert_eq!(
            work.selected_documents(replacement["token"].as_str().unwrap())
                .unwrap()
                .len(),
            10
        );
        let details = ImportDetails {
            title: "Course".into(),
            description: "Chapter one".into(),
        };
        assert!(ImportDetails {
            title: " ".into(),
            description: "x".into()
        }
        .validate()
        .is_err());
        assert!(ImportDetails {
            title: "x".into(),
            description: " ".into()
        }
        .validate()
        .is_err());
        let id = store::id();
        let document = json!({"fileName":"source.pdf"});
        stage_document(
            dir.path(),
            &work,
            document.clone(),
            "source.pdf",
            None,
            Some(&details),
        )
        .unwrap();
        let task_id = id.clone();
        let (endpoint, worker) = server(2, move |path, body| {
            if path == "/api/document-tasks" {
                response(json!({"accepted":true,"requestId":body["requestId"],"threadId":task_id}))
            } else {
                response(task(&task_id, false))
            }
        });
        submit_documents(
            dir.path(),
            &work,
            &endpoint,
            vec![(document, "source.pdf".into(), None)],
        )
        .unwrap();
        assert_eq!(import_details(dir.path()).unwrap()[&id].title, "Course");
        let pending = endpoint.pending(dir.path(), &id).unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let result = store
            .import_pending(&pending, None, &pending.title)
            .unwrap();
        let saved: (String, String) = store
            .connect()
            .unwrap()
            .query_row(
                "SELECT title,description FROM banks WHERE id=?1",
                [result["bankId"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved, ("Course".into(), "Chapter one".into()));
        worker.join().unwrap();
    }

    #[test]
    fn deleting_history_clears_receipts_but_rejects_an_active_import_batch() {
        let dir = tempfile::tempdir().unwrap();
        let work = WorkState::default();
        let id = store::id();
        let batch_id = store::id();
        let mut op = stage_operation(
            dir.path(),
            "/api/document-tasks",
            json!({"requestId":store::id(),"document":{}}),
            "source",
            None,
        )
        .unwrap();
        op.status = OperationStatus::Accepted;
        op.receipt = Some(json!({"threadId":id}));
        save(dir.path(), "requests", &op.id, &op).unwrap();
        let batch = Batch {
            id: batch_id.clone(),
            created_at: 0,
            status: BatchStatus::Running,
            bank_id: None,
            items: vec![BatchItem {
                thread_id: id.clone(),
                checkpoint_id: "cp".into(),
                digest: "digest".into(),
                title: "Course".into(),
                question_count: 1,
                review_count: 0,
                partial: false,
                previous_version: false,
                status: ItemStatus::Pending,
                bank_id: None,
                error: None,
            }],
        };
        save(dir.path(), "import-batches", &batch_id, &batch).unwrap();
        let (endpoint, worker) = server(1, |_, _| response(json!({"deleted":true})));
        let lease = work.claim(&batch_id).unwrap();
        assert_eq!(
            delete_task(dir.path(), &work, &endpoint, &id)
                .unwrap_err()
                .code,
            "OPERATION_BUSY"
        );
        assert!(path(dir.path(), "requests", &op.id).unwrap().exists());
        drop(lease);
        assert_eq!(
            delete_task(dir.path(), &work, &endpoint, &id).unwrap()["deleted"],
            true
        );
        assert!(!path(dir.path(), "requests", &op.id).unwrap().exists());
        worker.join().unwrap();
    }

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
    fn interrupted_sheet_uploads_have_receipts_before_content_transfer() {
        let dir = tempfile::tempdir().unwrap();
        let stored = dir.path().to_owned();
        let origin = crate::office::Origin {
            file_name: "source.xlsx".into(),
            source_sha256: "a".repeat(64),
            mode: crate::office::Mode::Text,
            version: "LibreOffice".into(),
            artifact_sha256: "b".repeat(64),
        };
        let mut uploads = 0;
        let (endpoint, worker) = server(6, move |path, body| {
            if path == "/api/uploads" {
                return response(
                    json!({"document":body, "upload":{"url":"/api/uploads/content?test"}}),
                );
            }
            if path.starts_with("/api/uploads/content?") {
                uploads += 1;
                let pending = all::<Operation>(&stored, "requests").unwrap();
                assert_eq!(pending.len(), uploads);
                assert!(pending
                    .iter()
                    .all(|op| op.office_source.is_some() && op.receipt.is_none()));
                // The second PUT can persist its data but lose a successful response.
                return Some((if uploads == 2 { 503 } else { 200 }, b"{}".to_vec()));
            }
            assert_eq!(path, "/api/document-tasks");
            response(
                json!({"accepted":true, "requestId":body["requestId"], "threadId":body["requestId"]}),
            )
        });
        for (index, bytes) in [b"{}".to_vec(), b"[]".to_vec()].into_iter().enumerate() {
            let name = format!("sheet-{index}.csv");
            let result =
                crate::ai::upload_document(&endpoint, Path::new(&name), bytes, |document| {
                    stage_document(
                        dir.path(),
                        &WorkState::default(),
                        document.clone(),
                        &name,
                        Some(origin.clone()),
                        None,
                    )
                });
            assert_eq!(result.is_ok(), index == 0);
        }
        let pending = operations(dir.path()).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 2);
        for op in pending.as_array().unwrap() {
            let id = contract::text(op, "id");
            let receipt =
                replay_operation(dir.path(), &WorkState::default(), &endpoint, id).unwrap();
            assert_eq!(receipt["requestId"], id);
        }
        worker.join().unwrap();
        assert!(operations(dir.path())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            office_matches(dir.path(), &origin.source_sha256, crate::office::Mode::Text)
                .unwrap()
                .len(),
            2
        );

        let (endpoint, worker) = server(1, |_, body| {
            response(json!({"document":body,"upload":{"url":"/api/uploads/content?test"}}))
        });
        let result = crate::ai::upload_document(
            &endpoint,
            Path::new("never-uploaded.csv"),
            b"{}".to_vec(),
            |_| Err(AppError::new("DISK_FULL", "cannot record ownership")),
        );
        assert_eq!(result.unwrap_err().code, "DISK_FULL");
        worker.join().unwrap();
    }

    #[test]
    fn office_sheets_are_durable_before_submission_and_keep_origins_on_replay() {
        let dir = tempfile::tempdir().unwrap();
        let origin = crate::office::Origin {
            file_name: "source.xlsx".into(),
            source_sha256: "a".repeat(64),
            mode: crate::office::Mode::Text,
            version: "LibreOffice 26.2".into(),
            artifact_sha256: "b".repeat(64),
        };
        let (endpoint, server_thread) = server(1, |_, _| None);
        assert!(submit_documents(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            vec![
                (
                    json!({"sha256":"one"}),
                    "first.csv".into(),
                    Some(origin.clone())
                ),
                (
                    json!({"sha256":"two"}),
                    "second.csv".into(),
                    Some(origin.clone())
                )
            ]
        )
        .is_err());
        server_thread.join().unwrap();
        let pending = operations(dir.path()).unwrap();
        assert_eq!(pending.as_array().unwrap().len(), 2);
        assert_eq!(
            office_matches(dir.path(), &origin.source_sha256, crate::office::Mode::Text)
                .unwrap_err()
                .code,
            "OFFICE_IMPORT_PENDING"
        );
        let (endpoint, server_thread) = server(2, |_, body| {
            response(
                json!({"requestId":body["requestId"], "accepted":true, "threadId":body["requestId"]}),
            )
        });
        for item in pending.as_array().unwrap() {
            let id = contract::text(item, "id");
            replay_operation(dir.path(), &WorkState::default(), &endpoint, id).unwrap();
            let saved = office_sources(dir.path()).unwrap().remove(id).unwrap();
            assert_eq!(saved.source_sha256, origin.source_sha256);
            assert_eq!(saved.file_name, "source.xlsx");
        }
        server_thread.join().unwrap();
        assert!(operations(dir.path())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            office_matches(dir.path(), &origin.source_sha256, crate::office::Mode::Text)
                .unwrap()
                .len(),
            2
        );
        assert!(
            office_matches(dir.path(), &origin.source_sha256, crate::office::Mode::Pdf)
                .unwrap()
                .is_empty()
        );
        let old = contract::text(&pending[0], "id");
        let new = store::id();
        let expected = new.clone();
        let (endpoint, server_thread) = server(2, move |_, body| {
            response(json!({"requestId":body["requestId"], "accepted":true, "threadId":expected}))
        });
        submit_operation(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            &format!("/api/document-tasks/{old}/reparse"),
            json!({"requestId":new}),
            "reparse",
        )
        .unwrap();
        // Control receipts for the same task must not mask its original source association.
        submit_operation(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            &format!("/api/document-tasks/{new}/control"),
            json!({"requestId":store::id(), "action":"pause"}),
            "pause",
        )
        .unwrap();
        server_thread.join().unwrap();
        assert_eq!(
            office_sources(dir.path()).unwrap()[&new].source_sha256,
            origin.source_sha256
        );
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
    fn reparse_replays_the_same_request_and_rejects_other_action_paths() {
        let dir = tempfile::tempdir().unwrap();
        let request_id = store::id();
        let task_id = store::id();
        let path = format!("{}/reparse", task_path(&task_id).unwrap());
        let expected_path = path.clone();
        let expected_id = request_id.clone();
        let mut calls = 0;
        let (endpoint, worker) = server(2, move |path, body| {
            assert_eq!(path, expected_path);
            assert_eq!(body["requestId"], expected_id);
            calls += 1;
            (calls == 2).then(|| {
                (
                    200,
                    serde_json::to_vec(&json!({"requestId":expected_id,"accepted":true})).unwrap(),
                )
            })
        });
        assert!(submit_operation(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            &path,
            json!({"requestId":request_id}),
            "reparse",
        )
        .is_err());
        replay_operation(dir.path(), &WorkState::default(), &endpoint, &request_id).unwrap();
        worker.join().unwrap();
        let mut op: Operation = read(dir.path(), "requests", &request_id).unwrap();
        for invalid in [
            format!("{}/delete", task_path(&task_id).unwrap()),
            "/api/document-tasks/not-a-uuid/reparse".into(),
            format!("{}/reparse/extra", task_path(&task_id).unwrap()),
        ] {
            op.path = invalid;
            assert!(validate_operation(&op).is_err());
        }
    }

    #[test]
    fn batch_pages_keep_active_work_and_off_page_failure_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let _shared = shared(dir.path());
        let work = WorkState::default();
        let thread = store::id();
        let mut first = String::new();
        for i in 0..26 {
            let id = store::id();
            if i == 0 {
                first = id.clone();
            }
            let batch = Batch {
                id: id.clone(),
                created_at: i,
                status: BatchStatus::Running,
                bank_id: None,
                items: vec![BatchItem {
                    thread_id: thread.clone(),
                    checkpoint_id: "checkpoint".into(),
                    digest: "a".repeat(64),
                    title: format!("Item {i}"),
                    question_count: 1,
                    review_count: 0,
                    partial: false,
                    previous_version: false,
                    status: if i == 0 {
                        ItemStatus::Pending
                    } else {
                        ItemStatus::Failed
                    },
                    bank_id: None,
                    error: None,
                }],
            };
            save(dir.path(), "import-batches", &id, &batch).unwrap();
        }
        let _lease = work.claim(&first).unwrap();
        let page = batches(dir.path(), &work, 0, std::slice::from_ref(&thread)).unwrap();
        assert_eq!(page["total"], 25);
        assert_eq!(page["items"].as_array().unwrap().len(), 21);
        assert_eq!(page["items"][0]["id"], first);
        assert_eq!(page["items"][0]["status"], "running");
        assert_eq!(page["operations"].as_array().unwrap().len(), 1);
        assert_eq!(page["operations"][0]["state"], "importing");
        let last = batches(dir.path(), &work, 200, std::slice::from_ref(&thread)).unwrap();
        assert_eq!(last["offset"], 20);
        assert_eq!(last["items"].as_array().unwrap().len(), 6);
        assert_eq!(last["operations"], page["operations"]);
        drop(_lease);
        let inactive = batches(dir.path(), &work, 0, &[thread]).unwrap();
        assert_eq!(inactive["operations"][0]["state"], "failed");
        assert!(batches(dir.path(), &work, 0, &["invalid".into()]).is_err());
    }

    #[test]
    fn batch_isolates_corrupt_images_and_resumes_from_database_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        let backup = dir.path().join("before-import.zip");
        shared.lock().unwrap().backup(&backup).unwrap();
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
        let preview = prepare_batch(dir.path(), &endpoint, &ids, None).unwrap();
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
            batches(dir.path(), &WorkState::default(), 0, &[]).unwrap()["items"][0]["status"],
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
        drop(db);
        shared.lock().unwrap().restore(&backup).unwrap();
        let reconciled = batches(dir.path(), &work, 0, &[]).unwrap()["items"].clone();
        assert_eq!(reconciled[0]["status"], "paused");
        assert!(reconciled[0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["status"] == "pending" && i["bankId"].is_null()));
    }

    #[test]
    fn append_batch_keeps_destination_through_cancel_restart_and_committed_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let shared = shared(dir.path());
        let work = Arc::new(WorkState::default());
        let ids = vec![store::id(), store::id()];
        let bank_id = shared
            .lock()
            .unwrap()
            .save_bank(None, "Combined", "")
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        fn distinct_task(path: &str) -> Value {
            let id = path.rsplit('/').next().unwrap();
            let mut value = task(id, false);
            value["result"]["questions"][0]["stem"] = json!(id);
            value
        }
        let offline = Endpoint::test("http://127.0.0.1:1".into());
        assert_eq!(
            prepare_batch(dir.path(), &offline, &ids, Some("missing".into()))
                .unwrap_err()
                .code,
            "LOCAL_BANK_MISSING"
        );
        let (endpoint, worker) = server(2, |path, _| response(distinct_task(path)));
        let preview = prepare_batch(dir.path(), &endpoint, &ids, Some(bank_id.clone())).unwrap();
        worker.join().unwrap();
        assert_eq!(preview["bankId"], bank_id);
        let id = contract::text(&preview, "id").to_owned();
        let cancel_dir = dir.path().to_owned();
        let cancel_id = id.clone();
        let cancel_work = work.clone();
        let (endpoint, worker) = server(1, move |path, _| {
            cancel_batch(&cancel_dir, &cancel_work, &cancel_id).unwrap();
            response(distinct_task(path))
        });
        let paused = run_batch(dir.path(), &work, &endpoint, &shared, &id, None).unwrap();
        worker.join().unwrap();
        assert_eq!(paused["status"], "paused");
        assert_eq!(paused["items"][0]["status"], "imported");
        assert_eq!(paused["items"][1]["status"], "pending");
        assert_eq!(paused["items"][0]["bankId"], bank_id);
        // Simulate exit after a commit but before its manifest update.
        let mut interrupted: Batch = read(dir.path(), "import-batches", &id).unwrap();
        interrupted.items[0].status = ItemStatus::Pending;
        interrupted.items[0].bank_id = None;
        save(dir.path(), "import-batches", &id, &interrupted).unwrap();
        let (endpoint, worker) = server(1, |path, _| response(distinct_task(path)));
        let done = run_batch(
            dir.path(),
            &WorkState::default(),
            &endpoint,
            &shared,
            &id,
            None,
        )
        .unwrap();
        worker.join().unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(done["items"][1]["status"], "imported");
        assert_eq!(done["items"][1]["bankId"], bank_id);
        let db = shared.lock().unwrap().connect().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM banks", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM imports", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let repeated = run_batch(dir.path(), &work, &offline, &shared, &id, None).unwrap();
        assert_eq!(repeated, done);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM imports", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let other = shared
            .lock()
            .unwrap()
            .save_bank(None, "Other", "")
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let (endpoint, worker) = server(1, |path, _| response(distinct_task(path)));
        assert_eq!(
            prepare_batch(dir.path(), &endpoint, &ids, Some(other.clone()))
                .unwrap_err()
                .code,
            "AI_RESULT_IMPORTED_ELSEWHERE"
        );
        worker.join().unwrap();
        // A result imported elsewhere after preparation must also fail at execution.
        interrupted.bank_id = Some(other.clone());
        interrupted.items[0].status = ItemStatus::Imported;
        interrupted.items[0].bank_id = Some(bank_id);
        save(dir.path(), "import-batches", &id, &interrupted).unwrap();
        assert_eq!(
            batches(dir.path(), &work, 0, &[]).unwrap()["items"][0]["items"][0]["error"]["code"],
            "AI_RESULT_IMPORTED_ELSEWHERE"
        );
        let conflicted = run_batch(dir.path(), &work, &offline, &shared, &id, None).unwrap();
        assert_eq!(
            conflicted["items"][0]["error"]["code"],
            "AI_RESULT_IMPORTED_ELSEWHERE"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM imports", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        let mut legacy = serde_json::to_value(interrupted).unwrap();
        legacy.as_object_mut().unwrap().remove("bankId");
        assert!(serde_json::from_value::<Batch>(legacy)
            .unwrap()
            .bank_id
            .is_none());
        shared.lock().unwrap().delete_bank(&other).unwrap();
        assert_eq!(
            run_batch(dir.path(), &work, &offline, &shared, &id, None)
                .unwrap_err()
                .code,
            "LOCAL_BANK_MISSING"
        );
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
        let batch = prepare_batch(dir.path(), &endpoint, &[id], None).unwrap();
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
    assert!(work.configure().is_err());
    drop(request);
    let restore = work.restore().unwrap();
    assert!(work.enter().is_err());
    assert!(work.configure().is_err());
    drop(restore);
    let configure = work.configure().unwrap();
    assert!(work.enter().is_err());
    assert!(work.restore().is_err());
    assert!(work.configure().is_err());
    drop(configure);
    assert!(work.enter().is_ok());
}
