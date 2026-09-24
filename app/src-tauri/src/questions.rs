//! The only mapping between normalized current questions and the wire contract.
use crate::{
    contract::{self, list, text, Result},
    store::{id, Store},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
fn err(e: impl std::fmt::Display) -> crate::AppError {
    e.to_string().into()
}
pub fn composite(q: &Value) -> bool {
    matches!(
        text(q, "answerMode"),
        "reading" | "word_bank" | "cloze" | "listening" | "gap_fill"
    )
}
pub(crate) fn answer_content(content: &Value) -> bool {
    let role = text(content, "role").to_lowercase();
    [
        "answer",
        "analysis",
        "solution",
        "explanation",
        "rubric",
        "transcript",
        "听力原文",
        "答案",
        "解析",
        "解答",
        "评分",
    ]
    .iter()
    .any(|word| role.contains(word))
}
const DETAILS: &[(&str, &str, &str)] = &[
    ("choice", "choice_questions", "correct"),
    ("true_false", "true_false_questions", "value"),
    ("fill_blank", "fill_blank_questions", "answers"),
    ("short_answer", "short_answer_questions", "text"),
    ("ordering", "ordering_questions", "order"),
    ("matching", "matching_questions", "matches"),
    ("reading", "reading_questions", ""),
    ("word_bank", "word_bank_questions", ""),
    ("cloze", "cloze_questions", ""),
    ("listening", "listening_questions", ""),
    ("gap_fill", "gap_fill_questions", ""),
];
fn nullable(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_owned)
}
fn json_read(s: String) -> Result<Value> {
    serde_json::from_str(&s).map_err(err)
}

pub fn remap(q: &mut Value, ids: &HashMap<String, String>) -> Result<()> {
    for key in ["id", "parentId", "optionSourceId"] {
        if let Some(old) = q[key].as_str() {
            q[key] = json!(ids
                .get(old)
                .ok_or_else(|| format!("Unknown question reference: {old}"))?);
        }
    }
    if let Some(blocks) = q["passage"].as_array_mut() {
        for b in blocks {
            if let Some(old) = b["questionId"].as_str() {
                b["questionId"] = json!(ids.get(old).ok_or("Unknown blank reference")?);
            }
        }
    }
    Ok(())
}

