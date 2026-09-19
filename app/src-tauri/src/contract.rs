use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

pub type Result<T> = std::result::Result<T, String>;
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
        return Err(format!("{prefix}{}: {error}", error.instance_path));
    }
    Ok(())
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
        ] {
            if let Some(Value::String(s)) = obj.get_mut(key) {
                *s = s.trim().to_owned();
                if s.is_empty() {
                    obj.insert(key.into(), Value::Null);
                }
            }
        }
        for key in ["items", "options", "contentBlocks", "missingFields"] {
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
            return Err("items.id 必须是整数".into());
        }
    }
    for block in list(q, "contentBlocks") {
        if !["textValue", "markdownValue", "latexValue"]
            .iter()
            .any(|k| filled(&block[*k]))
            && block["jsonValue"].is_null()
        {
            return Err("contentBlocks: 内容不能为空".into());
        }
    }
    let wrapper = json!({"questions":[q.clone()],"groups":[],"visualElements":[],"warnings":[],"confidenceScore":0});
    schema_check(&schemas().0, &wrapper, "result")?;
    let mode = text(q, "answerMode");
    if !mode.is_empty()
        && mode != "choice"
        && (!list(q, "options").is_empty() || !text(q, "choiceVariant").is_empty())
    {
        return Err("options / choiceVariant 仅适用于选择题".into());
    }
    if !mode.is_empty() && mode != "ordering" && mode != "matching" && !list(q, "items").is_empty()
    {
        return Err("items 仅适用于排序和匹配题".into());
    }
    if !mode.is_empty() && mode != "matching" && !text(q, "matchingVariant").is_empty() {
        return Err("matchingVariant 仅适用于匹配题".into());
    }
    if mode == "ordering" && list(q, "items").iter().any(|i| !i["side"].is_null()) {
        return Err("排序项不能含 side".into());
    }
    let labels: Vec<Value> = list(q, "options")
        .iter()
        .filter_map(|o| o["label"].as_str())
        .map(|s| json!(s.to_lowercase()))
        .collect();
    if !unique(&labels) {
        return Err("选项标签重复".into());
    }
    let answer = &q["answerPayload"];
    if !answer.is_null() && !answer.is_object() {
        return Err("answerPayload 必须为对象或 null".into());
    }
    if let Some(obj) = answer.as_object() {
        let allowed: &[&str] = match mode {
            "choice" if text(q, "choiceVariant") == "multiple" => &["correct"],
            "choice" => &["correctOption"],
            "true_false" => &["value"],
            "fill_blank" => &["answers"],
            "short_answer" => &["text"],
            "ordering" => &["order"],
            "matching" => &["matches"],
            _ => &[
                "correct",
                "correctOption",
                "value",
                "answers",
                "text",
                "order",
                "matches",
            ],
        };
        if obj.keys().any(|k| !allowed.contains(&k.as_str())) || (mode.is_empty() && obj.len() > 1)
        {
            return Err("answerPayload 与 answerMode 不匹配".into());
        }
        for (key, value) in obj {
            if value.is_null() {
                continue;
            }
            let valid = match key.as_str() {
                "value" => value.is_boolean(),
                "correctOption" | "text" => value
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
                return Err(format!("answerPayload.{key}: 类型或长度不合法"));
            }
        }
    }
    if mode == "choice" {
        let selected = if text(q, "choiceVariant") == "multiple" {
            list(answer, "correct").to_vec()
        } else {
            vec![answer["correctOption"].clone()]
        };
        let selected: Vec<Value> = selected
            .iter()
            .filter_map(Value::as_str)
            .map(|s| json!(s.trim().to_lowercase()))
            .filter(|s| s != "")
            .collect();
        if !unique(&selected)
            || (!labels.is_empty() && selected.iter().any(|s| !labels.contains(s)))
        {
            return Err("答案引用不存在或重复的选项".into());
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
            return Err("排序答案引用无效".into());
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
            return Err("匹配答案引用无效".into());
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
    ]
    .iter()
    .any(|k| filled(&q[*k]))
    {
        return Err("不能导入空题目".into());
    }
    let mut missing: Vec<Value> = ["stem", "questionTypeId", "answerMode"]
        .iter()
        .filter(|k| !filled(&q[**k]))
        .map(|k| json!(k))
        .collect();
    if mode == "choice" {
        if text(q, "choiceVariant").is_empty() {
            missing.push(json!("choiceVariant"));
        }
        if list(q, "options").len() < 2
            || list(q, "options")
                .iter()
                .any(|o| !filled(&o["label"]) || !filled(&o["content"]))
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
    if !answer_complete(q) {
        missing.push(json!("answerPayload"));
    }
    for key in ["analysis", "sourceText"] {
        if !filled(&q[key]) {
            missing.push(json!(key));
        }
    }
    for key in ["media", "material"] {
        if list(q, "missingFields").contains(&json!(key)) {
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
        "choice" if text(q, "choiceVariant") == "multiple" => "correct",
        "choice" => "correctOption",
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
        return Err("JSON 超过 32 MiB".into());
    }
    let mut root: Value = serde_json::from_slice(bytes).map_err(|e| format!("JSON: {e}"))?;
    // Old exports included this retired attribution field even for non-spreadsheet files.
    // Ignore it on import so removing the parser does not invalidate existing JSON/backups.
    let visuals = if root.get("result").is_some() {
        "/result/visualElements"
    } else {
        "/visualElements"
    };
    for pointer in [visuals, "/processing/questionSources"] {
        if let Some(items) = root.pointer_mut(pointer).and_then(Value::as_array_mut) {
            for item in items {
                if let Some(object) = item.as_object_mut() {
                    object.remove("excelSource");
                }
            }
        }
    }
    let result = if root.get("result").is_some() {
        &mut root["result"]
    } else {
        &mut root
    };
    if let Some(questions) = result.get_mut("questions").and_then(Value::as_array_mut) {
        for (i, q) in questions.iter_mut().enumerate() {
            validate_question(q).map_err(|e| format!("questions[{i}]: {e}"))?;
        }
    }
    schema_check(&schemas().0, result, "result")?;
    let count = list(result, "questions").len();
    for g in list(result, "groups") {
        if text(g, "title").trim().is_empty() {
            return Err("groups.title 不能为空".into());
        }
    }
    for v in list(result, "visualElements") {
        if text(v, "description").trim().is_empty() {
            return Err("visualElements.description 不能为空".into());
        }
    }
    for key in ["groups", "visualElements"] {
        for (i, group) in list(result, key).iter().enumerate() {
            if list(group, "questionIndexes")
                .iter()
                .any(|v| v.as_u64().is_none_or(|v| v as usize >= count))
            {
                return Err(format!("{key}[{i}].questionIndexes: 越界"));
            }
            if key == "visualElements" {
                if let Some(bbox) = group["bbox"].as_array() {
                    if bbox
                        .iter()
                        .any(|v| v.as_f64().is_none_or(|v| !(0.0..=1.0).contains(&v)))
                        || bbox[2].as_f64() <= bbox[0].as_f64()
                        || bbox[3].as_f64() <= bbox[1].as_f64()
                    {
                        return Err(format!("visualElements[{i}].bbox: 无效区域"));
                    }
                }
            }
        }
    }
    if let Some(processing) = root.get("processing").filter(|v| !v.is_null()) {
        schema_check(&schemas().1, processing, "processing")?;
        for key in ["chunks", "visuals"] {
            let c = &processing[key];
            if c["succeeded"].as_u64().unwrap_or(0) + c["skipped"].as_u64().unwrap_or(0)
                > c["total"].as_u64().unwrap_or(0)
            {
                return Err(format!("processing.{key}: 计数越界"));
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
        "choice" if text(q, "choiceVariant") == "multiple" => {
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
        "choice" => Some(
            answer["correctOption"].as_str()?.to_lowercase()
                == expected["correctOption"].as_str()?.to_lowercase(),
        ),
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
