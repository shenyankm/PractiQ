use crate::{
    contract::{self, list, text, Result},
    store::{id, now, Store},
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Paper {
    pub question_ids: Vec<String>,
    pub kind: String,
    pub minutes: Option<i64>,
    pub scores: Vec<i64>,
    pub total_cents: i64,
}

pub fn has_answer(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => a.iter().any(has_answer),
        Value::Object(o) => o.values().any(has_answer),
        _ => true,
    }
}
pub fn has_basis(q: &Value) -> bool {
    !text(q, "scoringRubric").trim().is_empty() || contract::answer_complete(q)
}
pub fn usable(s: &Value) -> bool {
    s["missingAssets"] != true
        && !text(&s["question"], "stem").is_empty()
        && !list(&s["question"], "missingFields").iter().any(|v| {
            matches!(
                v.as_str(),
                Some(
                    "stem"
                        | "material"
                        | "media"
                        | "options"
                        | "items"
                        | "choiceVariant"
                        | "matchingVariant"
                        | "answerMode"
                )
            )
        })
}

impl Store {
    pub fn questions_multi(
        &self,
        bank: Option<&str>,
        banks: &[String],
        search: &str,
        mode: &str,
        filter: &str,
    ) -> Result<Value> {
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
            ]
            .contains(&mode)
            || !["", "wrong", "favorite", "unattempted"].contains(&filter)
        {
            return Err("筛选条件不合法".into());
        }
        let rows = self.questions(bank, search, mode, filter)?;
        Ok(json!(list_value(&rows)
            .iter()
            .filter(|q| banks.is_empty() || banks.iter().any(|b| b == text(q, "bankId")))
            .collect::<Vec<_>>()))
    }
    pub fn start_paper(&self, paper: Paper) -> Result<Value> {
        let n = paper.question_ids.len();
        if n == 0 || n > 1000 || paper.question_ids.iter().collect::<HashSet<_>>().len() != n {
            return Err("请选择 1–1000 道不重复的题目".into());
        }
        let exam = paper.kind != "practice";
        if !["practice", "self_test", "mock_exam"].contains(&paper.kind.as_str())
            || (paper.kind == "mock_exam"
                && !paper.minutes.is_some_and(|m| (1..=1440).contains(&m)))
            || (paper.kind != "mock_exam" && paper.minutes.is_some())
        {
            return Err("考试模式或时长不合法".into());
        }
        if exam
            && (paper.scores.len() != n
                || paper.scores.iter().any(|s| *s < 1 || *s > 100_000_000)
                || paper.total_cents < 1
                || paper.total_cents > 100_000_000
                || paper.scores.iter().sum::<i64>() != paper.total_cents)
        {
            return Err("每题至少 0.01 分，分值之和必须等于总分（不超过 100 万分）".into());
        }
        let rows = self.questions(None, "", "", "")?;
        let map: HashMap<_, _> = list_value(&rows)
            .iter()
            .map(|q| (text(q, "id"), q))
            .collect();
        let sid = id();
        let created = now();
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind,deadline_at) VALUES(?1,?2,?3,0,'ordered',?4,?5)",params![sid,if exam {"自测 / 模考"} else {"跨题库练习"},created,paper.kind,paper.minutes.map(|m|created+m*60_000)]).map_err(err)?;
        for (i, qid) in paper.question_ids.iter().enumerate() {
            let q = map.get(qid.as_str()).ok_or("所选题目已删除，请重新选题")?;
            tx.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot,max_cents) VALUES(?1,?2,?3,?4,?5)",params![sid,i as i64,qid,q.to_string(),if exam {Some(paper.scores[i])} else {None}]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.session(&sid)
    }
    pub fn expire_exam(&self, sid: &str) -> Result<()> {
        let db = self.connect()?;
        let expired:bool=db.query_row("SELECT deadline_at IS NOT NULL AND deadline_at<=?2 AND submitted_at IS NULL FROM sessions WHERE id=?1",params![sid,now()],|r|r.get(0)).map_err(err)?;
        if expired {
            self.submit_core(sid, true)?;
        }
        Ok(())
    }
    fn submit_core(&self, sid: &str, submit_drafts: bool) -> Result<()> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let (_kind, submitted, finished): (String, Option<i64>, Option<i64>) = tx
            .query_row(
                "SELECT kind,submitted_at,finished_at FROM sessions WHERE id=?1",
                [sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(err)?;
        if submitted.is_some() || finished.is_some() {
            return Ok(());
        }
        let mut stmt=tx.prepare("SELECT ordinal,snapshot,answer,max_cents FROM attempts WHERE session_id=?1 AND submitted_at IS NULL").map_err(err)?;
        let rows = stmt
            .query_map([sid], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(stmt);
        for (ordinal, snapshot, answer, max) in rows {
            let snapshot: Value = serde_json::from_str(&snapshot).map_err(err)?;
            let answer: Value = serde_json::from_str(&answer).map_err(err)?;
            let q = &snapshot["question"];
            let skipped = !submit_drafts || !has_answer(&answer);
            let auto = if !skipped && usable(&snapshot) {
                contract::grade(q, &answer)
            } else {
                None
            };
            let earned = if max.is_some() && usable(&snapshot) && has_basis(q) {
                if skipped {
                    Some(0)
                } else {
                    auto.map(|v| if v { max.unwrap_or(0) } else { 0 })
                }
            } else {
                None
            };
            tx.execute("UPDATE attempts SET submitted_at=?3,skipped=?4,auto_result=?5,result=?8,grade_kind=?6,earned_cents=?7 WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal,now(),skipped,auto,if auto.is_some() || earned.is_some(){"auto"}else{"ungraded"},earned,if max.is_some(){earned.map(|v|Some(v)==max)}else{auto}]).map_err(err)?;
        }
        tx.execute("UPDATE sessions SET submitted_at=?2,finished_at=CASE WHEN kind='practice' THEN ?2 ELSE finished_at END WHERE id=?1",params![sid,now()]).map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
    pub fn submit_paper(&self, sid: &str, submit_drafts: bool) -> Result<Value> {
        self.submit_core(sid, submit_drafts)?;
        self.session(sid)
    }
    pub fn complete_review(&self, sid: &str) -> Result<Value> {
        self.connect()?.execute("UPDATE sessions SET finished_at=COALESCE(finished_at,?2) WHERE id=?1 AND submitted_at IS NOT NULL",params![sid,now()]).map_err(err)?;
        self.session(sid)
    }
    pub fn flag(&self, sid: &str, ordinal: usize, value: bool) -> Result<Value> {
        self.expire_exam(sid)?;
        self.connect()?.execute("UPDATE attempts SET flagged=?3 WHERE session_id=?1 AND ordinal=?2 AND EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND submitted_at IS NULL AND finished_at IS NULL)",params![sid,ordinal,value]).map_err(err)?;
        self.session(sid)
    }
    pub fn manual_score(
        &self,
        sid: &str,
        ordinal: usize,
        cents: i64,
        reason: &str,
    ) -> Result<Value> {
        if reason.trim().is_empty() || reason.len() > 20_000 {
            return Err("请填写改分原因（最多 20000 字节）".into());
        }
        let db = self.connect()?;
        let changed=db.execute("UPDATE attempts SET earned_cents=?3,result=(?3=max_cents),grade_kind='manual',grading=json_set(grading,'$.manual',json(?4),'$.manualHistory',json_insert(COALESCE(json_extract(grading,'$.manualHistory'),'[]'),'$[#]',json(?4))) WHERE session_id=?1 AND ordinal=?2 AND max_cents>=?3 AND ?3>=0 AND EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND submitted_at IS NOT NULL)",params![sid,ordinal,cents,json!({"scoreCents":cents,"reason":reason,"at":now()}).to_string()]).map_err(err)?;
        if changed != 1 {
            return Err("请先交卷，且分数须在 0 至本题满分之间".into());
        }
        self.session(sid)
    }
    pub fn enrich_session(&self, db: &Connection, s: &mut Value) -> Result<()> {
        let sid = text(s, "id").to_owned();
        let (kind, deadline, submitted): (String, Option<i64>, Option<i64>) = db
            .query_row(
                "SELECT kind,deadline_at,submitted_at FROM sessions WHERE id=?1",
                [&sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(err)?;
        s["kind"] = json!(kind);
        s["deadlineAt"] = json!(deadline);
        s["submittedAt"] = json!(submitted);
        for a in s["attempts"].as_array_mut().ok_or("练习记录损坏")? {
            let (max,earned,flagged,grading):(Option<i64>,Option<i64>,bool,String)=db.query_row("SELECT max_cents,earned_cents,flagged,grading FROM attempts WHERE session_id=?1 AND ordinal=?2",params![sid,a["ordinal"].as_i64()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(err)?;
            let favorite: Option<bool> = db.query_row(
                "SELECT q.favorite FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 AND a.ordinal=?2",
                params![sid, a["ordinal"].as_i64()], |r| r.get(0),
            ).map_err(err)?;
            a["favorite"] = json!(favorite);
            a["maxCents"] = json!(max);
            a["earnedCents"] = json!(earned);
            a["flagged"] = json!(flagged);
            a["grading"] = serde_json::from_str(&grading).map_err(err)?;
            if kind != "practice" && submitted.is_none() {
                let q = &mut a["snapshot"]["question"];
                a_blank_count(q);
                if let Some(visuals) = a["snapshot"]["visuals"].as_array_mut() {
                    visuals.retain(|visual| !answer_content(visual));
                    for visual in visuals {
                        visual
                            .as_object_mut()
                            .ok_or("图片格式无效")?
                            .remove("sourceRef");
                    }
                }
                a["result"] = Value::Null;
                a["autoResult"] = Value::Null;
            }
        }
        Ok(())
    }
    pub fn retry_wrong(&self, sid: &str) -> Result<Value> {
        let s = self.session(sid)?;
        let sid2 = id();
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let wrong: Vec<_> = list(&s, "attempts")
            .iter()
            .filter(|a| {
                a["result"] == false
                    || (a["earnedCents"]
                        .as_i64()
                        .zip(a["maxCents"].as_i64())
                        .is_some_and(|(e, m)| e < m))
            })
            .collect();
        if wrong.is_empty() {
            return Err("本次没有已判定错题".into());
        }
        tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES(?1,'本次错题重练',?2,0,'ordered')",params![sid2,now()]).map_err(err)?;
        for (i, a) in wrong.iter().enumerate() {
            tx.execute(
                "INSERT INTO attempts(session_id,ordinal,question_id,snapshot) VALUES(?1,?2,?3,?4)",
                params![
                    sid2,
                    i as i64,
                    a["snapshot"]["id"].as_str(),
                    a["snapshot"].to_string()
                ],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.session(&sid2)
    }
    pub fn merge_banks(&self, banks: &[String], title: &str) -> Result<Value> {
        if banks.len() < 2
            || banks.len() > 1000
            || banks.iter().collect::<HashSet<_>>().len() != banks.len()
            || title.trim().is_empty()
            || title.chars().count() > 200
        {
            return Err("请选择至少两个不同题库，并填写 1–200 字名称".into());
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        for b in banks {
            if !tx
                .query_row("SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)", [b], |r| {
                    r.get::<_, bool>(0)
                })
                .map_err(err)?
            {
                return Err("来源题库已删除".into());
            }
        }
        let mut stmt=tx.prepare("SELECT q.id,q.bank_id,b.title,q.snapshot,q.favorite FROM questions q JOIN banks b ON b.id=q.bank_id ORDER BY b.created_at,b.id,q.position,q.id").map_err(err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(stmt);
        let rows: Vec<_> = rows.into_iter().filter(|r| banks.contains(&r.1)).collect();
        let ids: HashMap<_, _> = rows.iter().map(|r| (r.0.clone(), id())).collect();
        let bank = id();
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,'合并副本',?3)",
            params![bank, title.trim(), now()],
        )
        .map_err(err)?;
        for (i, (old, origin, name, raw, favorite)) in rows.iter().enumerate() {
            let mut s: Value = serde_json::from_str(raw).map_err(err)?;
            for key in ["groups", "visuals"] {
                if let Some(values) = s[key].as_array_mut() {
                    for v in values {
                        v["questionIds"] = json!(list(v, "questionIds")
                            .iter()
                            .filter_map(|qid| ids.get(qid.as_str()?))
                            .collect::<Vec<_>>());
                    }
                }
            }
            s["origin"] = json!({"bankId":origin,"bankTitle":name,"questionId":old});
            tx.execute("INSERT INTO questions(id,bank_id,position,stem,mode,snapshot,favorite) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![ids[old],bank,i as i64,text(&s["question"],"stem"),text(&s["question"],"answerMode"),s.to_string(),favorite]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(json!({"bankId":bank,"count":rows.len()}))
    }
}
fn list_value(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn a_blank_count(q: &mut Value) {
    q["blankCount"] = json!(list(&q["answerPayload"], "answers").len().max(1));
    for k in [
        "answerPayload",
        "analysis",
        "sourceText",
        "scoringRubric",
        "scoreSourceText",
    ] {
        q[k] = Value::Null;
    }
    if let Some(options) = q["options"].as_array_mut() {
        for o in options {
            o["isCorrect"] = Value::Null;
        }
    }
    if let Some(blocks) = q["contentBlocks"].as_array_mut() {
        blocks.retain(|block| !answer_content(block));
    }
}

fn answer_content(content: &Value) -> bool {
    let role = text(content, "role").to_lowercase();
    [
        "answer",
        "analysis",
        "solution",
        "explanation",
        "rubric",
        "答案",
        "解析",
        "解答",
        "评分",
    ]
    .iter()
    .any(|word| role.contains(word))
}

impl Store {
    pub fn prepare_grade(&self, sid: &str, ordinal: usize, retry: bool) -> Result<Value> {
        let db = self.connect()?;
        let (snapshot,answer,max,submitted,kind,grade_kind):(String,String,Option<i64>,Option<i64>,String,String)=db.query_row("SELECT a.snapshot,a.answer,a.max_cents,s.submitted_at,s.kind,a.grade_kind FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=?1 AND a.ordinal=?2",params![sid,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(err)?;
        let snapshot: Value = serde_json::from_str(&snapshot).map_err(err)?;
        let answer: Value = serde_json::from_str(&answer).map_err(err)?;
        let q = &snapshot["question"];
        if submitted.is_none()
            || kind == "practice"
            || grade_kind == "manual"
            || text(q, "answerMode") != "short_answer"
            || !has_basis(q)
            || !usable(&snapshot)
            || text(&answer, "text").trim().is_empty()
        {
            return Err("请先交卷；仅对有完整依据和作答、未经人工确认的简答题评分".into());
        }
        let mut images = Vec::new();
        let mut seen = HashSet::new();
        for v in list(&snapshot, "visuals") {
            if let Some(digest) = v["imageRef"]["sha256"].as_str() {
                if seen.insert(digest) {
                    let data = self.asset(digest)?;
                    if data.is_null() {
                        return Err("图片缺失，无法评分".into());
                    }
                    images.push(json!({"sha256":digest,"data":data}));
                }
            }
        }
        let mut materials: Vec<String> = list(&snapshot, "groups")
            .iter()
            .map(|g| format!("{}\n{}", text(g, "title"), text(g, "instructions")))
            .collect();
        materials.extend(
            list(&snapshot, "visuals")
                .iter()
                .map(|v| format!("{}\n{}", text(v, "description"), text(v, "extractedText"))),
        );
        let payload = json!({"question":q,"answer":text(&answer,"text"),"maxCents":max,"materials":materials,"images":images});
        let raw = payload.to_string();
        if raw.len() > 31 * 1024 * 1024 {
            return Err("评分题目资源超过 31 MiB，请人工评分".into());
        }
        let mut payload = json!({"inputDigest":crate::store::hash(raw.as_bytes()),"payload":raw});
        if !retry {
            let mut stmt=db.prepare("SELECT input FROM grade_requests WHERE session_id=?1 AND ordinal=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1").map_err(err)?;
            let mut rows = stmt.query(params![sid, ordinal]).map_err(err)?;
            if let Some(row) = rows.next().map_err(err)? {
                let previous: Value =
                    serde_json::from_str(&row.get::<_, String>(0).map_err(err)?).map_err(err)?;
                if previous["inputDigest"] != payload["inputDigest"] {
                    return Err("评分输入已变化，请明确重新评分".into());
                }
                payload["requestId"] = previous["requestId"].clone();
                return Ok(payload);
            }
        }
        let rid = id();
        payload["requestId"] = json!(rid);
        db.execute(
            "INSERT INTO grade_requests VALUES(?1,?2,?3,?4,NULL,?5)",
            params![
                rid,
                sid,
                ordinal,
                json!({"requestId":rid,"inputDigest":payload["inputDigest"]}).to_string(),
                now()
            ],
        )
        .map_err(err)?;
        Ok(payload)
    }
    pub fn record_grade(
        &self,
        sid: &str,
        ordinal: usize,
        rid: &str,
        response: &Value,
    ) -> Result<Value> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let max: i64 = tx
            .query_row(
                "SELECT max_cents FROM attempts WHERE session_id=?1 AND ordinal=?2",
                params![sid, ordinal],
                |r| r.get(0),
            )
            .map_err(err)?;
        let score = if response["status"] == "graded" {
            Some(
                response["result"]["scoreCents"]
                    .as_i64()
                    .filter(|s| *s >= 0 && *s <= max)
                    .ok_or("AI 分数不合法")?,
            )
        } else {
            None
        };
        if score.is_some() && response["result"]["maxCents"] != max {
            return Err("AI 满分不匹配".into());
        }
        let updated=tx.execute("UPDATE grade_requests SET response=?4 WHERE id=?1 AND session_id=?2 AND ordinal=?3",params![rid,sid,ordinal,response.to_string()]).map_err(err)?;
        if updated != 1 {
            return Err("评分请求不存在".into());
        }
        tx.execute("UPDATE attempts SET grading=json_set(grading,CASE WHEN ?4 IS NULL THEN '$.lastRequest' ELSE '$.ai' END,json(?3)),earned_cents=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN earned_cents ELSE ?4 END,result=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN result ELSE (?4=max_cents) END,grade_kind=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN grade_kind ELSE 'ai' END WHERE session_id=?1 AND ordinal=?2 AND ?5=(SELECT id FROM grade_requests WHERE session_id=?1 AND ordinal=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1)",params![sid,ordinal,response.to_string(),score,rid]).map_err(err)?;
        tx.commit().map_err(err)?;
        self.session(sid)
    }
}