pub fn write(
    db: &Connection,
    q: &Value,
    bank: &str,
    import: Option<&str>,
    position: i64,
    favorite: bool,
) -> Result<()> {
    let qid = text(q, "id");
    if qid.is_empty() {
        return Err("Question ID is required".into());
    }
    db.execute("INSERT INTO questions(id,bank_id,import_id,parent_id,position,stem,mode,question_type,analysis,source_text,source_score,scoring_rubric,score_source_text,content_blocks,confidence,needs_review,missing_fields,favorite) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,position=excluded.position,stem=excluded.stem,mode=excluded.mode,question_type=excluded.question_type,analysis=excluded.analysis,source_text=excluded.source_text,source_score=excluded.source_score,scoring_rubric=excluded.scoring_rubric,score_source_text=excluded.score_source_text,content_blocks=excluded.content_blocks,confidence=excluded.confidence,needs_review=excluded.needs_review,missing_fields=excluded.missing_fields",params![qid,bank,import,nullable(q,"parentId"),position,nullable(q,"stem"),nullable(q,"answerMode"),nullable(q,"questionTypeId"),nullable(q,"analysis"),nullable(q,"sourceText"),q["sourceScore"].as_f64(),nullable(q,"scoringRubric"),nullable(q,"scoreSourceText"),q["contentBlocks"].to_string(),q["confidence"].as_f64().unwrap_or(0.0),q["needsReview"].as_bool().unwrap_or(true),q["missingFields"].to_string(),favorite]).map_err(err)?;
    db.execute(
        "UPDATE questions SET question_kind=?2,instructions=?3 WHERE id=?1",
        params![
            qid,
            nullable(q, "questionKind"),
            nullable(q, "instructions")
        ],
    )
    .map_err(err)?;
    for (_, table, _) in DETAILS {
        db.execute(&format!("DELETE FROM {table} WHERE question_id=?1"), [qid])
            .map_err(err)?;
    }
    db.execute("DELETE FROM question_options WHERE owner_id=?1", [qid])
        .map_err(err)?;
    db.execute("DELETE FROM question_items WHERE question_id=?1", [qid])
        .map_err(err)?;
    let mode = text(q, "answerMode");
    let shared = nullable(q, "optionSourceId");
    if matches!(mode, "choice" | "word_bank") && shared.is_none() {
        db.execute("INSERT OR IGNORE INTO option_sets VALUES(?1)", [qid])
            .map_err(err)?;
        for (i, o) in list(q, "options").iter().enumerate() {
            db.execute(
                "INSERT INTO question_options VALUES(?1,?2,?3,?4)",
                params![qid, i as i64, nullable(o, "label"), nullable(o, "content")],
            )
            .map_err(err)?;
        }
    }
    if !matches!(mode, "choice" | "word_bank") || shared.is_some() {
        db.execute("DELETE FROM option_sets WHERE id=?1", [qid])
            .map_err(err)?;
    }
    let a = &q["answerPayload"];
    match mode {
        "choice" => {
            db.execute(
                "INSERT INTO choice_questions VALUES(?1,?2,?3,?4)",
                params![
                    qid,
                    nullable(q, "choiceVariant"),
                    shared.as_deref().unwrap_or(qid),
                    a["correct"].to_string()
                ],
            )
            .map_err(err)?;
        }
        "true_false" => {
            db.execute(
                "INSERT INTO true_false_questions VALUES(?1,?2)",
                params![qid, a["value"].to_string()],
            )
            .map_err(err)?;
        }
        "fill_blank" => {
            db.execute(
                "INSERT INTO fill_blank_questions VALUES(?1,?2,?3)",
                params![qid, q["blankCount"].as_i64(), a["answers"].to_string()],
            )
            .map_err(err)?;
        }
        "short_answer" => {
            db.execute(
                "INSERT INTO short_answer_questions VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    qid,
                    a["text"].to_string(),
                    nullable(q, "sourceLanguage"),
                    nullable(q, "targetLanguage"),
                    nullable(q, "writingGenre"),
                    q["minWords"].as_i64(),
                    q["maxWords"].as_i64()
                ],
            )
            .map_err(err)?;
        }
        "ordering" => {
            db.execute(
                "INSERT INTO ordering_questions VALUES(?1,?2)",
                params![qid, a["order"].to_string()],
            )
            .map_err(err)?;
        }
        "matching" => {
            db.execute(
                "INSERT INTO matching_questions VALUES(?1,?2,?3)",
                params![
                    qid,
                    nullable(q, "matchingVariant"),
                    a["matches"].to_string()
                ],
            )
            .map_err(err)?;
        }
        "word_bank" => {
            db.execute(
                "INSERT INTO word_bank_questions VALUES(?1,?2,?3,?1)",
                params![
                    qid,
                    q["passage"].to_string(),
                    q["allowReuse"].as_bool().unwrap_or(false)
                ],
            )
            .map_err(err)?;
        }
        "listening" => {
            db.execute(
                "INSERT INTO listening_questions VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    qid,
                    q["passage"].to_string(),
                    q["audioRef"].to_string(),
                    q["audioStartSeconds"].as_f64().unwrap_or(0.0),
                    q["audioEndSeconds"].as_f64(),
                    json!(list(q, "transcript")).to_string(),
                    q["examPlayCount"].as_i64().unwrap_or(2)
                ],
            )
            .map_err(err)?;
        }
        "reading" | "cloze" | "gap_fill" => {
            let table = DETAILS.iter().find(|(m, _, _)| *m == mode).unwrap().1;
            db.execute(
                &format!("INSERT INTO {table} VALUES(?1,?2)"),
                params![qid, q["passage"].to_string()],
            )
            .map_err(err)?;
        }
        "" => (),
        _ => return Err("Unsupported question type".into()),
    }
    for (i, item) in list(q, "items").iter().enumerate() {
        db.execute(
            "INSERT INTO question_items VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                qid,
                i as i64,
                item["id"].as_i64(),
                nullable(item, "side"),
                nullable(item, "content"),
                nullable(item, "label")
            ],
        )
        .map_err(err)?;
    }
    Ok(())
}

