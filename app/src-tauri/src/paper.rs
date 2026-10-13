//! Group-aware selection and score allocation run only in Rust.
use crate::question_metadata::FILTER_MODES;
use crate::{
    contract::{text, Result},
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
    if !text(q, "questionKind").is_empty() {
        text(q, "questionKind")
    } else if text(q, "answerMode") == "gap_fill" {
        "grammar_fill"
    } else if text(q, "answerMode") == "choice" {
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
fn selection_paths(weights: &[usize], target: usize) -> Vec<Option<(usize, usize)>> {
    let mut paths = vec![None; target + 1];
    paths[0] = Some((0, usize::MAX));
    let mut reachable = 1;
    // Positive sums below the smallest eligible group can never become reachable.
    let reachable_limit = weights
        .iter()
        .copied()
        .filter(|&weight| weight > 0 && weight <= target)
        .min()
        .map_or(1, |weight| target - weight + 2);
    for (i, &weight) in weights.iter().enumerate() {
        if weight == 0 || weight > target {
            continue;
        }
        for n in (weight..=target).rev() {
            if paths[n].is_none() && paths[n - weight].is_some() {
                paths[n] = Some((n - weight, i));
                reachable += 1;
            }
        }
        if reachable == reachable_limit {
            break;
        }
    }
    paths
}
pub(crate) fn feasible_counts(weights: &[usize]) -> Vec<usize> {
    if let Some(&weight) = weights.first() {
        if weight > 0 && weights.iter().all(|&value| value == weight) {
            return (1..=weights.len().min(1000 / weight))
                .map(|n| n * weight)
                .collect();
        }
    }
    selection_paths(weights, weights.iter().sum::<usize>().min(1000))
        .iter()
        .enumerate()
        .skip(1)
        .filter_map(|(n, path)| path.is_some().then_some(n))
        .collect()
}
fn exact(weights: &[usize], target: usize) -> Result<Vec<usize>> {
    if target == 0 || target > 1000 {
        return Err("Question count must be between 1 and 1000".into());
    }
    let paths = selection_paths(weights, target);
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
        questions::validate_filter(&p.bank_ids, &p.mode, &p.filter)?;
        let db = self.connect()?;
        let (mut ids, _) = questions::matching_roots(&db, &p.bank_ids, &p.mode, &p.filter, None)?;
        if !p.search.is_empty() {
            ids = crate::store::search_roots(&db, &p.bank_ids, ids, &p.search, &p.mode, &p.filter)?;
        }
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = questions::prepare_root_metadata(&db)?;
        let mut details = statement
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
            fastrand::shuffle(&mut roots);
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
                let chosen = chosen.into_iter().collect::<HashSet<_>>();
                roots
                    .iter()
                    .filter(|root| chosen.contains(&root.id))
                    .map(|root| root.id.clone())
                    .collect()
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
            if p.budgets
                .keys()
                .any(|key| !FILTER_MODES.contains(&key.as_str()))
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
    use crate::contract::list;
    #[test]
    fn reallocates_all_supported_types_without_changing_selection_or_content() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::new(directory.path().into()).unwrap();
        let imported = store.add_example_bank().unwrap();
        let bank = text(&imported, "bankId");
        let rows = store.questions(Some(bank), "", "", "").unwrap();
        let ids: Vec<_> = rows
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .map(|r| r["id"].clone())
            .collect();
        let request = || {
            serde_json::from_value::<Preview>(json!({"bank_ids":[bank],"search":"","mode":"","filter":"","selection":"manual","count":0,"quotas":{},"question_ids":ids,"random":false,"total_cents":10000})).unwrap()
        };
        let original = store.preview_paper(request()).unwrap();
        let mut budgets = HashMap::new();
        for question in list(&original, "questions") {
            *budgets
                .entry(text(question, "rootType").to_owned())
                .or_insert(0) += 100;
        }
        assert!(budgets.len() > 10);
        let mut allocation = request();
        allocation.total_cents = budgets.values().sum();
        allocation.budgets = budgets;
        let updated = store.preview_paper(allocation).unwrap();
        assert_eq!(updated["questionIds"], original["questionIds"]);
        assert_eq!(updated["questions"], original["questions"]);
        assert_eq!(updated["digest"], original["digest"]);
        assert!(list(&updated, "scores").iter().all(|score| score == 100));
    }
    #[test]
    fn indivisible_groups() {
        assert_eq!(exact(&[3, 4, 2], 6).unwrap(), vec![1, 2]);
        assert!(exact(&[3, 3], 5).is_err());
        assert_eq!(split(100, 3).unwrap(), vec![34, 33, 33]);
        assert_eq!(
            feasible_counts(&[3; 8]),
            (1..=8).map(|n| n * 3).collect::<Vec<_>>()
        );
        assert_eq!(feasible_counts(&[1000, 3]), vec![3, 1000]);
        assert!(feasible_counts(&[1001]).is_empty());
        assert!(feasible_counts(&[]).is_empty());
        assert_eq!(
            feasible_counts(&vec![1; 100_000]),
            (1..=1000).collect::<Vec<_>>()
        );
        assert_eq!(feasible_counts(&[0, 1, 1, 4]), vec![1, 2, 4, 5, 6]);
        assert_eq!(
            exact(&[1; 2000], 1000).unwrap(),
            (0..1000).collect::<Vec<_>>()
        );
        assert!(exact(&[1001], 1001).is_err());
    }
    #[test]
    fn feasible_counts_match_all_small_subsets_and_count_limits() {
        fn brute_counts(weights: &[usize]) -> Vec<usize> {
            (0..(1usize << weights.len()))
                .map(|mask| {
                    weights
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| mask & (1 << i) != 0)
                        .map(|(_, weight)| weight)
                        .sum::<usize>()
                })
                .filter(|count| (1..=1000).contains(count))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect()
        }
        for length in 0..=6 {
            for mut encoded in 0..4usize.pow(length) {
                let weights: Vec<_> = (0..length)
                    .map(|_| {
                        let weight = encoded % 4;
                        encoded /= 4;
                        weight
                    })
                    .collect();
                let counts = feasible_counts(&weights);
                assert_eq!(counts, brute_counts(&weights), "{weights:?}");
                for target in counts {
                    let selected = exact(&weights, target).unwrap();
                    assert!(selected.windows(2).all(|pair| pair[0] < pair[1]));
                    assert!(selected
                        .iter()
                        .all(|&i| i < weights.len() && weights[i] > 0));
                    assert_eq!(selected.iter().map(|&i| weights[i]).sum::<usize>(), target);
                    assert!((1..=1000).contains(&target));
                }
            }
        }
        for weights in [
            vec![0, 0, 0],
            vec![999, 999],
            vec![1000, 1000],
            vec![1001, 1001],
            vec![1, 999, 1000, 1001],
            vec![0, 2, 998, 1001],
        ] {
            assert_eq!(
                feasible_counts(&weights),
                brute_counts(&weights),
                "{weights:?}"
            );
        }
        assert_eq!(
            feasible_counts(&[3; 334]),
            (1..=333).map(|i| i * 3).collect::<Vec<_>>()
        );
        assert_eq!(
            feasible_counts(&[10; 101]),
            (1..=100).map(|i| i * 10).collect::<Vec<_>>()
        );
        assert!(exact(&[1], 0).is_err());
        assert!(exact(&[1001], 1001).is_err());
    }
    #[test]
    fn selection_paths_keep_future_smaller_groups_and_first_selection_order() {
        let weights = [2, 3, 2, 3, 2, 1];
        let paths = selection_paths(&weights, 10);
        assert_eq!(paths[1], Some((0, 5)));
        assert_eq!(exact(&weights, 1).unwrap(), vec![5]);
        assert_eq!(exact(&weights, 10).unwrap(), vec![0, 1, 2, 3]);
        let with_ignored = [0, 1001, 2, 3, 2, 3, 2, 1];
        assert_eq!(exact(&with_ignored, 2).unwrap(), vec![2]);
        assert_eq!(exact(&with_ignored, 3).unwrap(), vec![3]);
        assert_eq!(exact(&with_ignored, 4).unwrap(), vec![2, 4]);
        assert_eq!(exact(&with_ignored, 6).unwrap(), vec![3, 5]);
        assert_eq!(exact(&with_ignored, 10).unwrap(), vec![2, 3, 4, 5]);
        assert!(exact(&[0, 1001, 2, 2], 3).is_err());
    }
    #[test]
    fn statistics_and_random_papers_preserve_complete_groups() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::new(directory.path().into()).unwrap();
        let mut document: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
        let root = document["questions"][0].clone();
        let child = document["questions"][1].clone();
        let mut questions = Vec::new();
        for i in 0..8 {
            let id = format!("group-{i}");
            let mut group = root.clone();
            group["id"] = json!(id);
            questions.push(group);
            for j in 0..3 {
                let mut leaf = child.clone();
                leaf["id"] = json!(format!("{id}-{j}"));
                leaf["parentId"] = json!(id);
                questions.push(leaf);
            }
        }
        document["questions"] = json!(questions);
        document["groups"] = json!([]);
        let imported = store
            .preview(serde_json::to_vec(&document).unwrap(), "Groups".into())
            .unwrap();
        let imported = store
            .import(text(&imported, "ticket"), None, "Groups")
            .unwrap();
        let bank = text(&imported, "bankId");
        let stats = store
            .question_stats(&[bank.to_owned()], ("", "", ""))
            .unwrap();
        assert_eq!(stats["count"], 24);
        assert_eq!(stats["types"], json!({"reading":8}));
        assert_eq!(
            stats["feasibleCounts"],
            json!([3, 6, 9, 12, 15, 18, 21, 24])
        );
        let page = store
            .query_questions(&[bank.to_owned()], ("", "", ""), Some((30, 0)))
            .unwrap();
        assert_eq!(page["total"], 8);
        assert!(list(&page, "items")
            .iter()
            .all(|row| row["answerableCount"] == 3));
        let request = |count, random| {
            serde_json::from_value::<Preview>(json!({"bank_ids":[bank],"search":"","mode":"","filter":"","selection":"count","count":count,"quotas":{},"question_ids":[],"random":random,"total_cents":0})).unwrap()
        };
        assert!(store.preview_paper(request(20, false)).is_err());
        let preview = store.preview_paper(request(18, false)).unwrap();
        assert_eq!(preview["count"], 18);
        assert_eq!(list(&preview, "questionIds").len(), 6);
        assert!(list(&preview, "questions")
            .iter()
            .all(|row| row.get("answerableCount").is_none()));
        let ordered = store.preview_paper(request(24, false)).unwrap();
        assert_eq!(
            ordered["questionIds"],
            json!(list(&page, "items")
                .iter()
                .map(|row| &row["id"])
                .collect::<Vec<_>>())
        );
        fastrand::seed(7);
        let shuffled = store.preview_paper(request(24, true)).unwrap();
        assert_ne!(shuffled["questionIds"], ordered["questionIds"]);
        let groups: HashMap<_, _> = list(&ordered, "questionIds")
            .iter()
            .map(|id| id.as_str().unwrap())
            .zip(list(&ordered, "questions").chunks(3))
            .collect();
        let shuffled_ids: HashSet<_> = list(&shuffled, "questionIds")
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        assert_eq!(shuffled_ids, groups.keys().copied().collect());
        assert_eq!(shuffled["count"], 24);
        for (id, children) in list(&shuffled, "questionIds")
            .iter()
            .zip(list(&shuffled, "questions").chunks(3))
        {
            assert_eq!(children, groups[id.as_str().unwrap()]);
        }
    }
    #[test]
    fn quotas_preserve_interleaved_order_complete_groups_scores_and_digest() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::new(directory.path().into()).unwrap();
        let mut document: Value =
            serde_json::from_slice(include_bytes!("../../fixtures/composite.json")).unwrap();
        let kinds = [
            "single",
            "short_answer",
            "single",
            "short_answer",
            "reading",
            "short_answer",
            "single",
            "reading",
        ];
        let mut questions = Vec::new();
        for (i, kind) in kinds.iter().enumerate() {
            let template = match *kind {
                "reading" => 0,
                "single" => 1,
                _ => 2,
            };
            let mut root = document["questions"][template].clone();
            root["id"] = json!(format!("root-{i}"));
            root["stem"] = root["id"].clone();
            root["parentId"] = Value::Null;
            questions.push(root);
            if *kind == "reading" {
                for j in 0..if i == 4 { 3 } else { 2 } {
                    let mut child = document["questions"][1].clone();
                    child["id"] = json!(format!("leaf-{i}-{j}"));
                    child["stem"] = child["id"].clone();
                    child["parentId"] = json!(format!("root-{i}"));
                    questions.push(child);
                }
            }
        }
        document["questions"] = json!(questions);
        document["groups"] = json!([]);
        let preview = store
            .preview(serde_json::to_vec(&document).unwrap(), "Quotas".into())
            .unwrap();
        let imported = store
            .import(text(&preview, "ticket"), None, "Quotas")
            .unwrap();
        let bank = text(&imported, "bankId");
        let page = store
            .query_questions(&[bank.to_owned()], ("", "", ""), Some((30, 0)))
            .unwrap();
        let roots: Vec<_> = list(&page, "items")
            .iter()
            .map(|row| text(row, "id").to_owned())
            .collect();
        let rows = store.question_rows().unwrap();
        let request = |random, quotas: Value| {
            serde_json::from_value::<Preview>(json!({"bank_ids":[bank],"search":"","mode":"","filter":"","selection":"quota","count":0,"quotas":quotas,"question_ids":[],"random":random,"total_cents":1000})).unwrap()
        };
        for random in [false, true] {
            let mut order: Vec<_> = (0..kinds.len()).collect();
            if random {
                fastrand::seed(7);
                fastrand::shuffle(&mut order);
            }
            let mut remaining = HashMap::from([("single", 2), ("short_answer", 2), ("reading", 1)]);
            let expected: Vec<_> = order
                .into_iter()
                .filter(|&i| {
                    let amount = remaining.get_mut(kinds[i]).unwrap();
                    if *amount == 0 {
                        false
                    } else {
                        *amount -= 1;
                        true
                    }
                })
                .map(|i| roots[i].clone())
                .collect();
            if !random {
                assert_eq!(expected, roots[..5]);
            }
            fastrand::seed(7);
            let preview = store
                .preview_paper(request(
                    random,
                    json!({"single":2,"short_answer":2,"reading":1,"word_bank":0}),
                ))
                .unwrap();
            assert_eq!(preview["questionIds"], json!(expected));
            let selected = selected_rows(&rows, &expected).unwrap();
            let leaves: Vec<_> = selected
                .iter()
                .filter(|row| !questions::composite(&row["question"]))
                .collect();
            assert_eq!(preview["count"], leaves.len());
            assert_eq!(preview["digest"], digest(&selected).unwrap());
            assert_eq!(
                preview["scores"],
                if leaves.len() == 7 {
                    json!([143, 143, 143, 143, 143, 143, 142])
                } else {
                    json!([167, 167, 167, 167, 166, 166])
                }
            );
            assert_eq!(
                list(&preview, "questions")
                    .iter()
                    .map(|row| text(row, "id"))
                    .collect::<Vec<_>>(),
                leaves.iter().map(|row| text(row, "id")).collect::<Vec<_>>()
            );
            for group in expected
                .iter()
                .filter(|id| *id == &roots[4] || *id == &roots[7])
            {
                let children: Vec<_> = list(&preview, "questions")
                    .iter()
                    .filter(|row| row["question"]["parentId"] == *group)
                    .collect();
                assert_eq!(children.len(), if group == &roots[4] { 3 } else { 2 });
                assert!(children
                    .iter()
                    .all(|row| row["materials"][0]["id"] == *group));
            }
            fastrand::seed(7);
            assert_eq!(
                preview,
                store
                    .preview_paper(request(
                        random,
                        json!({"single":2,"short_answer":2,"reading":1,"word_bank":0})
                    ))
                    .unwrap()
            );
        }
        assert!(store
            .preview_paper(request(false, json!({"reading":3})))
            .is_err());
        assert!(store
            .preview_paper(request(false, json!({"single":0,"reading":0})))
            .is_err());
    }
    #[test]
    fn changing_previous_scores_keeps_previews_valid_and_snapshots_free_of_live_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::new(directory.path().into()).unwrap();
        let imported = store
            .preview(
                include_bytes!("../../fixtures/sample.json").to_vec(),
                "Bank".into(),
            )
            .unwrap();
        let imported = store
            .import(text(&imported, "ticket"), None, "Bank")
            .unwrap();
        let bank = text(&imported, "bankId");
        let request = || {
            serde_json::from_value::<Preview>(json!({"bank_ids":[bank],"search":"","mode":"single","filter":"","selection":"count","count":1,"quotas":{},"question_ids":[],"random":false,"total_cents":1000})).unwrap()
        };
        let paper = |preview: &Value| crate::exams::Paper {
            question_ids: list(preview, "questionIds")
                .iter()
                .map(|id| id.as_str().unwrap().into())
                .collect(),
            digest: text(preview, "digest").into(),
            kind: "self_test".into(),
            minutes: None,
            scores: vec![1000],
            total_cents: 1000,
        };
        let previous = store
            .start_paper(paper(&store.preview_paper(request()).unwrap()))
            .unwrap();
        let sid = text(&previous, "id");
        store
            .save_draft((sid, 0), json!({"correct":["A"]}), 10)
            .unwrap();
        store.submit_paper(sid, true).unwrap();
        store.manual_score(sid, 0, 800, "First review").unwrap();
        let preview = store.preview_paper(request()).unwrap();
        assert_eq!(preview["questions"][0]["latestScore"]["earnedCents"], 800);
        store.manual_score(sid, 0, 900, "Corrected review").unwrap();
        assert_eq!(
            store.preview_paper(request()).unwrap()["digest"],
            preview["digest"]
        );
        let next = store.start_paper(paper(&preview)).unwrap();
        let snapshot = &next["attempts"][0]["snapshot"];
        assert!(snapshot.get("latestScore").is_none());
        assert!(snapshot.get("answerableCount").is_none());
        let rows = store.questions(Some(bank), "", "single", "").unwrap();
        assert_eq!(rows[0]["answerableCount"], 1);
        assert_eq!(rows[0]["latestScore"]["earnedCents"], 900);
        let frozen = questions::freeze(rows.as_array().unwrap());
        assert!(list(&frozen, "questions")
            .iter()
            .all(|row| row.get("latestScore").is_none() && row.get("answerableCount").is_none()));
    }
}
