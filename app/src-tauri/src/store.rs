use crate::contract::{self, list, text, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}
pub fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let f = fs::File::open(path).map_err(err)?;
    if !f.metadata().map_err(err)?.is_file() {
        return Err(crate::language::error(
            "LOCAL_REGULAR_FILE_REQUIRED",
            serde_json::json!({}),
        ));
    }
    let mut bytes = Vec::new();
    f.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err(crate::language::error(
            "LOCAL_FILE_TOO_LARGE",
            serde_json::json!({}),
        ));
    }
    Ok(bytes)
}
pub struct Pending {
    pub ticket: String,
    pub root: Value,
    pub title: String,
    pub assets: HashMap<String, (String, Vec<u8>)>,
    pub missing: Vec<String>,
    pub source: Option<ImportSource>,
}
pub struct ImportSource {
    pub thread_id: String,
    pub checkpoint_id: String,
}
impl Pending {
    pub fn new(bytes: Vec<u8>, title: String) -> Result<Self> {
        let root = contract::parse(&bytes)?;
        let missing = list(contract::result(&root), "visualElements")
            .iter()
            .flat_map(contract::visual_refs)
            .map(|r| text(r, "objectKey").to_owned())
            .collect();
        Ok(Self {
            ticket: id(),
            root,
            title,
            assets: HashMap::new(),
            missing,
            source: None,
        })
    }
    pub fn digest(&self) -> Result<String> {
        if self.source.is_some() {
            return Ok(hash(&serde_json::to_vec(&json!({"result":contract::result(&self.root),"status":self.root["status"],"processing":self.root["processing"]})).map_err(err)?));
        }
        Ok(hash(
            &serde_json::to_vec(contract::result(&self.root)).map_err(err)?,
        ))
    }
}
pub struct Store {
    pub locale: crate::language::Locale,
    pub dir: PathBuf,
    pub pending: Option<Pending>,
}
fn contains_search_text(value: &Value, search: &str) -> bool {
    match value {
        Value::String(value) => value.to_lowercase().contains(search),
        Value::Array(values) => values.iter().any(|v| contains_search_text(v, search)),
        Value::Object(values) => values.values().any(|v| contains_search_text(v, search)),
        _ => false,
    }
}

fn searchable_content_matches(value: &Value, search: &str) -> bool {
    match value {
        Value::Array(values) => values.iter().any(|v| searchable_content_matches(v, search)),
        Value::Object(values) => values.iter().any(|(key, value)| match key.as_str() {
            // These fields contain free-form content, not contract metadata.
            "jsonValue" | "answerPayload" => contains_search_text(value, search),
            "stem" | "sourceText" | "analysis" | "scoringRubric" | "scoreSourceText"
            | "options" | "items" | "content" | "label" | "passage" | "contentBlocks"
            | "textValue" | "markdownValue" | "latexValue" | "title" | "instructions"
            | "description" | "extractedText" => searchable_content_matches(value, search),
            _ => false,
        }),
        _ => contains_search_text(value, search),
    }
}

