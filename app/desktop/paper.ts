import type { DatabaseSync } from "node:sqlite";
import { randomInt } from "node:crypto";
import type { PaperPreview, QuestionRow } from "../src/api.js";
import { Assets, hash } from "./assets.js";
import { contractSource } from "./contract-source.js";
import { invariant } from "./errors.js";
import { matchingRoots, rootMetadata, searchRoots, type Query } from "./question-list.js";
import { composite, object } from "./question-contract.js";
import { canonical, category, freeze, QuestionIndex, readQuestions } from "./questions.js";

export interface PaperSelection extends Query {
  selection: string; count: number; quotas: Record<string, number>; question_ids: string[];
  random: boolean; total_cents: number; budgets?: Record<string, number>;
}
export function validateSelection(input: unknown): PaperSelection {
  const value = object(input), fields = ["bank_ids", "search", "mode", "filter", "selection", "count", "quotas", "question_ids", "random", "total_cents", "budgets"];
  invariant(Object.keys(value).every(key => fields.includes(key)) && ["search", "mode", "filter", "selection"].every(key => typeof value[key] === "string") &&
    ["bank_ids", "question_ids"].every(key => Array.isArray(value[key]) && (value[key] as unknown[]).every(item => typeof item === "string")) &&
    Number.isSafeInteger(value.count) && Number(value.count) >= 0 && typeof value.random === "boolean" && Number.isSafeInteger(value.total_cents), "LOCAL_FILTER_INVALID", "Invalid paper selection");
  for (const key of ["quotas", "budgets"]) {
    if (key === "budgets" && value[key] === undefined) continue;
    invariant(value[key] !== null && typeof value[key] === "object" && !Array.isArray(value[key]) && Object.values(value[key]).every(count => Number.isSafeInteger(count) && Number(count) >= 0), "LOCAL_FILTER_INVALID", "Invalid paper allocation");
  }
  return value as unknown as PaperSelection;
}
export function selectedRows(rows: QuestionRow[], roots: string[]): QuestionRow[] {
  invariant(roots.length >= 1 && roots.length <= 1000 && new Set(roots).size === roots.length, "LOCAL_QUESTION_SELECTION_INVALID", "Select distinct complete questions or groups");
  const index = new QuestionIndex(rows), selected: QuestionRow[] = [];
  for (const root of roots) {
    const row = index.byId.get(root);
    invariant(row && !row.question.parentId, "LOCAL_QUESTION_SELECTION_INVALID", "Select complete question groups");
    selected.push(...index.trees.get(root)!);
  }
  const count = selected.filter(row => !composite(row.question)).length;
  invariant(count >= 1 && count <= 1000, "LOCAL_QUESTION_SELECTION_INVALID", "Select between 1 and 1000 answerable subquestions");
  return selected;
}
export function paperDigest(rows: QuestionRow[]): string {
  const document = freeze(rows);
  for (const row of document.questions as Record<string, unknown>[]) { delete row.favorite; delete row.latestResult; }
  return hash(canonical(document));
}
export function splitScore(total: number, count: number): number[] {
  invariant(Number.isSafeInteger(total) && count > 0 && total >= count && total <= 100000000, "LOCAL_EXAM_SCORES_INVALID", "Each question requires at least 0.01 points; total exceeds its limit");
  return Array.from({ length: count }, (_, i) => Math.floor(total / count) + Number(i < total % count));
}
function exact(weights: number[], target: number): number[] {
  invariant(target >= 1 && target <= 1000, "LOCAL_QUESTION_SELECTION_INVALID", "Question count must be between 1 and 1000");
  const paths: ({ previous: number; index: number } | null)[] = Array(target + 1).fill(null);
  paths[0] = { previous: 0, index: -1 };
  for (let i = 0; i < weights.length && !paths[target]; i++) if (weights[i] > 0 && weights[i] <= target) for (let n = target; n >= weights[i]; n--) if (!paths[n] && paths[n - weights[i]]) paths[n] = { previous: n - weights[i], index: i };
  invariant(paths[target], "LOCAL_GROUP_COUNT_UNSATISFIABLE", "Question count cannot be met without splitting a group");
  const selected: number[] = [];
  for (let n = target; n > 0;) { const path = paths[n]!; selected.push(path.index); n = path.previous; }
  return selected.sort((left, right) => left - right);
}
export function previewPaper(db: DatabaseSync, assets: Assets, input: unknown): PaperPreview {
  const p = validateSelection(input);
  invariant(p.bank_ids.length > 0, "LOCAL_QUESTION_SELECTION_INVALID", "Select at least one bank");
  const ids = searchRoots(db, matchingRoots(db, p).ids, p), metadata = new Map(rootMetadata(db, ids).map(item => [item.id, item]));
  const roots = ids.map(id => { const root = metadata.get(id); invariant(root, "LOCAL_WORK_UNAVAILABLE", "Selected question is missing"); return root; });
  if (p.random) for (let i = roots.length - 1; i > 0; i--) { const j = randomInt(i + 1); [roots[i], roots[j]] = [roots[j], roots[i]]; }
  let chosen: string[];
  switch (p.selection) {
    case "count": chosen = exact(roots.map(root => root.weight), p.count).map(i => roots[i].id); break;
    case "manual": invariant(p.question_ids.every(id => ids.includes(id)), "LOCAL_QUESTION_SELECTION_INVALID", "Selected groups no longer match the filter"); chosen = p.question_ids; break;
    case "quota": {
      const selected = new Set<string>();
      for (const key of Object.keys(p.quotas).sort()) {
        const available = roots.filter(root => root.category === key), count = p.quotas[key];
        invariant(count <= available.length, "LOCAL_QUESTION_SELECTION_INVALID", `Not enough complete questions/groups for ${key}`);
        for (const root of available.slice(0, count)) selected.add(root.id);
      }
      chosen = roots.filter(root => selected.has(root.id)).map(root => root.id); break;
    }
    default: throw new Error("Unsupported selection mode");
  }
  const selected = selectedRows(readQuestions(db, assets, p.bank_ids, chosen), chosen), index = new QuestionIndex(selected), leaves = selected.filter(row => !composite(row.question));
  const scores = p.total_cents === 0 ? [] : splitScore(p.total_cents, leaves.length), budgets = p.budgets ?? {};
  if (Object.keys(budgets).length) {
    invariant(Object.keys(budgets).every(key => contractSource.metadata.filterModes.includes(key)) && Object.values(budgets).every(value => value >= 0 && value <= 100000000) && Object.values(budgets).reduce((sum, value) => sum + value, 0) === p.total_cents, "LOCAL_EXAM_SCORES_INVALID", "Type budgets must add up to the total score");
    let allocated = 0;
    for (const [key, budget] of Object.entries(budgets)) {
      const indices = leaves.flatMap((row, i) => category(index.byId.get(index.roots.get(row.id)!)?.question) === key ? [i] : []);
      if (!indices.length) { invariant(budget === 0, "LOCAL_EXAM_SCORES_INVALID", "Budget has no matching questions"); continue; }
      const values = splitScore(budget, indices.length);
      indices.forEach((ordinal, i) => { scores[ordinal] = values[i]; allocated++; });
    }
    invariant(allocated === leaves.length, "LOCAL_EXAM_SCORES_INVALID", "Every selected type needs a score budget");
  }
  return { questionIds: chosen, digest: paperDigest(selected), questions: leaves.map(row => index.hydrate(row)), scores, count: leaves.length };
}
