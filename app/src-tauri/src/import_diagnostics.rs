use crate::{
    contract::{self, list, text, Result},
    store::{err, hash, id, now},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) fn from_root(root: &Value) -> Result<Vec<Value>> {
    if !root["status"].is_null() && root["status"] != "PARTIAL" && root["status"] != "SUCCEEDED" {
        return Err("Invalid import status".into());
    }
    let mut diagnostics = if let Some(value) = root.get("importDiagnostics") {
        let values = value.as_array().ok_or("Invalid import diagnostics")?;
        if values.len() > 1000 {
            return Err("Too many import diagnostics".into());
        }
        values.clone()
    } else {
        vec![]
    };
    if diagnostics.is_empty() && (!root["status"].is_null() || !root["processing"].is_null()) {
        diagnostics.push(json!({"questionIds":list(contract::result(root), "questions").iter().map(|q| &q["id"]).collect::<Vec<_>>(), "status":root["status"], "processing":root["processing"]}));
    }
    let ids: HashSet<_> = list(contract::result(root), "questions")
        .iter()
        .map(|q| text(q, "id"))
        .collect();
    for diagnostic in &diagnostics {
        contract::validate_import_diagnostic(diagnostic)?;
        if list(diagnostic, "questionIds")
            .iter()
            .any(|id| !ids.contains(id.as_str().unwrap_or("")))
        {
            return Err("Import diagnostics reference a missing question".into());
        }
    }
    Ok(diagnostics)
}

pub(crate) fn remap(diagnostics: &[Value], ids: &HashMap<String, String>) -> Vec<Value> {
    diagnostics
        .iter()
        .map(|value| {
            let mut value = value.clone();
            value["questionIds"] = json!(list(&value, "questionIds")
                .iter()
                .filter_map(|id| ids.get(id.as_str()?))
                .collect::<Vec<_>>());
            for path in ["/processing/questionSources", "/processing/quality/issues"] {
                if let Some(values) = value.pointer_mut(path).and_then(Value::as_array_mut) {
                    values.retain_mut(|item| {
                        if let Some(id) = ids.get(text(item, "questionId")) {
                            item["questionId"] = json!(id);
                            true
                        } else {
                            false
                        }
                    });
                }
            }
            value
        })
        .collect()
}

pub(crate) fn write(db: &Connection, import: &str, diagnostics: &[Value]) -> Result<()> {
    if !diagnostics.is_empty() {
        let previous: Option<String> = db
            .query_row(
                "SELECT message FROM import_warnings WHERE import_id=?1 AND position=-1",
                [import],
                |row| row.get(0),
            )
            .optional()
            .map_err(err)?;
        let mut saved: Vec<Value> = previous
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(err)?
            .unwrap_or_default();
        for value in &saved {
            contract::validate_import_diagnostic(value)?;
        }
        for diagnostic in diagnostics {
            if !saved.contains(diagnostic) {
                saved.push(diagnostic.clone());
            }
        }
        if saved.len() > 1000 {
            return Err("Too many import diagnostics".into());
        }
        let raw = serde_json::to_string(&saved).map_err(err)?;
        if raw.len() > contract::MAX_JSON {
            return Err("Import diagnostics exceed size limit".into());
        }
        // Negative positions keep structured metadata separate from literal warnings in schema 11.
        db.execute(
            "INSERT OR REPLACE INTO import_warnings VALUES(?1,-1,?2)",
            params![import, raw],
        )
        .map_err(err)?;
    }
    Ok(())
}

pub(crate) fn read(db: &Connection, bank: &str) -> Result<Vec<Value>> {
    let mut query = db.prepare("SELECT w.message FROM import_warnings w JOIN imports i ON i.id=w.import_id WHERE i.bank_id=?1 AND w.position=-1 ORDER BY i.created_at,i.rowid").map_err(err)?;
    let records = query
        .query_map([bank], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    if records.is_empty() {
        return Ok(vec![]);
    }
    let ids = db
        .prepare("SELECT id FROM questions WHERE bank_id=?1")
        .map_err(err)?
        .query_map([bank], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(err)?;
    let ids: HashMap<_, _> = ids.into_iter().map(|id| (id.clone(), id)).collect();
    let mut diagnostics = Vec::new();
    for raw in records {
        if raw.len() > contract::MAX_JSON {
            return Err("Import diagnostics exceed size limit".into());
        }
        let values: Vec<Value> = serde_json::from_str(&raw).map_err(err)?;
        if values.len() > 1000 {
            return Err("Too many import diagnostics".into());
        }
        for value in &values {
            contract::validate_import_diagnostic(value)?;
        }
        let missing: HashSet<_> = values
            .iter()
            .flat_map(|value| list(value, "questionIds"))
            .filter_map(Value::as_str)
            .filter(|id| !ids.contains_key(*id))
            .collect();
        if !missing.is_empty() {
            let foreign: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM questions WHERE bank_id<>?1 AND id IN (SELECT value FROM json_each(?2)))",params![bank,json!(missing).to_string()],|row| row.get(0)).map_err(err)?;
            if foreign {
                return Err("Import diagnostics reference another bank".into());
            }
        }
        diagnostics.extend(remap(&values, &ids));
    }
    Ok(diagnostics)
}

pub(crate) fn copy(
    db: &Connection,
    banks: &[String],
    bank: &str,
    ids: &HashMap<String, String>,
) -> Result<()> {
    let mut diagnostics = Vec::new();
    for source in banks {
        diagnostics.extend(read(db, source)?);
    }
    if !diagnostics.is_empty() {
        let import = id();
        db.execute(
            "INSERT INTO imports VALUES(?1,?2,?3,?4)",
            params![
                import,
                bank,
                hash(format!("diagnostics:{import}").as_bytes()),
                now()
            ],
        )
        .map_err(err)?;
        write(db, &import, &remap(&diagnostics, ids))?;
    }
    Ok(())
}

pub(crate) fn wrap(result: Value, diagnostics: Vec<Value>) -> Value {
    if diagnostics.is_empty() {
        return result;
    }
    let status = if diagnostics.iter().any(|d| d["status"] == "PARTIAL") {
        json!("PARTIAL")
    } else if diagnostics.iter().all(|d| d["status"] == "SUCCEEDED") {
        json!("SUCCEEDED")
    } else {
        Value::Null
    };
    let processing = if diagnostics.len() == 1 {
        diagnostics[0]["processing"].clone()
    } else {
        Value::Null
    };
    json!({"status":status,"result":result,"processing":processing,"importDiagnostics":diagnostics})
}

pub(crate) fn validate_database(db: &Connection) -> Result<()> {
    let mut query = db.prepare("SELECT DISTINCT i.bank_id FROM imports i JOIN import_warnings w ON w.import_id=i.id WHERE w.position=-1").map_err(err)?;
    for bank in query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
    {
        read(db, &bank.map_err(err)?)?;
    }
    Ok(())
}
