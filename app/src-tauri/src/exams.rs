use crate::{
    contract::{self, list, text, Result},
    store::{id, now, Store},
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Paper {
    pub question_ids: Vec<String>,
    pub kind: String,
    pub minutes: Option<i64>,
    pub scores: Vec<i64>,
    pub total_cents: i64,
    pub digest: String,
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
    pub fn start_paper(&self, paper: Paper) -> Result<Value> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let all = crate::questions::read(&tx)?;
        let selected = crate::paper::selected_rows(&all, &paper.question_ids)?;
        if crate::paper::digest(&selected)? != paper.digest {
            return Err(crate::language::error("LOCAL_PAPER_CHANGED", json!({})));
        }
        let leaves: Vec<_> = selected
            .iter()
            .filter(|r| !crate::questions::composite(&r["question"]))
            .collect();
        let n = leaves.len();
        if n == 0 || n > 1000 {
            return Err(crate::language::error(
                "LOCAL_QUESTION_SELECTION_INVALID",
                serde_json::json!({}),
            ));
        }
        let exam = paper.kind != "practice";
        if !["practice", "self_test", "mock_exam"].contains(&paper.kind.as_str())
            || (paper.kind == "mock_exam"
                && !paper.minutes.is_some_and(|m| (1..=1440).contains(&m)))
            || (paper.kind != "mock_exam" && paper.minutes.is_some())
        {
            return Err(crate::language::error(
                "LOCAL_EXAM_MODE_INVALID",
                serde_json::json!({}),
            ));
        }
        if exam
            && (paper.scores.len() != n
                || paper.scores.iter().any(|s| *s < 1 || *s > 100_000_000)
                || paper.total_cents < 1
                || paper.total_cents > 100_000_000
                || paper.scores.iter().sum::<i64>() != paper.total_cents)
        {
            return Err(crate::language::error(
                "LOCAL_EXAM_SCORES_INVALID",
                serde_json::json!({}),
            ));
        }
        let sid = id();
        let created = now();
        tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind,deadline_at) VALUES(?1,?2,?3,0,'ordered',?4,?5)",params![sid,if exam {self.locale.text("自测 / 模考", "Self-test / mock exam")} else {self.locale.text("跨题库练习", "Practice across banks")},created,paper.kind,paper.minutes.map(|m|created+m*60_000)]).map_err(err)?;
        tx.execute(
            "INSERT INTO session_documents VALUES(?1,?2)",
            params![sid, crate::questions::freeze(&selected).to_string()],
        )
        .map_err(err)?;
        for (i, row) in leaves.iter().enumerate() {
            let qid = text(row, "id");
            tx.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,max_cents) VALUES(?1,?2,?3,?3,?4)",params![sid,i as i64,qid,if exam {Some(paper.scores[i])} else {None}]).map_err(err)?;
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
        let mut stmt=tx.prepare("SELECT ordinal,snapshot_question_id,answer,max_cents FROM attempts WHERE session_id=?1 AND submitted_at IS NULL").map_err(err)?;
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
        let frozen = crate::questions::session_rows(&tx, sid)?;
        let index = crate::questions::Index::new(&frozen);
        for (ordinal, snapshot, answer, max) in rows {
            let snapshot = index.snapshot(&snapshot)?;
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
            return Err(crate::language::error(
                "LOCAL_OVERRIDE_REASON_REQUIRED",
                serde_json::json!({}),
            ));
        }
        let db = self.connect()?;
        let changed=db.execute("UPDATE attempts SET earned_cents=?3,result=(?3=max_cents),grade_kind='manual',grading=json_set(grading,'$.manual',json(?4),'$.manualHistory',json_insert(COALESCE(json_extract(grading,'$.manualHistory'),'[]'),'$[#]',json(?4))) WHERE session_id=?1 AND ordinal=?2 AND max_cents>=?3 AND ?3>=0 AND EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND submitted_at IS NOT NULL)",params![sid,ordinal,cents,json!({"scoreCents":cents,"reason":reason,"at":now()}).to_string()]).map_err(err)?;
        if changed != 1 {
            return Err(crate::language::error(
                "LOCAL_MANUAL_SCORE_INVALID",
                serde_json::json!({}),
            ));
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
        for a in s["attempts"].as_array_mut().ok_or(crate::language::error(
            "LOCAL_SESSION_CORRUPTED",
            serde_json::json!({}),
        ))? {
            if kind != "practice" && submitted.is_none() {
                let q = &mut a["snapshot"]["question"];
                a_blank_count(q);
                if let Some(groups) = a["snapshot"]["groups"].as_array_mut() {
                    groups.retain(|g| {
                        !answer_text(text(g, "title")) && !answer_text(text(g, "instructions"))
                    });
                }
                if let Some(visuals) = a["snapshot"]["visuals"].as_array_mut() {
                    visuals.retain(|visual| !crate::questions::answer_content(visual));
                    for visual in visuals {
                        visual
                            .as_object_mut()
                            .ok_or(crate::language::error(
                                "LOCAL_IMAGE_FORMAT_INVALID",
                                serde_json::json!({}),
                            ))?
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
        let mut db = self.connect()?;
        let rows = crate::questions::session_rows(&db, sid)?;
        let roots: HashSet<_> = list(&s, "attempts")
            .iter()
            .filter(|a| {
                a["result"] == false
                    || a["earnedCents"]
                        .as_i64()
                        .zip(a["maxCents"].as_i64())
                        .is_some_and(|(e, m)| e < m)
            })
            .map(|a| text(&a["snapshot"], "rootId").to_owned())
            .collect();
        if roots.is_empty() {
            return Err("No mistakes to retry".into());
        }
        let index = crate::questions::Index::new(&rows);
        let selected: Vec<_> = rows
            .iter()
            .filter(|r| roots.contains(index.root_id(r)))
            .cloned()
            .collect();
        let sid2 = id();
        let tx = db.transaction().map_err(err)?;
        tx.execute("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES(?1,?2,?3,0,'ordered')",params![sid2,self.locale.text("本次错题重练", "Retry session mistakes"),now()]).map_err(err)?;
        tx.execute(
            "INSERT INTO session_documents VALUES(?1,?2)",
            params![sid2, crate::questions::freeze(&selected).to_string()],
        )
        .map_err(err)?;
        for (i, row) in selected
            .iter()
            .filter(|r| !crate::questions::composite(&r["question"]))
            .enumerate()
        {
            tx.execute("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id) VALUES(?1,?2,?3,?3)",params![sid2,i as i64,text(row,"id")]).map_err(err)?;
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
            return Err(crate::language::error(
                "LOCAL_MERGE_SELECTION_INVALID",
                serde_json::json!({}),
            ));
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
                return Err(crate::language::error(
                    "LOCAL_SOURCE_BANK_DELETED",
                    serde_json::json!({}),
                ));
            }
        }
        let rows = crate::questions::read(&tx)?;
        let mut rows: Vec<_> = rows
            .into_iter()
            .filter(|r| banks.contains(&text(r, "bankId").to_owned()))
            .collect();
        rows.sort_by_key(|r| {
            banks
                .iter()
                .position(|b| b == text(r, "bankId"))
                .unwrap_or(usize::MAX)
        });
        let ids: HashMap<_, _> = rows
            .iter()
            .map(|r| (text(r, "id").to_owned(), id()))
            .collect();
        let bank = id();
        tx.execute(
            "INSERT INTO banks VALUES(?1,?2,?3,?4)",
            params![
                bank,
                title.trim(),
                self.locale.text("合并副本", "Merged copy"),
                now()
            ],
        )
        .map_err(err)?;
        for (i, row) in rows.iter().enumerate() {
            let mut q = row["question"].clone();
            crate::questions::remap(&mut q, &ids)?;
            crate::questions::write(&tx, &q, &bank, None, i as i64, row["favorite"] == true)?;
        }
        crate::questions::copy_context(&tx, &bank, &rows, &ids)?;
        tx.commit().map_err(err)?;
        Ok(
            json!({"bankId":bank,"count":rows.iter().filter(|r|!crate::questions::composite(&r["question"])).count()}),
        )
    }
}
fn a_blank_count(q: &mut Value) {
    for k in [
        "answerPayload",
        "analysis",
        "sourceText",
        "scoringRubric",
        "scoreSourceText",
    ] {
        q[k] = Value::Null;
    }
    if let Some(blocks) = q["contentBlocks"].as_array_mut() {
        blocks.retain(|block| !crate::questions::answer_content(block));
    }
}

// ponytail: explicit labels in legacy free text; typed roles are preferable for future content contracts.
fn answer_text(value: &str) -> bool {
    value.to_lowercase().split(['\n', '|']).any(|line| {
        let label = line
            .split([':', '：'])
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(['*', '#', ' '])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let answer = ["correct ", "reference ", "model "]
            .iter()
            .find_map(|prefix| label.strip_prefix(prefix))
            .unwrap_or(&label);
        matches!(
            answer,
            "answer" | "answers" | "answer key" | "answer keys" | "answers key" | "answers keys"
        ) || matches!(
            label.as_str(),
            "solution"
                | "solutions"
                | "worked solution"
                | "worked solutions"
                | "analysis"
                | "explanation"
                | "explanations"
                | "rubric"
                | "rubrics"
                | "scoring rubric"
                | "scoring rubrics"
                | "参考答案"
                | "正确答案"
                | "标准答案"
                | "答案"
                | "答案解析"
                | "解析"
                | "解答"
                | "评分"
                | "评分标准"
                | "评分细则"
        )
    })
}

impl Store {
    pub fn prepare_grade(&self, sid: &str, ordinal: usize, retry: bool) -> Result<Value> {
        let db = self.connect()?;
        let (snapshot,answer,max,submitted,kind,grade_kind):(String,String,Option<i64>,Option<i64>,String,String)=db.query_row("SELECT a.snapshot_question_id,a.answer,a.max_cents,s.submitted_at,s.kind,a.grade_kind FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=?1 AND a.ordinal=?2",params![sid,ordinal],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(err)?;
        let snapshot = crate::questions::snapshot(&db, sid, &snapshot)?;
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
            return Err(crate::language::error(
                "LOCAL_GRADING_INELIGIBLE",
                serde_json::json!({}),
            ));
        }
        let mut images = Vec::new();
        let mut seen = HashSet::new();
        for v in list(&snapshot, "visuals") {
            if let Some(digest) = v["imageRef"]["sha256"].as_str() {
                if seen.insert(digest) {
                    let data = self.asset(digest)?;
                    if data.is_null() {
                        return Err(crate::language::error(
                            "LOCAL_GRADING_IMAGE_MISSING",
                            serde_json::json!({}),
                        ));
                    }
                    let encoded = data
                        .as_str()
                        .and_then(|s| s.split_once(','))
                        .map(|(_, s)| s)
                        .unwrap_or("");
                    let padding = encoded.len() - encoded.trim_end_matches('=').len();
                    if encoded.len() / 4 * 3 - padding > 20 * 1024 * 1024 {
                        return Err(crate::language::error("LOCAL_GRADING_TOO_LARGE", json!({})));
                    }
                    images.push(json!({"sha256":digest,"data":data}));
                }
            }
        }
        let mut materials: Vec<String> = list(&snapshot, "groups")
            .iter()
            .map(|g| {
                let mut material = format!("{}\n{}", text(g, "title"), text(g, "instructions"));
                if let Some(blocks) = g.get("contentBlocks") {
                    material.push('\n');
                    material.push_str(&blocks.to_string());
                }
                material
            })
            .collect();
        materials.extend(list(&snapshot, "materials").iter().map(Value::to_string));
        materials.extend(
            list(&snapshot, "visuals")
                .iter()
                .map(|v| format!("{}\n{}", text(v, "description"), text(v, "extractedText"))),
        );
        if text(&answer, "text").chars().count() > 120_000
            || materials.len() > 100
            || materials.iter().map(|s| s.chars().count()).sum::<usize>() > 120_000
            || images.len() > 32
            || images
                .iter()
                .any(|image| text(image, "data").len() > 28_000_000)
        {
            return Err(crate::language::error("LOCAL_GRADING_TOO_LARGE", json!({})));
        }
        let payload = json!({"question":q,"answer":text(&answer,"text"),"maxCents":max,"materials":materials,"images":images});
        let raw = payload.to_string();
        if raw.len() > 31 * 1024 * 1024 {
            return Err(crate::language::error(
                "LOCAL_GRADING_TOO_LARGE",
                serde_json::json!({}),
            ));
        }
        let mut payload = json!({"inputDigest":crate::store::hash(raw.as_bytes()),"payload":raw});
        if !retry {
            let mut stmt=db.prepare("SELECT input FROM grade_requests WHERE session_id=?1 AND ordinal=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1").map_err(err)?;
            let mut rows = stmt.query(params![sid, ordinal]).map_err(err)?;
            if let Some(row) = rows.next().map_err(err)? {
                let previous: Value =
                    serde_json::from_str(&row.get::<_, String>(0).map_err(err)?).map_err(err)?;
                if previous["inputDigest"] != payload["inputDigest"] {
                    return Err(crate::language::error(
                        "LOCAL_GRADING_INPUT_CHANGED",
                        serde_json::json!({}),
                    ));
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
                    .ok_or(crate::language::error(
                        "LOCAL_AI_SCORE_INVALID",
                        serde_json::json!({}),
                    ))?,
            )
        } else {
            None
        };
        if score.is_some() && response["result"]["maxCents"] != max {
            return Err(crate::language::error(
                "LOCAL_AI_MAX_MISMATCH",
                serde_json::json!({}),
            ));
        }
        let updated=tx.execute("UPDATE grade_requests SET response=?4 WHERE id=?1 AND session_id=?2 AND ordinal=?3",params![rid,sid,ordinal,response.to_string()]).map_err(err)?;
        if updated != 1 {
            return Err(crate::language::error(
                "LOCAL_GRADING_REQUEST_MISSING",
                serde_json::json!({}),
            ));
        }
        tx.execute("UPDATE attempts SET grading=json_set(grading,CASE WHEN ?4 IS NULL THEN '$.lastRequest' ELSE '$.ai' END,json(?3)),earned_cents=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN earned_cents ELSE ?4 END,result=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN result ELSE (?4=max_cents) END,grade_kind=CASE WHEN grade_kind='manual' OR ?4 IS NULL THEN grade_kind ELSE 'ai' END WHERE session_id=?1 AND ordinal=?2 AND ?5=(SELECT id FROM grade_requests WHERE session_id=?1 AND ordinal=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1)",params![sid,ordinal,response.to_string(),score,rid]).map_err(err)?;
        tx.commit().map_err(err)?;
        self.session(sid)
    }
}
