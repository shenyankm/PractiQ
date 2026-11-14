import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Assets } from "./assets.js";
import { invariant } from "./errors.js";
import { transaction } from "./database.js";
import { answerContent, composite, list, object, text, validateTree } from "./question-contract.js";
import type { Question } from "../src/contracts.generated.js";
import type { QuestionRow } from "../src/api.js";

const details: Record<string, [string, string]> = {
  choice: ["choice_questions", "correct"], true_false: ["true_false_questions", "value"], fill_blank: ["fill_blank_questions", "answers"], short_answer: ["short_answer_questions", "text"],
  ordering: ["ordering_questions", "order"], matching: ["matching_questions", "matches"], reading: ["reading_questions", ""], word_bank: ["word_bank_questions", ""], cloze: ["cloze_questions", ""], listening: ["listening_questions", ""], gap_fill: ["gap_fill_questions", ""],
};
const columns: Record<string, string> = { id: "id", parentId: "parent_id", stem: "stem", answerMode: "mode", questionTypeId: "question_type", analysis: "analysis", sourceText: "source_text", sourceScore: "source_score", scoringRubric: "scoring_rubric", scoreSourceText: "score_source_text", questionKind: "question_kind", instructions: "instructions" };
const decode = (value: unknown): unknown => JSON.parse(String(value));
export function category(q: unknown): string { return text(q, "questionKind") || (text(q, "answerMode") === "choice" ? text(q, "choiceVariant") : text(q, "answerMode") === "gap_fill" ? "grammar_fill" : text(q, "answerMode")); }
export function canonical(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, ordered(value)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}
function related(db: DatabaseSync, sql: string, scope: string): Map<string, unknown[]> {
  const values = new Map<string, unknown[]>();
  for (const row of db.prepare(sql).all(scope)) {
    const [id, raw] = Object.values(row), key = String(id);
    if (!values.has(key)) values.set(key, []);
    values.get(key)!.push(decode(raw));
  }
  return values;
}
export function writeQuestion(db: DatabaseSync, q: Question, bank: string, importId: string | null, position: number, favorite: boolean, existing: boolean): void {
  invariant(q.id, "LOCAL_FILTER_INVALID", "Question ID is required");
  const fields = ["id", "bank_id", "import_id", "parent_id", "position", "stem", "mode", "question_type", "analysis", "source_text", "source_score", "scoring_rubric", "score_source_text", "content_blocks", "confidence", "needs_review", "missing_fields", "favorite", "question_kind", "instructions"];
  const values: SQLInputValue[] = [q.id, bank, importId, q.parentId ?? null, position, q.stem ?? null, q.answerMode ?? null, q.questionTypeId ?? null, q.analysis ?? null, q.sourceText ?? null, q.sourceScore ?? null, q.scoringRubric ?? null, q.scoreSourceText ?? null, JSON.stringify(q.contentBlocks), q.confidence, Number(q.needsReview), JSON.stringify(q.missingFields), Number(favorite), q.questionKind ?? null, q.instructions ?? null];
  db.prepare(`INSERT INTO questions(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${fields.filter(key => !["id", "bank_id", "import_id", "favorite"].includes(key)).map(key => `${key}=excluded.${key}`).join(",")}`).run(...values);
  if (existing) {
    for (const [table] of Object.values(details)) db.prepare(`DELETE FROM ${table} WHERE question_id=?`).run(q.id);
    db.prepare("DELETE FROM question_options WHERE owner_id=?").run(q.id);
    db.prepare("DELETE FROM question_items WHERE question_id=?").run(q.id);
  }
  const mode = q.answerMode ?? "", owner = q.optionSourceId || q.id, answer = object(q.answerPayload);
  if (["choice", "word_bank"].includes(mode) && !q.optionSourceId) {
    db.prepare("INSERT OR IGNORE INTO option_sets VALUES(?)").run(q.id);
    const insert = db.prepare("INSERT INTO question_options VALUES(?,?,?,?)");
    q.options.forEach((option, i) => insert.run(q.id!, i, option.label ?? null, option.content ?? null));
  }
  if (existing && (!["choice", "word_bank"].includes(mode) || q.optionSourceId)) db.prepare("DELETE FROM option_sets WHERE id=?").run(q.id);
  const json = (key: string) => JSON.stringify(answer[key] ?? null);
  switch (mode) {
    case "choice": db.prepare("INSERT INTO choice_questions VALUES(?,?,?,?)").run(q.id, q.choiceVariant ?? null, owner, json("correct")); break;
    case "true_false": db.prepare("INSERT INTO true_false_questions VALUES(?,?)").run(q.id, json("value")); break;
    case "fill_blank": db.prepare("INSERT INTO fill_blank_questions VALUES(?,?,?)").run(q.id, q.blankCount ?? null, json("answers")); break;
    case "short_answer": db.prepare("INSERT INTO short_answer_questions VALUES(?,?,?,?,?,?,?)").run(q.id, json("text"), q.sourceLanguage ?? null, q.targetLanguage ?? null, q.writingGenre ?? null, q.minWords ?? null, q.maxWords ?? null); break;
    case "ordering": db.prepare("INSERT INTO ordering_questions VALUES(?,?)").run(q.id, json("order")); break;
    case "matching": db.prepare("INSERT INTO matching_questions VALUES(?,?,?)").run(q.id, q.matchingVariant ?? null, json("matches")); break;
    case "word_bank": db.prepare("INSERT INTO word_bank_questions VALUES(?,?,?,?)").run(q.id, JSON.stringify(q.passage ?? []), Number(q.allowReuse ?? false), q.id); break;
    case "listening": db.prepare("INSERT INTO listening_questions VALUES(?,?,?,?,?,?,?)").run(q.id, JSON.stringify(q.passage ?? []), JSON.stringify(q.audioRef ?? null), q.audioStartSeconds ?? 0, q.audioEndSeconds ?? null, JSON.stringify(q.transcript ?? []), q.examPlayCount ?? 2); break;
    case "reading": case "cloze": case "gap_fill": db.prepare(`INSERT INTO ${details[mode][0]} VALUES(?,?)`).run(q.id, JSON.stringify(q.passage ?? [])); break;
    case "": break;
    default: throw new Error("Unsupported question type");
  }
  const insert = db.prepare("INSERT INTO question_items VALUES(?,?,?,?,?,?)");
  q.items.forEach((item, i) => insert.run(q.id!, i, item.id ?? null, item.side ?? null, item.content ?? null, item.label ?? null));
}

