//! Group-aware selection and score allocation run only in Rust.
use crate::{
    contract::{list, text, Result},
    questions,
    store::{hash, Store},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preview {
    pub bank_ids: Vec<String>,
    pub search: String,
    pub mode: String,
    pub filter: String,
    pub selection: String,
    pub count: usize,
    pub quotas: HashMap<String, usize>,
    pub question_ids: Vec<String>,
    pub random: bool,
    pub total_cents: i64,
    #[serde(default)]
    pub budgets: HashMap<String, i64>,
}
struct Candidate {
    id: String,
    category: String,
    weight: usize,
}
pub fn category(q: &Value) -> &str {
    if text(q, "answerMode") == "choice" {
        text(q, "choiceVariant")
    } else {
        text(q, "answerMode")
    }
}
pub fn selected_rows(rows: &[Value], roots: &[String]) -> Result<Vec<Value>> {
    if roots.is_empty()
        || roots.len() > 1000
        || roots.iter().collect::<HashSet<_>>().len() != roots.len()
    {
        return Err("Select distinct complete questions or groups".into());
    }
    let mut selected = Vec::new();
    let index = questions::Index::new(rows);
    for root in roots {
        let row = index
            .by_id
            .get(root.as_str())
            .ok_or("Selected question was deleted")?;
        if !text(&row["question"], "parentId").is_empty() {
            return Err("Composite questions must be selected as a whole".into());
        }
        selected.extend(index.trees[root.as_str()].iter().map(|r| (*r).clone()));
    }
    let count = selected
        .iter()
        .filter(|r| !questions::composite(&r["question"]))
        .count();
    if count == 0 || count > 1000 {
        return Err("Select between 1 and 1000 answerable subquestions".into());
    }
    Ok(selected)
}
pub fn digest(rows: &[Value]) -> Result<String> {
    let mut rows = rows.to_vec();
    for r in &mut rows {
        for key in ["favorite", "latestResult"] {
            r.as_object_mut().ok_or("Invalid question row")?.remove(key);
        }
    }
    Ok(hash(
        &serde_json::to_vec(&questions::freeze(&rows)).map_err(|e| e.to_string())?,
    ))
}
fn split(total: i64, count: usize) -> Result<Vec<i64>> {
    if count == 0 || total < count as i64 || total > 100_000_000 {
        return Err("Each question requires at least 0.01 points; total exceeds its limit".into());
    }
    Ok((0..count)
        .map(|i| total / count as i64 + i64::from((i as i64) < total % count as i64))
        .collect())
}
/// Bounded subset sum. Backtracking uses each root once; group children never split.
fn exact(weights: &[usize], target: usize) -> Result<Vec<usize>> {
    if target == 0 || target > 1000 {
        return Err("Question count must be between 1 and 1000".into());
    }
    let mut paths = vec![None; target + 1];
    paths[0] = Some((0, usize::MAX));
    for (i, &weight) in weights.iter().enumerate() {
        if weight == 0 || weight > target {
            continue;
        }
        for n in (weight..=target).rev() {
            if paths[n].is_none() && paths[n - weight].is_some() {
                paths[n] = Some((n - weight, i));
            }
        }
    }
    if paths[target].is_none() {
        return Err(crate::language::error(
            "LOCAL_GROUP_COUNT_UNSATISFIABLE",
            json!({}),
        ));
    }
    let mut selected = Vec::new();
    let mut n = target;
    while n > 0 {
        let (prev, i) = paths[n].ok_or("Invalid selection path")?;
        selected.push(i);
        n = prev;
    }
    selected.sort_unstable();
    Ok(selected)
}
impl Store {
    fn paper_candidates(&self, p: &Preview) -> Result<Vec<Candidate>> {
        if !p.search.is_empty()
            || p.bank_ids.len() > 1000
            || ![
                "",
                "choice",
                "single",
                "multiple",
                "true_false",
                "fill_blank",
                "short_answer",
                "ordering",
                "matching",
                "reading",
                "word_bank",
                "cloze",
            ]
            .contains(&p.mode.as_str())
            || !["", "wrong", "favorite", "unattempted"].contains(&p.filter.as_str())
        {
            let roots = self.questions_multi(None, &p.bank_ids, &p.search, &p.mode, &p.filter)?;
            return roots
                .as_array()
                .ok_or("Invalid question selection")?
                .iter()
                .map(|root| {
                    Ok(Candidate {
                        id: text(root, "id").to_owned(),
                        category: category(&root["question"]).to_owned(),
                        weight: if questions::composite(&root["question"]) {
                            list(root, "children")
                                .iter()
                                .filter(|child| !questions::composite(&child["question"]))
                                .count()
                        } else {
                            1
                        },
                    })
                })
                .collect();
        }
        let db = self.connect()?;
        let ids = questions::matching_roots(&db, &p.bank_ids, &p.mode, &p.filter)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut stmt = db.prepare("WITH RECURSIVE tree(root,id) AS (SELECT value,value FROM json_each(?1) UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id) SELECT t.root,COALESCE(CASE WHEN r.mode='choice' THEN c.variant ELSE r.mode END,''),SUM(n.mode IS NULL OR n.mode NOT IN ('reading','word_bank','cloze')) FROM tree t JOIN questions r ON r.id=t.root JOIN questions n ON n.id=t.id LEFT JOIN choice_questions c ON c.question_id=r.id GROUP BY t.root").map_err(|e| e.to_string())?;
        let mut details = stmt
            .query_map([json!(ids).to_string()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, String>(1)?, r.get::<_, i64>(2)?),
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        ids.into_iter()
            .map(|id| {
                let (category, weight) =
                    details.remove(&id).ok_or("Selected question is missing")?;
                Ok(Candidate {
                    id,
                    category,
                    weight: weight.try_into().map_err(|_| "Invalid question count")?,
                })
            })
            .collect()
    }
    pub fn preview_paper(&self, p: Preview) -> Result<Value> {
        if p.bank_ids.is_empty() {
            return Err("Select at least one bank".into());
        }
        let mut roots = self.paper_candidates(&p)?;
        if p.random {
            roots.sort_by_cached_key(|_| crate::store::id());
        }
        let chosen = match p.selection.as_str() {
            "count" => {
                let weights: Vec<_> = roots.iter().map(|r| r.weight).collect();
                exact(&weights, p.count)?
                    .into_iter()
                    .map(|i| roots[i].id.clone())
                    .collect::<Vec<_>>()
            }
            "manual" => {
                if p.question_ids
                    .iter()
                    .any(|id| !roots.iter().any(|r| &r.id == id))
                {
                    return Err("Selected groups no longer match the filter".into());
                }
                p.question_ids
            }
            "quota" => {
                let mut chosen = Vec::new();
                let mut keys: Vec<_> = p.quotas.keys().collect();
                keys.sort();
                for key in keys {
                    let count = p.quotas[key];
                    let available: Vec<_> = roots.iter().filter(|r| &r.category == key).collect();
                    if count > available.len() {
                        return Err(
                            format!("Not enough complete questions/groups for {key}").into()
                        );
                    }
                    chosen.extend(available.into_iter().take(count).map(|r| r.id.clone()));
                }
                chosen.sort_by_key(|id| roots.iter().position(|r| &r.id == id));
                chosen
            }
            _ => return Err("Unsupported selection mode".into()),
        };
        let db = self.connect()?;
        let selected = selected_rows(
            &questions::read_scoped(&db, &p.bank_ids, Some(&chosen))?,
            &chosen,
        )?;
        let index = questions::Index::new(&selected);
        let leaves: Vec<_> = selected
            .iter()
            .filter(|r| !questions::composite(&r["question"]))
            .collect();
        let mut scores = if p.total_cents == 0 {
            vec![]
        } else {
            split(p.total_cents, leaves.len())?
        };
        if !p.budgets.is_empty() {
            if p.budgets.len() > 10
                || p.budgets.values().any(|v| !(0..=100_000_000).contains(v))
                || p.budgets.values().sum::<i64>() != p.total_cents
            {
                return Err("Type budgets must add up to the total score".into());
            }
            let mut allocated = 0;
            for (key, budget) in &p.budgets {
                let indexes: Vec<_> = leaves
                    .iter()
                    .enumerate()
                    .filter_map(|(i, r)| {
                        let root = index.root_id(r);
                        let q = index.by_id.get(root)?;
                        (category(&q["question"]) == key).then_some(i)
                    })
                    .collect();
                if indexes.is_empty() {
                    if *budget != 0 {
                        return Err("Budget has no matching questions".into());
                    }
                    continue;
                }
                for (i, v) in indexes.iter().zip(split(*budget, indexes.len())?) {
                    scores[*i] = v;
                    allocated += 1;
                }
            }
            if allocated != leaves.len() {
                return Err("Every selected type needs a score budget".into());
            }
        }
        Ok(
            json!({"questionIds":chosen,"digest":digest(&selected)?,"questions":leaves.iter().map(|r|index.hydrate(r)).collect::<Vec<_>>(),"scores":scores,"count":leaves.len()}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indivisible_groups() {
        assert_eq!(exact(&[3, 4, 2], 6).unwrap(), vec![1, 2]);
        assert!(exact(&[3, 3], 5).is_err());
        assert_eq!(split(100, 3).unwrap(), vec![34, 33, 33]);
    }
}
