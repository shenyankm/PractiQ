use crate::contract::{self, list, text, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageDecoder;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
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
    pub description: String,
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
        let missing = contract::resource_refs(contract::result(&root))
            .map(|r| text(r, "objectKey").to_owned())
            .collect();
        Ok(Self {
            ticket: id(),
            root,
            title,
            description: String::new(),
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
    pub staged_audio: HashMap<String, (String, Vec<u8>)>,
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
            "stem" | "instructions" | "transcript" | "sourceText" | "analysis"
            | "scoringRubric" | "scoreSourceText" | "options" | "items" | "content" | "label"
            | "passage" | "contentBlocks" | "textValue" | "markdownValue" | "latexValue"
            | "title" | "description" | "extractedText" => {
                searchable_content_matches(value, search)
            }
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
            staged_audio: HashMap::new(),
            locale: crate::language::Locale::default(),
        };
        store.connect()?;
        store.collect_unused_assets()?;
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
        } else if version != 10 {
            return Err("Only database schema 10 is supported; legacy data remains in its original directory".into());
        } else {
            if !db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('visuals') WHERE name='document_level')",
                    [],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
            {
                db.execute_batch("ALTER TABLE visuals ADD COLUMN document_level INTEGER NOT NULL DEFAULT 0 CHECK(document_level IN(0,1));")
                    .map_err(err)?;
            }
            if !db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('listening_playback') WHERE name='active_elapsed_ms')",
                    [],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(err)?
            {
                // Earlier rows tracked the last update, so restart unfinished plays with their allowance intact.
                db.execute_batch("BEGIN IMMEDIATE; ALTER TABLE listening_playback ADD COLUMN active_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_elapsed_ms>=0); UPDATE listening_playback SET used=MAX(used-1,0),position=0,active=0,updated_at=0 WHERE active=1; COMMIT;")
                    .map_err(err)?;
            }
        }
        Ok(db)
    }
    #[cfg(test)]
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
    #[cfg(test)]
    pub fn resources(&mut self, root: &Path) -> Result<Value> {
        let root = root.canonicalize().map_err(err)?;
        let p = self.pending.as_mut().ok_or(crate::language::error(
            "LOCAL_JSON_REQUIRED",
            serde_json::json!({}),
        ))?;
        let mut assets = HashMap::new();
        let mut missing = Vec::new();
        let mut total = 0usize;
        for r in contract::resource_refs(contract::result(&p.root)) {
            if assets.contains_key(text(r, "sha256")) {
                continue;
            }
            let key = text(r, "objectKey");
            if Path::new(key)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
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
            if ![
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "audio/mpeg",
                "audio/mp4",
                "audio/aac",
                "audio/wav",
            ]
            .contains(&media)
            {
                missing.push(format!(
                    "{key} ({})",
                    self.locale
                        .text("不支持的图片类型", "unsupported image type")
                ));
                continue;
            }
            if !crate::audio::valid_media(&bytes, media) {
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
        let result = self.import_pending_inner(p, bank_id, title);
        if result.is_err() {
            let _ = self.collect_unused_assets();
        }
        result
    }
    fn import_pending_inner(
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
        for (digest, (media, bytes)) in &p.assets {
            tx.execute(
                "INSERT OR IGNORE INTO assets VALUES(?1,?2,?3,?4)",
                params![digest, media, bytes.len(), format!("assets/{digest}")],
            )
            .map_err(err)?;
        }
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
                "INSERT INTO banks VALUES(?1,?2,?3,?4)",
                params![bank, title, p.description, now()],
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
            }
            tx.commit().map_err(err)?;
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
        // Early schema 9 databases still have an unused, required raw column.
        let has_raw = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('imports') WHERE name='raw')",
                [],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?;
        tx.execute(
            if has_raw {
                "INSERT INTO imports(id,bank_id,digest,raw,created_at) VALUES(?1,?2,?3,'',?4)"
            } else {
                "INSERT INTO imports(id,bank_id,digest,created_at) VALUES(?1,?2,?3,?4)"
            },
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
        let mut stmt = db.prepare("SELECT b.id,b.title,COUNT(q.id) FROM banks b LEFT JOIN questions q ON q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN ('reading','word_bank','cloze','listening','gap_fill')) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"count":r.get::<_,i64>(2)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(json!(rows))
    }
    pub fn banks_page(&self, limit: usize, offset: usize) -> Result<Value> {
        validate_page(limit, offset)?;
        let db = self.connect()?;
        let total: usize = db
            .query_row("SELECT COUNT(*) FROM banks", [], |r| r.get(0))
            .map_err(err)?;
        let offset = offset.min(total.saturating_sub(1) / limit * limit);
        let mut stmt = db.prepare("WITH page AS (SELECT * FROM banks ORDER BY created_at DESC,id DESC LIMIT ?1 OFFSET ?2) SELECT b.id,b.title,b.description,b.created_at,COUNT(q.id) FROM page b LEFT JOIN questions q ON q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN ('reading','word_bank','cloze','listening','gap_fill')) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC").map_err(err)?;
        let items = stmt.query_map(params![limit,offset], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"description":r.get::<_,String>(2)?,"createdAt":r.get::<_,i64>(3)?,"count":r.get::<_,i64>(4)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(json!({"items":items,"total":total,"offset":offset}))
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
        if let Err(error) = self.collect_unused_assets() {
            eprintln!("Asset cleanup deferred after bank deletion: {error}");
        }
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
        self.query_question_data(bank, banks, query, page, false)
    }
    pub fn question_stats(
        &self,
        bank: Option<&str>,
        banks: &[String],
        query: (&str, &str, &str),
    ) -> Result<Value> {
        self.query_question_data(bank, banks, query, None, true)
    }
    fn query_question_data(
        &self,
        bank: Option<&str>,
        banks: &[String],
        query: (&str, &str, &str),
        page: Option<(usize, usize)>,
        stats_only: bool,
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
                "listening",
                "gap_fill",
                "grammar_fill",
                "translation",
                "writing",
                "sentence_selection",
                "paragraph_matching",
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
            return Ok(if stats_only {
                json!({"count":0,"types":{}})
            } else if page.is_some() {
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
                            || crate::paper::category(q) == mode
                            || (mode == "choice" && text(q, "answerMode") == "choice")
                            || (text(q, "answerMode") == "choice"
                                && text(q, "choiceVariant") == mode))
                })
                .map(|r| text(r, "id").to_owned())
                .collect();
        }
        let total = ids.len();
        if stats_only {
            let mut statement = db.prepare("
                WITH RECURSIVE tree(root,id) AS (
                    SELECT value,value FROM json_each(?1)
                    UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
                ) SELECT COALESCE(CASE WHEN r.question_kind IS NOT NULL THEN r.question_kind WHEN r.mode='gap_fill' THEN 'grammar_fill' WHEN r.mode='choice' THEN c.variant ELSE r.mode END,''),
                    COUNT(DISTINCT r.id), SUM(n.mode IS NULL OR n.mode NOT IN ('reading','word_bank','cloze','listening','gap_fill'))
                FROM tree t JOIN questions r ON r.id=t.root JOIN questions n ON n.id=t.id
                LEFT JOIN choice_questions c ON c.question_id=r.id GROUP BY 1
            ").map_err(err)?;
            let mut types = serde_json::Map::new();
            let mut count = 0;
            for row in statement
                .query_map([json!(ids).to_string()], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(err)?
            {
                let (mode, roots, answerable) = row.map_err(err)?;
                types.insert(mode, json!(roots));
                count += answerable;
            }
            return Ok(json!({"count":count,"types":types}));
        }
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
        drop(db);
        if let Err(error) = self.collect_unused_assets() {
            eprintln!("Asset cleanup deferred after question deletion: {error}");
        }
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
    pub fn asset(&self, digest: &str) -> Result<Value> {
        Ok(match self.asset_bytes(digest)? {
            Some((media, bytes)) => {
                json!(format!("data:{media};base64,{}", STANDARD.encode(bytes)))
            }
            None => Value::Null,
        })
    }
    pub fn asset_bytes(&self, digest: &str) -> Result<Option<(String, Vec<u8>)>> {
        if let Some(asset) = self.staged_audio.get(digest) {
            return Ok(Some(asset.clone()));
        }
        if let Some((media, bytes)) = self.pending.as_ref().and_then(|p| p.assets.get(digest)) {
            return Ok(Some((media.clone(), bytes.clone())));
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
        row.map(|(media, size)| Ok((media, self.read_asset(digest, size)?)))
            .transpose()
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
pub(crate) fn valid_image(bytes: &[u8], media: &str) -> bool {
    let format = match media {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/gif" => image::ImageFormat::Gif,
        "image/webp" => image::ImageFormat::WebP,
        _ => return false,
    };
    if image::guess_format(bytes).ok() != Some(format) {
        return false;
    }
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let Ok(decoder) = reader.into_decoder() else {
        return false;
    };
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 16_384
        || height > 16_384
        || u64::from(width) * u64::from(height) > 32_000_000
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return false;
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().is_ok()
}

pub(crate) fn validate_page(limit: usize, offset: usize) -> Result<()> {
    if !(1..=100).contains(&limit) || offset > i64::MAX as usize {
        return Err(crate::language::error("LOCAL_FILTER_INVALID", json!({})));
    }
    Ok(())
}
