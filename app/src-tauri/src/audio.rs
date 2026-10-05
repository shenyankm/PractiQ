//! Local listening assets and per-session playback; no network or transcription.
use crate::{
    contract::{list, text, Result},
    store::{err, hash, read_bounded, Store},
};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io::Cursor, path::Path};

/// Probe and decode bounded input; filenames and supplied MIME types are untrusted.
pub fn audio_info(bytes: &[u8]) -> Result<(String, f64)> {
    use symphonia::core::{
        codecs::audio::{
            well_known::{CODEC_ID_AAC, CODEC_ID_MP3},
            AudioDecoderOptions,
        },
        formats::{probe::Hint, FormatOptions, TrackType},
        io::{MediaSourceStream, MediaSourceStreamOptions},
        meta::MetadataOptions,
    };
    if bytes.is_empty() || bytes.len() > crate::assets::LIMIT {
        return Err("Invalid audio size".into());
    }
    let source = MediaSourceStream::new(
        Box::new(Cursor::new(bytes.to_vec())),
        MediaSourceStreamOptions::default(),
    );
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(err)?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or("Empty audio stream")?;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("Missing audio parameters")?;
    let media = if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        "audio/wav"
    } else if bytes.get(4..8) == Some(b"ftyp") {
        "audio/mp4"
    } else if parameters.codec == CODEC_ID_MP3 {
        "audio/mpeg"
    } else if parameters.codec == CODEC_ID_AAC {
        "audio/aac"
    } else {
        return Err("Use MP3, M4A/AAC or WAV audio".into());
    };
    let id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(parameters, &AudioDecoderOptions::default())
        .map_err(err)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut duration = 0.0;
    loop {
        if std::time::Instant::now() >= deadline {
            return Err("Audio validation timed out".into());
        }
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(e) => return Err(err(e)),
        };
        if packet.track_id != id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(err)?;
        duration += decoded.frames() as f64 / decoded.spec().rate() as f64;
        if !duration.is_finite() || duration > 86400.0 {
            return Err("Invalid audio duration".into());
        }
    }
    if duration <= 0.0 {
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
pub(crate) fn validate_segment(q: &Value, duration: f64) -> Result<()> {
    if q["audioStartSeconds"].as_f64().unwrap_or(0.0) >= duration
        || q["audioEndSeconds"]
            .as_f64()
            .is_some_and(|end| end > duration + 0.05)
    {
        return Err("Audio segment exceeds file duration".into());
    }
    Ok(())
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
        self.stage_audio_bytes(bytes)
    }
    pub fn stage_audio_bytes(&mut self, bytes: Vec<u8>) -> Result<Value> {
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
        let lease = crate::store::id();
        self.audio_leases.insert(lease.clone(), digest.clone());
        self.staged_audio.insert(digest, (media, bytes));
        Ok(json!({"reference":reference,"duration":duration,"lease":lease}))
    }
    /// Release only this import; other editors may hold the same audio bytes.
    pub fn release_audio(&mut self, lease: &str) {
        if let Some(digest) = self.audio_leases.remove(lease) {
            if !self.audio_leases.values().any(|hash| hash == &digest) {
                self.staged_audio.remove(&digest);
            }
        }
    }
    pub fn persist_audio(&self, db: &rusqlite::Connection, tree: &[Value]) -> Result<()> {
        for question in tree.iter().filter(|q| q["audioRef"].is_object()) {
            let reference = &question["audioRef"];
            let digest = text(reference, "sha256");
            let Some((media, bytes)) = self.asset_bytes(digest)? else {
                // Preserve existing incomplete imports, but never save a new dangling reference.
                let previous: Option<String> = db
                    .query_row(
                        "SELECT audio_ref FROM listening_questions WHERE question_id=?1",
                        [text(question, "id")],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(err)?;
                if previous
                    .as_deref()
                    .and_then(|v| serde_json::from_str::<Value>(v).ok())
                    .as_ref()
                    != Some(reference)
                {
                    return Err(crate::language::error("LOCAL_AUDIO_MISSING", json!({})));
                }
                continue;
            };
            if reference["sizeBytes"] != bytes.len() || text(reference, "mediaType") != media {
                return Err("Audio reference does not match asset".into());
            }
            let (_, duration) = audio_info(&bytes)?;
            for q in tree.iter().filter(|q| q["audioRef"]["sha256"] == digest) {
                validate_segment(q, duration)?;
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
        let document = self.session_document_cache.borrow();
        let selected;
        let q = if let Some((_, doc)) = document.as_ref().filter(|(id, _)| id == sid) {
            crate::questions::question_from_document(doc, qid)?
        } else {
            // Large documents retain the selective read-through path instead of allocating the full tree per tick.
            selected = crate::questions::session_question(&tx, sid, qid)?;
            &selected
        };
        if text(q, "answerMode") != "listening" {
            return Err("Listening group is not in this session".into());
        }
        let start = q["audioStartSeconds"].as_f64().unwrap_or(0.0);
        let end = q["audioEndSeconds"].as_f64().unwrap_or(86400.0);
        let limit = q["examPlayCount"].as_u64().unwrap_or(2);
        let restricted = kind != "practice" && submitted.is_none();
        // updated_at stores this play's unpaused segment start; zero means paused.
        let (mut used, mut pos, mut active, mut active_since, mut active_elapsed_ms):
            (u64, f64, bool, i64, i64) = tx.query_row(
                "SELECT used,position,active,updated_at,active_elapsed_ms FROM listening_playback WHERE session_id=?1 AND question_id=?2",
                params![sid,qid],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
            ).optional().map_err(err)?.unwrap_or((0,start,false,0,0));
        if !matches!(action, PlaybackAction::State) {
            let at = self.session_clock.now()?;
            if submitted.is_some() || finished.is_some() {
                return Err("Session playback is locked; use review playback".into());
            }
            if matches!(action, PlaybackAction::Start)
                && self.asset_bytes(text(&q["audioRef"], "sha256"))?.is_none()
            {
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
                        active_since = at;
                        active_elapsed_ms = 0;
                    } else if active_since == 0 {
                        active_since = at;
                    } else {
                        // Reopening an active play must not count time spent outside the player.
                        active_elapsed_ms = ((pos - start - 2.0).max(0.0) * 1000.0).ceil() as i64;
                        active_since = at;
                    }
                }
                PlaybackAction::Progress | PlaybackAction::Pause | PlaybackAction::End => {
                    let next = position
                        .filter(|v| v.is_finite() && *v >= start && *v <= end + 0.1)
                        .ok_or("Invalid playback position")?;
                    if !active {
                        return Err("Listening playback has not started".into());
                    }
                    if active_since == 0 {
                        if !matches!(action, PlaybackAction::Pause) {
                            return Err("Listening playback is paused".into());
                        }
                    } else {
                        // The two-second IPC allowance applies once per play, even across pauses.
                        let elapsed = active_elapsed_ms
                            .saturating_add(at.saturating_sub(active_since).max(0));
                        if restricted
                            && (next + 0.25 < pos || next - start > elapsed as f64 / 1000.0 + 2.0)
                        {
                            return Err("Seeking is disabled in exams".into());
                        }
                        pos = if restricted { pos.max(next) } else { next };
                        if matches!(action, PlaybackAction::Pause) {
                            active_elapsed_ms = elapsed;
                            active_since = 0;
                        } else if matches!(action, PlaybackAction::End) {
                            active = false;
                            active_since = 0;
                        }
                    }
                }
                PlaybackAction::State => {}
            }
            tx.execute("INSERT INTO listening_playback(session_id,question_id,used,position,active,updated_at,active_elapsed_ms) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id,question_id) DO UPDATE SET used=excluded.used,position=excluded.position,active=excluded.active,updated_at=excluded.updated_at,active_elapsed_ms=excluded.active_elapsed_ms",params![sid,qid,used,pos,active,active_since,active_elapsed_ms]).map_err(err)?;
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
        if a.get("snapshot").is_none() {
            continue;
        }
        let submitted = !a["submittedAt"].is_null();
        redact_snapshot(&mut a["snapshot"], exam, finished, submitted, &open);
    }
}
pub(crate) fn redact_snapshot(
    snapshot: &mut Value,
    exam: bool,
    finished: bool,
    submitted: bool,
    open: &std::collections::HashMap<String, bool>,
) {
    let reveal = if exam {
        finished
    } else {
        submitted || finished
    };
    let protected =
        exam || matches!(
            text(&snapshot["question"], "questionKind"),
            "translation" | "writing"
        ) || list(snapshot, "materials")
            .iter()
            .any(|p| text(p, "answerMode") == "listening");
    if !reveal && protected {
        strip_answers(&mut snapshot["question"]);
    }
    let materials = snapshot.get_mut("materials").and_then(Value::as_array_mut);
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
    if (!reveal && protected) || listening_locked {
        if let Some(groups) = snapshot["groups"].as_array_mut() {
            groups.retain(|g| {
                !crate::exams::answer_text(text(g, "title"))
                    && !crate::exams::answer_text(text(g, "instructions"))
            });
        }
        if let Some(visuals) = snapshot["visuals"].as_array_mut() {
            visuals.retain(|v| !crate::questions::answer_content(v));
        }
    }
    if listening_locked {
        if let Some(blocks) = snapshot["question"]["contentBlocks"].as_array_mut() {
            blocks.retain(|b| !crate::questions::answer_content(b));
        }
    }
    if (!reveal && protected) || listening_locked {
        snapshot["question"]["sourceText"] = Value::Null;
        for visual in snapshot["visuals"].as_array_mut().into_iter().flatten() {
            if let Some(visual) = visual.as_object_mut() {
                visual.remove("sourceRef");
            }
        }
    }
}
fn strip_answers(q: &mut Value) {
    crate::exams::strip_answer_lines(q);
    crate::exams::clear_answer_fields(q);
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
    fn unsubmitted_writing_hides_answer_lines_in_question_text() {
        let mut session = json!({"kind":"practice","submittedAt":null,"finishedAt":null,"attempts":[{
            "submittedAt":null,
            "snapshot":{"question":{"questionKind":"writing","stem":"Write a letter\nReference answer:\nSECRET","instructions":"Use 100 words | 参考答案： | SECRET","contentBlocks":[],"passage":[]},"materials":[],"visuals":[]}
        }]});
        redact_session(&mut session);
        let question = &session["attempts"][0]["snapshot"]["question"];
        assert_eq!(question["stem"], "Write a letter");
        assert_eq!(question["instructions"], "Use 100 words");
        assert!(!question.to_string().contains("SECRET"));
    }
    #[test]
    fn protected_practice_hides_answer_groups_and_visuals_until_submission() {
        for kind in ["writing", "translation", "listening"] {
            let original = json!({"kind":"practice","submittedAt":null,"finishedAt":null,"attempts":[{
                "submittedAt":null,
                "snapshot":{
                    "question":{"questionKind":if kind == "listening" { "choice" } else { kind },"contentBlocks":[],"passage":[]},
                    "materials":if kind == "listening" { json!([{"id":"root","answerMode":"listening","transcript":[]}]) } else { json!([]) },
                    "groups":[{"title":"Prompt","instructions":"Read this"},{"title":"Answer: SECRET","instructions":"Reveal"},{"title":"More context","instructions":"Answer: SECRET"}],
                    "visuals":[{"role":"question","imageRef":{"sha256":"question"},"sourceRef":{"sha256":"full-page"}},{"role":"answer","imageRef":{"sha256":"SECRET"}}]
                }
            }]});
            let mut pending = original.clone();
            redact_session(&mut pending);
            let snapshot = &pending["attempts"][0]["snapshot"];
            assert_eq!(snapshot["groups"].as_array().unwrap().len(), 1, "{kind}");
            assert_eq!(snapshot["visuals"].as_array().unwrap().len(), 1, "{kind}");
            assert!(snapshot["visuals"][0].get("sourceRef").is_none(), "{kind}");
            assert!(!snapshot.to_string().contains("SECRET"), "{kind}");

            let mut submitted = original;
            submitted["attempts"][0]["submittedAt"] = json!(1);
            redact_session(&mut submitted);
            let snapshot = &submitted["attempts"][0]["snapshot"];
            assert_eq!(snapshot["groups"].as_array().unwrap().len(), 3, "{kind}");
            assert_eq!(snapshot["visuals"].as_array().unwrap().len(), 2, "{kind}");
        }
    }
    #[test]
    fn restore_rejects_audio_segments_past_duration_in_questions_and_snapshots() {
        let (dir, store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let digest = text(&roots[0]["question"]["audioRef"], "sha256");
        let (_, bytes) = store.asset_bytes(digest).unwrap().unwrap();
        let duration = audio_info(&bytes).unwrap().1;
        let original_start = roots[0]["question"]["audioStartSeconds"]
            .as_f64()
            .unwrap_or(0.0);
        let original_end = roots[0]["question"]["audioEndSeconds"].as_f64();
        let db = store.connect().unwrap();
        db.execute(
            "UPDATE listening_questions SET end_seconds=?1 WHERE question_id=?2",
            params![duration + 1.0, root],
        )
        .unwrap();
        let current_backup = dir.path().join("bad-current.zip");
        store.backup(&current_backup).unwrap();
        let mut restored = Store::new(dir.path().join("restored")).unwrap();
        assert!(restored
            .restore(&current_backup)
            .unwrap_err()
            .to_string()
            .contains("duration"));
        assert!(restored.banks().unwrap().as_array().unwrap().is_empty());

        db.execute(
            "UPDATE listening_questions SET start_seconds=?1,end_seconds=?2 WHERE question_id=?3",
            params![original_start, original_end, root],
        )
        .unwrap();
        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root],
                kind: "practice".into(),
                minutes: None,
                scores: vec![],
                total_cents: 0,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        let raw: String = db
            .query_row(
                "SELECT content FROM session_documents WHERE session_id=?1",
                [sid],
                |r| r.get(0),
            )
            .unwrap();
        let mut document: Value = serde_json::from_str(&raw).unwrap();
        let question = document["questions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row["question"]["audioRef"]["sha256"] == digest)
            .unwrap();
        question["question"]["audioStartSeconds"] = json!(duration + 1.0);
        question["question"]["audioEndSeconds"] = json!(duration + 2.0);
        db.execute(
            "UPDATE session_documents SET content=?1 WHERE session_id=?2",
            params![document.to_string(), sid],
        )
        .unwrap();
        let snapshot_backup = dir.path().join("bad-snapshot.zip");
        store.backup(&snapshot_backup).unwrap();
        assert!(restored
            .restore(&snapshot_backup)
            .unwrap_err()
            .to_string()
            .contains("duration"));
        assert!(restored.banks().unwrap().as_array().unwrap().is_empty());
    }
    #[test]
    fn question_save_collects_replaced_audio_and_failed_persistence() {
        let (dir, mut store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let old_hash = text(&roots[0]["question"]["audioRef"], "sha256").to_owned();
        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let mut tree: Vec<_> = selected.iter().map(|row| row["question"].clone()).collect();
        let mut audio = include_bytes!("../../fixtures/resources/audio/chimes.wav").to_vec();
        *audio.last_mut().unwrap() ^= 1;
        let file = dir.path().join("replacement.wav");
        std::fs::write(&file, &audio).unwrap();
        let replacement = store.stage_audio(&file).unwrap();
        let replacement_hash = text(&replacement["reference"], "sha256").to_owned();
        tree[0]["audioRef"] = replacement["reference"].clone();
        store
            .save_question_tree(&bank, Some(&root), tree.clone())
            .unwrap();
        assert!(!store.asset_path(&old_hash).unwrap().exists());
        assert!(store.asset_path(&replacement_hash).unwrap().exists());

        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root.clone()],
                kind: "practice".into(),
                minutes: None,
                scores: vec![],
                total_cents: 0,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        tree[0]["audioRef"] = Value::Null;
        store
            .save_question_tree(&bank, Some(&root), tree.clone())
            .unwrap();
        assert!(store.asset_path(&replacement_hash).unwrap().exists());

        *audio.last_mut().unwrap() ^= 3;
        std::fs::write(&file, &audio).unwrap();
        let failed = store.stage_audio(&file).unwrap();
        let failed_hash = text(&failed["reference"], "sha256").to_owned();
        tree[0]["audioRef"] = failed["reference"].clone();
        tree[0]["id"] = json!("missing-root");
        for child in tree.iter_mut().skip(1) {
            child["parentId"] = json!("missing-root");
        }
        assert!(store
            .save_question_tree(&bank, Some("missing-root"), tree)
            .is_err());
        assert!(!store.asset_path(&failed_hash).unwrap().exists());
        assert!(!store
            .connect()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE hash=?1)",
                [&failed_hash],
                |row| row.get::<_, bool>(0)
            )
            .unwrap());
    }
    #[test]
    fn deleting_unreferenced_listening_question_collects_audio() {
        let (_dir, store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id");
        let digest = text(&roots[0]["question"]["audioRef"], "sha256");
        store.delete_question(root).unwrap();
        assert!(!store.asset_path(digest).unwrap().exists());
        assert!(store.asset_bytes(digest).unwrap().is_none());
    }
    #[test]
    fn audio_probe_decodes_aac_containers_without_platform_tools() {
        // Fixtures: afconvert chimes.wav chimes.{m4a,aac} -f {m4af,adts} -d aac.
        for (bytes, expected) in [
            (
                include_bytes!("../../fixtures/resources/audio/chimes.m4a").as_slice(),
                "audio/mp4",
            ),
            (
                include_bytes!("../../fixtures/resources/audio/chimes.aac").as_slice(),
                "audio/aac",
            ),
        ] {
            let (media, duration) =
                audio_info(bytes).unwrap_or_else(|e| panic!("{expected}: {e:?}"));
            assert_eq!(media, expected);
            assert!((2.9..3.3).contains(&duration), "{duration}");
            assert!(!valid_media(bytes, "audio/wav"));
            assert!(audio_info(&bytes[..16]).is_err());
        }
    }
    #[test]
    fn audio_probe_accepts_id3_prefixed_aac() {
        // Empty ID3v2.4 tag followed by the existing ADTS fixture.
        let mut bytes = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        bytes.extend_from_slice(include_bytes!("../../fixtures/resources/audio/chimes.aac"));
        let (media, duration) = audio_info(&bytes).unwrap();
        assert_eq!(media, "audio/aac");
        assert!((2.9..3.3).contains(&duration), "{duration}");
        assert!(valid_media(&bytes, "audio/aac"));
    }
    #[test]
    fn audio_leases_isolate_stale_cleanup_and_missing_references_cannot_be_saved() {
        let (_dir, mut store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let rows = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let mut tree: Vec<_> = rows.iter().map(|row| row["question"].clone()).collect();
        let mut bytes = include_bytes!("../../fixtures/resources/audio/chimes.wav").to_vec();
        *bytes.last_mut().unwrap() ^= 1;
        let stale = store.stage_audio_bytes(bytes.clone()).unwrap();
        let live = store.stage_audio_bytes(bytes.clone()).unwrap();
        assert_ne!(stale["lease"], live["lease"]);
        store.release_audio(text(&stale, "lease"));
        store.release_audio(text(&stale, "lease")); // A duplicate late release is harmless.
        assert!(store
            .asset_bytes(text(&live["reference"], "sha256"))
            .unwrap()
            .is_some());
        tree[0]["audioRef"] = live["reference"].clone();
        store
            .save_question_tree(&bank, Some(&root), tree.clone())
            .unwrap();
        store.release_audio(text(&live, "lease"));
        assert!(store.staged_audio.is_empty());
        assert!(store.audio_leases.is_empty());
        assert!(store
            .asset_bytes(text(&live["reference"], "sha256"))
            .unwrap()
            .is_some());

        *bytes.last_mut().unwrap() ^= 2;
        let expired = store.stage_audio_bytes(bytes).unwrap();
        store.release_audio(text(&expired, "lease"));
        tree[0]["audioRef"] = expired["reference"].clone();
        assert_eq!(
            store
                .save_question_tree(&bank, Some(&root), tree)
                .unwrap_err()
                .code,
            "LOCAL_AUDIO_MISSING"
        );
        let saved = store.questions(Some(&bank), "", "listening", "").unwrap();
        assert_eq!(saved[0]["question"]["audioRef"], live["reference"]);
    }

    #[test]
    fn unchanged_missing_audio_from_an_incomplete_import_remains_editable() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().to_path_buf()).unwrap();
        let preview = store
            .preview(
                include_bytes!("../../fixtures/english.json").to_vec(),
                "Partial".into(),
            )
            .unwrap();
        let bank = store
            .import(text(&preview, "ticket"), None, "Partial")
            .unwrap();
        let bank = text(&bank, "bankId");
        let roots = store.questions(Some(bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id");
        let rows = crate::paper::selected_rows(&store.question_rows().unwrap(), &[root.to_owned()])
            .unwrap();
        let mut tree: Vec<_> = rows.iter().map(|row| row["question"].clone()).collect();
        tree[0]["instructions"] = json!("Updated instructions");
        store.save_question_tree(bank, Some(root), tree).unwrap();
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
    fn playback_progress_does_not_rehash_the_audio_file() {
        let (_dir, store, bank) = english();
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let digest = text(&roots[0]["question"]["audioRef"], "sha256");
        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root.clone()],
                kind: "practice".into(),
                minutes: None,
                scores: vec![],
                total_cents: 0,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .unwrap();
        std::fs::remove_file(store.asset_path(digest).unwrap()).unwrap();
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(0.1))
            .is_ok());
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .is_err());
    }
    #[test]
    fn exam_playback_uses_continuous_time_across_clock_jumps_and_sleep() {
        let (_dir, store, bank) = english();
        let wall = 1_800_000_000_000;
        store.session_clock.set(wall, 1_000);
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root.clone()],
                kind: "self_test".into(),
                minutes: None,
                scores: vec![100, 100],
                total_cents: 200,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .unwrap();
        store.session_clock.set(wall - 120_000, 4_000);
        assert_eq!(
            store
                .listening_playback(sid, &root, PlaybackAction::Progress, Some(3.0))
                .unwrap()["position"],
            3.0
        );
        store.session_clock.set(wall + 7_200_000, 5_000);
        assert_eq!(
            store
                .listening_playback(sid, &root, PlaybackAction::Pause, Some(4.0))
                .unwrap()["position"],
            4.0
        );
        // Sleep while paused does not grant extra seek allowance or consume another play.
        store.session_clock.set(wall + 7_200_000, 65_000);
        assert_eq!(
            store
                .listening_playback(sid, &root, PlaybackAction::Start, None)
                .unwrap()["used"],
            1
        );
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(9.0))
            .is_err());
        store.session_clock.set(wall - 120_000, 66_000);
        assert_eq!(
            store
                .listening_playback(sid, &root, PlaybackAction::Progress, Some(5.0))
                .unwrap()["position"],
            5.0
        );
    }

    #[test]
    fn exam_progress_cannot_accumulate_seek_allowance_across_updates_or_pauses() {
        let (_dir, store, bank) = english();
        // CI scheduling delays must not count as actual audio playback.
        store.session_clock.set(crate::store::now(), 1_000);
        let roots = store.questions(Some(&bank), "", "listening", "").unwrap();
        let root = text(&roots[0], "id").to_owned();
        let selected = crate::paper::selected_rows(
            &store.question_rows().unwrap(),
            std::slice::from_ref(&root),
        )
        .unwrap();
        let session = store
            .start_paper(crate::exams::Paper {
                question_ids: vec![root.clone()],
                kind: "self_test".into(),
                minutes: None,
                scores: vec![100, 100],
                total_cents: 200,
                digest: crate::paper::digest(&selected).unwrap(),
            })
            .unwrap();
        let sid = text(&session, "id");
        store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .unwrap();
        store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(1.8))
            .unwrap();
        store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(1.56))
            .unwrap();
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(1.32))
            .is_err());
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(2.8))
            .is_err());
        store.connect().unwrap().execute(
            "UPDATE listening_playback SET updated_at=updated_at-60000 WHERE session_id=?1 AND question_id=?2",
            params![sid,root],
        ).unwrap();
        assert_eq!(
            store
                .listening_playback(sid, &root, PlaybackAction::Start, None)
                .unwrap()["used"],
            1
        );
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(2.8))
            .is_err());
        store
            .listening_playback(sid, &root, PlaybackAction::Pause, Some(1.8))
            .unwrap();
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(2.8))
            .is_err());
        let resumed = store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .unwrap();
        assert_eq!(resumed["used"], 1);
        assert_eq!(resumed["position"], 1.8);
        assert!(store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(2.8))
            .is_err());

        store
            .listening_playback(sid, &root, PlaybackAction::End, Some(1.8))
            .unwrap();
        store
            .listening_playback(sid, &root, PlaybackAction::Start, None)
            .unwrap();
        store.connect().unwrap().execute(
            "UPDATE listening_playback SET updated_at=updated_at+60000 WHERE session_id=?1 AND question_id=?2",
            params![sid,root],
        ).unwrap();
        store
            .listening_playback(sid, &root, PlaybackAction::Progress, Some(0.1))
            .unwrap();
        store
            .listening_playback(sid, &root, PlaybackAction::Pause, Some(0.1))
            .unwrap();
        let elapsed: i64 = store.connect().unwrap().query_row(
            "SELECT active_elapsed_ms FROM listening_playback WHERE session_id=?1 AND question_id=?2",
            params![sid,root], |row| row.get(0),
        ).unwrap();
        assert_eq!(elapsed, 0);
    }
    #[test]
    fn english_roundtrip_redaction_playback_and_immutable_history() {
        let (dir, store, bank) = english();
        let stats = store
            .question_stats(std::slice::from_ref(&bank), ("", "", ""))
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
            let preview = store
                .preview_paper(
                    serde_json::from_value(json!({
                        "bank_ids":[bank],"search":"","mode":kind,"filter":"",
                        "selection":"quota","count":0,"quotas":{kind:1},"question_ids":[],
                        "random":false,"total_cents":100
                    }))
                    .unwrap(),
                )
                .unwrap();
            assert_eq!(list(&preview, "questionIds").len(), 1);
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
        assert_eq!(
            s["attempts"][0]["snapshot"]["materials"][0]["transcript"],
            json!([])
        );
        let first = store
            .save_attempt((sid, 0), json!({"correct":["B"]}), 0, true, false)
            .unwrap();
        assert_eq!(
            first["attempts"][0]["snapshot"]["materials"][0]["transcript"],
            json!([])
        );
        let done = store
            .save_attempt((sid, 1), Value::Null, 0, true, true)
            .unwrap();
        assert!(!list(
            &done["attempts"][0]["snapshot"]["materials"][0],
            "transcript"
        )
        .is_empty());
    }
}
