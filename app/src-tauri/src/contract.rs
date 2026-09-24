use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

pub type Result<T> = std::result::Result<T, crate::AppError>;
pub const MAX_JSON: usize = 32 * 1024 * 1024;

fn schemas() -> &'static (jsonschema::Validator, jsonschema::Validator) {
    static SCHEMAS: OnceLock<(jsonschema::Validator, jsonschema::Validator)> = OnceLock::new();
    SCHEMAS.get_or_init(|| {
        let schemas: Value =
            serde_json::from_str(include_str!("../contracts.json")).expect("bundled schemas");
        (
            jsonschema::validator_for(&schemas["result"]).expect("result schema"),
            jsonschema::validator_for(&schemas["processing"]).expect("processing schema"),
        )
    })
}
fn schema_check(schema: &jsonschema::Validator, value: &Value, prefix: &str) -> Result<()> {
    if let Some(error) = schema.iter_errors(value).next() {
        return Err(crate::language::error(
            "LOCAL_SCHEMA_INVALID",
            serde_json::json!({"path": format!("{prefix}{}", error.instance_path), "detail": error.to_string()}),
        ));
    }
    Ok(())
}
pub fn validate_workflow(value: &Value, review: bool) -> Result<()> {
    static SCHEMAS: OnceLock<(jsonschema::Validator, jsonschema::Validator)> = OnceLock::new();
    let schemas = SCHEMAS.get_or_init(|| {
        let source: Value =
            serde_json::from_str(include_str!("../contracts.json")).expect("bundled schemas");
        (
            jsonschema::validator_for(&source["taskSummary"]).expect("task summary schema"),
            jsonschema::validator_for(&source["taskReview"]).expect("task review schema"),
        )
    });
    schema_check(if review { &schemas.1 } else { &schemas.0 }, value, "task")
}
pub fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn filled(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => !a.is_empty() && a.iter().all(filled),
        Value::Object(o) => !o.is_empty() && o.values().all(filled),
        _ => true,
    }
}
fn unique(values: &[Value]) -> bool {
    values
        .iter()
        .map(Value::to_string)
        .collect::<HashSet<_>>()
        .len()
        == values.len()
}
pub fn item_ids(q: &Value, side: Option<&str>) -> Vec<Value> {
    list(q, "items")
        .iter()
        .filter(|item| side.is_none_or(|s| text(item, "side") == s))
        .enumerate()
        .map(|(i, item)| {
            item.get("id")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(i))
        })
        .collect()
}
fn normalize(q: &mut Value) {
    if let Some(obj) = q.as_object_mut() {
        for key in [
            "stem",
            "answerMode",
            "questionTypeId",
            "choiceVariant",
            "matchingVariant",
            "analysis",
            "sourceText",
            "scoringRubric",
            "scoreSourceText",
            "instructions",
            "writingGenre",
            "sourceLanguage",
            "targetLanguage",
        ] {
            if let Some(Value::String(s)) = obj.get_mut(key) {
                *s = s.trim().to_owned();
                if s.is_empty() {
                    obj.insert(key.into(), Value::Null);
                }
            }
        }
        for key in [
            "items",
            "options",
            "contentBlocks",
            "missingFields",
            "passage",
            "transcript",
        ] {
            if obj.get(key).is_none_or(Value::is_null) {
                obj.insert(key.into(), json!([]));
            }
        }
        for key in ["items", "options"] {
            if let Some(Value::Array(items)) = obj.get_mut(key) {
                for item in items {
                    for field in ["label", "content"] {
                        if let Some(Value::String(s)) = item.get_mut(field) {
                            let value = s.trim();
                            item[field] = if value.is_empty() {
                                Value::Null
                            } else {
                                json!(value)
                            };
                        }
                    }
                }
            }
        }
        obj.entry("audioStartSeconds").or_insert(json!(0));
        obj.entry("examPlayCount").or_insert(json!(2));
        obj.entry("allowReuse").or_insert(json!(false));
        obj.entry("confidence").or_insert(json!(0));
        obj.entry("needsReview").or_insert(json!(true));
    }
}
fn normalize_answer_values(value: &mut Value) {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            *value = if trimmed.is_empty() {
                Value::Null
            } else {
                json!(trimmed)
            };
        }
        Value::Array(a) => {
            for v in a {
                normalize_answer_values(v);
            }
        }
        Value::Object(o) => {
            for v in o.values_mut() {
                normalize_answer_values(v);
            }
        }
        _ => (),
    }
}
pub fn validate_question(q: &mut Value) -> Result<()> {
    normalize(q);
    if let Some(answer) = q.get_mut("answerPayload") {
        normalize_answer_values(answer);
        if answer.as_object().is_some_and(|o| o.is_empty()) {
            *answer = Value::Null;
        }
    }
    for item in list(q, "items") {
        if item.get("id").is_some_and(|v| !v.is_null() && !v.is_i64()) {
            return Err(crate::language::error(
                "LOCAL_ITEM_ID_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    for block in list(q, "contentBlocks").iter().chain(list(q, "passage")) {
        if text(block, "partType") != "blank"
            && !["textValue", "markdownValue", "latexValue"]
                .iter()
                .any(|k| filled(&block[*k]))
            && block["jsonValue"].is_null()
        {
            return Err(crate::language::error(
                "LOCAL_CONTENT_EMPTY",
                serde_json::json!({}),
            ));
        }
    }
    if text(q, "answerMode") == "fill_blank" && answer_complete(q) {
        if let Some(answers) = q["answerPayload"]["answers"].as_array() {
            let count = answers.len() as u64;
            if !q["blankCount"].is_null() && q["blankCount"].as_u64() != Some(count) {
                return Err("blankCount must match the number of reference answers".into());
            }
            q["blankCount"] = json!(count);
        }
    }
    let wrapper = json!({"schemaVersion":3,"questions":[q.clone()],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0});
    schema_check(&schemas().0, &wrapper, "result")?;
    let mode = text(q, "answerMode");
    let kind = text(q, "questionKind");
    let expected = match kind {
        "listening" => "listening",
        "reading" => "reading",
        "word_bank" | "sentence_selection" => "word_bank",
        "cloze" => "cloze",
        "grammar_fill" => "gap_fill",
        "paragraph_matching" => "matching",
        "translation" | "writing" => "short_answer",
        _ => mode,
    };
    if expected != mode {
        return Err("questionKind does not match answerMode".into());
    }
    let start = q["audioStartSeconds"].as_f64().unwrap_or(0.0);
    if q["audioEndSeconds"]
        .as_f64()
        .is_some_and(|end| end <= start)
    {
        return Err("Audio end must be after start".into());
    }
    if mode != "listening"
        && (q["audioRef"].is_object()
            || !list(q, "transcript").is_empty()
            || start != 0.0
            || !q["audioEndSeconds"].is_null()
            || q["examPlayCount"] != 2)
    {
        return Err("Audio fields require listening mode".into());
    }
    if list(q, "transcript")
        .iter()
        .any(|b| text(b, "partType") == "blank")
    {
        return Err("Transcript cannot contain blanks".into());
    }
    if let Some(key) = q["audioRef"]["objectKey"].as_str() {
        if key.contains(['\\', ':']) || key.split('/').any(|p| matches!(p, "" | "." | "..")) {
            return Err("Unsafe audio resource path".into());
        }
    }
    if (kind != "translation" && !q["sourceLanguage"].is_null())
        || (!matches!(kind, "translation" | "writing") && !q["targetLanguage"].is_null())
    {
        return Err("Language fields require translation or writing".into());
    }
    if kind != "writing"
        && ["minWords", "maxWords", "writingGenre"]
            .iter()
            .any(|k| !q[*k].is_null())
    {
        return Err("Writing fields require writing".into());
    }
    if let (Some(min), Some(max)) = (q["minWords"].as_u64(), q["maxWords"].as_u64()) {
        if min > max {
            return Err("Minimum words exceeds maximum".into());
        }
    }
    if q["allowReuse"] == true && mode != "word_bank" {
        return Err("allowReuse requires word_bank mode".into());
    }
    if !q["blankCount"].is_null() && mode != "fill_blank" {
        return Err("blankCount requires fill_blank mode".into());
    }
    if !crate::questions::composite(q) && !list(q, "passage").is_empty() {
        return Err("passage requires a composite question".into());
    }
    if list(q, "contentBlocks")
        .iter()
        .any(|b| text(b, "partType") == "blank")
    {
        return Err("blank references belong in passage".into());
    }
    for block in list(q, "passage") {
        if (text(block, "partType") == "blank") != !text(block, "questionId").is_empty() {
            return Err("Invalid blank reference".into());
        }
    }

    if !mode.is_empty()
        && mode != "choice"
        && mode != "word_bank"
        && (!list(q, "options").is_empty() || !text(q, "choiceVariant").is_empty())
    {
        return Err(crate::language::error(
            "LOCAL_CHOICE_FIELDS_INVALID",
            serde_json::json!({}),
        ));
    }
    if !mode.is_empty() && mode != "ordering" && mode != "matching" && !list(q, "items").is_empty()
    {
        return Err(crate::language::error(
            "LOCAL_ITEMS_MODE_INVALID",
            serde_json::json!({}),
        ));
    }
    if !mode.is_empty() && mode != "matching" && !text(q, "matchingVariant").is_empty() {
        return Err(crate::language::error(
            "LOCAL_MATCHING_MODE_INVALID",
            serde_json::json!({}),
        ));
    }
    if mode == "ordering" && list(q, "items").iter().any(|i| !i["side"].is_null()) {
        return Err(crate::language::error(
            "LOCAL_ORDERING_SIDE_INVALID",
            serde_json::json!({}),
        ));
    }
    let labels: Vec<Value> = list(q, "options")
        .iter()
        .filter_map(|o| o["label"].as_str())
        .map(|s| json!(s.to_lowercase()))
        .collect();
    if !unique(&labels) {
        return Err(crate::language::error(
            "LOCAL_OPTION_LABEL_DUPLICATE",
            serde_json::json!({}),
        ));
    }
    let answer = &q["answerPayload"];
    if !answer.is_null() && !answer.is_object() {
        return Err(crate::language::error(
            "LOCAL_ANSWER_PAYLOAD_INVALID",
            serde_json::json!({}),
        ));
    }
    if let Some(obj) = answer.as_object() {
        let allowed: &[&str] = match mode {
            "choice" => &["correct"],
            "true_false" => &["value"],
            "fill_blank" => &["answers"],
            "short_answer" => &["text"],
            "ordering" => &["order"],
            "matching" => &["matches"],
            _ => &["correct", "value", "answers", "text", "order", "matches"],
        };
        if obj.keys().any(|k| !allowed.contains(&k.as_str())) || (mode.is_empty() && obj.len() > 1)
        {
            return Err(crate::language::error(
                "LOCAL_ANSWER_MODE_MISMATCH",
                serde_json::json!({}),
            ));
        }
        for (key, value) in obj {
            if value.is_null() {
                continue;
            }
            let valid = match key.as_str() {
                "value" => value.is_boolean(),
                "text" => value
                    .as_str()
                    .is_some_and(|s| s.chars().count() <= if key == "text" { 120_000 } else { 32 }),
                "correct" | "answers" => value.as_array().is_some_and(|a| {
                    a.len() <= 100 && a.iter().all(|v| v.is_null() || v.is_string())
                }),
                "order" => value
                    .as_array()
                    .is_some_and(|a| a.len() <= 100 && a.iter().all(|v| v.is_null() || v.is_i64())),
                "matches" => value.as_array().is_some_and(|a| {
                    a.len() <= 100
                        && a.iter().all(|v| {
                            v.is_null()
                                || v.as_object().is_some_and(|o| {
                                    o.iter().all(|(k, v)| {
                                        (k == "left" || k == "right") && (v.is_null() || v.is_i64())
                                    })
                                })
                        })
                }),
                _ => false,
            };
            if !valid {
                return Err(crate::language::error(
                    "LOCAL_ANSWER_FIELD_INVALID",
                    serde_json::json!({"key": key}),
                ));
            }
        }
    }
    if mode == "choice" {
        let selected = list(answer, "correct").to_vec();
        if text(q, "choiceVariant") == "single" && selected.len() > 1 {
            return Err("Single choice requires one answer".into());
        }
        let selected: Vec<Value> = selected
            .iter()
            .filter_map(Value::as_str)
            .map(|s| json!(s.trim().to_lowercase()))
            .filter(|s| s != "")
            .collect();
        if !unique(&selected)
            || (!labels.is_empty() && selected.iter().any(|s| !labels.contains(s)))
        {
            return Err(crate::language::error(
                "LOCAL_OPTION_REFERENCE_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    if mode == "ordering" {
        let order: Vec<_> = list(answer, "order")
            .iter()
            .filter(|v| !v.is_null())
            .cloned()
            .collect();
        let ids = item_ids(q, None);
        if !unique(&order) || (!ids.is_empty() && order.iter().any(|v| !ids.contains(v))) {
            return Err(crate::language::error(
                "LOCAL_ORDER_REFERENCE_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    if mode == "matching" {
        let left: Vec<_> = list(answer, "matches")
            .iter()
            .filter_map(|p| p.get("left").filter(|v| !v.is_null()))
            .cloned()
            .collect();
        let right: Vec<_> = list(answer, "matches")
            .iter()
            .filter_map(|p| p.get("right").filter(|v| !v.is_null()))
            .cloned()
            .collect();
        if !unique(&left)
            || (text(q, "matchingVariant") == "one_to_one" && !unique(&right))
            || (!list(q, "items").is_empty()
                && (left.iter().any(|v| !item_ids(q, Some("left")).contains(v))
                    || right
                        .iter()
                        .any(|v| !item_ids(q, Some("right")).contains(v))))
        {
            return Err(crate::language::error(
                "LOCAL_MATCH_REFERENCE_INVALID",
                serde_json::json!({}),
            ));
        }
    }
    if ![
        "stem",
        "sourceText",
        "options",
        "items",
        "contentBlocks",
        "answerPayload",
        "analysis",
        "passage",
    ]
    .iter()
    .any(|k| filled(&q[*k]))
    {
        return Err(crate::language::error(
            "LOCAL_QUESTION_EMPTY",
            serde_json::json!({}),
        ));
    }
    let mut missing: Vec<Value> = ["stem", "questionTypeId", "answerMode"]
        .iter()
        .filter(|k| !filled(&q[**k]))
        .map(|k| json!(k))
        .collect();
    if matches!(mode, "choice" | "word_bank") {
        if mode == "choice" && text(q, "choiceVariant").is_empty() {
            missing.push(json!("choiceVariant"));
        }
        if text(q, "optionSourceId").is_empty()
            && (list(q, "options").len() < 2
                || list(q, "options")
                    .iter()
                    .any(|o| !filled(&o["label"]) || !filled(&o["content"])))
        {
            missing.push(json!("options"));
        }
    }
    if mode == "matching" || mode == "ordering" {
        if mode == "matching" && text(q, "matchingVariant").is_empty() {
            missing.push(json!("matchingVariant"));
        }
        if list(q, "items").len() < 2
            || list(q, "items").iter().any(|i| !filled(&i["content"]))
            || (mode == "matching"
                && (item_ids(q, Some("left")).len() < 2
                    || item_ids(q, Some("right")).len() < 2
                    || list(q, "items").iter().any(|i| i["side"].is_null())))
        {
            missing.push(json!("items"));
        }
    }
    if !crate::questions::composite(q) && !answer_complete(q) {
        missing.push(json!("answerPayload"));
    }
    for key in ["analysis", "sourceText"] {
        if !filled(&q[key]) {
            missing.push(json!(key));
        }
    }
    if mode == "listening" && !q["audioRef"].is_object() {
        missing.push(json!("media"));
    }
    for key in ["media", "material"] {
        if list(q, "missingFields").contains(&json!(key)) && !missing.contains(&json!(key)) {
            missing.push(json!(key));
        }
    }
    if !missing.is_empty() {
        q["needsReview"] = json!(true);
    }
    q["missingFields"] = json!(missing);
    Ok(())
}
pub fn answer_complete(q: &Value) -> bool {
    let a = &q["answerPayload"];
    let key = match text(q, "answerMode") {
        "choice" => "correct",
        "true_false" => "value",
        "fill_blank" => "answers",
        "short_answer" => "text",
        "ordering" => "order",
        "matching" => "matches",
        _ => return false,
    };
    if !filled(&a[key]) {
        return false;
    }
    match key {
        "order" => list(a, key).len() == list(q, "items").len(),
        "matches" => {
            list(a, key).len() == item_ids(q, Some("left")).len()
                && list(a, key).iter().all(|p| {
                    p.get("left").is_some_and(filled) && p.get("right").is_some_and(filled)
                })
        }
        _ => true,
    }
}
pub fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_JSON {
        return Err(crate::language::error(
            "LOCAL_JSON_TOO_LARGE",
            serde_json::json!({}),
        ));
    }
    let mut root: Value = serde_json::from_slice(bytes).map_err(|e| format!("JSON: {e}"))?;
    let result = if root.get("result").is_some() {
        &mut root["result"]
    } else {
        &mut root
    };
    if result["schemaVersion"] != 3 {
        return Err(crate::language::error("LOCAL_JSON_VERSION", json!({})));
    }
    if let Some(questions) = result.get_mut("questions").and_then(Value::as_array_mut) {
        validate_tree(questions)?;
        for (i, q) in questions.iter_mut().enumerate() {
            validate_question(q).map_err(|mut e| {
                e.context = Some(format!("questions[{i}]"));
                e
            })?;
        }
    }
    schema_check(&schemas().0, result, "result")?;
    let ids: HashSet<_> = list(result, "questions")
        .iter()
        .map(|q| text(q, "id"))
        .collect();
    for g in list(result, "groups") {
        if text(g, "title").trim().is_empty() {
            return Err(crate::language::error(
                "LOCAL_GROUP_TITLE_EMPTY",
                serde_json::json!({}),
            ));
        }
    }
    for v in list(result, "visualElements") {
        if text(v, "description").trim().is_empty() {
            return Err(crate::language::error(
                "LOCAL_VISUAL_DESCRIPTION_EMPTY",
                serde_json::json!({}),
            ));
        }
    }
    for key in ["groups", "visualElements"] {
        for (i, group) in list(result, key).iter().enumerate() {
            if list(group, "questionIds")
                .iter()
                .any(|v| v.as_str().is_none_or(|v| !ids.contains(v)))
            {
                return Err(crate::language::error(
                    "LOCAL_QUESTION_INDEX_INVALID",
                    serde_json::json!({"key": key, "i": i}),
                ));
            }
            if key == "visualElements" {
                if let Some(bbox) = group["bbox"].as_array() {
                    if bbox
                        .iter()
                        .any(|v| v.as_f64().is_none_or(|v| !(0.0..=1.0).contains(&v)))
                        || bbox[2].as_f64() <= bbox[0].as_f64()
                        || bbox[3].as_f64() <= bbox[1].as_f64()
                    {
                        return Err(crate::language::error(
                            "LOCAL_VISUAL_BBOX_INVALID",
                            serde_json::json!({"i": i}),
                        ));
                    }
                }
            }
        }
    }
    if let Some(processing) = root.get("processing").filter(|v| !v.is_null()) {
        schema_check(&schemas().1, processing, "processing")?;
        let ids: HashSet<_> = list(self::result(&root), "questions")
            .iter()
            .map(|q| text(q, "id"))
            .collect();
        if list(processing, "questionSources")
            .iter()
            .chain(list(&processing["quality"], "issues"))
            .any(|r| !ids.contains(text(r, "questionId")))
        {
            return Err("Processing references a missing question".into());
        }
        for key in ["chunks", "visuals"] {
            let c = &processing[key];
            if c["succeeded"].as_u64().unwrap_or(0) + c["skipped"].as_u64().unwrap_or(0)
                > c["total"].as_u64().unwrap_or(0)
            {
                return Err(crate::language::error(
                    "LOCAL_PROCESSING_COUNT_INVALID",
                    serde_json::json!({"key": key}),
                ));
            }
        }
    }
    Ok(root)
}
pub fn result(root: &Value) -> &Value {
    root.get("result").unwrap_or(root)
}
pub fn grade(q: &Value, answer: &Value) -> Option<bool> {
    if !answer_complete(q)
        || [
            "media",
            "material",
            "options",
            "items",
            "choiceVariant",
            "matchingVariant",
            "stem",
        ]
        .iter()
        .any(|k| list(q, "missingFields").contains(&json!(k)))
    {
        return None;
    }
    let expected = &q["answerPayload"];
    match text(q, "answerMode") {
        "choice" => {
            let canonical = |v: &Value| -> Option<Vec<String>> {
                let mut s = v
                    .as_array()?
                    .iter()
                    .map(|x| x.as_str().map(|s| s.to_lowercase()))
                    .collect::<Option<Vec<_>>>()?;
                s.sort();
                s.dedup();
                Some(s)
            };
            Some(canonical(&answer["correct"])? == canonical(&expected["correct"])?)
        }
        "true_false" => Some(answer["value"].as_bool()? == expected["value"].as_bool()?),
        "fill_blank" => {
            let trim = |v: &Value| -> Option<Vec<String>> {
                v.as_array()?
                    .iter()
                    .map(|x| x.as_str().map(|s| s.trim().to_owned()))
                    .collect::<Option<Vec<_>>>()
            };
            Some(trim(&answer["answers"])? == trim(&expected["answers"])?)
        }
        "ordering" => {
            answer["order"].as_array()?;
            Some(answer["order"] == expected["order"])
        }
        "matching" => {
            answer["matches"].as_array()?;
            let pairs = |v: &Value| -> Vec<String> {
                let mut p = list(v, "matches")
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>();
                p.sort();
                p
            };
            Some(pairs(answer) == pairs(expected))
        }
        _ => None,
    }
}

// Every visual resource follows the same path/checksum/import boundaries.
pub fn resource_refs(root: &Value) -> impl Iterator<Item = &Value> {
    list(root, "visualElements")
        .iter()
        .flat_map(visual_refs)
        .chain(
            list(root, "questions")
                .iter()
                .filter_map(|q| q.get("audioRef").filter(|r| r.is_object())),
        )
}

pub fn visual_refs(visual: &Value) -> impl Iterator<Item = &Value> {
    ["imageRef", "sourceRef"]
        .into_iter()
        .filter_map(|key| visual.get(key).filter(|v| v.is_object()))
}

/// Relational rules shared by JSON import, editing and backup validation.
pub fn validate_tree(questions: &mut [Value]) -> Result<()> {
    for q in questions.iter_mut() {
        validate_question(q)?;
    }
    let mut ids = std::collections::HashMap::new();
    for (i, q) in questions.iter().enumerate() {
        let id = text(q, "id");
        if id.is_empty() || ids.insert(id.to_owned(), i).is_some() {
            return Err("Questions require unique IDs".into());
        }
    }
    for q in questions.iter() {
        let parent = text(q, "parentId");
        if !parent.is_empty() {
            let p = &questions[*ids.get(parent).ok_or("Missing parent question")?];
            if !crate::questions::composite(p)
                || matches!(text(q, "answerMode"), "reading" | "listening")
            {
                return Err("Invalid composite ancestry".into());
            }
            if matches!(text(p, "answerMode"), "word_bank" | "cloze")
                && (text(q, "answerMode") != "choice" || text(q, "choiceVariant") != "single")
            {
                return Err("Gap children must be single choices".into());
            }
            if text(p, "answerMode") == "gap_fill"
                && (text(q, "answerMode") != "fill_blank" || q["blankCount"] != 1)
            {
                return Err("Grammar gaps require single-blank children".into());
            }
            if text(p, "answerMode") == "listening"
                && !matches!(
                    text(q, "answerMode"),
                    "choice" | "fill_blank" | "short_answer"
                )
            {
                return Err("Invalid listening child mode".into());
            }
            if text(p, "answerMode") == "word_bank" && text(q, "optionSourceId") != parent {
                return Err("Word bank must share its options".into());
            }
        }
        let mut current = parent;
        let mut seen = HashSet::from([text(q, "id")]);
        while !current.is_empty() {
            if !seen.insert(current) {
                return Err("Cyclic question ancestry".into());
            }
            current = text(
                &questions[*ids.get(current).ok_or("Missing ancestor")?],
                "parentId",
            );
        }
        let owner = text(q, "optionSourceId");
        if !owner.is_empty() {
            let p = &questions[*ids.get(owner).ok_or("Missing option pool")?];
            if owner != parent
                || text(p, "answerMode") != "word_bank"
                || text(q, "answerMode") != "choice"
                || !list(q, "options").is_empty()
            {
                return Err("Invalid shared option pool".into());
            }
            let labels: Vec<_> = list(p, "options")
                .iter()
                .filter_map(|o| o["label"].as_str())
                .map(str::to_lowercase)
                .collect();
            if !labels.is_empty()
                && list(&q["answerPayload"], "correct")
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|v| !labels.contains(&v.to_lowercase()))
            {
                return Err("Answer references an unknown shared option".into());
            }
        }
        if crate::questions::composite(q) {
            if !q["answerPayload"].is_null() {
                return Err("Composite parents cannot have answers".into());
            }
            let children: Vec<_> = questions
                .iter()
                .filter(|c| text(c, "parentId") == text(q, "id"))
                .collect();
            if matches!(text(q, "answerMode"), "word_bank" | "cloze" | "gap_fill") {
                let refs: Vec<_> = list(q, "passage")
                    .iter()
                    .filter(|b| text(b, "partType") == "blank")
                    .map(|b| text(b, "questionId"))
                    .collect();
                if refs.iter().collect::<HashSet<_>>().len() != refs.len()
                    || refs.len() != children.len()
                    || children.iter().any(|c| !refs.contains(&text(c, "id")))
                {
                    return Err("Blank references must match child questions exactly".into());
                }
            }
            if text(q, "answerMode") == "word_bank" && q["allowReuse"] != true {
                let selected: Vec<_> = children
                    .iter()
                    .flat_map(|c| list(&c["answerPayload"], "correct"))
                    .filter(|v| !v.is_null())
                    .collect();
                if selected
                    .iter()
                    .map(|v| v.to_string().to_lowercase())
                    .collect::<HashSet<_>>()
                    .len()
                    != selected.len()
                {
                    return Err("Word bank answers cannot repeat".into());
                }
            }
        }
    }
    let incomplete: Vec<_> = questions
        .iter()
        .filter(|q| {
            crate::questions::composite(q)
                && ((text(q, "answerMode") != "listening" && list(q, "passage").is_empty())
                    || !questions
                        .iter()
                        .any(|c| text(c, "parentId") == text(q, "id")))
        })
        .map(|q| text(q, "id").to_owned())
        .collect();
    for q in questions {
        if incomplete.contains(&text(q, "id").to_owned()) {
            q["needsReview"] = json!(true);
            if !list(q, "missingFields").contains(&json!("material")) {
                q["missingFields"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("material"));
            }
        }
    }
    Ok(())
}

pub fn validate_attempt(q: &Value, answer: &Value) -> Result<()> {
    if answer.is_null() {
        return Ok(());
    }
    let mut candidate = q.clone();
    candidate["answerPayload"] = answer.clone();
    // A structurally incomplete question explicitly permits free text and self assessment.
    if [
        "answerMode",
        "options",
        "items",
        "choiceVariant",
        "matchingVariant",
    ]
    .iter()
    .any(|k| list(q, "missingFields").contains(&json!(k)))
        && answer
            .as_object()
            .is_some_and(|o| o.len() == 1 && o.get("text").is_some_and(Value::is_string))
    {
        return Ok(());
    }
    validate_question(&mut candidate)
}

pub fn validate_context(groups: &[Value], visuals: &[Value], ids: &HashSet<&str>) -> Result<()> {
    static CONTEXT: OnceLock<(jsonschema::Validator, jsonschema::Validator)> = OnceLock::new();
    let validators = CONTEXT.get_or_init(|| {
        let source: Value =
            serde_json::from_str(include_str!("../contracts.json")).expect("schemas");
        let validator = |name: &str| {
            jsonschema::validator_for(
                &json!({"$defs":source["result"]["$defs"],"$ref":format!("#/$defs/{name}")}),
            )
            .expect("context schema")
        };
        (validator("DocumentGroup"), validator("DocumentVisual"))
    });
    for (values, schema) in [(groups, &validators.0), (visuals, &validators.1)] {
        for value in values {
            let mut v = value.clone();
            v.as_object_mut().ok_or("Invalid context")?.remove("id");
            schema_check(schema, &v, "context")?;
            if list(&v, "questionIds")
                .iter()
                .any(|id| id.as_str().is_none_or(|id| !ids.contains(id)))
            {
                return Err("Context references a missing question".into());
            }
        }
    }
    Ok(())
}
