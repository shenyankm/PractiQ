use crate::{
    contract::{list, text, Result},
    store::{err, now, Store},
};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub(crate) const DATA_LIMIT: usize = 4 * 1024 * 1024;
const SCHEMA: &str =
    "CREATE TABLE learning_data(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL)";
const DAY: i64 = 86_400_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MistakeCause {
    Knowledge,
    Misread,
    Calculation,
    Other,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Note {
    pub body: String,
    pub cause: Option<MistakeCause>,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LearningData {
    pub version: u8,
    pub notes: BTreeMap<String, Note>,
    pub last_backup_at: Option<i64>,
}
impl Default for LearningData {
    fn default() -> Self {
        Self {
            version: 1,
            notes: BTreeMap::new(),
            last_backup_at: None,
        }
    }
}
impl LearningData {
    pub(crate) fn validate(self) -> Result<Self> {
        if self.version != 1
            || self.notes.len() > 10_000
            || self.last_backup_at.is_some_and(|time| time < 0)
            || self.notes.iter().any(|(id, note)| {
                id.is_empty()
                    || id.len() > 128
                    || note.body.chars().count() > 20_000
                    || note.updated_at < 0
            })
            || serde_json::to_vec(&self).map_err(err)?.len() > DATA_LIMIT
        {
            return Err("Unsupported or invalid learning data".into());
        }
        Ok(self)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LearningRestore {
    pub previous: LearningData,
    pub next: LearningData,
}
impl LearningRestore {
    pub(crate) fn validate(self) -> Result<Self> {
        Ok(Self {
            previous: self.previous.validate()?,
            next: self.next.validate()?,
        })
    }
}
fn empty(db: &Connection) -> Result<bool> {
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(err)?;
    Ok(db
        .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(err)?
        == 0
        && db
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(err)?
            == 0)
}
fn read(db: &Connection) -> Result<LearningData> {
    db.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(err)?;
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(err)?;
    let objects = db.prepare("SELECT type,name,COALESCE(sql,'') FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").map_err(err)?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>().map_err(err)?;
    if version != 1 || objects != [("table".into(), "learning_data".into(), SCHEMA.into())] {
        return Err("Unsupported learning database".into());
    }
    let raw: String = db
        .query_row("SELECT content FROM learning_data WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(err)?;
    if raw.len() > DATA_LIMIT {
        return Err("Learning data exceeds its size limit".into());
    }
    serde_json::from_str::<LearningData>(&raw)
        .map_err(err)?
        .validate()
}

impl Store {
    pub(crate) fn learning_path(&self) -> std::path::PathBuf {
        self.dir.join("learning-v1.sqlite")
    }
    fn learning_exists(&self) -> Result<bool> {
        match std::fs::symlink_metadata(self.learning_path()) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => Err("Learning database must be a regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(err(error)),
        }
    }
    pub(crate) fn learning_data(&self) -> Result<LearningData> {
        if !self.learning_exists()? {
            return Ok(LearningData::default());
        }
        let db =
            Connection::open_with_flags(self.learning_path(), OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(err)?;
        if empty(&db)? {
            return Ok(LearningData::default());
        }
        read(&db)
    }
    fn update_learning(
        &self,
        update: impl FnOnce(LearningData) -> Result<LearningData>,
    ) -> Result<()> {
        self.learning_exists()?;
        let mut db = Connection::open(self.learning_path()).map_err(err)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(err)?;
        if empty(&tx)? {
            tx.execute_batch(SCHEMA).map_err(err)?;
            tx.execute(
                "INSERT INTO learning_data VALUES(1,?1)",
                [serde_json::to_string(&LearningData::default()).map_err(err)?],
            )
            .map_err(err)?;
            tx.execute_batch("PRAGMA user_version=1;").map_err(err)?;
        }
        let data = update(read(&tx)?)?.validate()?;
        tx.execute(
            "UPDATE learning_data SET content=?1 WHERE id=1",
            [serde_json::to_string(&data).map_err(err)?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }
    // Called only while the durable restore record owns publication/recovery.
    pub(crate) fn publish_learning(&self, data: LearningData) -> Result<()> {
        self.update_learning(|_| Ok(data))
    }
    pub(crate) fn learning_backup(&self, db: &Connection) -> Result<LearningData> {
        let mut data = self.learning_data()?;
        let ids = db
            .prepare("SELECT id FROM questions")
            .map_err(err)?
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<std::collections::HashSet<_>, _>>()
            .map_err(err)?;
        data.notes
            .retain(|id, note| ids.contains(id) && (!note.body.is_empty() || note.cause.is_some()));
        data.last_backup_at = None;
        Ok(data)
    }
    pub fn question_note(&self, id: &str) -> Result<Value> {
        let db = self.connect()?;
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM questions WHERE id=?1)",
                [id],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            return Err("Question no longer exists".into());
        }
        Ok(json!(self.learning_data()?.notes.get(id).filter(
            |note| !note.body.is_empty() || note.cause.is_some()
        )))
    }
    pub fn save_question_note(
        &self,
        id: &str,
        body: String,
        cause: Option<MistakeCause>,
    ) -> Result<Value> {
        self.question_note(id)?;
        let note = Note {
            body,
            cause,
            updated_at: now(),
        };
        self.update_learning(|mut data| {
            // Retain the cleared entry's timestamp so deleting a note still makes a backup due.
            data.notes.insert(id.into(), note.clone());
            Ok(data)
        })?;
        Ok(json!(note))
    }
    pub fn backup_status(&self) -> Result<Value> {
        let db = self.connect()?;
        let data = self.learning_data()?;
        let since = data.last_backup_at.unwrap_or(0);
        let attempts: i64 = db
            .query_row(
                "SELECT count(*) FROM attempts WHERE submitted_at>?1",
                [since],
                |r| r.get(0),
            )
            .map_err(err)?;
        let notes = data
            .notes
            .values()
            .filter(|note| note.updated_at > since)
            .count();
        let has_banks: bool = db
            .query_row("SELECT EXISTS(SELECT 1 FROM banks)", [], |r| r.get(0))
            .map_err(err)?;
        let due = if let Some(last) = data.last_backup_at {
            now().saturating_sub(last) >= 7 * DAY && (attempts > 0 || notes > 0)
        } else {
            has_banks || notes > 0
        };
        Ok(
            json!({"lastBackupAt":data.last_backup_at,"newAttempts":attempts,"changedNotes":notes,"due":due}),
        )
    }
    pub fn export_backup(&self, path: &std::path::Path) -> Result<Value> {
        self.learning_data()?;
        let mut result = self.backup(path)?;
        #[cfg(test)]
        tests::backup_mark_checkpoint(self);
        if let Err(error) = self.update_learning(|mut data| {
            data.last_backup_at = Some(now());
            Ok(data)
        }) {
            // The archive is already published; never report the completed export as failed.
            result["reminderError"] = json!(error.to_string());
        }
        Ok(result)
    }
    pub fn learning_overview(&self, days: u8, today_start: i64, since: i64) -> Result<Value> {
        let time = now();
        // Browser calendar arithmetic preserves local midnight across daylight-saving changes.
        if ![7, 30].contains(&days)
            || since < 0
            || since > today_start
            || today_start > time
            || time.saturating_sub(today_start) > 26 * 3_600_000
            || today_start
                .saturating_sub(since)
                .abs_diff(i64::from(days.saturating_sub(1)) * DAY)
                > 2 * 3_600_000
        {
            return Err("Invalid learning statistics window".into());
        }
        self.learning_overview_at(days, today_start, time, since)
    }
    fn learning_overview_at(&self, days: u8, today: i64, time: i64, since: i64) -> Result<Value> {
        let db = self.connect()?;
        let mut total = Counts::default();
        let mut banks: BTreeMap<String, (String, Counts)> = BTreeMap::new();
        let mut kinds: BTreeMap<String, Counts> = BTreeMap::new();
        // The frozen question owns historical type and bank attribution, even after edits/deletions.
        let mut statement = db.prepare("WITH RECURSIVE frozen AS MATERIALIZED (
            SELECT d.session_id,q.value AS content FROM session_documents d JOIN json_each(d.content,'$.questions') q
            WHERE EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=d.session_id AND a.submitted_at>=?1 AND a.submitted_at<=?2)
        ), classified(session_id,id,kind) AS (
            SELECT session_id,json_extract(content,'$.id'),COALESCE(json_extract(content,'$.question.questionKind'),CASE json_extract(content,'$.question.answerMode') WHEN 'choice' THEN json_extract(content,'$.question.choiceVariant') WHEN 'gap_fill' THEN 'grammar_fill' ELSE json_extract(content,'$.question.answerMode') END,'') FROM frozen WHERE json_extract(content,'$.question.parentId') IS NULL
            UNION ALL SELECT c.session_id,json_extract(f.content,'$.id'),c.kind FROM classified c JOIN frozen f ON f.session_id=c.session_id AND json_extract(f.content,'$.question.parentId')=c.id
        ) SELECT a.skipped,a.result,a.grade_kind,json_extract(f.content,'$.bankId'),json_extract(f.content,'$.bankTitle'),c.kind FROM attempts a JOIN frozen f ON f.session_id=a.session_id AND json_extract(f.content,'$.id')=a.snapshot_question_id JOIN classified c ON c.session_id=a.session_id AND c.id=a.snapshot_question_id WHERE a.submitted_at>=?1 AND a.submitted_at<=?2").map_err(err)?;
        let records = statement
            .query_map(params![since, time], |r| {
                Ok((
                    r.get::<_, bool>(0)?,
                    r.get::<_, Option<bool>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(err)?;
        for record in records {
            let (skipped, result, grade, bank, title, kind) = record.map_err(err)?;
            total.add(skipped, result, &grade);
            banks
                .entry(bank)
                .or_insert_with(|| (title, Counts::default()))
                .1
                .add(skipped, result, &grade);
            kinds.entry(kind).or_default().add(skipped, result, &grade);
        }
        let current_banks: std::collections::HashSet<String> = db
            .prepare("SELECT id FROM banks")
            .map_err(err)?
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(err)?;
        let banks: Vec<_> = banks.into_iter().map(|(id,(title,counts))| json!({"id":id,"title":title,"available":current_banks.contains(&id),"counts":counts})).collect();
        let kinds: Vec<_> = kinds
            .into_iter()
            .map(|(kind, counts)| json!({"kind":kind,"counts":counts}))
            .collect();
        let notes = self.learning_data()?.notes;
        let mut review = self.review_candidates(&db, today, time, &notes)?;
        review.truncate(20);
        Ok(
            json!({"days":days,"since":since,"through":time,"counts":total,"banks":banks,"kinds":kinds,"review":review,"backup":self.backup_status()?}),
        )
    }
    fn review_candidates(
        &self,
        db: &Connection,
        today: i64,
        time: i64,
        notes: &BTreeMap<String, Note>,
    ) -> Result<Vec<Value>> {
        let mut statement = db.prepare("SELECT question_id,submitted_at,result FROM attempts WHERE question_id IS NOT NULL AND submitted_at IS NOT NULL AND skipped=0 AND submitted_at<=?1 ORDER BY submitted_at DESC,rowid DESC").map_err(err)?;
        let mut history: HashMap<String, History> = HashMap::new();
        for item in statement
            .query_map([time], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<bool>>(2)?,
                ))
            })
            .map_err(err)?
        {
            let (id, at, result) = item.map_err(err)?;
            let entry = history.entry(id).or_default();
            entry.last_answered = entry.last_answered.max(at);
            if entry.latest.is_none() {
                if let Some(result) = result {
                    entry.latest = Some((at, result));
                }
            }
            if result == Some(false) {
                entry.wrong += 1;
            }
        }
        let mut statement = db.prepare("WITH RECURSIVE tree(root,id) AS (SELECT id,id FROM questions WHERE parent_id IS NULL UNION ALL SELECT t.root,q.id FROM tree t JOIN questions q ON q.parent_id=t.id) SELECT t.root,q.id,q.mode,b.id,b.title,root.stem FROM tree t JOIN questions q ON q.id=t.id JOIN questions root ON root.id=t.root JOIN banks b ON b.id=q.bank_id ORDER BY b.created_at DESC,root.position,q.position").map_err(err)?;
        let mut candidates: BTreeMap<String, (Value, i64, u8)> = BTreeMap::new();
        for row in statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(err)?
        {
            let (root, id, mode, bank, title, stem) = row.map_err(err)?;
            if mode
                .as_deref()
                .is_some_and(|mode| crate::question_metadata::COMPOSITE_MODES.contains(&mode))
            {
                continue;
            }
            let candidate = candidates.entry(root.clone()).or_insert_with(|| (json!({"rootId":root,"bankId":bank,"bankTitle":title,"stem":stem,"count":0,"reason":"stale","causes":[]}),0,3));
            candidate.0["count"] = json!(candidate.0["count"].as_u64().unwrap_or(0) + 1);
            for note_id in [&id, &root] {
                if let Some(cause) = notes.get(note_id).and_then(|note| note.cause.as_ref()) {
                    let cause = json!(cause);
                    if !list(&candidate.0, "causes").contains(&cause) {
                        candidate.0["causes"].as_array_mut().unwrap().push(cause);
                    }
                }
            }
            if let Some(h) = history.get(&id) {
                candidate.1 = candidate.1.max(h.last_answered);
                if let Some((at, correct)) = h.latest {
                    let priority = if !correct && h.wrong >= 2 {
                        0
                    } else if !correct {
                        1
                    } else if time.saturating_sub(at) >= 7 * DAY {
                        2
                    } else {
                        3
                    };
                    if priority < candidate.2 {
                        candidate.2 = priority;
                    }
                }
            }
        }
        let mut candidates: Vec<_> = candidates
            .into_values()
            .filter(|(_, last, priority)| *last < today && *priority < 3)
            .collect();
        candidates.sort_by_key(|(row, last, priority)| {
            (*priority, *last, text(row, "rootId").to_owned())
        });
        Ok(candidates
            .into_iter()
            .map(|(mut row, last, priority)| {
                row["reason"] = json!(["repeated_wrong", "wrong", "stale"][priority as usize]);
                row["lastAnsweredAt"] = json!(last);
                row
            })
            .collect())
    }
}

#[derive(Default)]
struct History {
    last_answered: i64,
    latest: Option<(i64, bool)>,
    wrong: usize,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    submitted: usize,
    skipped: usize,
    ungraded: usize,
    auto: Scores,
    self_assessed: Scores,
    ai: Scores,
    manual: Scores,
}
#[derive(Default, Serialize)]
struct Scores {
    graded: usize,
    correct: usize,
}
impl Counts {
    fn add(&mut self, skipped: bool, result: Option<bool>, kind: &str) {
        self.submitted += 1;
        if skipped {
            self.skipped += 1;
            return;
        }
        let Some(result) = result else {
            self.ungraded += 1;
            return;
        };
        let scores = match kind {
            "auto" => &mut self.auto,
            "self" => &mut self.self_assessed,
            "ai" => &mut self.ai,
            "manual" => &mut self.manual,
            _ => {
                self.ungraded += 1;
                return;
            }
        };
        scores.graded += 1;
        scores.correct += usize::from(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{exams::Paper, store::Pending};
    thread_local! { static CORRUPT_BEFORE_BACKUP_MARK: std::cell::Cell<bool> = const {std::cell::Cell::new(false)}; }
    pub(super) fn backup_mark_checkpoint(store: &Store) {
        if CORRUPT_BEFORE_BACKUP_MARK.with(|flag| flag.replace(false)) {
            std::fs::write(store.learning_path(), b"simulated metadata write failure").unwrap();
        }
    }

    #[test]
    fn published_backup_is_reported_as_saved_when_reminder_metadata_fails() {
        let (dir, store, _, id) = fixture();
        store
            .save_question_note(&id, "Archived note".into(), None)
            .unwrap();
        CORRUPT_BEFORE_BACKUP_MARK.with(|flag| flag.set(true));
        let archive = dir.path().join("saved.zip");
        let result = store.export_backup(&archive).unwrap();
        assert_eq!(result["path"], archive.display().to_string());
        assert!(result["reminderError"].is_string());
        let mut target = Store::new(dir.path().join("restored")).unwrap();
        target.restore(&archive).unwrap();
        assert_eq!(target.question_note(&id).unwrap()["body"], "Archived note");
    }

    fn fixture() -> (tempfile::TempDir, Store, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let sample: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
        let root = json!({"schemaVersion":3,"questions":[sample["questions"][0]],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":100,"missingFields":[]});
        let pending =
            Pending::new(serde_json::to_vec(&root).unwrap(), "Study bank".into()).unwrap();
        let bank = store.import_pending(&pending, None, "Study bank").unwrap();
        let bank = text(&bank, "bankId").to_owned();
        let id = text(&store.questions(Some(&bank), "", "", "").unwrap()[0], "id").to_owned();
        (dir, store, bank, id)
    }
    fn attempt(store: &Store, id: &str, at: i64, result: Option<bool>, kind: &str, skipped: bool) {
        let rows =
            crate::questions::read_scoped(&store.connect().unwrap(), &[], Some(&[id.into()]))
                .unwrap();
        let session = store
            .start_paper(Paper {
                question_ids: vec![id.into()],
                kind: "practice".into(),
                minutes: None,
                scores: vec![],
                total_cents: 0,
                digest: crate::paper::digest(&rows).unwrap(),
            })
            .unwrap();
        store.connect().unwrap().execute("UPDATE attempts SET submitted_at=?2,result=?3,grade_kind=?4,skipped=?5 WHERE session_id=?1",params![text(&session,"id"),at,result,kind,skipped]).unwrap();
    }
    #[test]
    fn notes_are_bounded_durable_and_private_to_full_backups() {
        let (dir, mut store, bank, id) = fixture();
        assert!(store.question_note(&id).unwrap().is_null());
        assert!(!store.learning_path().exists());
        assert!(store
            .save_question_note("missing", "text".into(), None)
            .is_err());
        assert!(store
            .save_question_note(&id, "x".repeat(20_001), None)
            .is_err());
        store
            .save_question_note(
                &id,
                "Check the assumptions".into(),
                Some(MistakeCause::Misread),
            )
            .unwrap();
        let backup = dir.path().join("study.zip");
        store.backup(&backup).unwrap();
        let shared = dir.path().join("bank.zip");
        store.export_bank(&bank, &shared).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(shared).unwrap()).unwrap();
        let root: Value = serde_json::from_reader(zip.by_name("questions.json").unwrap()).unwrap();
        assert!(!root.to_string().contains("Check the assumptions"));
        store
            .save_question_note(&id, "Replacement".into(), None)
            .unwrap();
        store.restore(&backup).unwrap();
        let reopened = Store::new(dir.path().into()).unwrap();
        assert_eq!(
            reopened.question_note(&id).unwrap()["body"],
            "Check the assumptions"
        );
        assert_eq!(reopened.question_note(&id).unwrap()["cause"], "misread");
        assert_eq!(
            reopened
                .connect()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            11
        );
        assert!(reopened.learning_data().unwrap().last_backup_at.is_none());
    }
    #[test]
    fn old_backups_clear_notes_and_invalid_learning_data_never_replaces_live_data() {
        let (dir, mut store, _, id) = fixture();
        let archive = dir.path().join("old.zip");
        store.backup(&archive).unwrap();
        store
            .save_question_note(&id, "Personal".into(), None)
            .unwrap();
        store.restore(&archive).unwrap();
        assert!(store.question_note(&id).unwrap().is_null());
        let invalid = dir.path().join("invalid.zip");
        let mut output = zip::ZipWriter::new(std::fs::File::create(&invalid).unwrap());
        use std::io::{Read, Write};
        let mut incoming = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        for i in 0..incoming.len() {
            let mut entry = incoming.by_index(i).unwrap();
            let name = entry.name().unwrap().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            if name == "manifest.json" {
                let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
                manifest["learningData"] = json!({"version":1,"notes":{"unknown":{"body":"x","cause":null,"updatedAt":0}},"lastBackupAt":null});
                bytes = serde_json::to_vec(&manifest).unwrap();
            }
            output
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            output.write_all(&bytes).unwrap();
        }
        output.finish().unwrap();
        store
            .save_question_note(&id, "Keep me".into(), None)
            .unwrap();
        assert!(store.restore(&invalid).is_err());
        assert_eq!(store.question_note(&id).unwrap()["body"], "Keep me");
    }
    #[test]
    fn unknown_learning_databases_are_not_reinitialized_and_reads_do_not_create_files() {
        let (_dir, store, _, id) = fixture();
        store.backup_status().unwrap();
        assert!(!store.learning_path().exists());
        Connection::open(store.learning_path())
            .unwrap()
            .execute_batch("CREATE TABLE other(value TEXT);")
            .unwrap();
        let before = std::fs::read(store.learning_path()).unwrap();
        assert!(store.question_note(&id).is_err());
        assert!(store.save_question_note(&id, "note".into(), None).is_err());
        assert_eq!(std::fs::read(store.learning_path()).unwrap(), before);
    }
    #[test]
    fn pending_restore_recovers_notes_and_blocks_offline_writes() {
        let (dir, store, _, id) = fixture();
        store
            .save_question_note(&id, "Previous".into(), None)
            .unwrap();
        let previous = store.learning_data().unwrap();
        let mut next = previous.clone();
        next.notes.get_mut(&id).unwrap().body = "Restored".into();
        store
            .prepare_settings_and_learning_restore(
                None,
                crate::backup::file_digest(&store.db_path()).unwrap().1,
                Some(LearningRestore {
                    previous: previous.clone(),
                    next: next.clone(),
                }),
            )
            .unwrap();
        assert!(store
            .save_question_note(&id, "Blocked".into(), None)
            .is_err());
        store.publish_learning(next).unwrap();
        drop(store);
        let reopened = Store::new(dir.path().into()).unwrap();
        assert_eq!(reopened.question_note(&id).unwrap()["body"], "Restored");
        reopened
            .prepare_settings_and_learning_restore(
                None,
                "0".repeat(64),
                Some(LearningRestore {
                    previous: reopened.learning_data().unwrap(),
                    next: previous,
                }),
            )
            .unwrap();
        reopened.finish_service_settings_restore(false).unwrap();
        assert_eq!(reopened.question_note(&id).unwrap()["body"], "Restored");
    }
    #[test]
    fn overview_separates_grading_and_uses_frozen_bank_and_type() {
        let (_dir, store, bank, id) = fixture();
        let today = 20 * DAY;
        for (result, kind, skip) in [
            (Some(true), "auto", false),
            (Some(false), "auto", false),
            (Some(true), "self", false),
            (None, "ungraded", false),
            (Some(false), "auto", true),
            (Some(false), "ai", false),
            (Some(true), "manual", false),
        ] {
            attempt(&store, &id, today - DAY, result, kind, skip);
        }
        attempt(&store, &id, today - 10 * DAY, Some(false), "auto", false);
        store
            .connect()
            .unwrap()
            .execute(
                "UPDATE questions SET mode='short_answer' WHERE id=?1",
                [&id],
            )
            .unwrap();
        store
            .connect()
            .unwrap()
            .execute("UPDATE banks SET title='Renamed' WHERE id=?1", [&bank])
            .unwrap();
        let data = store
            .learning_overview_at(7, today, today + 1, today - 6 * DAY)
            .unwrap();
        assert_eq!(data["counts"]["submitted"], 7);
        assert_eq!(data["counts"]["auto"], json!({"graded":2,"correct":1}));
        assert_eq!(data["counts"]["selfAssessed"]["graded"], 1);
        assert_eq!(data["counts"]["ai"]["graded"], 1);
        assert_eq!(data["counts"]["manual"]["graded"], 1);
        assert_eq!(data["counts"]["skipped"], 1);
        assert_eq!(data["counts"]["ungraded"], 1);
        assert_eq!(data["banks"][0]["title"], "Study bank");
        assert_eq!(data["kinds"][0]["kind"], "single");
        assert_eq!(
            store
                .learning_overview_at(30, today, today + 1, today - 29 * DAY)
                .unwrap()["counts"]["submitted"],
            8
        );
        store.delete_bank(&bank).unwrap();
        let data = store
            .learning_overview_at(7, today, today + 1, today - 6 * DAY)
            .unwrap();
        assert_eq!(data["counts"]["submitted"], 7);
        assert_eq!(data["banks"][0]["available"], false);
        assert!(list(&data, "review").is_empty());
        assert!(store.learning_overview(8, 0, 0).is_err());
        assert!(store.learning_overview(7, now(), 900).is_err());
    }
    #[test]
    fn statistics_accept_bounded_calendar_days_across_dst_and_reject_unbounded_ranges() {
        let (_dir, store, _, _) = fixture();
        let today = now() - 3_600_000;
        let since = today - 6 * DAY - 3_600_000;
        assert_eq!(
            store.learning_overview(7, today, since).unwrap()["since"],
            since
        );
        assert!(store.learning_overview(7, now() + DAY, since).is_err());
        assert!(store.learning_overview(7, today, -1).is_err());
        assert!(store.learning_overview(7, today, today - 60 * DAY).is_err());
    }
    #[test]
    fn reviews_rank_errors_exclude_today_and_ungraded_and_keep_complete_groups() {
        let (_dir, store, _, id) = fixture();
        let today = 20 * DAY;
        attempt(&store, &id, today - 2 * DAY, Some(false), "auto", false);
        attempt(&store, &id, today - DAY, Some(false), "auto", false);
        store
            .save_question_note(&id, "Try again".into(), Some(MistakeCause::Knowledge))
            .unwrap();
        let result = store
            .learning_overview_at(7, today, today + 1, today - 6 * DAY)
            .unwrap();
        assert_eq!(result["review"][0]["reason"], "repeated_wrong");
        assert_eq!(result["review"][0]["causes"], json!(["knowledge"]));
        attempt(&store, &id, today, Some(true), "auto", false);
        assert!(list(
            &store
                .learning_overview_at(7, today, today + 1, today - 6 * DAY)
                .unwrap(),
            "review"
        )
        .is_empty());
        let root: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
        let p = Pending::new(serde_json::to_vec(&root).unwrap(), "Groups".into()).unwrap();
        let bank = store.import_pending(&p, None, "Groups").unwrap();
        let rows = store
            .questions(Some(text(&bank, "bankId")), "", "", "")
            .unwrap();
        let rows = rows.as_array().unwrap();
        let group = rows
            .iter()
            .find(|r| text(&r["question"], "answerMode") == "reading")
            .unwrap();
        let group_id = text(group, "id");
        attempt(&store, group_id, today - 8 * DAY, Some(true), "auto", false);
        let result = store
            .learning_overview_at(30, today, today + 1, today - 29 * DAY)
            .unwrap();
        let review = list(&result, "review")
            .iter()
            .find(|r| r["rootId"] == group_id)
            .unwrap();
        assert_eq!(review["reason"], "stale");
        assert_eq!(review["count"], 6);
        assert!(list(&result, "kinds")
            .iter()
            .any(|r| r["kind"] == "reading"));
    }
    #[test]
    fn backup_reminder_records_only_successful_explicit_exports() {
        let (dir, store, _, id) = fixture();
        assert_eq!(store.backup_status().unwrap()["due"], true);
        assert!(store
            .export_backup(&dir.path().join("missing/backup.zip"))
            .is_err());
        assert!(store.learning_data().unwrap().last_backup_at.is_none());
        let archive = dir.path().join("backup.zip");
        store.export_backup(&archive).unwrap();
        assert!(archive.exists());
        assert_eq!(store.backup_status().unwrap()["due"], false);
        store
            .update_learning(|mut data| {
                data.last_backup_at = Some(now() - 8 * DAY);
                Ok(data)
            })
            .unwrap();
        store
            .save_question_note(&id, "New note".into(), None)
            .unwrap();
        assert_eq!(store.backup_status().unwrap()["due"], true);
        store.backup(&dir.path().join("recovery.zip")).unwrap();
        assert_eq!(store.backup_status().unwrap()["due"], true);
        store.save_question_note(&id, String::new(), None).unwrap();
        assert!(store.question_note(&id).unwrap().is_null());
        assert_eq!(store.backup_status().unwrap()["due"], true);
        assert!(store
            .learning_backup(&store.connect().unwrap())
            .unwrap()
            .notes
            .is_empty());
    }
}
