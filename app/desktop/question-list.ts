import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { sqlRows as arrays } from "./database.js";
import type { QuestionPage, QuestionStats, QuestionSummary } from "../src/api.js";
import { contractSource } from "./contract-source.js";
import { invariant } from "./errors.js";
import { ROOT_METADATA, ROOT_SUMMARIES, SEARCH_BASE, SEARCH_DETAILS, SEARCH_VISUAL_ROOTS, SEARCH_VISUALS } from "./question-queries.js";

export interface Query { bank_ids: string[]; search: string; mode: string; filter: string }
const composite = contractSource.metadata.compositeModes.map(mode => `'${mode}'`).join(",");
export function validatePage(limit: number, offset: number): void {
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0, "LOCAL_FILTER_INVALID", "Invalid pagination");
}
export function validateFilter(query: Query): void {
  invariant(query.bank_ids.length <= 1000 && query.bank_ids.every(id => typeof id === "string") && Buffer.byteLength(query.mode) <= 256 && ["", "wrong", "favorite", "unattempted", "review"].includes(query.filter), "LOCAL_FILTER_INVALID", "Invalid question filter");
  const modes = query.mode ? query.mode.split(",") : [];
  invariant(new Set(modes).size === modes.length && modes.every(mode => mode && contractSource.metadata.filterModes.includes(mode)), "LOCAL_FILTER_INVALID", "Invalid question type filter");
}
export function matchingRoots(db: DatabaseSync, query: Query, page?: { limit: number; offset: number }): { ids: string[]; total: number; offset: number } {
  validateFilter(query);
  if (page) validatePage(page.limit, page.offset);
  const scope = query.bank_ids.length ? "q.bank_id IN (SELECT value FROM json_each(?1))" : "?1='[]'";
  const from = page ? "banks b CROSS JOIN questions q ON q.bank_id=b.id" : "questions q JOIN banks b ON b.id=q.bank_id";
  const skipKind = page && !query.mode;
  const choice = skipKind ? "" : "LEFT JOIN choice_questions c ON c.question_id=q.id";
  const kind = skipKind ? "" : "AND (json_array_length(?2)=0 OR EXISTS(SELECT 1 FROM json_each(?2) m WHERE COALESCE(q.question_kind,q.mode)=m.value OR (m.value='grammar_fill' AND q.mode='gap_fill') OR (q.mode='choice' AND c.variant=m.value)))";
  const filtered = Boolean(query.filter);
  const matches = filtered ? `WITH RECURSIVE tree(root,id) AS (
    SELECT q.id,q.id FROM questions q WHERE q.parent_id IS NULL AND ${scope}
    UNION ALL SELECT t.root,q.id FROM questions q JOIN tree t ON q.parent_id=t.id
  ), matches AS (
    SELECT DISTINCT t.root FROM tree t JOIN questions n ON n.id=t.id WHERE
      (?3='favorite' AND n.favorite=1) OR
      (?3='review' AND n.needs_review=1 AND NOT EXISTS(SELECT 1 FROM question_reviews r WHERE r.question_id=n.id)) OR
      (?3='wrong' AND (SELECT result FROM attempts WHERE question_id=n.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1)=0) OR
      (?3='unattempted' AND (n.mode IS NULL OR n.mode NOT IN (${composite})) AND NOT EXISTS(SELECT 1 FROM attempts WHERE question_id=n.id AND submitted_at IS NOT NULL AND skipped=0))
  ) ` : "";
  const sql = `${matches}SELECT q.id FROM ${from} ${choice} WHERE q.parent_id IS NULL AND ${scope} ${kind}${filtered ? " AND q.id IN (SELECT root FROM matches)" : ""}`;
  const bindings: SQLInputValue[] = [JSON.stringify(query.bank_ids), JSON.stringify(query.mode.split(",").filter(Boolean)), query.filter];
  const countBindings = filtered ? 3 : skipKind ? 1 : 2;
  const total = page ? Number(db.prepare(`SELECT COUNT(*) AS total FROM (${sql})`).get(...bindings.slice(0, countBindings))!.total) : 0;
  const offset = page ? Math.min(page.offset, Math.floor(Math.max(0, total - 1) / page.limit) * page.limit) : 0;
  const ids = db.prepare(`${sql} ORDER BY b.created_at DESC,q.position,q.id${page ? " LIMIT ?4 OFFSET ?5" : ""}`)
    .all(...(page ? [...bindings, page.limit, offset] : bindings.slice(0, filtered ? 3 : 2))).map(row => String(row.id));
  return { ids, total: page ? total : ids.length, offset };
}
function containsText(value: unknown, search: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(search);
  return value !== null && typeof value === "object" && Object.values(value).some(item => containsText(item, search));
}
const contentFields = new Set(["stem", "instructions", "transcript", "sourceText", "analysis", "scoringRubric", "scoreSourceText", "options", "items", "content", "label", "passage", "contentBlocks", "textValue", "markdownValue", "latexValue", "title", "description", "extractedText"]);
function contentMatches(value: unknown, search: string): boolean {
  if (Array.isArray(value)) return value.some(item => contentMatches(item, search));
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, item]) => ["jsonValue", "answerPayload"].includes(key) ? containsText(item, search) : contentFields.has(key) && contentMatches(item, search));
  return containsText(value, search);
}
export function searchRoots(db: DatabaseSync, candidates: string[], query: Query): string[] {
  if (!candidates.length || !query.search) return candidates;
  const search = query.search.toLowerCase(), matches = new Set<string>();
  const parameters = (roots: string[]) => [JSON.stringify(roots), query.filter, JSON.stringify(query.bank_ids), JSON.stringify(query.mode.split(",").filter(Boolean))];
  for (const row of arrays(db, SEARCH_BASE, parameters(candidates))) {
    const root = String(row[0]);
    if (!matches.has(root) && (row.slice(1, 7).some(value => typeof value === "string" && value.toLowerCase().includes(search)) || contentMatches(JSON.parse(String(row[7])), search))) matches.add(root);
  }
  let remaining = candidates.filter(id => !matches.has(id));
  if (remaining.length) for (const row of arrays(db, SEARCH_DETAILS, parameters(remaining))) {
    const root = String(row[0]), raw = row[1];
    if (matches.has(root) || raw === null) continue;
    const found = row[2] === 0 ? String(raw).toLowerCase().includes(search) : row[2] === 1 ? contentMatches(JSON.parse(String(raw)), search) : containsText(JSON.parse(String(raw)), search);
    if (found) matches.add(root);
  }
  remaining = candidates.filter(id => !matches.has(id));
  if (remaining.length) {
    const visualIds: string[] = [];
    for (const row of arrays(db, SEARCH_VISUALS, parameters(remaining))) if (contentMatches(JSON.parse(String(row[1])), search)) visualIds.push(String(row[0]));
    if (visualIds.length) for (const row of arrays(db, SEARCH_VISUAL_ROOTS, [...parameters(remaining), JSON.stringify(visualIds)])) matches.add(String(row[0]));
  }
  return candidates.filter(id => matches.has(id));
}
export function feasibleCounts(weights: number[]): number[] {
  if (weights.length && weights[0] > 0 && weights.every(weight => weight === weights[0])) return Array.from({ length: Math.min(weights.length, Math.floor(1000 / weights[0])) }, (_, i) => (i + 1) * weights[0]);
  const maximum = Math.min(1000, weights.reduce((total, weight) => total + weight, 0)), reachable = new Uint8Array(maximum + 1);
  reachable[0] = 1;
  for (const weight of weights) if (weight > 0 && weight <= maximum) for (let n = maximum; n >= weight; n--) if (reachable[n - weight]) reachable[n] = 1;
  return Array.from(reachable.keys()).filter(n => n > 0 && reachable[n] === 1);
}
export function rootMetadata(db: DatabaseSync, ids: string[]): { id: string; category: string; weight: number }[] {
  return [...arrays(db, ROOT_METADATA, [JSON.stringify(ids)])].map(row => ({ id: String(row[0]), category: String(row[1]), weight: Number(row[2]) }));
}
export function summaries(db: DatabaseSync, roots: string[]): QuestionSummary[] {
  return [...arrays(db, ROOT_SUMMARIES, [JSON.stringify(roots)])].map(row => ({
    id: String(row[0]), bankId: String(row[1]), bankTitle: String(row[2]), question: { id: String(row[0]), stem: row[3], sourceText: row[4], answerMode: row[5], questionKind: row[6], choiceVariant: row[7] },
    answerableCount: Number(row[8]), favorite: Boolean(row[9]), reviewRequired: Boolean(row[10]), hasWrong: Boolean(row[11]), hasPartialScore: Boolean(row[12]),
    latestScore: row[13] !== null && row[14] !== null ? { earnedCents: Number(row[13]), maxCents: Number(row[14]), gradeKind: String(row[15] ?? "") } : null,
  })) as QuestionSummary[];
}
export function queryQuestions(db: DatabaseSync, query: Query, page?: { limit: number; offset: number }, includeStats = false): QuestionPage | QuestionStats {
  validateFilter(query);
  if (page) validatePage(page.limit, page.offset);
  const sqlPage = !query.search && !query.filter && page && !includeStats ? page : undefined;
  const matched = matchingRoots(db, query, sqlPage);
  let ids = query.search ? searchRoots(db, matched.ids, query) : matched.ids;
  const total = query.search ? ids.length : matched.total;
  let stats: QuestionStats | undefined;
  if (!page || includeStats) {
    const metadata = rootMetadata(db, ids), types: Record<string, number> = Object.create(null);
    for (const item of metadata) types[item.category] = (types[item.category] ?? 0) + 1;
    stats = { count: metadata.reduce((sum, item) => sum + item.weight, 0), types, feasibleCounts: feasibleCounts(metadata.map(item => item.weight)) };
  }
  if (!page) return stats!;
  const offset = Math.min(page.offset, Math.floor(Math.max(0, total - 1) / page.limit) * page.limit);
  if (!sqlPage) ids = ids.slice(offset, offset + page.limit);
  return { items: summaries(db, ids), total, offset, ...(stats ? { stats } : {}) };
}
