use crate::{
    contract::{self, list, text, Result},
    store::{err, validate_page, Store},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
struct SnapshotDocument {
    content: Vec<Value>,
    references: HashMap<(String, String), Vec<usize>>,
}
impl SnapshotDocument {
    fn intern(&mut self, field: &str, id: &str, value: Value) -> usize {
        let entries = self
            .references
            .entry((field.into(), id.into()))
            .or_default();
        if let Some(index) = entries.iter().copied().find(|i| self.content[*i] == value) {
            return index;
        }
        let index = self.content.len();
        self.content.push(value);
        entries.push(index);
        index
    }
    fn share(&mut self, snapshot: &mut Value) {
        let mut refs = serde_json::Map::new();
        for field in ["materials", "groups", "visuals"] {
            let values = snapshot[field].take();
            if values.as_array().is_none_or(|values| values.is_empty()) {
                snapshot[field] = values;
                continue;
            }
            let ids = if let Value::Array(values) = values {
                values
                    .into_iter()
                    .map(|value| {
                        let id = text(&value, "id").to_owned();
                        json!(self.intern(field, &id, value))
                    })
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            refs.insert(field.into(), json!(ids));
            snapshot.as_object_mut().unwrap().remove(field);
        }
        let owner = text(&snapshot["question"], "optionSourceId").to_owned();
        let options = snapshot["question"]["options"].take();
        if !owner.is_empty()
            && options
                .as_array()
                .is_some_and(|options| !options.is_empty())
        {
            refs.insert(
                "options".into(),
                json!(self.intern("options", &owner, options)),
            );
        } else {
            snapshot["question"]["options"] = options;
        }
        let warnings = snapshot["warnings"].take();
        if warnings.as_array().is_some_and(|values| !values.is_empty()) {
            let root = text(snapshot, "rootId").to_owned();
            refs.insert(
                "warnings".into(),
                json!(self.intern("warnings", &root, warnings)),
            );
        } else {
            snapshot["warnings"] = warnings;
        }
        if !refs.is_empty() {
            snapshot["snapshotRefs"] = json!(refs);
        }
    }
}

impl Store {
    pub(crate) fn session_now_with(&self, db: &rusqlite::Connection) -> Result<i64> {
        if self.session_clock.started() {
            return self.session_clock.now();
        }
        let saved: i64 = db.query_row(
            "SELECT COALESCE(MAX(MAX(created_at,COALESCE(last_active_at,created_at),COALESCE(submitted_at,created_at),COALESCE(finished_at,created_at))),0) FROM sessions",
            [], |row| row.get(0),
        ).map_err(err)?;
        self.session_clock.at_least(saved)
    }

    #[cfg(test)]
    pub fn session(&self, sid: &str) -> Result<Value> {
        self.session_with(&self.connect()?, sid, None, false)
    }
    pub(crate) fn session_data(&self, sid: &str, snapshot_key: Option<&str>) -> Result<Value> {
        let db = self.connect()?;
        self.session_with(&db, sid, snapshot_key, true)
    }
    fn session_with(
        &self,
        db: &rusqlite::Connection,
        sid: &str,
        snapshot_key: Option<&str>,
        compact: bool,
    ) -> Result<Value> {
        let (snapshot_key, attempt_key) = snapshot_key
            .map(|key| {
                key.split_once(':')
                    .map_or((Some(key), None), |(snapshot, attempts)| {
                        (Some(snapshot), Some(attempts))
                    })
            })
            .unwrap_or((None, None));
        self.expire_exam_with(db, sid)?;
        let mut session=db.query_row("SELECT id,bank_title,created_at,finished_at,position,mode,kind,deadline_at,submitted_at FROM sessions WHERE id=?1",[sid],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"createdAt":r.get::<_,i64>(2)?,"finishedAt":r.get::<_,Option<i64>>(3)?,"position":r.get::<_,i64>(4)?,"mode":r.get::<_,String>(5)?,"kind":r.get::<_,String>(6)?,"deadlineAt":r.get::<_,Option<i64>>(7)?,"submittedAt":r.get::<_,Option<i64>>(8)?}))).map_err(err)?;
        let mut stmt=db.prepare("SELECT a.ordinal,a.snapshot_question_id,a.answer,a.auto_result,a.result,a.grade_kind,a.submitted_at,a.skipped,a.elapsed_ms,a.max_cents,a.earned_cents,a.flagged,a.grading,q.favorite FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 ORDER BY a.ordinal").map_err(err)?;
        let attempts=stmt.query_map([sid],|r|Ok(json!({"ordinal":r.get::<_,i64>(0)?,"snapshotId":r.get::<_,String>(1)?,"answer":serde_json::from_str::<Value>(&r.get::<_,String>(2)?).unwrap_or(Value::Null),"autoResult":r.get::<_,Option<bool>>(3)?,"result":r.get::<_,Option<bool>>(4)?,"gradeKind":r.get::<_,String>(5)?,"submittedAt":r.get::<_,Option<i64>>(6)?,"skipped":r.get::<_,bool>(7)?,"elapsedMs":r.get::<_,i64>(8)?,"maxCents":r.get::<_,Option<i64>>(9)?,"earnedCents":r.get::<_,Option<i64>>(10)?,"flagged":r.get::<_,bool>(11)?,"grading":serde_json::from_str::<Value>(&r.get::<_,String>(12)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(12,rusqlite::types::Type::Text,Box::new(e)))?,"favorite":r.get::<_,Option<bool>>(13)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let mut attempts = attempts;
        // Restore can replace immutable content with the same session/attempt identities.
        let key = crate::store::hash(
            json!([
                sid,
                self.session_epoch,
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
        let mut document = SnapshotDocument::default();
        if snapshot_key != Some(key.as_str()) {
            let frozen = crate::questions::thaw(self.session_document(db, sid)?.as_ref())?;
            let index = crate::questions::Index::new(&frozen);
            let mut open = HashMap::new();
            let submitted: HashMap<_, _> = attempts
                .iter()
                .map(|a| (text(a, "snapshotId"), !a["submittedAt"].is_null()))
                .collect();
            for row in frozen
                .iter()
                .filter(|row| text(&row["question"], "answerMode") == "listening")
            {
                let unlocked = index.trees[text(row, "id")]
                    .iter()
                    .filter_map(|child| submitted.get(text(child, "id")))
                    .all(|value| *value);
                open.insert(text(row, "id").to_owned(), unlocked);
            }
            let exam = text(&session, "kind") != "practice";
            let finished = !session["submittedAt"].is_null() || !session["finishedAt"].is_null();
            for a in &mut attempts {
                let mut snapshot = index.snapshot(text(a, "snapshotId"))?;
                if compact {
                    crate::exams::enrich_snapshot(
                        &mut snapshot,
                        exam && session["submittedAt"].is_null(),
                    );
                    crate::audio::redact_snapshot(
                        &mut snapshot,
                        exam,
                        finished,
                        !a["submittedAt"].is_null(),
                        &open,
                    );
                    document.share(&mut snapshot);
                }
                a["snapshot"] = snapshot;
            }
        }
        for a in &mut attempts {
            a.as_object_mut().unwrap().remove("snapshotId");
        }
        if session["deadlineAt"].is_number() && session["submittedAt"].is_null() {
            session["clockNow"] = json!(self.session_clock.now()?);
        }
        session["snapshotKey"] = json!(key);
        session["attempts"] = Value::Array(attempts);
        let mut banks = db.prepare("SELECT q.bank_id FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.session_id=?1 GROUP BY q.bank_id ORDER BY MIN(a.ordinal)").map_err(err)?;
        session["bankIds"] = json!(banks
            .query_map([sid], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?);
        if compact {
            if !document.content.is_empty() {
                session["snapshotDocument"] = json!(document.content);
            }
            if text(&session, "kind") != "practice" && session["submittedAt"].is_null() {
                for a in session["attempts"].as_array_mut().unwrap() {
                    a["result"] = Value::Null;
                    a["autoResult"] = Value::Null;
                }
            }
            let mutable = if snapshot_key == session["snapshotKey"].as_str() {
                match session["attempts"].take() {
                    Value::Array(attempts) => attempts,
                    _ => unreachable!(),
                }
            } else {
                list(&session, "attempts")
                    .iter()
                    .map(|attempt| {
                        let mut value = attempt.clone();
                        value.as_object_mut().unwrap().remove("snapshot");
                        value
                    })
                    .collect()
            };
            let bytes =
                serde_json::to_vec(&(sid, &session["snapshotKey"], &mutable)).map_err(err)?;
            let attempt_revision = crate::store::hash(&bytes);
            if snapshot_key == session["snapshotKey"].as_str() {
                if let Some((cached_key, cached)) = self.session_attempt_cache.borrow().as_ref() {
                    if attempt_key == Some(cached_key.as_str())
                        && cached.len() == mutable.len()
                        && cached
                            .iter()
                            .zip(&mutable)
                            .all(|(old, new)| old["ordinal"] == new["ordinal"])
                    {
                        session["attempts"] = json!(mutable
                            .iter()
                            .zip(cached)
                            .filter_map(|(new, old)| (new != old).then_some(new))
                            .collect::<Vec<_>>());
                        session["attemptsBase"] = json!(cached_key);
                        session["attemptCount"] = json!(mutable.len());
                    }
                }
            }
            if session["attempts"].is_null() {
                session["attempts"] = json!(mutable);
            }
            session["attemptKey"] = json!(attempt_revision);
            // ponytail: cache one view, capped at 8 MiB; mismatched views use the full response.
            *self.session_attempt_cache.borrow_mut() =
                (bytes.len() <= 8 * 1024 * 1024).then_some((attempt_revision, mutable));
        } else {
            Self::enrich_session(&mut session)?;
            crate::audio::redact_session(&mut session);
        }
        Ok(session)
    }
    fn expire_sessions(&self) -> Result<()> {
        let db = self.connect()?;
        let at = self.session_now_with(&db)?;
        let mut expired = db
            .prepare("SELECT id FROM sessions WHERE deadline_at<=?1 AND submitted_at IS NULL")
            .map_err(err)?;
        let ids = expired
            .query_map([at], |r| r.get::<_, String>(0))
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
            if session["deadlineAt"].is_number() && session["submittedAt"].is_null() {
                session["clockNow"] = json!(self.session_now_with(&db)?);
            }
        }
        Ok(json!({"items":rows,"total":total,"offset":offset}))
    }
    #[cfg(test)]
    pub fn self_assess(&self, sid: &str, ordinal: usize, result: bool) -> Result<Value> {
        self.self_assess_with_key(sid, ordinal, result, None)?;
        self.session(sid)
    }
    pub fn self_assess_with_key(
        &self,
        sid: &str,
        ordinal: usize,
        result: bool,
        snapshot_key: Option<&str>,
    ) -> Result<Value> {
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
        self.session_now_with(&tx)?;
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
            params![sid, self.session_clock.now()?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        self.session_data(sid, snapshot_key)
    }
    #[cfg(test)]
    pub fn save_attempt(
        &self,
        target: (&str, usize),
        answer: Value,
        elapsed: i64,
        submit: bool,
        skip: bool,
    ) -> Result<Value> {
        self.write_attempt(target, answer, elapsed, submit, skip)?;
        self.session(target.0)
    }
    pub fn save_draft(&self, target: (&str, usize), answer: Value, elapsed: i64) -> Result<Value> {
        self.write_attempt(target, answer, elapsed, false, false)?;
        Ok(Value::Null)
    }
    pub(crate) fn write_attempt(
        &self,
        target: (&str, usize),
        answer: Value,
        elapsed: i64,
        submit: bool,
        skip: bool,
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
        if exam.0 != "practice" && (submit || skip || exam.1.is_some()) {
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
        if elapsed
            > self
                .session_clock
                .now()?
                .saturating_sub(created)
                .saturating_add(60_000)
        {
            return Err(crate::language::error(
                "LOCAL_ELAPSED_INVALID",
                serde_json::json!({}),
            ));
        }
        let (snapshot,submitted):(String,Option<i64>)=tx.query_row("SELECT snapshot_question_id,submitted_at FROM attempts WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
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

        if submitted.is_none() {
            let auto = if submit && !skip && snapshot["missingAssets"] != true {
                contract::grade(q, &answer)
            } else {
                None
            };
            let grade_kind = if auto.is_some() { "auto" } else { "ungraded" };
            tx.execute("UPDATE attempts SET answer=?3,elapsed_ms=MAX(elapsed_ms,?4),submitted_at=?5,skipped=?6,auto_result=?7,result=?7,grade_kind=?8 WHERE session_id=?1 AND ordinal=?2",params![sid,ordinal,answer.to_string(),elapsed,if submit{Some(self.session_clock.now()?)}else{None},submit&&skip,auto,grade_kind]).map_err(err)?;
        }
        tx.execute(
            "UPDATE sessions SET position=?2,last_active_at=?3 WHERE id=?1",
            params![sid, ordinal, self.session_clock.now()?],
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
        self.session_now_with(&db)?;
        db.execute("UPDATE sessions SET position=?2,last_active_at=?3 WHERE id=?1 AND finished_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE session_id=?1 AND ordinal=?2)",params![sid,position,self.session_clock.now()?]).map_err(err)?;
        let mut session = self.session_with(&db, sid, snapshot_key, true)?;
        let count = session["attemptCount"]
            .as_u64()
            .map_or_else(|| list(&session, "attempts").len(), |count| count as usize);
        if position < count {
            session["position"] = json!(position);
        }
        Ok(session)
    }
    #[cfg(test)]
    pub fn finish(&self, sid: &str) -> Result<Value> {
        self.finish_data(sid)?;
        self.session(sid)
    }
    pub fn finish_data(&self, sid: &str) -> Result<Value> {
        let kind: String = self
            .connect()?
            .query_row("SELECT kind FROM sessions WHERE id=?1", [sid], |row| {
                row.get(0)
            })
            .map_err(err)?;
        if kind != "practice" {
            return self.submit_paper_data(sid, true);
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        tx.execute("UPDATE attempts SET skipped=1,submitted_at=?2 WHERE session_id=?1 AND submitted_at IS NULL",params![sid,self.session_clock.now()?]).map_err(err)?;
        tx.execute(
            "UPDATE sessions SET finished_at=COALESCE(finished_at,?2) WHERE id=?1",
            params![sid, self.session_clock.now()?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        self.session_data(sid, None)
    }
}

#[cfg(test)]
#[path = "shared_snapshots_tests.rs"]
mod shared_snapshots_tests;
#[cfg(test)]
#[path = "ux_sessions_tests.rs"]
mod ux_sessions_tests;
