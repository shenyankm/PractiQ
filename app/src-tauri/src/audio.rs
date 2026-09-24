//! Local listening assets and per-session playback; no network or transcription.
use crate::{
    contract::{list, text, Result},
    store::{hash, now, read_bounded, Store},
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Write, path::Path};
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}

/// Use the target platform's audio reader, instead of trusting a filename or MIME hint.
pub fn audio_info(bytes: &[u8]) -> Result<(String, f64)> {
    if bytes.is_empty() || bytes.len() > crate::assets::LIMIT {
        return Err("Invalid audio size".into());
    }
    let mut file = tempfile::NamedTempFile::new().map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    let output = tempfile::NamedTempFile::new().map_err(err)?;
    let mut child = std::process::Command::new("/usr/bin/afinfo")
        .arg(file.path())
        .stdout(output.reopen().map_err(err)?)
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(err)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().map_err(err)? {
            if !status.success() {
                return Err("Unsupported or damaged audio".into());
            }
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Audio validation timed out".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let data = String::from_utf8(read_bounded(output.path(), 16 * 1024)?).map_err(err)?;
    let field = |key: &str| {
        data.lines()
            .find_map(|line| line.strip_prefix(key))
            .map(str::trim)
            .unwrap_or("")
    };
    let media = match field("File type ID:") {
        "WAVE" => "audio/wav",
        "MPG3" => "audio/mpeg",
        "m4af" | "mp4f" => "audio/mp4",
        "adts" => "audio/aac",
        _ => return Err("Use MP3, M4A/AAC or WAV audio".into()),
    };
    let duration = field("estimated duration:")
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= 86400.0)
        .ok_or("Invalid audio duration")?;
    if field("audio packets:").parse::<u64>().unwrap_or(0) == 0
        || field("audio bytes:").parse::<u64>().unwrap_or(0) == 0
    {
        return Err("Empty audio stream".into());
    }
    Ok((media.into(), duration))
}
pub fn valid_media(bytes: &[u8], media: &str) -> bool {
    if media.starts_with("image/") {
        crate::store::valid_image(bytes, media)
    } else {
        audio_info(bytes).is_ok_and(|(actual, _)| actual == media)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackAction {
    State,
    Start,
    Progress,
    Pause,
    End,
}
impl Store {
    pub fn stage_audio(&mut self, path: &Path) -> Result<Value> {
        let bytes = read_bounded(path, crate::assets::LIMIT)?;
        let (media, duration) = audio_info(&bytes)?;
        let digest = hash(&bytes);
        if !self.staged_audio.contains_key(&digest)
            && self
                .staged_audio
                .values()
                .map(|(_, v)| v.len())
                .sum::<usize>()
                + bytes.len()
                > 256 * 1024 * 1024
        {
            return Err("Staged audio exceeds 256 MiB".into());
        }
        let reference = json!({"objectKey":format!("audio/{digest}"),"sha256":digest,"mediaType":media,"sizeBytes":bytes.len()});
        self.staged_audio.insert(digest, (media, bytes));
        Ok(json!({"reference":reference,"duration":duration}))
    }
    pub fn persist_audio(&self, db: &rusqlite::Connection, tree: &[Value]) -> Result<()> {
        for reference in tree
            .iter()
            .filter_map(|q| q.get("audioRef").filter(|v| v.is_object()))
        {
            let digest = text(reference, "sha256");
            let Some((media, bytes)) = self.asset_bytes(digest)? else {
                continue;
            };
            if reference["sizeBytes"] != bytes.len() || text(reference, "mediaType") != media {
                return Err("Audio reference does not match asset".into());
            }
            let (_, duration) = audio_info(&bytes)?;
            for q in tree.iter().filter(|q| q["audioRef"]["sha256"] == digest) {
                if q["audioStartSeconds"].as_f64().unwrap_or(0.0) >= duration
                    || q["audioEndSeconds"]
                        .as_f64()
                        .is_some_and(|end| end > duration + 0.05)
                {
                    return Err("Audio segment exceeds file duration".into());
                }
            }
            self.write_asset(digest, &bytes)?;
            db.execute(
                "INSERT OR IGNORE INTO assets VALUES(?1,?2,?3,?4)",
                params![digest, media, bytes.len(), format!("assets/{digest}")],
            )
            .map_err(err)?;
        }
        Ok(())
    }
    pub fn listening_playback(
        &self,
        sid: &str,
        qid: &str,
        action: PlaybackAction,
        position: Option<f64>,
    ) -> Result<Value> {
        self.expire_exam(sid)?;
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        let (kind, submitted, finished): (String, Option<i64>, Option<i64>) = tx
            .query_row(
                "SELECT kind,submitted_at,finished_at FROM sessions WHERE id=?1",
                [sid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(err)?;
        let rows = crate::questions::session_rows(&tx, sid)?;
        let q = &rows
            .iter()
            .find(|r| {
                text(&r["question"], "id") == qid
                    && text(&r["question"], "answerMode") == "listening"
            })
            .ok_or("Listening group is not in this session")?["question"];
        let start = q["audioStartSeconds"].as_f64().unwrap_or(0.0);
        let end = q["audioEndSeconds"].as_f64().unwrap_or(86400.0);
        let limit = q["examPlayCount"].as_u64().unwrap_or(2);
        let restricted = kind != "practice" && submitted.is_none();
        let (mut used,mut pos,mut active,updated):(u64,f64,bool,i64)=tx.query_row("SELECT used,position,active,updated_at FROM listening_playback WHERE session_id=?1 AND question_id=?2",params![sid,qid],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?.unwrap_or((0,start,false,now()));
        if !matches!(action, PlaybackAction::State) {
            if submitted.is_some() || finished.is_some() {
                return Err("Session playback is locked; use review playback".into());
            }
            if self.asset_bytes(text(&q["audioRef"], "sha256"))?.is_none() {
                return Err("Listening audio is missing".into());
            }
            match action {
                PlaybackAction::Start => {
                    if !active {
                        if restricted && used >= limit {
                            return Err("No listening plays remaining".into());
                        }
                        used += 1;
                        pos = start;
                        active = true;
                    }
                }
                PlaybackAction::Progress | PlaybackAction::Pause | PlaybackAction::End => {
                    let next = position
                        .filter(|v| v.is_finite() && *v >= start && *v <= end + 0.1)
                        .ok_or("Invalid playback position")?;
                    if !active {
                        return Err("Listening playback has not started".into());
                    }
                    // Allow IPC timing jitter, but never an arbitrary forward/backward seek in an exam.
                    if restricted
                        && (next + 0.25 < pos
                            || next - pos > ((now() - updated).max(0) as f64 / 1000.0 + 2.0))
                    {
                        return Err("Seeking is disabled in exams".into());
                    }
                    pos = next;
                    if matches!(action, PlaybackAction::End) {
                        active = false;
                    }
                }
                PlaybackAction::State => {}
            }
            tx.execute("INSERT INTO listening_playback VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(session_id,question_id) DO UPDATE SET used=excluded.used,position=excluded.position,active=excluded.active,updated_at=excluded.updated_at",params![sid,qid,used,pos,active,now()]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(
            json!({"used":used,"position":pos,"active":active,"limit":limit,"restricted":restricted}),
        )
    }
}

/// Strip secrets at the native response boundary, including inherited materials.
pub fn redact_session(session: &mut Value) {
    let exam = text(session, "kind") != "practice";
    let finished = !session["submittedAt"].is_null() || !session["finishedAt"].is_null();
    let mut open = std::collections::HashMap::new();
    for a in list(session, "attempts") {
        for p in list(&a["snapshot"], "materials")
            .iter()
            .filter(|p| text(p, "answerMode") == "listening")
        {
            let entry = open.entry(text(p, "id").to_owned()).or_insert(true);
            *entry &= !a["submittedAt"].is_null();
        }
    }
    for a in session["attempts"].as_array_mut().into_iter().flatten() {
        let reveal = if exam {
            finished
        } else {
            !a["submittedAt"].is_null() || finished
        };
        let protected =
            exam || matches!(
                text(&a["snapshot"]["question"], "questionKind"),
                "translation" | "writing"
            ) || list(&a["snapshot"], "materials")
                .iter()
                .any(|p| text(p, "answerMode") == "listening");
        if !reveal && protected {
            strip_answers(&mut a["snapshot"]["question"]);
        }
        let materials = a["snapshot"]
            .get_mut("materials")
            .and_then(Value::as_array_mut);
        let mut listening_locked = false;
        for p in materials.into_iter().flatten() {
            let is_listening = text(p, "answerMode") == "listening";
            let unlocked = finished || (!exam && open.get(text(p, "id")).copied().unwrap_or(false));
            if (!reveal && protected) || (is_listening && !unlocked) {
                strip_answers(p);
            }
            if is_listening && !unlocked {
                p["transcript"] = json!([]);
                listening_locked = true;
            }
        }
        if listening_locked {
            if let Some(blocks) = a["snapshot"]["question"]["contentBlocks"].as_array_mut() {
                blocks.retain(|b| !crate::questions::answer_content(b));
            }
            if let Some(visuals) = a["snapshot"]["visuals"].as_array_mut() {
                visuals.retain(|v| !crate::questions::answer_content(v));
            }
        }
        if (!reveal && protected) || listening_locked {
            a["snapshot"]["question"]["sourceText"] = Value::Null;
            for visual in a["snapshot"]["visuals"]
                .as_array_mut()
                .into_iter()
                .flatten()
            {
                visual.as_object_mut().unwrap().remove("sourceRef");
            }
        }
    }
}
fn strip_answers(q: &mut Value) {
    for k in [
        "answerPayload",
        "analysis",
        "sourceText",
        "scoringRubric",
        "scoreSourceText",
    ] {
        q[k] = Value::Null;
    }
    for key in ["contentBlocks", "passage"] {
        if let Some(blocks) = q.get_mut(key).and_then(Value::as_array_mut) {
            blocks.retain(|b| !crate::questions::answer_content(b));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn english() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().join("data")).unwrap();
        let preview = store
            .preview_bank_zip(
                &Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/english.zip"),
            )
            .unwrap();
        let bank = store
            .import(text(&preview, "ticket"), None, "English")
            .unwrap();
        (dir, store, text(&bank, "bankId").into())
    }
    #[test]
    fn audio_selection_is_staged_and_checks_real_format() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into()).unwrap();
        let picked = store
            .stage_audio(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/resources/audio/chimes.wav"),
            )
            .unwrap();
        assert_eq!(picked["reference"]["mediaType"], "audio/wav");
        assert!(picked["duration"].as_f64().unwrap() > 0.0);
        assert_eq!(
            store
                .connect()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!store
            .dir
            .join("assets")
            .read_dir()
            .is_ok_and(|mut entries| entries.next().is_some()));
        store.staged_audio.clear();
        assert!(store
            .asset_bytes(text(&picked["reference"], "sha256"))
            .unwrap()
            .is_none());
        assert!(audio_info(b"not an audio file").is_err());
        assert!(audio_info(&vec![0; crate::assets::LIMIT + 1]).is_err());
        assert!(!valid_media(
            include_bytes!("../../fixtures/resources/audio/chimes.wav"),
            "audio/mpeg"
        ));
    }
    #[test]
    fn english_roundtrip_redaction_playback_and_immutable_history() {
        let (dir, store, bank) = english();
        let stats = store
            .question_stats(Some(&bank), &[], ("", "", ""))
            .unwrap();
        for kind in [
            "listening",
            "reading",
            "word_bank",
            "cloze",
            "grammar_fill",
            "sentence_selection",
            "paragraph_matching",
            "translation",
            "writing",
        ] {
            assert_eq!(stats["types"][kind], 1);
            assert_eq!(
                store
                    .questions(Some(&bank), "", kind, "")
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
        }
        let roots = store.questions(Some(&bank), "", "", "").unwrap();
        let root = roots
            .as_array()
            .unwrap()
            .iter()
            .find(|r| text(&r["question"], "answerMode") == "listening")
            .unwrap();
        let qid = text(root, "id");
        let hash = text(&root["question"]["audioRef"], "sha256");
        let selected =
            crate::paper::selected_rows(&store.question_rows().unwrap(), &[qid.into()]).unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![qid.into()],
                kind: "self_test".into(),
                minutes: None,
                scores: vec![100, 100],
                total_cents: 200,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        assert_eq!(
            session["attempts"][0]["snapshot"]["materials"][0]["transcript"],
            json!([])
        );
        assert!(session["attempts"][0]["snapshot"]["question"]["answerPayload"].is_null());
        assert!(store
            .listening_playback(sid, "foreign", PlaybackAction::Start, None)
            .is_err());
        assert_eq!(
            store
                .listening_playback(sid, qid, PlaybackAction::State, None)
                .unwrap()["used"],
            0
        );
        assert_eq!(
            store
                .listening_playback(sid, qid, PlaybackAction::Start, None)
                .unwrap()["used"],
            1
        );
        store
            .listening_playback(sid, qid, PlaybackAction::Pause, Some(0.2))
            .unwrap();
        assert!(store
            .listening_playback(sid, qid, PlaybackAction::Progress, Some(100.0))
            .is_err());
        let reopened = Store::new(store.dir.clone()).unwrap();
        let state = reopened
            .listening_playback(sid, qid, PlaybackAction::Start, None)
            .unwrap();
        assert_eq!(state["used"], 1);
        assert_eq!(state["position"], 0.2);
        reopened
            .listening_playback(sid, qid, PlaybackAction::End, Some(0.3))
            .unwrap();
        assert_eq!(
            reopened
                .listening_playback(sid, qid, PlaybackAction::Start, None)
                .unwrap()["used"],
            2
        );
        reopened
            .listening_playback(sid, qid, PlaybackAction::End, Some(0.4))
            .unwrap();
        assert!(reopened
            .listening_playback(sid, qid, PlaybackAction::Start, None)
            .is_err());
        let mut edited: Vec<_> = selected.iter().map(|r| r["question"].clone()).collect();
        edited[0]["transcript"] = json!([{"partType":"text","textValue":"NEW TRANSCRIPT"}]);
        edited[0]["instructions"] = json!("New instructions");
        reopened
            .save_question_tree(&bank, Some(qid), edited)
            .unwrap();
        let export = dir.path().join("bank.zip");
        reopened.export_bank(&bank, &export).unwrap();
        let mut other = Store::new(dir.path().join("other")).unwrap();
        let p = other.preview_bank_zip(&export).unwrap();
        let imported = other.import(text(&p, "ticket"), None, "Roundtrip").unwrap();
        let imported = other
            .questions(Some(text(&imported, "bankId")), "", "listening", "")
            .unwrap();
        assert_eq!(
            imported[0]["question"]["transcript"][0]["textValue"],
            "NEW TRANSCRIPT"
        );
        reopened.delete_bank(&bank).unwrap();
        assert!(reopened.asset_bytes(hash).unwrap().is_some());
        let backup = dir.path().join("backup.zip");
        reopened.backup(&backup).unwrap();
        other.restore(&backup).unwrap();
        assert_eq!(
            other
                .listening_playback(sid, qid, PlaybackAction::State, None)
                .unwrap()["used"],
            2
        );
        let finished = other.submit_paper(sid, false).unwrap();
        assert!(
            finished["attempts"][0]["snapshot"]["materials"][0]["transcript"][0]["textValue"]
                .as_str()
                .unwrap()
                .contains("Three evenly")
        );
        assert!(other.asset_bytes(hash).unwrap().is_some());
    }
    #[test]
    fn listening_practice_reveals_transcript_only_after_whole_group() {
        let (_dir, store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id");
        let selected =
            crate::paper::selected_rows(&store.question_rows().unwrap(), &[root.into()]).unwrap();
        let s = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root.into()],
                kind: "practice".into(),
                minutes: None,
                scores: vec![],
                total_cents: 0,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&s, "id");
        let first = store
            .save_attempt((sid, 0), json!({"correct":["B"]}), 0, true, false, None)
            .unwrap();
        assert_eq!(
            first["attempts"][0]["snapshot"]["materials"][0]["transcript"],
            json!([])
        );
        let done = store
            .save_attempt((sid, 1), Value::Null, 0, true, true, None)
            .unwrap();
        assert!(!list(
            &done["attempts"][0]["snapshot"]["materials"][0],
            "transcript"
        )
        .is_empty());
    }
}
