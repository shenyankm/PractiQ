use crate::contract::{self, list, text, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::seq::SliceRandom;
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
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let f = fs::File::open(path).map_err(err)?;
    if !f.metadata().map_err(err)?.is_file() {
        return Err("请选择普通文件".into());
    }
    let mut bytes = Vec::new();
    f.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err("文件超过大小限制".into());
    }
    Ok(bytes)
}
pub struct Pending {
    pub ticket: String,
    pub root: Value,
    pub raw: Vec<u8>,
    pub title: String,
    pub assets: HashMap<String, (String, Vec<u8>)>,
    pub missing: Vec<String>,
}
pub struct Store {
    pub dir: PathBuf,
    pub pending: Option<Pending>,
}
impl Store {
    pub fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).map_err(err)?;
        let store = Self { dir, pending: None };
        store.connect()?;
        Ok(store)
    }
    pub fn db_path(&self) -> PathBuf {
        self.dir.join("practiq.sqlite")
    }
    pub fn connect(&self) -> Result<Connection> {
        let mut db = Connection::open(self.db_path()).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        db.execute_batch("PRAGMA foreign_keys=ON;").map_err(err)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version > 4 {
            return Err("数据库来自更新版本的 PractiQ，请升级应用".into());
        }
        if version == 0 {
            db.execute_batch(include_str!("schema.sql")).map_err(err)?;
        }
        if version < 2 {
            db.execute_batch(include_str!("settings.sql"))
                .map_err(err)?;
        }
        if version < 3 {
            self.migrate_assets(&mut db)?;
        }
        if version < 4 {
            db.execute_batch(include_str!("models.sql")).map_err(err)?;
        }
        Ok(db)
    }
    pub fn preview(&mut self, bytes: Vec<u8>, title: String) -> Result<Value> {
        let root = contract::parse(&bytes)?;
        let missing = list(contract::result(&root), "visualElements")
            .iter()
            .filter(|v| v["imageRef"].is_object())
            .map(|v| text(&v["imageRef"], "objectKey").to_owned())
            .collect();
        self.pending = Some(Pending {
            ticket: id(),
            root,
            raw: bytes,
            title,
            assets: HashMap::new(),
            missing,
        });
        self.preview_value()
    }
    pub fn preview_value(&self) -> Result<Value> {
        let p = self.pending.as_ref().ok_or("没有待导入文件")?;
        let r = contract::result(&p.root);
        Ok(
            json!({"ticket":p.ticket,"title":p.title,"count":list(r,"questions").len(),"reviewCount":list(r,"questions").iter().filter(|q|q["needsReview"]==true).count(),"warnings":r["warnings"],"status":p.root["status"],"processing":p.root["processing"],"missingAssets":p.missing,"assetCount":p.assets.len()}),
        )
    }
    pub fn resources(&mut self, root: &Path) -> Result<Value> {
        let root = root.canonicalize().map_err(err)?;
        let p = self.pending.as_mut().ok_or("请先选择 JSON")?;
        let mut assets = HashMap::new();
        let mut missing = Vec::new();
        let mut total = 0usize;
        for visual in list(contract::result(&p.root), "visualElements") {
            let r = &visual["imageRef"];
            if !r.is_object() {
                continue;
            }
            let key = text(r, "objectKey");
            if Path::new(key)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
                || key.contains('\\')
            {
                return Err(format!("资源路径不安全: {key}"));
            }
            let path = root.join(key);
            if !path.exists() {
                missing.push(key.to_owned());
                continue;
            }
            let path = path.canonicalize().map_err(err)?;
            if !path.starts_with(&root) {
                return Err(format!("资源路径越界: {key}"));
            }
            let bytes = read_bounded(&path, 20 * 1024 * 1024)?;
            if bytes.len() as u64 != r["sizeBytes"].as_u64().unwrap_or(u64::MAX)
                || hash(&bytes) != text(r, "sha256")
            {
                return Err(format!("资源大小或 SHA-256 不匹配: {key}"));
            }
            let media = text(r, "mediaType");
            if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&media) {
                missing.push(format!("{key}（不支持的图片类型）"));
                continue;
            }
            if !image_signature(&bytes, media) {
                return Err(format!("图片实际格式不匹配: {key}"));
            }
            total += bytes.len();
            if total > 256 * 1024 * 1024 {
                return Err("单次资源总量超过 256 MiB".into());
            }
            assets.insert(text(r, "sha256").to_owned(), (media.to_owned(), bytes));
        }
        p.assets = assets;
        p.missing = missing;
        self.preview_value()
    }
    pub fn import(&mut self, ticket: &str, bank_id: Option<String>, title: &str) -> Result<Value> {
        let p = self
            .pending
            .as_ref()
            .ok_or("导入预览已失效，请重新选择 JSON")?;
        if ticket != p.ticket {
            return Err("导入预览已失效".into());
        }
        let title = valid_title(title)?;
        for (digest, (_, bytes)) in &p.assets {
            self.write_asset(digest, bytes)?;
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
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
            return Err("题库已不存在，请重新选择".into());
        }
        if !exists {
            tx.execute(
                "INSERT INTO banks VALUES(?1,?2,'',?3)",
                params![bank, title, now()],
            )
            .map_err(err)?;
        }
        let digest = hash(&serde_json::to_vec(contract::result(&p.root)).map_err(err)?);
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM imports WHERE bank_id=?1 AND digest=?2)",
                params![bank, digest],
                |r| r.get::<_, bool>(0),
            )
            .map_err(err)?
        {
            return Ok(json!({"duplicate":true,"bankId":bank,"count":0}));
        }
        let import_id = id();
        let r = contract::result(&p.root);
        let ids: Vec<String> = list(r, "questions").iter().map(|_| id()).collect();
        let groups = map_associations(list(r, "groups"), &ids);
        let visuals = map_associations(list(r, "visualElements"), &ids);
        tx.execute(
            "INSERT INTO imports VALUES(?1,?2,?3,?4,?5)",
            params![
                import_id,
                bank,
                digest,
                String::from_utf8_lossy(&p.raw),
                now()
            ],
        )
        .map_err(err)?;
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
        for (i, q) in list(r, "questions").iter().enumerate() {
            let groups: Vec<_> = groups
                .iter()
                .filter(|g| list(g, "questionIds").contains(&json!(ids[i])))
                .cloned()
                .collect();
            let visuals: Vec<_> = visuals
                .iter()
                .filter(|v| {
                    list(v, "questionIds").is_empty()
                        || list(v, "questionIds").contains(&json!(ids[i]))
                })
                .cloned()
                .collect();
            let sources: Vec<_> = list(&p.root["processing"], "questionSources")
                .iter()
                .filter(|s| s["questionIndex"] == i)
                .cloned()
                .collect();
            let missing = visuals.iter().any(|v| {
                v["imageRef"].is_object()
                    && !p.assets.contains_key(text(&v["imageRef"], "sha256"))
                    && !tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM assets WHERE hash=?1)",
                            [text(&v["imageRef"], "sha256")],
                            |r| r.get::<_, bool>(0),
                        )
                        .unwrap_or(false)
            });
            let snapshot = json!({"question":q,"groups":groups,"visuals":visuals,"sources":sources,"warnings":r["warnings"],"missingAssets":missing});
            tx.execute(
                "INSERT INTO questions VALUES(?1,?2,?3,?4,?5,?6,?7,0)",
                params![
                    ids[i],
                    bank,
                    import_id,
                    offset + i as i64,
                    text(q, "stem"),
                    text(q, "answerMode"),
                    snapshot.to_string()
                ],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        let count = ids.len();
        self.pending = None;
        Ok(json!({"duplicate":false,"bankId":bank,"count":count}))
    }
    pub fn banks(&self) -> Result<Value> {
        let db = self.connect()?;
        let mut s=db.prepare("SELECT b.id,b.title,b.description,b.created_at,COUNT(q.id) FROM banks b LEFT JOIN questions q ON q.bank_id=b.id GROUP BY b.id ORDER BY b.created_at DESC").map_err(err)?;
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
            return Err("说明过长".into());
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
    // ponytail: load matching snapshots together; add SQL pagination when large libraries make this slow.
    pub fn questions(
        &self,
        bank_id: Option<&str>,
        search: &str,
        mode: &str,
        filter: &str,
    ) -> Result<Value> {
        let db = self.connect()?;
        let mut stmt=db.prepare("SELECT q.id,q.bank_id,q.snapshot,q.favorite,b.title,(SELECT a.result FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.question_id=q.id AND a.result IS NOT NULL ORDER BY a.submitted_at DESC,a.rowid DESC LIMIT 1) AS latest_result FROM questions q JOIN banks b ON b.id=q.bank_id WHERE (?1 IS NULL OR q.bank_id=?1) AND (?2='' OR instr(lower(q.stem),lower(?2))>0 OR instr(lower(q.snapshot),lower(?2))>0) AND (?3='' OR q.mode=?3) AND (?4!='favorite' OR q.favorite=1) AND (?4!='wrong' OR latest_result=0) ORDER BY b.created_at DESC,q.position").map_err(err)?;
        let rows = stmt
            .query_map(params![bank_id, search, mode, filter], |r| {
                let mut v: Value =
                    serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Value::Null);
                v["id"] = json!(r.get::<_, String>(0)?);
                v["bankId"] = json!(r.get::<_, String>(1)?);
                v["favorite"] = json!(r.get::<_, bool>(3)?);
                v["bankTitle"] = json!(r.get::<_, String>(4)?);
                v["latestResult"] = json!(r.get::<_, Option<bool>>(5)?);
                Ok(v)
            })
            .map_err(err)?;
        Ok(json!(rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?))
    }
    pub fn save_question(
        &self,
        question_id: Option<String>,
        bank: &str,
        mut question: Value,
    ) -> Result<Value> {
        contract::validate_question(&mut question)?;
        let db = self.connect()?;
        let editing = question_id.is_some();
        let qid = question_id.unwrap_or_else(id);
        let old: Option<String> = db
            .query_row(
                "SELECT snapshot FROM questions WHERE id=?1 AND bank_id=?2",
                params![qid, bank],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if editing && old.is_none() {
            return Err("题目已不存在或不属于所选题库".into());
        }
        let mut snapshot: Value = old
            .map(|s| serde_json::from_str(&s).map_err(err))
            .transpose()?
            .unwrap_or(
                json!({"groups":[],"visuals":[],"sources":[],"warnings":[],"missingAssets":false}),
            );
        snapshot["question"] = question.clone();
        db.execute("INSERT INTO questions(id,bank_id,position,stem,mode,snapshot,favorite) VALUES(?1,?2,(SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE bank_id=?2),?3,?4,?5,0) ON CONFLICT(id) DO UPDATE SET stem=excluded.stem,mode=excluded.mode,snapshot=excluded.snapshot",params![qid,bank,text(&question,"stem"),text(&question,"answerMode"),snapshot.to_string()]).map_err(err)?;
        Ok(json!(qid))
    }
    pub fn delete_question(&self, qid: &str) -> Result<Value> {
        self.connect()?
            .execute("DELETE FROM questions WHERE id=?1", [qid])
            .map_err(err)?;
        Ok(Value::Null)
    }
    pub fn favorite(&self, qid: &str, value: bool) -> Result<Value> {
        self.connect()?
            .execute(
                "UPDATE questions SET favorite=?2 WHERE id=?1",
                params![qid, value],
            )
            .map_err(err)?;
        Ok(json!(value))
    }
    pub fn start(
        &self,
        bank: Option<&str>,
        search: &str,
        mode: &str,
        filter: &str,
        random: bool,
        count: usize,
    ) -> Result<Value> {
        if count == 0 || count > 1000 {
            return Err("练习题数须为 1–1000".into());
        }
        let mut questions = self
            .questions(bank, search, mode, filter)?
            .as_array()
            .cloned()
            .unwrap_or_default();
        if questions.is_empty() {
            return Err("当前筛选下没有可练习题目".into());
        }
        if random {
            questions.shuffle(&mut rand::rng());
        }
        questions.truncate(count);
        let sid = id();
        let title = if bank.is_some() {
            text(&questions[0], "bankTitle")
        } else if filter == "wrong" {
            "错题练习"
        } else if filter == "favorite" {
            "收藏练习"
        } else {
            "跨题库练习"
        };
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute(
            "INSERT INTO sessions VALUES(?1,?2,?3,?4,NULL,0,?5)",
            params![
                sid,
                bank,
                title,
                now(),
                if random { "random" } else { "ordered" }
            ],
        )
        .map_err(err)?;
        for (i, snapshot) in questions.iter().enumerate() {
            tx.execute(
                "INSERT INTO attempts(session_id,ordinal,question_id,snapshot) VALUES(?1,?2,?3,?4)",
                params![sid, i as i64, text(snapshot, "id"), snapshot.to_string()],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.session(&sid)
    }
    pub fn session(&self, sid: &str) -> Result<Value> {
        let db = self.connect()?;
        let mut session=db.query_row("SELECT id,bank_title,created_at,finished_at,position,mode FROM sessions WHERE id=?1",[sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"position":r.get::<_,i64>(4)?,"mode":r.get::<_,String>(5)?}))).map_err(err)?;
        let mut stmt=db.prepare("SELECT ordinal,snapshot,answer,auto_result,result,grade_kind,submitted_at,skipped,elapsed_ms FROM attempts WHERE session_id=?1 ORDER BY ordinal").map_err(err)?;
        let attempts=stmt.query_map([sid],|r|Ok(json!({"ordinal":r.get::<_,i64>(0)?,"snapshot":serde_json::from_str::<Value>(&r.get::<_,String>(1)?).unwrap_or(Value::Null),"answer":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"autoResult":r.get::<_,Option<bool>>(3)?,"result":r.get::<_,Option<bool>>(4)?,"gradeKind":r.get::<_,String>(5)?,"submittedAt":r.get::<_,Option<i64>>(6)?,"skipped":r.get::<_,bool>(7)?,"elapsedMs":r.get::<_,i64>(8)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        session["attempts"] = json!(attempts);
        Ok(session)
    }
    pub fn sessions(&self) -> Result<Value> {
        let db = self.connect()?;
        let mut stmt=db.prepare("SELECT s.id,s.bank_title,s.created_at,s.finished_at,COUNT(*),SUM(a.submitted_at IS NOT NULL),SUM(a.result=1),SUM(a.result IS NOT NULL),SUM(a.skipped),SUM(a.elapsed_ms),SUM(a.grade_kind='self'),SUM(a.grade_kind='auto') FROM sessions s JOIN attempts a ON a.session_id=s.id GROUP BY s.id ORDER BY s.created_at DESC").map_err(err)?;
        let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"count":r.get::<_,i64>(4)?,"answered":r.get::<_,i64>(5)?,"correct":r.get::<_,Option<i64>>(6)?.unwrap_or(0),"graded":r.get::<_,i64>(7)?,"skipped":r.get::<_,i64>(8)?,"elapsedMs":r.get::<_,i64>(9)?,"selfGraded":r.get::<_,i64>(10)?,"autoGraded":r.get::<_,i64>(11)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
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
        let (sid, ordinal) = target;
        if serde_json::to_vec(&answer).map_err(err)?.len() > 256 * 1024 || elapsed < 0 {
            return Err("作答数据不合法".into());
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
            return Err("练习已结束，不能修改作答".into());
        }
        if elapsed > now() - created + 60_000 {
            return Err("作答用时不合法".into());
        }
        let (snapshot,submitted,kind):(String,Option<i64>,String)=tx.query_row("SELECT snapshot,submitted_at,grade_kind FROM attempts WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(err)?;
        let snapshot: Value = serde_json::from_str(&snapshot).map_err(err)?;
        let q = &snapshot["question"];
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
        self.session(sid)
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
        Err("名称须为 1–255 个字符".into())
    } else {
        Ok(title)
    }
}
fn map_associations(values: &[Value], ids: &[String]) -> Vec<Value> {
    values
        .iter()
        .map(|v| {
            let mut v = v.clone();
            v["id"] = json!(id());
            v["questionIds"] = json!(list(&v, "questionIndexes")
                .iter()
                .filter_map(|i| i.as_u64().and_then(|i| ids.get(i as usize)))
                .collect::<Vec<_>>());
            v
        })
        .collect()
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