impl Store {
    pub fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).map_err(err)?;
        let store = Self {
            dir,
            pending: None,
            locale: crate::language::Locale::default(),
        };
        store.connect()?;
        Ok(store)
    }
    pub fn db_path(&self) -> PathBuf {
        self.dir.join("practiq.sqlite")
    }
    pub fn connect(&self) -> Result<Connection> {
        let db = Connection::open(self.db_path()).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON;").map_err(err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version == 0 {
            db.execute_batch(include_str!("schema.sql")).map_err(err)?;
        } else if version != 9 {
            return Err("Only database schema 9 is supported; legacy data remains in its original directory".into());
        }
        Ok(db)
    }
    pub fn preview(&mut self, bytes: Vec<u8>, title: String) -> Result<Value> {
        self.pending = Some(Pending::new(bytes, title)?);
        self.preview_value()
    }
    pub fn preview_value(&self) -> Result<Value> {
        let p = self.pending.as_ref().ok_or(crate::language::error(
            "LOCAL_IMPORT_MISSING",
            serde_json::json!({}),
        ))?;
        let r = contract::result(&p.root);
        Ok(
            json!({"ticket":p.ticket,"title":p.title,"count":list(r,"questions").iter().filter(|q|!crate::questions::composite(q)).count(),"reviewCount":list(r,"questions").iter().filter(|q|q["needsReview"]==true && !crate::questions::composite(q)).count(),"questions":r["questions"],"groups":r["groups"],"visuals":r["visualElements"],"warnings":r["warnings"],"status":p.root["status"],"processing":p.root["processing"],"missingAssets":p.missing,"assetCount":p.assets.len()}),
        )
    }
    pub fn resources(&mut self, root: &Path) -> Result<Value> {
        let root = root.canonicalize().map_err(err)?;
        let p = self.pending.as_mut().ok_or(crate::language::error(
            "LOCAL_JSON_REQUIRED",
            serde_json::json!({}),
        ))?;
        let mut assets = HashMap::new();
        let mut missing = Vec::new();
        let mut total = 0usize;
        for r in list(contract::result(&p.root), "visualElements")
            .iter()
            .flat_map(contract::visual_refs)
        {
            if assets.contains_key(text(r, "sha256")) {
                continue;
            }
            let key = text(r, "objectKey");
            if Path::new(key)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
                || key.contains('\\')
            {
                return Err(crate::language::error(
                    "LOCAL_RESOURCE_PATH_UNSAFE",
                    serde_json::json!({"key": key}),
                ));
            }
            let path = root.join(key);
            if !path.exists() {
                missing.push(key.to_owned());
                continue;
            }
            let path = path.canonicalize().map_err(err)?;
            if !path.starts_with(&root) {
                return Err(crate::language::error(
                    "LOCAL_RESOURCE_PATH_OUTSIDE",
                    serde_json::json!({"key": key}),
                ));
            }
            let bytes = read_bounded(&path, crate::assets::LIMIT)?;
            if bytes.len() as u64 != r["sizeBytes"].as_u64().unwrap_or(u64::MAX)
                || hash(&bytes) != text(r, "sha256")
            {
                return Err(crate::language::error(
                    "LOCAL_RESOURCE_CHECKSUM_MISMATCH",
                    serde_json::json!({"key": key}),
                ));
            }
            let media = text(r, "mediaType");
            if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&media) {
                missing.push(format!(
                    "{key} ({})",
                    self.locale
                        .text("不支持的图片类型", "unsupported image type")
                ));
                continue;
            }
            if !image_signature(&bytes, media) {
                return Err(crate::language::error(
                    "LOCAL_IMAGE_FORMAT_MISMATCH",
                    serde_json::json!({"key": key}),
                ));
            }
            total += bytes.len();
            if total > 256 * 1024 * 1024 {
                return Err(crate::language::error(
                    "LOCAL_RESOURCES_TOO_LARGE",
                    serde_json::json!({}),
                ));
            }
            assets.insert(text(r, "sha256").to_owned(), (media.to_owned(), bytes));
        }
        p.assets = assets;
        p.missing = missing;
        self.preview_value()
    }
    pub fn import(&mut self, ticket: &str, bank_id: Option<String>, title: &str) -> Result<Value> {
        let p = self.pending.as_ref().ok_or(crate::language::error(
            "LOCAL_IMPORT_PREVIEW_EXPIRED",
            serde_json::json!({}),
        ))?;
        if ticket != p.ticket {
            return Err(crate::language::error(
                "LOCAL_IMPORT_EXPIRED",
                serde_json::json!({}),
            ));
        }
        let result = self.import_pending(p, bank_id, title)?;
        self.pending = None;
        Ok(result)
    }
    pub fn import_pending(
        &self,
        p: &Pending,
        bank_id: Option<String>,
        title: &str,
    ) -> Result<Value> {
        let title = valid_title(title)?;
        for (digest, (_, bytes)) in &p.assets {
            self.write_asset(digest, bytes)?;
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let digest = p.digest()?;
        if let Some(source) = &p.source {
            if let Some(bank) = tx.query_row(
                "SELECT i.bank_id FROM ai_imports a JOIN imports i ON i.id=a.import_id WHERE a.thread_id=?1 AND a.digest=?2",
                params![source.thread_id, digest], |r| r.get::<_, String>(0),
            ).optional().map_err(err)? {
                tx.execute("UPDATE ai_imports SET checkpoint_id=?3 WHERE thread_id=?1 AND digest=?2",
                    params![source.thread_id, digest, source.checkpoint_id]).map_err(err)?;
                tx.commit().map_err(err)?;
                return Ok(json!({"duplicate":true,"bankId":bank,"count":0}));
            }
        }
        let existing_bank = bank_id.is_some();
        let bank = bank_id.unwrap_or_else(id);
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)",
                [&bank],
                |r| r.get(0),
            )
            .map_err(err)?;
        if existing_bank && !exists {
            return Err(crate::language::error(
                "LOCAL_BANK_MISSING",
                serde_json::json!({}),
            ));
        }
        if !exists {
            tx.execute(
                "INSERT INTO banks VALUES(?1,?2,'',?3)",
                params![bank, title, now()],
            )
            .map_err(err)?;
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM imports WHERE bank_id=?1 AND digest=?2)",
                params![bank, digest],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?
        {
            if let Some(source) = &p.source {
                tx.execute("INSERT INTO ai_imports(thread_id,digest,checkpoint_id,import_id) SELECT ?1,?2,?3,id FROM imports WHERE bank_id=?4 AND digest=?2",
                    params![source.thread_id, digest, source.checkpoint_id, bank]).map_err(err)?;
                tx.commit().map_err(err)?;
            }
            return Ok(json!({"duplicate":true,"bankId":bank,"count":0}));
        }
        let import_id = id();
        let r = contract::result(&p.root);
        let ids: Vec<String> = list(r, "questions").iter().map(|_| id()).collect();
        let id_map: HashMap<_, _> = list(r, "questions")
            .iter()
            .zip(&ids)
            .map(|(q, id)| (text(q, "id").to_owned(), id.clone()))
            .collect();
        tx.execute(
            "INSERT INTO imports VALUES(?1,?2,?3,?4)",
            params![import_id, bank, digest, now()],
        )
        .map_err(err)?;
        if let Some(source) = &p.source {
            tx.execute(
                "INSERT INTO ai_imports VALUES(?1,?2,?3,?4)",
                params![source.thread_id, digest, source.checkpoint_id, import_id],
            )
            .map_err(err)?;
        }
        for (digest, (media, bytes)) in &p.assets {
            tx.execute(
                "INSERT OR IGNORE INTO assets VALUES(?1,?2,?3,?4)",
                params![digest, media, bytes.len(), format!("assets/{digest}")],
            )
            .map_err(err)?;
        }
        let offset: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE bank_id=?1",
                [&bank],
                |r| r.get(0),
            )
            .map_err(err)?;
        for (i, original) in list(r, "questions").iter().enumerate() {
            let mut q = original.clone();
            crate::questions::remap(&mut q, &id_map)?;
            crate::questions::write(&tx, &q, &bank, Some(&import_id), offset + i as i64, false)?;
        }
        crate::questions::put_context(&tx, &bank, r, &ids, &import_id, &p.root["processing"])?;
        tx.commit().map_err(err)?;
        let count = list(r, "questions")
            .iter()
            .filter(|q| !crate::questions::composite(q))
            .count();
        Ok(json!({"duplicate":false,"bankId":bank,"count":count}))
    }

    pub fn imported_ai(
        &self,
        thread: &str,
        digest: Option<&str>,
        checkpoint: Option<&str>,
    ) -> Result<Option<String>> {
        self.connect()?.query_row(
            "SELECT i.bank_id FROM ai_imports a JOIN imports i ON i.id=a.import_id WHERE a.thread_id=?1 AND (?2 IS NULL OR a.digest=?2) AND (?3 IS NULL OR a.checkpoint_id=?3) LIMIT 1",
            params![thread, digest, checkpoint], |r| r.get(0),
        ).optional().map_err(err)
    }
    pub fn banks(&self) -> Result<Value> {
        let db = self.connect()?;
        let mut s=db.prepare("SELECT b.id,b.title,b.description,b.created_at,COUNT(q.id) FROM banks b LEFT JOIN questions q ON q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN ('reading','word_bank','cloze')) GROUP BY b.id ORDER BY b.created_at DESC").map_err(err)?;
        let rows=s.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"description":r.get::<_,String>(2)?,"createdAt":r.get::<_,i64>(3)?,"count":r.get::<_,i64>(4)?}))).map_err(err)?;
        Ok(json!(rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?))
    }
    pub fn save_bank(
        &self,
        bank_id: Option<String>,
        title: &str,
        description: &str,
    ) -> Result<Value> {
        let title = valid_title(title)?;
        if description.chars().count() > 20_000 {
            return Err(crate::language::error(
                "LOCAL_DESCRIPTION_TOO_LONG",
                serde_json::json!({}),
            ));
        }
        let bank_id = bank_id.unwrap_or_else(id);
        let db = self.connect()?;
        db.execute("INSERT INTO banks VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description",params![bank_id,title,description,now()]).map_err(err)?;
        Ok(json!(bank_id))
    }
    pub fn delete_bank(&self, bank_id: &str) -> Result<Value> {
        self.connect()?
            .execute("DELETE FROM banks WHERE id=?1", [bank_id])
            .map_err(err)?;
        Ok(Value::Null)
    }
    pub fn questions(
        &self,
        bank: Option<&str>,
        search: &str,
        mode: &str,
        filter: &str,
    ) -> Result<Value> {
        self.query_questions(bank, &[], (search, mode, filter), None)
    }
    pub fn questions_multi(
        &self,
        bank: Option<&str>,
        banks: &[String],
        search: &str,
        mode: &str,
        filter: &str,
    ) -> Result<Value> {
        if banks.is_empty() {
            return self.questions(bank, search, mode, filter);
        }
        self.query_questions(bank, banks, (search, mode, filter), None)
    }
    pub fn query_questions(
        &self,
        bank: Option<&str>,
        banks: &[String],
        query: (&str, &str, &str),
        page: Option<(usize, usize)>,
    ) -> Result<Value> {
        let (search, mode, filter) = query;
        if banks.len() > 1000
            || ![
                "",
                "choice",
                "single",
                "multiple",
                "true_false",
                "fill_blank",
                "short_answer",
                "ordering",
                "matching",
                "reading",
                "word_bank",
                "cloze",
            ]
            .contains(&mode)
            || !["", "wrong", "favorite", "unattempted"].contains(&filter)
            || page.is_some_and(|(limit, offset)| {
                !(1..=100).contains(&limit) || offset > i64::MAX as usize
            })
        {
            return Err(crate::language::error("LOCAL_FILTER_INVALID", json!({})));
        }
        if bank.is_some_and(|b| !banks.is_empty() && !banks.iter().any(|v| v == b)) {
            return Ok(if page.is_some() {
                json!({"items":[],"total":0,"offset":0})
            } else {
                json!([])
            });
        }
        let banks = bank
            .map(|b| vec![b.to_owned()])
            .unwrap_or_else(|| banks.to_vec());
        let db = self.connect()?;
        let mut rows;
        let mut ids;
        if search.is_empty() {
            // ponytail: root IDs use linear memory for exact totals; move COUNT/paging into SQL if ID lists become large.
            ids = crate::questions::matching_roots(&db, &banks, mode, filter)?;
            rows = Vec::new();
        } else {
            // Unicode substring search includes answers, shared materials and visuals.
            rows = crate::questions::read_scoped(&db, &banks, None)?;
            let index = crate::questions::Index::new(&rows);
            let mut matches = std::collections::HashSet::new();
            let search = search.to_lowercase();
            for row in &rows {
                if ![&row["question"], &row["groups"], &row["visuals"]]
                    .iter()
                    .any(|value| searchable_content_matches(value, &search))
                {
                    continue;
                }
                let selected = match filter {
                    "favorite" => row["favorite"] == true,
                    "wrong" => row["latestResult"] == false,
                    "unattempted" => !crate::questions::composite(&row["question"]) && !db.query_row("SELECT EXISTS(SELECT 1 FROM attempts WHERE question_id=?1 AND submitted_at IS NOT NULL AND skipped=0)",[text(row,"id")],|r|r.get::<_,bool>(0)).map_err(err)?,
                    _ => true,
                };
                if selected {
                    matches.insert(index.root_id(row));
                }
            }
            ids = rows
                .iter()
                .filter(|row| {
                    let q = &row["question"];
                    text(q, "parentId").is_empty()
                        && matches.contains(text(row, "id"))
                        && (mode.is_empty()
                            || text(q, "answerMode") == mode
                            || (text(q, "answerMode") == "choice"
                                && text(q, "choiceVariant") == mode))
                })
                .map(|r| text(r, "id").to_owned())
                .collect();
        }
        let total = ids.len();
        let offset = if let Some((limit, offset)) = page {
            let offset = offset.min(total.saturating_sub(1) / limit * limit);
            ids = ids.into_iter().skip(offset).take(limit).collect();
            offset
        } else {
            0
        };
        if search.is_empty() {
            rows = crate::questions::read_scoped(&db, &banks, Some(&ids))?;
        }
        let index = crate::questions::Index::new(&rows);
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let row = index
                .by_id
                .get(id.as_str())
                .ok_or("Selected question is missing")?;
            let mut root = index.hydrate(row);
            root["children"] = json!(index.trees[id.as_str()]
                .iter()
                .filter(|r| r["id"] != row["id"])
                .map(|r| index.hydrate(r))
                .collect::<Vec<_>>());
            root["favorite"] = json!(
                row["favorite"] == true
                    || list(&root, "children")
                        .iter()
                        .any(|c| c["favorite"] == true)
            );
            results.push(root);
        }
        Ok(if page.is_some() {
            json!({"items":results,"total":total,"offset":offset})
        } else {
            json!(results)
        })
    }
    #[cfg(test)]
    pub fn save_question(
        &self,
        qid: Option<String>,
        bank: &str,
        mut question: Value,
    ) -> Result<Value> {
        question["id"] = json!(qid.clone().unwrap_or_else(id));
        self.save_question_tree(bank, qid.as_deref(), vec![question])
    }
    pub fn delete_question(&self, qid: &str) -> Result<Value> {
        let db = self.connect()?;
        let child: bool = db
            .query_row(
                "SELECT parent_id IS NOT NULL FROM questions WHERE id=?1",
                [qid],
                |r| r.get(0),
            )
            .map_err(err)?;
        if child {
            return Err(crate::language::error(
                "LOCAL_GROUP_DELETE_CHILD",
                json!({}),
            ));
        }
        db.execute("DELETE FROM questions WHERE id=?1", [qid])
            .map_err(err)?;
        Ok(Value::Null)
    }
    pub fn favorite(&self, qid: &str, value: bool) -> Result<Value> {
        let changed = self
            .connect()?
            .execute(
                "WITH RECURSIVE subtree(id) AS (SELECT id FROM questions WHERE id=?1 UNION ALL SELECT q.id FROM questions q JOIN subtree s ON q.parent_id=s.id) UPDATE questions SET favorite=?2 WHERE id IN subtree",
                params![qid, value],
            )
            .map_err(err)?;
        if changed == 0 {
            return Err(crate::language::error(
                "LOCAL_FAVORITE_DELETED",
                serde_json::json!({}),
            ));
        }
        Ok(json!(value))
    }
    pub fn session(&self, sid: &str) -> Result<Value> {
        self.expire_exam(sid)?;
        let db = self.connect()?;
        let mut session=db.query_row("SELECT id,bank_title,created_at,finished_at,position,mode FROM sessions WHERE id=?1",[sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"position":r.get::<_,i64>(4)?,"mode":r.get::<_,String>(5)?}))).map_err(err)?;
        let mut stmt=db.prepare("SELECT a.ordinal,a.snapshot_question_id,a.answer,a.auto_result,a.result,a.grade_kind,a.submitted_at,a.skipped,a.elapsed_ms,a.max_cents,a.earned_cents,a.flagged,a.grading,q.favorite FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 ORDER BY a.ordinal").map_err(err)?;
        let attempts=stmt.query_map([sid],|r|Ok(json!({"ordinal":r.get::<_,i64>(0)?,"snapshotId":r.get::<_,String>(1)?,"answer":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"autoResult":r.get::<_,Option<bool>>(3)?,"result":r.get::<_,Option<bool>>(4)?,"gradeKind":r.get::<_,String>(5)?,"submittedAt":r.get::<_,Option<i64>>(6)?,"skipped":r.get::<_,bool>(7)?,"elapsedMs":r.get::<_,i64>(8)?,"maxCents":r.get::<_,Option<i64>>(9)?,"earnedCents":r.get::<_,Option<i64>>(10)?,"flagged":r.get::<_,bool>(11)?,"grading":serde_json::from_str::<Value>(&r.get::<_,String>(12)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(12,rusqlite::types::Type::Text,Box::new(e)))?,"favorite":r.get::<_,Option<bool>>(13)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let mut attempts = attempts;
        let frozen = crate::questions::session_rows(&db, sid)?;
        let index = crate::questions::Index::new(&frozen);
        for a in &mut attempts {
            a["snapshot"] = index.snapshot(text(a, "snapshotId"))?;
            a.as_object_mut().unwrap().remove("snapshotId");
        }
        session["attempts"] = json!(attempts);
        self.enrich_session(&db, &mut session)?;
        Ok(session)
    }
    pub fn sessions(&self) -> Result<Value> {
        let db = self.connect()?;
        let mut expired = db
            .prepare("SELECT id FROM sessions WHERE deadline_at<=?1 AND submitted_at IS NULL")
            .map_err(err)?;
        let ids = expired
            .query_map([now()], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(expired);
        for sid in ids {
            self.expire_exam(&sid)?;
        }

        let mut stmt=db.prepare("SELECT s.id,s.bank_title,s.created_at,s.finished_at,COUNT(*),SUM(a.submitted_at IS NOT NULL),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents=a.max_cents ELSE a.result=1 END),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents IS NOT NULL ELSE a.result IS NOT NULL END),SUM(a.skipped),SUM(a.elapsed_ms),SUM(a.grade_kind='self'),SUM(a.grade_kind='auto'),s.kind,s.submitted_at,SUM(a.max_cents),SUM(a.earned_cents),SUM(a.max_cents IS NOT NULL AND a.earned_cents IS NULL) FROM sessions s JOIN attempts a ON a.session_id=s.id GROUP BY s.id ORDER BY s.created_at DESC").map_err(err)?;
        let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"count":r.get::<_,i64>(4)?,"answered":r.get::<_,i64>(5)?,"correct":r.get::<_,Option<i64>>(6)?.unwrap_or(0),"graded":r.get::<_,i64>(7)?,"skipped":r.get::<_,i64>(8)?,"elapsedMs":r.get::<_,i64>(9)?,"selfGraded":r.get::<_,i64>(10)?,"autoGraded":r.get::<_,i64>(11)?,"kind":r.get::<_,String>(12)?,"submittedAt":r.get::<_,Option<i64>>(13)?,"totalCents":r.get::<_,Option<i64>>(14)?,"earnedCents":r.get::<_,Option<i64>>(15)?,"pendingGrades":r.get::<_,i64>(16)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(json!(rows))
    }
    pub fn save_attempt(
        &self,
        target: (&str, usize),
        answer: Value,
        elapsed: i64,
        submit: bool,
        skip: bool,
        self_result: Option<bool>,
    ) -> Result<Value> {
        self.write_attempt(target, answer, elapsed, submit, skip, self_result)?;
        self.session(target.0)
    }
    pub fn save_draft(&self, target: (&str, usize), answer: Value, elapsed: i64) -> Result<Value> {
        self.write_attempt(target, answer, elapsed, false, false, None)?;
        Ok(Value::Null)
    }
    fn write_attempt(
        &self,
        target: (&str, usize),
        answer: Value,
        elapsed: i64,
        submit: bool,
        skip: bool,
        self_result: Option<bool>,
    ) -> Result<()> {
        let (sid, ordinal) = target;
        self.expire_exam(sid)?;
        let exam = self
            .connect()?
            .query_row(
                "SELECT kind,submitted_at FROM sessions WHERE id=?1",
                [sid],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
            )
            .map_err(err)?;
        if exam.0 != "practice" && (submit || skip || self_result.is_some() || exam.1.is_some()) {
            return Err(crate::language::error(
                "LOCAL_EXAM_LOCKED",
                serde_json::json!({}),
            ));
        }
        if serde_json::to_vec(&answer).map_err(err)?.len() > 256 * 1024 || elapsed < 0 {
            return Err(crate::language::error(
                "LOCAL_ANSWER_INVALID",
                serde_json::json!({}),
            ));
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let (finished, created): (Option<i64>, i64) = tx
            .query_row(
                "SELECT finished_at,created_at FROM sessions WHERE id=?1",
                [sid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(err)?;
        if finished.is_some() {
            return Err(crate::language::error(
                "LOCAL_PRACTICE_FINISHED",
                serde_json::json!({}),
            ));
        }
        if elapsed > now() - created + 60_000 {
            return Err(crate::language::error(
                "LOCAL_ELAPSED_INVALID",
                serde_json::json!({}),
            ));
        }
        let (snapshot,submitted,kind):(String,Option<i64>,String)=tx.query_row("SELECT snapshot_question_id,submitted_at,grade_kind FROM attempts WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(err)?;
        let frozen = crate::questions::session_rows(&tx, sid)?;
        let index = crate::questions::Index::new(&frozen);
        let snapshot = index.snapshot(&snapshot)?;
        let q = &snapshot["question"];
        contract::validate_attempt(q, &answer)?;
        if let Some(parent) = index.by_id.get(text(q, "optionSourceId")) {
            if parent["question"]["allowReuse"] != true {
                let mut statement=tx.prepare("SELECT snapshot_question_id,answer FROM attempts WHERE session_id=?1 AND ordinal!=?2").map_err(err)?;
                let others = statement
                    .query_map(params![sid, ordinal], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })
                    .map_err(err)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(err)?;
                for (other, raw) in others {
                    let row = index
                        .by_id
                        .get(other.as_str())
                        .ok_or("Snapshot question is missing")?;
                    let a: Value = serde_json::from_str(&raw).map_err(err)?;
                    if row["question"]["parentId"] == parent["id"]
                        && list(&answer, "correct").iter().any(|v| {
                            list(&a, "correct").iter().any(|other| {
                                other.as_str().is_some_and(|other| {
                                    v.as_str().is_some_and(|v| other.eq_ignore_ascii_case(v))
                                })
                            })
                        })
                    {
                        return Err(crate::language::error("LOCAL_WORD_REUSED", json!({})));
                    }
                }
            }
        }

        if submitted.is_some() {
            if submit
                && self_result.is_some()
                && (kind != "auto" || text(q, "answerMode") == "fill_blank")
            {
                tx.execute("UPDATE attempts SET result=?3,grade_kind='self' WHERE session_id=?1 AND ordinal=?2 AND skipped=0",params![sid,ordinal,self_result]).map_err(err)?;
            }
        } else {
            let auto = if submit && !skip && snapshot["missingAssets"] != true {
                contract::grade(q, &answer)
            } else {
                None
            };
            let own =
                if submit && !skip && (auto.is_none() || text(q, "answerMode") == "fill_blank") {
                    self_result
                } else {
                    None
                };
            let result = own.or(auto);
            let grade_kind = if own.is_some() {
                "self"
            } else if auto.is_some() {
                "auto"
            } else {
                "ungraded"
            };
            tx.execute("UPDATE attempts SET answer=?3,elapsed_ms=MAX(elapsed_ms,?4),submitted_at=?5,skipped=?6,auto_result=?7,result=?8,grade_kind=?9 WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal,answer.to_string(),elapsed,if submit{Some(now())}else{None},submit&&skip,auto,result,grade_kind]).map_err(err)?;
        }
        tx.execute(
            "UPDATE sessions SET position=?2 WHERE id=?1",
            params![sid, ordinal],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
    pub fn position(&self, sid: &str, position: usize) -> Result<Value> {
        let db = self.connect()?;
        db.execute("UPDATE sessions SET position=?2 WHERE id=?1 AND finished_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE session_id=?1 AND ordinal=?2)",params![sid,position]).map_err(err)?;
        let mut session = self.session(sid)?;
        if position < list(&session, "attempts").len() {
            session["position"] = json!(position);
        }
        Ok(session)
    }
    pub fn finish(&self, sid: &str) -> Result<Value> {
        if self.session(sid)?["kind"] != "practice" {
            return self.submit_paper(sid, true);
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute("UPDATE attempts SET skipped=1,submitted_at=?2 WHERE session_id=?1 AND submitted_at IS NULL",params![sid,now()]).map_err(err)?;
        tx.execute(
            "UPDATE sessions SET finished_at=COALESCE(finished_at,?2) WHERE id=?1",
            params![sid, now()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        self.session(sid)
    }
    pub fn asset(&self, digest: &str) -> Result<Value> {
        if let Some((media, bytes)) = self.pending.as_ref().and_then(|p| p.assets.get(digest)) {
            return Ok(json!(format!(
                "data:{media};base64,{}",
                STANDARD.encode(bytes)
            )));
        }
        let row: Option<(String, u64)> = self
            .connect()?
            .query_row(
                "SELECT media,size FROM assets WHERE hash=?1",
                [digest],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        match row {
            Some((media, size)) => Ok(json!(format!(
                "data:{media};base64,{}",
                STANDARD.encode(self.read_asset(digest, size)?)
            ))),
            None => Ok(Value::Null),
        }
    }
}
fn valid_title(title: &str) -> Result<&str> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 255 {
        Err(crate::language::error(
            "LOCAL_NAME_INVALID",
            serde_json::json!({}),
        ))
    } else {
        Ok(title)
    }
}
pub(crate) fn image_signature(bytes: &[u8], media: &str) -> bool {
    match media {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}