export function readQuestions(db: DatabaseSync, assets: Assets, banks: string[] = [], roots?: string[]): QuestionRow[] {
  const bankScope = JSON.stringify(banks), rootScope = roots ? JSON.stringify(roots) : null;
  const records = db.prepare("WITH RECURSIVE selected(id) AS (SELECT value FROM json_each(?) UNION SELECT q.id FROM questions q JOIN selected s ON q.parent_id=s.id) SELECT q.*,b.title AS bank_title,r.reviewed_at FROM questions q JOIN banks b ON b.id=q.bank_id LEFT JOIN question_reviews r ON r.question_id=q.id WHERE (?='[]' OR q.bank_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR q.id IN selected) ORDER BY b.created_at DESC,q.position,q.id")
    .all(rootScope, bankScope, bankScope, rootScope);
  if (!records.length) return [];
  const scope = JSON.stringify(records.map(row => row.id)), byDetail = new Map<string, Record<string, unknown>>();
  for (const [mode, [table]] of Object.entries(details)) if (records.some(row => row.mode === mode)) {
    for (const row of db.prepare(`SELECT d.* FROM ${table} d JOIN questions q ON q.id=d.question_id WHERE q.mode=? AND d.question_id IN (SELECT value FROM json_each(?))`).all(mode, scope)) byDetail.set(String(row.question_id), row);
  }
  const options = related(db, "SELECT owner_id,json_object('label',label,'content',content) FROM question_options WHERE owner_id IN (SELECT value FROM json_each(?)) ORDER BY owner_id,position", scope);
  const items = related(db, "SELECT question_id,json_object('id',item_id,'side',side,'content',content,'label',label) FROM question_items WHERE question_id IN (SELECT value FROM json_each(?)) ORDER BY question_id,position", scope);
  const sources = related(db, "SELECT question_id,json_object('questionId',question_id,'stage',stage,'unitIndex',unit_index) FROM question_sources WHERE question_id IN (SELECT value FROM json_each(?)) ORDER BY question_id,stage,unit_index", scope);
  const warnings = related(db, "SELECT import_id,json_quote(message) FROM import_warnings WHERE position>=0 AND message NOT IN ('PRACTIQ_MISSING:questions','PRACTIQ_MISSING:media') AND import_id IN (SELECT import_id FROM questions WHERE id IN (SELECT value FROM json_each(?))) ORDER BY import_id,position", scope);
  const latest = related(db, "SELECT q.id,COALESCE((SELECT json_object('result',result,'earnedCents',earned_cents,'maxCents',max_cents,'gradeKind',grade_kind) FROM attempts WHERE question_id=q.id AND result IS NOT NULL ORDER BY submitted_at DESC,rowid DESC LIMIT 1),'null') FROM questions q WHERE q.id IN (SELECT value FROM json_each(?))", scope);
  const rows = records.map(record => {
    const q: Record<string, unknown> = Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, record[column]]));
    Object.assign(q, { contentBlocks: decode(record.content_blocks), missingFields: decode(record.missing_fields), confidence: Number(record.confidence), needsReview: Boolean(record.needs_review), options: [], items: [], passage: [], choiceVariant: null, matchingVariant: null, blankCount: null, optionSourceId: null, answerPayload: null, allowReuse: false });
    const id = String(record.id), mode = String(record.mode ?? ""), detail = byDetail.get(id); let owner = id;
    if (Object.hasOwn(details, mode)) {
      invariant(detail, "LOCAL_DATABASE_UNAVAILABLE", "Question detail is missing");
      const key = details[mode][1];
      const field = ({ choice: "correct", true_false: "value", fill_blank: "answers", short_answer: "answer", ordering: "answer_order", matching: "matches" } as Record<string, string>)[mode];
      if (key) { const answer = decode(detail[field]); if (answer !== null) q.answerPayload = { [key]: answer }; }
      if (mode === "short_answer") Object.assign(q, { sourceLanguage: detail.source_language, targetLanguage: detail.target_language, writingGenre: detail.writing_genre, minWords: detail.min_words, maxWords: detail.max_words });
      if (mode === "listening") Object.assign(q, { audioRef: decode(detail.audio_ref), audioStartSeconds: detail.start_seconds, audioEndSeconds: detail.end_seconds, transcript: decode(detail.transcript), examPlayCount: detail.play_count });
      if (mode === "choice") { q.choiceVariant = detail.variant; owner = String(detail.option_set_id); if (owner !== id) q.optionSourceId = owner; }
      if (mode === "matching") q.matchingVariant = detail.variant;
      if (mode === "fill_blank") q.blankCount = detail.blank_count;
      if (composite(q)) q.passage = decode(detail.passage);
      if (mode === "word_bank") q.allowReuse = Boolean(detail.allow_reuse);
    }
    if (owner === id) q.options = options.get(id) ?? [];
    q.items = items.get(id) ?? [];
    const last = object(latest.get(id)?.at(-1));
    return { id, bankId: String(record.bank_id), bankTitle: String(record.bank_title), question: q, favorite: Boolean(record.favorite), reviewedAt: record.reviewed_at,
      latestResult: typeof last.result === "number" ? Boolean(last.result) : null,
      latestScore: typeof last.earnedCents === "number" && typeof last.maxCents === "number" ? { earnedCents: last.earnedCents, maxCents: last.maxCents, gradeKind: last.gradeKind } : null,
      sources: sources.get(id) ?? [], warnings: warnings.get(String(record.import_id)) ?? [], groups: [], visuals: [], missingAssets: false } as unknown as QuestionRow;
  });
  const loadedIds = new Set(rows.map(row => row.id));
  const groups = db.prepare("SELECT id,title,instructions FROM sections WHERE id IN (SELECT section_id FROM section_questions WHERE question_id IN (SELECT value FROM json_each(?))) ORDER BY rowid").all(scope);
  const groupRefs = related(db, "SELECT section_id,json_quote(question_id) FROM section_questions WHERE section_id IN (SELECT value FROM json_each(?)) ORDER BY section_id,question_id", JSON.stringify(groups.map(row => row.id)));
  for (const row of groups) {
    const group = { id: String(row.id), title: String(row.title), instructions: row.instructions === null ? null : String(row.instructions), questionIds: (groupRefs.get(String(row.id)) ?? []) as string[] };
    for (const target of rows) if (group.questionIds.includes(target.id)) target.groups.push(group);
  }
  const visuals = db.prepare("SELECT id,content,bank_id,document_level FROM visuals WHERE bank_id IN (SELECT value FROM json_each(?)) AND (document_level=1 OR id IN (SELECT visual_id FROM question_visuals WHERE question_id IN (SELECT value FROM json_each(?)))) ORDER BY rowid")
    .all(JSON.stringify([...new Set(rows.map(row => row.bankId))]), scope);
  const visualRefs = related(db, "SELECT visual_id,json_quote(question_id) FROM question_visuals WHERE visual_id IN (SELECT value FROM json_each(?)) ORDER BY visual_id,question_id", JSON.stringify(visuals.map(row => row.id)));
  for (const row of visuals) {
    const visual = object(decode(row.content));
    if (visual.documentOnly === true) continue;
    visual.id = String(row.id); visual.questionIds = visualRefs.get(String(row.id)) ?? [];
    const targets = row.document_level ? rows.filter(target => target.bankId === row.bank_id).map(target => target.id) : list(visual, "questionIds");
    for (const target of rows) if (loadedIds.has(target.id) && targets.includes(target.id)) target.visuals.push(visual as unknown as QuestionRow["visuals"][number]);
  }
  assets.markMissing(rows as unknown as Record<string, unknown>[]);
  return rows;
}

