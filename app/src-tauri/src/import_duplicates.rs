use crate::{
    contract::{self, list, text, Result},
    questions,
    store::{hash, Pending, Store},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn signature(rows: &[Value]) -> Result<String> {
    let ids: HashMap<_, _> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| (text(row, "id").to_owned(), format!("q{i}")))
        .collect();
    let mut document = questions::freeze(rows);
    let mut content = Vec::new();
    for row in rows {
        let mut q = row["question"].clone();
        questions::remap(&mut q, &ids)?;
        content.push(q);
    }
    document["questions"] = json!(content);
    for key in ["groups", "visuals"] {
        for item in document[key]
            .as_array_mut()
            .ok_or("Invalid question context")?
        {
            item.as_object_mut()
                .ok_or("Invalid question context")?
                .remove("id");
            if let Some(refs) = item["questionIds"].as_array_mut() {
                for id in refs.iter_mut() {
                    *id = json!(ids
                        .get(id.as_str().unwrap_or(""))
                        .ok_or("Missing group reference")?);
                }
                refs.sort_by_key(Value::to_string);
            }
        }
        document[key]
            .as_array_mut()
            .unwrap()
            .sort_by_key(Value::to_string);
    }
    Ok(hash(
        &serde_json::to_vec(&document).map_err(crate::store::err)?,
    ))
}

impl Store {
    pub fn import_duplicates(&self, ticket: &str, bank: &str) -> Result<Value> {
        let pending = self
            .pending
            .as_ref()
            .filter(|p| p.ticket == ticket)
            .ok_or("Import preview expired")?;
        self.pending_duplicates(pending, bank)
    }
    fn pending_duplicates(&self, pending: &Pending, bank: &str) -> Result<Value> {
        let db = self.connect()?;
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM banks WHERE id=?1)",
                [bank],
                |r| r.get(0),
            )
            .map_err(crate::store::err)?;
        if !exists {
            return Err("Destination bank no longer exists".into());
        }
        let existing = questions::read_scoped(&db, &[bank.into()], None)?;
        let index = questions::Index::new(&existing);
        let mut signatures = HashSet::new();
        for row in existing
            .iter()
            .filter(|row| text(&row["question"], "parentId").is_empty())
        {
            let tree: Vec<_> = index.trees[text(row, "id")]
                .iter()
                .map(|r| (*r).clone())
                .collect();
            signatures.insert(signature(&tree)?);
        }
        // Reuse the real importer to compare normalized trees, without copying resources or starting models.
        let directory = tempfile::tempdir_in(&self.dir).map_err(crate::store::err)?;
        let staged = Store::new(directory.path().to_owned())?;
        let input = Pending::new(
            serde_json::to_vec(&pending.root).map_err(crate::store::err)?,
            pending.title.clone(),
        )?;
        let imported = staged.import_pending(&input, None, &pending.title)?;
        let rows = questions::read_scoped(
            &staged.connect()?,
            &[text(&imported, "bankId").into()],
            None,
        )?;
        let incoming_ids: HashMap<_, _> = rows
            .iter()
            .zip(list(contract::result(&pending.root), "questions"))
            .map(|(row, q)| (text(row, "id"), text(q, "id")))
            .collect();
        let index = questions::Index::new(&rows);
        let mut duplicates = Vec::new();
        let mut content_checks = Vec::new();
        for row in rows
            .iter()
            .filter(|row| text(&row["question"], "parentId").is_empty())
        {
            let tree: Vec<_> = index.trees[text(row, "id")]
                .iter()
                .map(|r| (*r).clone())
                .collect();
            let digest = signature(&tree)?;
            content_checks.push(digest.clone());
            if signatures.contains(&digest) {
                duplicates.push(json!({"id":incoming_ids[text(row,"id")],"stem":row["question"]["stem"],"count":tree.iter().filter(|r|!questions::composite(&r["question"])).count()}));
            }
        }
        let mut existing_checks: Vec<_> = signatures.into_iter().collect();
        existing_checks.sort();
        let check = hash(
            &serde_json::to_vec(&json!([
                bank,
                pending.digest()?,
                existing_checks,
                content_checks
            ]))
            .map_err(crate::store::err)?,
        );
        Ok(json!({"groups":duplicates,"check":check}))
    }
    pub fn import_checked(
        &mut self,
        ticket: &str,
        bank: Option<String>,
        title: &str,
        skip: bool,
        check: Option<&str>,
    ) -> Result<Value> {
        if !skip {
            return self.import(ticket, bank, title);
        }
        let pending = self
            .pending
            .as_ref()
            .filter(|p| p.ticket == ticket)
            .ok_or("Import preview expired")?;
        let destination = bank
            .as_deref()
            .ok_or("Choose an existing bank before skipping duplicates")?;
        let comparison = self.pending_duplicates(pending, destination)?;
        if check != comparison["check"].as_str() {
            return Err(crate::language::error(
                "LOCAL_DUPLICATE_CHECK_CHANGED",
                json!({}),
            ));
        }
        let roots: HashSet<_> = list(&comparison, "groups")
            .iter()
            .map(|g| text(g, "id").to_owned())
            .collect();
        let mut skipped = roots;
        let questions = list(contract::result(&pending.root), "questions");
        loop {
            let before = skipped.len();
            for q in questions {
                if skipped.contains(text(q, "parentId")) {
                    skipped.insert(text(q, "id").into());
                }
            }
            if before == skipped.len() {
                break;
            }
        }
        let result = self.import_pending_skipping(pending, bank, title, &skipped)?;
        self.pending = None;
        Ok(result)
    }
}