pub fn put_context(
    db: &Connection,
    bank: &str,
    result: &Value,
    ids: &[String],
    import: &str,
    processing: &Value,
) -> Result<()> {
    for (i, w) in list(result, "warnings").iter().enumerate() {
        db.execute(
            "INSERT INTO import_warnings VALUES(?1,?2,?3)",
            params![import, i as i64, w.as_str().ok_or("Invalid warning")?],
        )
        .map_err(err)?;
    }
    let exported_ids: HashMap<_, _> = list(result, "questions")
        .iter()
        .zip(ids)
        .map(|(q, id)| (text(q, "id"), id))
        .collect();
    for g in list(result, "groups") {
        let gid = id();
        db.execute(
            "INSERT INTO sections VALUES(?1,?2,?3,?4)",
            params![gid, bank, text(g, "title"), nullable(g, "instructions")],
        )
        .map_err(err)?;
        for reference in list(g, "questionIds") {
            let qid = exported_ids
                .get(reference.as_str().ok_or("Invalid section reference")?)
                .ok_or("Missing section question")?;
            db.execute(
                "INSERT INTO section_questions VALUES(?1,?2)",
                params![gid, qid],
            )
            .map_err(err)?;
        }
    }
    for v in list(result, "visualElements") {
        let vid = id();
        let mut content = v.clone();
        content
            .as_object_mut()
            .ok_or("Invalid visual")?
            .remove("questionIds");
        db.execute(
            "INSERT INTO visuals VALUES(?1,?2,?3,?4)",
            params![
                vid,
                bank,
                content.to_string(),
                list(v, "questionIds").is_empty()
            ],
        )
        .map_err(err)?;
        let targets: Vec<&String> = if list(v, "questionIds").is_empty() {
            Vec::new()
        } else {
            list(v, "questionIds")
                .iter()
                .map(|i| {
                    exported_ids
                        .get(i.as_str().unwrap_or(""))
                        .copied()
                        .ok_or("Missing visual question")
                })
                .collect::<std::result::Result<_, _>>()?
        };
        for qid in targets {
            db.execute(
                "INSERT INTO question_visuals VALUES(?1,?2)",
                params![vid, qid],
            )
            .map_err(err)?;
        }
    }
    for source in list(processing, "questionSources") {
        let qid = exported_ids
            .get(text(source, "questionId"))
            .ok_or("Missing source question")?;
        db.execute(
            "INSERT OR IGNORE INTO question_sources VALUES(?1,?2,?3)",
            params![qid, text(source, "stage"), source["unitIndex"].as_i64()],
        )
        .map_err(err)?;
    }
    Ok(())
}