export class QuestionIndex {
  readonly byId: Map<string, QuestionRow>;
  readonly roots = new Map<string, string>();
  readonly trees = new Map<string, QuestionRow[]>();
  constructor(readonly rows: QuestionRow[]) {
    this.byId = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) {
      let current = row; const seen = new Set<string>();
      while (current.question.parentId && !seen.has(current.id)) {
        seen.add(current.id); const parent = this.byId.get(current.question.parentId); if (!parent) break; current = parent;
      }
      this.roots.set(row.id, current.id);
      if (!this.trees.has(current.id)) this.trees.set(current.id, []);
      this.trees.get(current.id)!.push(row);
    }
  }
  hydrate(row: QuestionRow): QuestionRow {
    const result = structuredClone(row), materials: Question[] = [], seen = new Set<string>();
    let parent = row.question.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent); const ancestor = this.byId.get(parent);
      if (!ancestor) { result.missingAssets = true; break; }
      materials.push(ancestor.question);
      result.missingAssets ||= ancestor.missingAssets || ancestor.question.missingFields.some(key => ["material", "media", "options"].includes(key));
      for (const group of ancestor.groups) if (!result.groups.some(item => item.id === group.id)) result.groups.push(structuredClone(group));
      for (const visual of ancestor.visuals) if (!result.visuals.some(item => item.id === visual.id)) result.visuals.push(structuredClone(visual));
      parent = ancestor.question.parentId;
    }
    result.materials = materials.reverse().map(item => ({ ...structuredClone(item), passage: (item.passage ?? []).filter(block => !answerContent(block)) }));
    const owner = row.question.optionSourceId && this.byId.get(row.question.optionSourceId);
    if (owner) result.question.options = structuredClone(owner.question.options);
    result.rootId = this.roots.get(row.id) ?? row.id;
    const root = this.byId.get(result.rootId);
    if (root) result.rootType = category(root.question);
    return result;
  }
  snapshot(id: string): QuestionRow { const row = this.byId.get(id); invariant(row, "LOCAL_WORK_UNAVAILABLE", "Snapshot question is missing"); return this.hydrate(row); }
}