pub(crate) fn without(root: &Value, skipped: &HashSet<String>) -> Value {
    let mut root = root.clone();
    let result = if root.get("result").is_some() {
        &mut root["result"]
    } else {
        &mut root
    };
    result["questions"]
        .as_array_mut()
        .unwrap()
        .retain(|q| !skipped.contains(text(q, "id")));
    for key in ["groups", "visualElements"] {
        if let Some(items) = result[key].as_array_mut() {
            items.retain_mut(|item| {
                let Some(ids) = item["questionIds"].as_array_mut() else {
                    return true;
                };
                let was_empty = ids.is_empty();
                ids.retain(|id| !skipped.contains(id.as_str().unwrap_or("")));
                was_empty || !ids.is_empty()
            });
        }
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(extra: bool) -> Value {
        let sample: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/sample.json")).unwrap();
        let mut qs = vec![sample["questions"][0].clone()];
        if extra {
            let mut q = qs[0].clone();
            q["id"] = json!("additional");
            q["stem"] = json!("Another question");
            q["sourceText"] = Value::Null;
            qs.push(q);
        }
        json!({"schemaVersion":3,"questions":qs,"groups":[],"visualElements":[],"warnings":[],"confidenceScore":100,"missingFields":[]})
    }
    fn preview(store: &mut Store, root: &Value) -> String {
        let value = store
            .preview(serde_json::to_vec(root).unwrap(), "Import".into())
            .unwrap();
        text(&value, "ticket").into()
    }
    #[test]
    fn exact_preview_is_passive_and_skips_only_identical_complete_trees() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into()).unwrap();
        let ticket = preview(&mut store, &document(false));
        let bank = store.import(&ticket, None, "Bank").unwrap();
        let bank = text(&bank, "bankId");
        let original = store.questions(Some(bank), "", "", "").unwrap()[0].clone();
        store.favorite(text(&original, "id"), true).unwrap();
        let ticket = preview(&mut store, &document(true));
        let before = store.banks().unwrap();
        let comparison = store.import_duplicates(&ticket, bank).unwrap();
        assert_eq!(comparison["groups"][0]["id"], "q0");
        assert_eq!(comparison["groups"][0]["count"], 1);
        assert_eq!(store.banks().unwrap(), before);
        let result = store
            .import_checked(
                &ticket,
                Some(bank.into()),
                "Bank",
                true,
                comparison["check"].as_str(),
            )
            .unwrap();
        assert_eq!(result["count"], 1);
        assert_eq!(result["skippedCount"], 1);
        let rows = store.questions(Some(bank), "", "", "").unwrap();
        assert_eq!(list(&json!({"items":rows}), "items").len(), 2);
        assert_eq!(
            store.question_detail(text(&original, "id")).unwrap()["favorite"],
            true
        );
        let ticket = preview(&mut store, &document(true));
        assert_eq!(
            store
                .import_checked(&ticket, Some(bank.into()), "Bank", false, None)
                .unwrap()["duplicate"],
            true
        );
    }
    #[test]
    fn changed_answers_and_stale_comparisons_are_never_silently_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into()).unwrap();
        let ticket = preview(&mut store, &document(false));
        let bank = store.import(&ticket, None, "Bank").unwrap();
        let bank = text(&bank, "bankId");
        let mut changed = document(true);
        changed["questions"][0]["answerPayload"] = json!({"correct":["B"]});
        changed["questions"][0]["sourceText"] = Value::Null;
        let ticket = preview(&mut store, &changed);
        assert!(list(&store.import_duplicates(&ticket, bank).unwrap(), "groups").is_empty());
        let ticket = preview(&mut store, &document(true));
        let comparison = store.import_duplicates(&ticket, bank).unwrap();
        let rows = store.questions(Some(bank), "", "", "").unwrap();
        let id = text(&rows[0], "id");
        let mut q = rows[0]["question"].clone();
        q["analysis"] = json!("User correction");
        store.save_question_tree(bank, Some(id), vec![q]).unwrap();
        assert!(store
            .import_checked(
                &ticket,
                Some(bank.into()),
                "Bank",
                true,
                comparison["check"].as_str()
            )
            .is_err());
        assert_eq!(
            store
                .questions(Some(bank), "", "", "")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(store.pending.is_some());
    }
    #[test]
    fn choosing_keep_appends_overlapping_snapshots_and_group_changes_keep_the_whole_group() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into()).unwrap();
        let ticket = preview(&mut store, &document(false));
        let bank = store.import(&ticket, None, "Bank").unwrap();
        let bank = text(&bank, "bankId");
        let ticket = preview(&mut store, &document(true));
        let result = store
            .import_checked(&ticket, Some(bank.into()), "Bank", false, None)
            .unwrap();
        assert_eq!(result["count"], 2);
        assert_eq!(
            store
                .questions(Some(bank), "", "", "")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let mut composite: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
        let ticket = preview(&mut store, &composite);
        let groups = store.import(&ticket, None, "Groups").unwrap();
        let bank = text(&groups, "bankId");
        // A different result envelope must not defeat tree comparison.
        composite["warnings"] = json!(["Another snapshot"]);
        let ticket = preview(&mut store, &composite);
        let comparison = store.import_duplicates(&ticket, bank).unwrap();
        assert!(list(&comparison, "groups")
            .iter()
            .any(|g| g["id"] == "reading" && g["count"] == 6));
        let child = composite["questions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|q| q["id"] == "r-choice")
            .unwrap();
        child["analysis"] = json!("Changed child");
        let ticket = preview(&mut store, &composite);
        let comparison = store.import_duplicates(&ticket, bank).unwrap();
        assert!(!list(&comparison, "groups")
            .iter()
            .any(|g| g["id"] == "reading"));
    }
    #[test]
    fn skip_preserves_diagnostics_of_retained_questions_and_complete_snapshot_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().into()).unwrap();
        let ticket = preview(&mut store, &document(false));
        let bank = store.import(&ticket, None, "Bank").unwrap();
        let bank = text(&bank, "bankId");
        let root = json!({"status":"PARTIAL","processing":null,"result":document(true)});
        let ticket = preview(&mut store, &root);
        let comparison = store.import_duplicates(&ticket, bank).unwrap();
        store
            .import_checked(
                &ticket,
                Some(bank.into()),
                "Bank",
                true,
                comparison["check"].as_str(),
            )
            .unwrap();
        crate::import_diagnostics::validate_database(&store.connect().unwrap()).unwrap();
        let diagnostics = crate::import_diagnostics::read(&store.connect().unwrap(), bank).unwrap();
        assert_eq!(diagnostics[0]["status"], "PARTIAL");
        assert_eq!(list(&diagnostics[0], "questionIds").len(), 1);
        let ticket = preview(&mut store, &root);
        assert_eq!(
            store.import(&ticket, Some(bank.into()), "Bank").unwrap()["duplicate"],
            true
        );
    }
}