pub fn matching_roots(
    db: &Connection,
    banks: &[String],
    mode: &str,
    filter: &str,
) -> Result<Vec<String>> {
    let scope = if banks.is_empty() {
        "?1='[]'"
    } else {
        "q.bank_id IN (SELECT value FROM json_each(?1))"
    };
    let mut statement = db.prepare(&format!("
        WITH RECURSIVE tree(root,id) AS (
            SELECT q.id,q.id FROM questions q WHERE q.parent_id IS NULL AND {scope}
            UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
        ), matches AS (
            SELECT DISTINCT t.root FROM tree t JOIN questions n ON n.id=t.id WHERE
                (?3='favorite' AND n.favorite=1) OR
                (?3='wrong' AND (SELECT result FROM attempts WHERE question_id=n.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)=0) OR
                (?3='unattempted' AND (n.mode IS NULL OR n.mode NOT IN ('reading','word_bank','cloze','listening','gap_fill')) AND NOT EXISTS(SELECT 1 FROM attempts WHERE question_id=n.id AND submitted_at IS NOT NULL AND skipped=0))
        ) SELECT q.id FROM questions q JOIN banks b ON b.id=q.bank_id LEFT JOIN choice_questions c ON c.question_id=q.id
        WHERE q.parent_id IS NULL AND {scope} AND (?2='' OR COALESCE(q.question_kind,q.mode)=?2 OR (?2='grammar_fill' AND q.mode='gap_fill') OR (q.mode='choice' AND c.variant=?2))
            AND (?3='' OR q.id IN (SELECT root FROM matches))
        ORDER BY b.created_at DESC,q.position,q.id" )).map_err(err)?;
    let result = statement
        .query_map(params![json!(banks).to_string(), mode, filter], |r| {
            r.get(0)
        })
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err);
    result
}

pub fn read(db: &Connection) -> Result<Vec<Value>> {
    read_scoped(db, &[], None)
}

pub fn read_scoped(
    db: &Connection,
    banks: &[String],
    roots: Option<&[String]>,
) -> Result<Vec<Value>> {
    let bank_filter = if banks.is_empty() {
        "?1='[]'"
    } else {
        "q.bank_id IN (SELECT value FROM json_each(?1))"
    };
    let root_filter = if roots.is_some() {
        "q.id IN selected"
    } else {
        "1"
    };
    let mut stmt=db.prepare(&format!("WITH RECURSIVE selected(id) AS (SELECT value FROM json_each(?2) UNION ALL SELECT q.id FROM questions q JOIN selected s ON q.parent_id=s.id) SELECT q.id,q.bank_id,q.import_id,q.parent_id,q.position,q.stem,q.mode,q.question_type,q.analysis,q.source_text,q.source_score,q.scoring_rubric,q.score_source_text,q.content_blocks,q.confidence,q.needs_review,q.missing_fields,q.favorite,b.title,q.question_kind,q.instructions FROM questions q JOIN banks b ON b.id=q.bank_id WHERE {bank_filter} AND {root_filter} ORDER BY b.created_at DESC,q.position,q.id")).map_err(err)?;
    let records=stmt.query_map(params![json!(banks).to_string(),roots.map(|v|json!(v).to_string())],|r| Ok((json!({"id":r.get::<_,String>(0)?,"parentId":r.get::<_,Option<String>>(3)?,"stem":r.get::<_,Option<String>>(5)?,"answerMode":r.get::<_,Option<String>>(6)?,"questionTypeId":r.get::<_,Option<String>>(7)?,"analysis":r.get::<_,Option<String>>(8)?,"sourceText":r.get::<_,Option<String>>(9)?,"sourceScore":r.get::<_,Option<f64>>(10)?,"scoringRubric":r.get::<_,Option<String>>(11)?,"scoreSourceText":r.get::<_,Option<String>>(12)?,"confidence":r.get::<_,f64>(14)?,"needsReview":r.get::<_,bool>(15)?,"questionKind":r.get::<_,Option<String>>(19)?,"instructions":r.get::<_,Option<String>>(20)?}),r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(13)?,r.get::<_,String>(16)?,r.get::<_,bool>(17)?,r.get::<_,String>(18)?))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
    let mut rows = Vec::new();
    for (mut q, bank, import, blocks, missing, favorite, title) in records {
        q["contentBlocks"] = json_read(blocks)?;
        q["missingFields"] = json_read(missing)?;
        for key in ["options", "items", "passage"] {
            q[key] = json!([]);
        }
        for key in [
            "choiceVariant",
            "matchingVariant",
            "blankCount",
            "optionSourceId",
            "answerPayload",
        ] {
            q[key] = Value::Null;
        }
        q["allowReuse"] = json!(false);
        let qid = text(&q, "id").to_owned();
        let mode = text(&q, "answerMode").to_owned();
        let mut owner = qid.clone();
        if let Some((_, table, key)) = DETAILS.iter().find(|(m, _, _)| *m == mode) {
            let data:String=db.query_row(&format!("SELECT {} FROM {table} WHERE question_id=?1",match mode.as_str(){
                "choice"=>"json_object('variant',variant,'owner',option_set_id,'answer',json(correct))",
                "true_false"=>"json_object('answer',json(value))", "fill_blank"=>"json_object('blankCount',blank_count,'answer',json(answers))",
                "short_answer"=>"json_object('answer',json(answer),'sourceLanguage',source_language,'targetLanguage',target_language,'writingGenre',writing_genre,'minWords',min_words,'maxWords',max_words)", "ordering"=>"json_object('answer',json(answer_order))",
                "matching"=>"json_object('variant',variant,'answer',json(matches))", "word_bank"=>"json_object('passage',json(passage),'allowReuse',json(CASE allow_reuse WHEN 1 THEN 'true' ELSE 'false' END))",
                "listening"=>"json_object('passage',json(passage),'audioRef',json(audio_ref),'audioStartSeconds',start_seconds,'audioEndSeconds',end_seconds,'transcript',json(transcript),'examPlayCount',play_count)",
                _=>"json_object('passage',json(passage))"}),[&qid],|r|r.get(0)).map_err(err)?;
            let d = json_read(data)?;
            if !key.is_empty() && !d["answer"].is_null() {
                q["answerPayload"] = json!({*key:d["answer"]});
            }
            if mode == "short_answer" {
                for key in [
                    "sourceLanguage",
                    "targetLanguage",
                    "writingGenre",
                    "minWords",
                    "maxWords",
                ] {
                    q[key] = d[key].clone();
                }
            }
            if mode == "listening" {
                for key in [
                    "audioRef",
                    "audioStartSeconds",
                    "audioEndSeconds",
                    "transcript",
                    "examPlayCount",
                ] {
                    q[key] = d[key].clone();
                }
            }
            if mode == "choice" {
                q["choiceVariant"] = d["variant"].clone();
                owner = text(&d, "owner").to_owned();
                if owner != qid {
                    q["optionSourceId"] = json!(owner);
                }
            }
            if mode == "matching" {
                q["matchingVariant"] = d["variant"].clone();
            }
            if mode == "fill_blank" {
                q["blankCount"] = d["blankCount"].clone();
            }
            if composite(&q) {
                q["passage"] = d["passage"].clone();
            }
            if mode == "word_bank" {
                q["allowReuse"] = d["allowReuse"].clone();
            }
        }
        // Only owners carry options in persistent or exported content; hydrate resolves shared pools.
        if owner == qid {
            q["options"]=json!(db.prepare("SELECT label,content FROM question_options WHERE owner_id=?1 ORDER BY position").map_err(err)?.query_map([&qid],|r|Ok(json!({"label":r.get::<_,Option<String>>(0)?,"content":r.get::<_,Option<String>>(1)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?);
        }
        q["items"]=json!(db.prepare("SELECT item_id,side,content,label FROM question_items WHERE question_id=?1 ORDER BY position").map_err(err)?.query_map([&qid],|r|Ok(json!({"id":r.get::<_,Option<i64>>(0)?,"side":r.get::<_,Option<String>>(1)?,"content":r.get::<_,Option<String>>(2)?,"label":r.get::<_,Option<String>>(3)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?);
        let sources=db.prepare("SELECT stage,unit_index FROM question_sources WHERE question_id=?1 ORDER BY stage,unit_index").map_err(err)?.query_map([&qid],|r|Ok(json!({"questionId":qid,"stage":r.get::<_,String>(0)?,"unitIndex":r.get::<_,i64>(1)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        let warnings = db
            .prepare("SELECT message FROM import_warnings WHERE import_id=?1 ORDER BY position")
            .map_err(err)?
            .query_map([import], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        let latest:Option<bool>=db.query_row("SELECT (SELECT result FROM attempts WHERE question_id=?1 AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)",[&qid],|r|r.get(0)).map_err(err)?;
        rows.push(json!({"id":qid,"bankId":bank,"bankTitle":title,"question":q,"favorite":favorite,"latestResult":latest,"sources":sources,"warnings":warnings,"groups":[],"visuals":[],"missingAssets":false}));
    }
    if rows.is_empty() {
        return Ok(rows);
    }
    let loaded_banks: HashSet<_> = rows.iter().map(|r| text(r, "bankId")).collect();
    let scope = json!(loaded_banks).to_string();
    let groups=db.prepare("SELECT id,title,instructions FROM sections WHERE bank_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid").map_err(err)?.query_map([&scope],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"instructions":r.get::<_,Option<String>>(2)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
    let mut gs = Vec::new();
    for mut g in groups {
        g["questionIds"] = json!(db
            .prepare("SELECT question_id FROM section_questions WHERE section_id=?1")
            .map_err(err)?
            .query_map([text(&g, "id")], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?);
        gs.push(g);
    }
    let visuals = db
        .prepare("SELECT id,content,bank_id,document_level FROM visuals WHERE bank_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid")
        .map_err(err)?
        .query_map([&scope], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut vs = Vec::new();
    for (vid, raw, bank, global) in visuals {
        let mut v = json_read(raw)?;
        v["id"] = json!(vid);
        v["questionIds"] = json!(db
            .prepare("SELECT question_id FROM question_visuals WHERE visual_id=?1")
            .map_err(err)?
            .query_map([&vid], |r| r.get::<_, String>(0))
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?);
        vs.push((bank, v, global));
    }
    for row in &mut rows {
        row["groups"] = json!(gs
            .iter()
            .filter(|g| list(g, "questionIds").contains(&row["id"]))
            .collect::<Vec<_>>());
        row["visuals"] = json!(vs
            .iter()
            .filter(|(bank, v, global)| row["bankId"] == *bank
                && (*global || list(v, "questionIds").contains(&row["id"])))
            .map(|(_, v, _)| v)
            .collect::<Vec<_>>());
        row["missingAssets"] = json!(list(row, "visuals")
            .iter()
            .filter_map(|v| v.get("imageRef").filter(|r| r.is_object()))
            .chain(row["question"].get("audioRef").filter(|r| r.is_object()))
            .any(|r| !db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE hash=?1)",
                    [text(r, "sha256")],
                    |r| r.get::<_, bool>(0)
                )
                .unwrap_or(false)));
    }
    Ok(rows)
}

/// Borrowed indexes live only for this read/transaction; edits never leave a stale cache.
pub struct Index<'a> {
    pub by_id: HashMap<&'a str, &'a Value>,
    pub trees: HashMap<&'a str, Vec<&'a Value>>,
    roots: HashMap<&'a str, &'a str>,
}
impl<'a> Index<'a> {
    pub fn new(rows: &'a [Value]) -> Self {
        let by_id: HashMap<_, _> = rows.iter().map(|r| (text(r, "id"), r)).collect();
        let mut roots = HashMap::new();
        let mut trees: HashMap<_, Vec<_>> = HashMap::new();
        for row in rows {
            let mut current = row;
            let mut seen = HashSet::new();
            while !text(&current["question"], "parentId").is_empty() {
                if !seen.insert(text(current, "id")) {
                    break;
                }
                let Some(parent) = by_id.get(text(&current["question"], "parentId")) else {
                    break;
                };
                current = parent;
            }
            let root = text(current, "id");
            roots.insert(text(row, "id"), root);
            trees.entry(root).or_default().push(row);
        }
        Self {
            by_id,
            roots,
            trees,
        }
    }
    pub fn root_id(&self, row: &'a Value) -> &'a str {
        self.roots
            .get(text(row, "id"))
            .copied()
            .unwrap_or(text(row, "id"))
    }
    pub fn snapshot(&self, id: &str) -> Result<Value> {
        self.by_id
            .get(id)
            .map(|r| self.hydrate(r))
            .ok_or_else(|| "Snapshot question is missing".into())
    }
    pub fn hydrate(&self, row: &'a Value) -> Value {
        let mut result = row.clone();
        let mut parent = text(&row["question"], "parentId");
        let mut seen = HashSet::new();
        let mut materials = Vec::new();
        while !parent.is_empty() && seen.insert(parent) {
            let Some(p) = self.by_id.get(parent) else {
                result["missingAssets"] = json!(true);
                break;
            };
            materials.push(p["question"].clone());
            if p["missingAssets"] == true {
                result["missingAssets"] = json!(true);
            }
            for key in ["groups", "visuals"] {
                let additions = list(p, key).to_vec();
                for value in additions {
                    if !list(&result, key).iter().any(|v| v["id"] == value["id"]) {
                        result[key].as_array_mut().unwrap().push(value);
                    }
                }
            }
            if list(&p["question"], "missingFields")
                .iter()
                .any(|v| v == "material" || v == "media" || v == "options")
            {
                result["missingAssets"] = json!(true);
            }
            parent = text(&p["question"], "parentId");
        }
        materials.reverse();
        result["materials"] = json!(materials
            .iter()
            .map(|p| {
                let mut p = (*p).clone();
                p["passage"] = json!(list(&p, "passage")
                    .iter()
                    .filter(|b| !answer_content(b))
                    .collect::<Vec<_>>());
                p
            })
            .collect::<Vec<_>>());
        if let Some(owner) = self.by_id.get(text(&row["question"], "optionSourceId")) {
            result["question"]["options"] = owner["question"]["options"].clone();
        }
        result["rootId"] = json!(self.root_id(row));
        if let Some(root) = self.by_id.get(self.root_id(row)) {
            result["rootType"] = json!(crate::paper::category(&root["question"]));
        }
        result
    }
}

pub fn freeze(rows: &[Value]) -> Value {
    let ids: HashSet<_> = rows.iter().map(|r| r["id"].clone().to_string()).collect();
    let mut qs = rows.to_vec();
    let mut groups = Vec::new();
    let mut visuals = Vec::new();
    for row in &mut qs {
        for (key, values) in [("groups", &mut groups), ("visuals", &mut visuals)] {
            for item in list(row, key) {
                if !values.iter().any(|v: &Value| v["id"] == item["id"]) {
                    let mut item = item.clone();
                    if let Some(refs) = item["questionIds"].as_array_mut() {
                        refs.retain(|id| ids.contains(&id.to_string()));
                    }
                    values.push(item);
                }
            }
            row.as_object_mut().unwrap().remove(key);
        }
    }
    json!({"schemaVersion":3,"questions":qs,"groups":groups,"visuals":visuals})
}

pub fn thaw(doc: &Value) -> Result<Vec<Value>> {
    if doc["schemaVersion"] != 3 {
        return Err("Unsupported session snapshot".into());
    }
    let mut rows = list(doc, "questions").to_vec();
    for row in &mut rows {
        for key in ["groups", "visuals"] {
            row[key] = json!(list(doc, key)
                .iter()
                .filter(|g| (key == "visuals" && list(g, "questionIds").is_empty())
                    || list(g, "questionIds").contains(&row["id"]))
                .collect::<Vec<_>>());
        }
    }
    Ok(rows)
}
pub fn session_rows(db: &Connection, sid: &str) -> Result<Vec<Value>> {
    let raw: String = db
        .query_row(
            "SELECT content FROM session_documents WHERE session_id=?1",
            [sid],
            |r| r.get(0),
        )
        .map_err(err)?;
    thaw(&json_read(raw)?)
}
pub fn snapshot(db: &Connection, sid: &str, qid: &str) -> Result<Value> {
    let rows = session_rows(db, sid)?;
    Index::new(&rows).snapshot(qid)
}
#[cfg(test)]
impl Store {
    pub fn question_rows(&self) -> Result<Vec<Value>> {
        read(&self.connect()?)
    }
}

pub fn copy_context(
    db: &Connection,
    bank: &str,
    rows: &[Value],
    ids: &HashMap<String, String>,
) -> Result<()> {
    let mut seen = HashSet::new();
    for row in rows {
        if !list(row, "warnings").is_empty() {
            let digest = crate::store::hash(
                format!("{}:{}", text(row, "bankId"), row["warnings"]).as_bytes(),
            );
            let source = id();
            db.execute(
                "INSERT OR IGNORE INTO imports VALUES(?1,?2,?3,?4)",
                params![source, bank, digest, crate::store::now()],
            )
            .map_err(err)?;
            let source: String = db
                .query_row(
                    "SELECT id FROM imports WHERE bank_id=?1 AND digest=?2",
                    params![bank, digest],
                    |r| r.get(0),
                )
                .map_err(err)?;
            db.execute(
                "UPDATE questions SET import_id=?2 WHERE id=?1",
                params![ids[text(row, "id")], source],
            )
            .map_err(err)?;
            for (i, warning) in list(row, "warnings").iter().enumerate() {
                db.execute(
                    "INSERT OR IGNORE INTO import_warnings VALUES(?1,?2,?3)",
                    params![source, i as i64, warning.as_str()],
                )
                .map_err(err)?;
            }
        }
        for g in list(row, "groups") {
            if !seen.insert(format!("g:{}", text(g, "id"))) {
                continue;
            }
            let gid = id();
            db.execute(
                "INSERT INTO sections VALUES(?1,?2,?3,?4)",
                params![gid, bank, text(g, "title"), nullable(g, "instructions")],
            )
            .map_err(err)?;
            for old in list(g, "questionIds").iter().filter_map(Value::as_str) {
                if let Some(qid) = ids.get(old) {
                    db.execute(
                        "INSERT INTO section_questions VALUES(?1,?2)",
                        params![gid, qid],
                    )
                    .map_err(err)?;
                }
            }
        }
        for v in list(row, "visuals") {
            if !seen.insert(format!("v:{}", text(v, "id"))) {
                continue;
            }
            let vid = id();
            let mut content = v.clone();
            for key in ["id", "questionIds"] {
                content.as_object_mut().unwrap().remove(key);
            }
            db.execute(
                "INSERT INTO visuals VALUES(?1,?2,?3,?4)",
                params![
                    vid,
                    bank,
                    content.to_string(),
                    list(v, "questionIds").is_empty()
                ],
            )
            .map_err(err)?;
            for old in list(v, "questionIds").iter().filter_map(Value::as_str) {
                if let Some(qid) = ids.get(old) {
                    db.execute(
                        "INSERT INTO question_visuals VALUES(?1,?2)",
                        params![vid, qid],
                    )
                    .map_err(err)?;
                }
            }
        }
        for source in list(row, "sources") {
            db.execute(
                "INSERT OR IGNORE INTO question_sources VALUES(?1,?2,?3)",
                params![
                    ids[text(row, "id")],
                    text(source, "stage"),
                    source["unitIndex"].as_i64()
                ],
            )
            .map_err(err)?;
        }
    }
    Ok(())
}

pub fn validate_tables(db: &Connection) -> Result<()> {
    for row in read(db)? {
        let mut count = 0;
        for (mode, table, _) in DETAILS {
            let exists: bool = db
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE question_id=?1)"),
                    [text(&row, "id")],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if exists {
                if *mode != text(&row["question"], "answerMode") {
                    return Err("Question detail type mismatch".into());
                }
                count += 1;
            }
        }
        if count != usize::from(!text(&row["question"], "answerMode").is_empty()) {
            return Err("Question must have exactly one matching detail row".into());
        }
    }
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM questions q JOIN questions p ON p.id=q.parent_id WHERE q.bank_id!=p.bank_id)",[],|r|r.get(0)).map_err(err)?;
    if invalid {
        return Err("Question parent belongs to another bank".into());
    }
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM word_bank_questions WHERE option_set_id!=question_id) OR EXISTS(SELECT 1 FROM option_sets o JOIN questions q ON q.id=o.id WHERE q.mode NOT IN ('choice','word_bank')) OR EXISTS(SELECT 1 FROM section_questions x JOIN sections s ON s.id=x.section_id JOIN questions q ON q.id=x.question_id WHERE s.bank_id!=q.bank_id) OR EXISTS(SELECT 1 FROM question_visuals x JOIN visuals v ON v.id=x.visual_id JOIN questions q ON q.id=x.question_id WHERE v.bank_id!=q.bank_id)",[],|r|r.get(0)).map_err(err)?;
    if invalid {
        return Err("Inconsistent question context or option ownership".into());
    }
    Ok(())
}
impl Store {
    pub fn save_question_tree(
        &self,
        bank: &str,
        root: Option<&str>,
        tree: Vec<Value>,
    ) -> Result<Value> {
        let result = self.save_question_tree_inner(bank, root, tree);
        if let Err(error) = self.collect_unused_assets() {
            eprintln!("Asset cleanup deferred after question save: {error}");
        }
        result
    }

    fn save_question_tree_inner(
        &self,
        bank: &str,
        root: Option<&str>,
        mut tree: Vec<Value>,
    ) -> Result<Value> {
        if tree.is_empty() || tree.len() > 1000 {
            return Err("A question tree needs 1–1000 nodes".into());
        }
        let qid = text(&tree[0], "id").to_owned();
        if !text(&tree[0], "parentId").is_empty() || root.is_some_and(|r| r != qid) {
            return Err("Invalid root question".into());
        }
        for q in &mut tree {
            if !text(q, "optionSourceId").is_empty() {
                q["options"] = json!([]);
            }
        }
        contract::validate_tree(&mut tree)?;
        let proposed: Vec<_> = tree
            .iter()
            .map(|q| json!({"id":q["id"],"question":q}))
            .collect();
        let proposed_index = Index::new(&proposed);
        if proposed.iter().any(|r| proposed_index.root_id(r) != qid) {
            return Err("Save one complete question tree at a time".into());
        }
        let mut db = self.connect()?;
        let tx = db.transaction().map_err(err)?;
        self.persist_audio(&tx, &tree)?;
        let old = read(&tx)?;
        let old_index = Index::new(&old);
        if root.is_some()
            && !old.iter().any(|r| {
                text(r, "id") == qid
                    && text(r, "bankId") == bank
                    && text(&r["question"], "parentId").is_empty()
            })
        {
            return Err("Edited root no longer exists".into());
        }
        for q in &tree {
            if old.iter().any(|r| {
                r["id"] == q["id"]
                    && (root.is_none() || old_index.root_id(r) != qid || text(r, "bankId") != bank)
            }) {
                return Err("Question ID belongs to another tree".into());
            }
        }
        let position:i64=tx.query_row("SELECT COALESCE((SELECT position FROM questions WHERE id=?1),(SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE bank_id=?2))",params![qid,bank],|r|r.get(0)).map_err(err)?;
        for row in old
            .iter()
            .filter(|r| old_index.root_id(r) == qid && !tree.iter().any(|q| q["id"] == r["id"]))
        {
            tx.execute("DELETE FROM questions WHERE id=?1", [text(row, "id")])
                .map_err(err)?;
        }
        for (i, q) in tree.iter().enumerate() {
            let favorite = old
                .iter()
                .find(|r| r["id"] == q["id"])
                .is_some_and(|r| r["favorite"] == true);
            write(&tx, q, bank, None, position + i as i64, favorite)?;
        }
        tx.commit().map_err(err)?;
        Ok(json!(qid))
    }
}
