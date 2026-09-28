use crate::{
    contract::{self, list, text, Result},
    store::{now, validate_page, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}

impl Store {
    pub fn session(&self, sid: &str) -> Result<Value> {
        self.session_data(sid, None)
    }
    pub(crate) fn session_data(&self, sid: &str, snapshot_key: Option<&str>) -> Result<Value> {
        let db = self.connect()?;
        self.session_with(&db, sid, snapshot_key)
    }
    fn session_with(
        &self,
        db: &rusqlite::Connection,
        sid: &str,
        snapshot_key: Option<&str>,
    ) -> Result<Value> {
        self.expire_exam_with(db, sid)?;
        let mut session=db.query_row("SELECT id,bank_title,created_at,finished_at,position,mode,kind,deadline_at,submitted_at FROM sessions WHERE id=?1",[sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"position":r.get::<_,i64>(4)?,"mode":r.get::<_,String>(5)?,"kind":r.get::<_,String>(6)?,"deadlineAt":r.get::<_,Option<i64>>(7)?,"submittedAt":r.get::<_,Option<i64>>(8)?}))).map_err(err)?;
        let mut stmt=db.prepare("SELECT a.ordinal,a.snapshot_question_id,a.answer,a.auto_result,a.result,a.grade_kind,a.submitted_at,a.skipped,a.elapsed_ms,a.max_cents,a.earned_cents,a.flagged,a.grading,q.favorite FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 ORDER BY a.ordinal").map_err(err)?;
        let attempts=stmt.query_map([sid],|r|Ok(json!({"ordinal":r.get::<_,i64>(0)?,"snapshotId":r.get::<_,String>(1)?,"answer":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"autoResult":r.get::<_,Option<bool>>(3)?,"result":r.get::<_,Option<bool>>(4)?,"gradeKind":r.get::<_,String>(5)?,"submittedAt":r.get::<_,Option<i64>>(6)?,"skipped":r.get::<_,bool>(7)?,"elapsedMs":r.get::<_,i64>(8)?,"maxCents":r.get::<_,Option<i64>>(9)?,"earnedCents":r.get::<_,Option<i64>>(10)?,"flagged":r.get::<_,bool>(11)?,"grading":serde_json::from_str::<Value>(&r.get::<_,String>(12)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(12,rusqlite::types::Type::Text,Box::new(e)))?,"favorite":r.get::<_,Option<bool>>(13)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let mut attempts = attempts;
        // Immutable snapshots change visibility only when an attempt/session is submitted or finished.
        let key = crate::store::hash(
            json!([
                sid,
                session["kind"],
                session["finishedAt"],
                session["submittedAt"],
                attempts
                    .iter()
                    .map(|a| (&a["snapshotId"], &a["submittedAt"]))
                    .collect::<Vec<_>>()
            ])
            .to_string()
            .as_bytes(),
        );
        if snapshot_key != Some(key.as_str()) {
            let frozen = crate::questions::thaw(self.session_document(db, sid)?.as_ref())?;
            let index = crate::questions::Index::new(&frozen);
            for a in &mut attempts {
                a["snapshot"] = index.snapshot(text(a, "snapshotId"))?;
            }
        }
        for a in &mut attempts {
            a.as_object_mut().unwrap().remove("snapshotId");
        }
        session["snapshotKey"] = json!(key);
        session["attempts"] = json!(attempts);
        let mut banks = db.prepare("SELECT q.bank_id FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 GROUP BY q.bank_id ORDER BY MIN(a.ordinal)").map_err(err)?;
        session["bankIds"] = json!(banks
            .query_map([sid], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?);
        Self::enrich_session(&mut session)?;
        crate::audio::redact_session(&mut session);
        Ok(session)
    }
    fn expire_sessions(&self) -> Result<()> {
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

        Ok(())
    }
    pub fn unfinished_session(&self) -> Result<Value> {
        let page = self.sessions_filtered(1, 0, "active")?;
        Ok(page["items"][0].clone())
    }
    #[cfg(test)]
    pub fn sessions(&self, limit: usize, offset: usize) -> Result<Value> {
        self.sessions_filtered(limit, offset, "all")
    }
    pub fn sessions_filtered(&self, limit: usize, offset: usize, filter: &str) -> Result<Value> {
        validate_page(limit, offset)?;
        let condition = match filter {
            "all" => "1",
            "active" => "s.finished_at IS NULL AND s.submitted_at IS NULL",
            "review" => "s.finished_at IS NULL AND s.submitted_at IS NOT NULL",
            "finished" => "s.finished_at IS NOT NULL",
            _ => return Err(crate::language::error("LOCAL_FILTER_INVALID", json!({}))),
        };
        self.expire_sessions()?;
        let db = self.connect()?;
        let total: usize = db.query_row(&format!("SELECT COUNT(*) FROM sessions s WHERE {condition} AND EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id)"), [], |r| r.get(0)).map_err(err)?;
        let offset = offset.min(total.saturating_sub(1) / limit * limit);
        let mut stmt=db.prepare(&format!("WITH page AS (SELECT * FROM sessions s WHERE {condition} AND EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id) ORDER BY COALESCE(last_active_at,created_at) DESC,id DESC LIMIT ?1 OFFSET ?2) SELECT s.id,s.bank_title,s.created_at,s.finished_at,COUNT(*),SUM(a.submitted_at IS NOT NULL),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents=a.max_cents ELSE a.result=1 END),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents IS NOT NULL ELSE a.result IS NOT NULL END),SUM(a.skipped),SUM(a.elapsed_ms),SUM(a.grade_kind='self'),SUM(a.grade_kind='auto'),s.kind,s.submitted_at,SUM(a.max_cents),SUM(a.earned_cents),SUM(a.max_cents IS NOT NULL AND a.earned_cents IS NULL),s.deadline_at,COALESCE(s.last_active_at,s.created_at) FROM page s JOIN attempts a ON a.session_id=s.id GROUP BY s.id ORDER BY COALESCE(s.last_active_at,s.created_at) DESC,s.id DESC")).map_err(err)?;
        let mut rows = stmt.query_map(params![limit, offset], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"count":r.get::<_,i64>(4)?,"answered":r.get::<_,i64>(5)?,"correct":r.get::<_,Option<i64>>(6)?.unwrap_or(0),"graded":r.get::<_,i64>(7)?,"skipped":r.get::<_,i64>(8)?,"elapsedMs":r.get::<_,i64>(9)?,"selfGraded":r.get::<_,i64>(10)?,"autoGraded":r.get::<_,i64>(11)?,"kind":r.get::<_,String>(12)?,"submittedAt":r.get::<_,Option<i64>>(13)?,"totalCents":r.get::<_,Option<i64>>(14)?,"earnedCents":r.get::<_,Option<i64>>(15)?,"pendingGrades":r.get::<_,i64>(16)?,"deadlineAt":r.get::<_,Option<i64>>(17)?,"lastActiveAt":r.get::<_,i64>(18)?}))
        }).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let mut drafts = db
            .prepare("SELECT answer FROM attempts WHERE session_id=?1 AND submitted_at IS NULL")
            .map_err(err)?;
        for session in &mut rows {
            let mut answers = drafts.query([text(session, "id")]).map_err(err)?;
            let mut count = 0;
            while let Some(row) = answers.next().map_err(err)? {
                let answer: Value =
                    serde_json::from_str(&row.get::<_, String>(0).map_err(err)?).map_err(err)?;
                count += usize::from(crate::exams::has_answer(&answer));
            }
            session["draftAnswered"] = json!(count);
        }
        Ok(json!({"items":rows,"total":total,"offset":offset}))
    }
    pub fn self_assess(&self, sid: &str, ordinal: usize, result: bool) -> Result<Value> {
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let attempt = tx.query_row(
            "SELECT s.kind,a.submitted_at,a.skipped,a.auto_result,a.snapshot_question_id FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=?1 AND a.ordinal=?2",
            params![sid, ordinal],
            |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,bool>(2)?,r.get::<_,Option<bool>>(3)?,r.get::<_,String>(4)?)),
        ).optional().map_err(err)?;
        let ineligible = || crate::language::error("LOCAL_SELF_ASSESSMENT_INELIGIBLE", json!({}));
        let (kind, submitted, skipped, auto, qid) = attempt.ok_or_else(ineligible)?;
        let snapshot = crate::questions::snapshot(&tx, sid, &qid)?;
        if kind != "practice"
            || submitted.is_none()
            || skipped
            || (auto.is_some() && text(&snapshot["question"], "answerMode") != "fill_blank")
        {
            return Err(ineligible());
        }
        tx.execute(
            "UPDATE attempts SET result=?3,grade_kind='self' WHERE session_id=?1 AND ordinal=?2",
            params![sid, ordinal, result],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE sessions SET last_active_at=?2 WHERE id=?1",
            params![sid, now()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        self.session(sid)
    }
    #[cfg(test)]
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
    pub(crate) fn write_attempt(
        &self,
        target: (&str, usize),
        answer: Value,
        elapsed: i64,
        submit: bool,
        skip: bool,
        self_result: Option<bool>,
    ) -> Result<()> {
        let (sid, ordinal) = target;
        let mut db = self.connect()?;
        self.expire_exam_with(&db, sid)?;
        let exam = db
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
        let frozen = crate::questions::context_from_document(
            self.session_document(&tx, sid)?.as_ref(),
            &snapshot,
        )?;
        let index = crate::questions::Index::new(&frozen);
        let snapshot = index.snapshot(&snapshot)?;
        let q = &snapshot["question"];
        contract::validate_attempt(q, &answer)?;
        if let Some(parent) = index.by_id.get(text(q, "optionSourceId")) {
            if parent["question"]["allowReuse"] != true {
                let siblings = frozen
                    .iter()
                    .filter(|r| r["question"]["parentId"] == parent["id"])
                    .map(|r| text(r, "id"))
                    .collect::<Vec<_>>();
                let mut statement=tx.prepare("SELECT snapshot_question_id,answer FROM attempts WHERE session_id=?1 AND ordinal!=?2 AND snapshot_question_id IN (SELECT value FROM json_each(?3))").map_err(err)?;
                let others = statement
                    .query_map(params![sid, ordinal, json!(siblings).to_string()], |r| {
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
            "UPDATE sessions SET position=?2,last_active_at=?3 WHERE id=?1",
            params![sid, ordinal, now()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
    pub fn position(
        &self,
        sid: &str,
        position: usize,
        snapshot_key: Option<&str>,
    ) -> Result<Value> {
        let db = self.connect()?;
        db.execute("UPDATE sessions SET position=?2,last_active_at=?3 WHERE id=?1 AND finished_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE session_id=?1 AND ordinal=?2)",params![sid,position,now()]).map_err(err)?;
        let mut session = self.session_with(&db, sid, snapshot_key)?;
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
}

#[cfg(test)]
#[path = "ux_sessions_tests.rs"]
mod ux_sessions_tests;