export function freeze(rows: QuestionRow[]): Record<string, unknown> {
  const ids = new Set(rows.map(row => row.id)), mixedBanks = new Set(rows.map(row => row.bankId)).size > 1;
  const questions = rows.map(row => Object.fromEntries(Object.entries(structuredClone(row)).filter(([key]) => !["groups", "visuals", "latestScore", "answerableCount", "reviewedAt"].includes(key))));
  const groups: unknown[] = [], visuals: unknown[] = [], seen = new Set<string>();
  for (const row of rows) for (const key of ["groups", "visuals"] as const) for (const value of row[key]) {
    const id = `${key}:${value.id}`; if (seen.has(id)) continue; seen.add(id);
    const item = object(structuredClone(value));
    if (mixedBanks && key === "visuals" && !list(item, "questionIds").length) item.questionIds = rows.filter(source => source.bankId === row.bankId).map(source => source.id);
    if (Array.isArray(item.questionIds)) item.questionIds = item.questionIds.filter(id => typeof id === "string" && ids.has(id));
    (key === "groups" ? groups : visuals).push(item);
  }
  return { schemaVersion: 3, questions, groups, visuals };
}
export function thaw(input: unknown): QuestionRow[] {
  const doc = object(input);
  invariant(doc.schemaVersion === 3, "LOCAL_BACKUP_SNAPSHOT_FIELD", "Unsupported session snapshot");
  for (const key of ["questions", "groups", "visuals"]) invariant(Array.isArray(doc[key]) && (doc[key] as unknown[]).every(value => value !== null && typeof value === "object" && !Array.isArray(value)), "LOCAL_BACKUP_SNAPSHOT_FIELD", "Invalid snapshot field");
  const rows = structuredClone(doc.questions) as QuestionRow[];
  for (const row of rows) {
    invariant(row.question !== null && typeof row.question === "object" && !Array.isArray(row.question), "LOCAL_BACKUP_SNAPSHOT_FIELD", "Invalid snapshot question");
    row.groups = list(doc, "groups").filter(item => list(item, "questionIds").includes(row.id)) as QuestionRow["groups"];
    row.visuals = list(doc, "visuals").filter(item => !list(item, "questionIds").length || list(item, "questionIds").includes(row.id)) as QuestionRow["visuals"];
  }
  return rows;
}

export function saveQuestionTree(db: DatabaseSync, assets: Assets, bank: string, root: string | null, input: unknown[]): string {
  invariant(input.length >= 1 && input.length <= 1000, "LOCAL_FILTER_INVALID", "A question tree needs 1–1000 nodes");
  const tree = validateTree(input.map(value => { const q = object(structuredClone(value)); if (text(q, "optionSourceId")) q.options = []; return q; }));
  const id = tree[0].id!;
  invariant(!tree[0].parentId && (root === null || root === id), "LOCAL_FILTER_INVALID", "Invalid root question");
  const proposed = new QuestionIndex(tree.map(q => ({ id: q.id!, question: q })) as QuestionRow[]);
  invariant(tree.every(q => proposed.roots.get(q.id!) === id), "LOCAL_FILTER_INVALID", "Save one complete question tree at a time");
  return transaction(db, () => {
    for (const q of tree) if (q.audioRef) {
      const resource = assets.bytes(q.audioRef.sha256);
      invariant(resource && resource.media === q.audioRef.mediaType && resource.bytes.length === q.audioRef.sizeBytes, "LOCAL_ASSET_MISSING", "Audio resource is unavailable");
    }
    const old = readQuestions(db, assets, [], [id]), previous = new QuestionIndex(old);
    if (root !== null) invariant(old.some(row => row.id === id && row.bankId === bank && !row.question.parentId), "LOCAL_FILTER_INVALID", "Edited root no longer exists");
    const incoming = new Set(tree.map(q => q.id!));
    for (const existing of db.prepare("SELECT id FROM questions WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...incoming]))) {
      const row = previous.byId.get(String(existing.id));
      invariant(root !== null && row && row.bankId === bank && previous.roots.get(row.id) === id, "LOCAL_FILTER_INVALID", "Question ID belongs to another tree");
    }
    const before = old.map(row => row.question).sort((a, b) => Number(a.id !== id) - Number(b.id !== id));
    let unchanged = false;
    try { unchanged = canonical(validateTree(before)) === canonical(tree); } catch { /* Existing incomplete content remains editable. */ }
    if (!unchanged) db.prepare("DELETE FROM question_reviews WHERE question_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(old.map(row => row.id)));
    const position = Number(db.prepare("SELECT COALESCE((SELECT position FROM questions WHERE id=?),(SELECT COALESCE(MAX(position),-1)+1 FROM questions WHERE bank_id=?)) AS position").get(id, bank)!.position);
    for (const row of old) if (previous.roots.get(row.id) === id && !incoming.has(row.id)) db.prepare("DELETE FROM questions WHERE id=?").run(row.id);
    tree.forEach((q, i) => writeQuestion(db, q, bank, null, position + i, previous.byId.get(q.id!)?.favorite ?? false, previous.byId.has(q.id!)));
    return id;
  });
}
