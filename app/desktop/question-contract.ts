import { contractSource, validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import type { Question } from "../src/contracts.generated.js";
import { sourceCasefold } from "./source-casefold.js";
import { SOURCE_WHITESPACE, sourceLines, sourceTrim, sourceWithoutWhitespace } from "./source-text.js";
import { LISTENING_ADDRESS_ROLE, listeningAddress, playbackAddress } from "../../shared/listening.js";

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const list = (value: unknown, key: string): unknown[] => Array.isArray(object(value)[key]) ? object(value)[key] as unknown[] : [];
export const text = (value: unknown, key: string): string => typeof object(value)[key] === "string" ? object(value)[key] as string : "";
export const unique = (values: unknown[]): boolean => new Set(values.map(value => JSON.stringify(value))).size === values.length;
export const composite = (q: unknown): boolean => contractSource.metadata.compositeModes.includes(text(q, "answerMode"));
export const answerContent = (value: unknown): boolean => ["answer", "analysis", "solution", "explanation", "rubric", "transcript", "听力原文", "答案", "解析", "解答", "评分"].some(word => text(value, "role").toLowerCase().includes(word));
function check(condition: unknown, message: string): asserts condition { invariant(condition, "OPERATION_FAILED", message); }
export function filled(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return practiceTrim(value).length > 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(filled);
  if (typeof value === "object") return Object.keys(value).length > 0 && Object.values(value).every(filled);
  return true;
}
export function hasAnswer(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return practiceTrim(value).length > 0;
  if (Array.isArray(value)) return value.some(hasAnswer);
  if (typeof value === "object") return Object.values(value).some(hasAnswer);
  return true;
}
export function itemIds(q: unknown, side?: string): unknown[] {
  return list(q, "items").filter(item => side === undefined || text(item, "side") === side).map((item, index) => object(item).id ?? index);
}
function uniqueItems(q: unknown): boolean {
  return text(q, "answerMode") === "ordering" ? unique(itemIds(q)) : text(q, "answerMode") !== "matching" || ["left", "right"].every(side => unique(itemIds(q, side)));
}
export function canInteract(q: unknown): boolean {
  switch (text(q, "answerMode")) {
    case "": return false;
    case "choice": return Boolean(text(q, "choiceVariant")) && list(q, "options").length >= 2 && list(q, "options").every(option => filled(object(option).label) && filled(object(option).content));
    case "ordering": return list(q, "items").length >= 2 && list(q, "items").every(item => filled(object(item).content)) && uniqueItems(q);
    case "matching": return Boolean(text(q, "matchingVariant")) && ["left", "right"].every(side => itemIds(q, side).length >= 2 && list(q, "items").filter(item => text(item, "side") === side).every(item => filled(object(item).content))) && uniqueItems(q);
    default: return true;
  }
}
const answerKeys: Record<string, string> = { choice: "correct", true_false: "value", fill_blank: "answers", short_answer: "text", ordering: "order", matching: "matches" };
export function answerComplete(q: unknown): boolean {
  const key = answerKeys[text(q, "answerMode")], answer = object(object(q).answerPayload);
  if (!key || !filled(answer[key]) || !uniqueItems(q)) return false;
  if (key === "order") return list(answer, key).length === list(q, "items").length;
  if (key === "matches") return list(answer, key).length === itemIds(q, "left").length && list(answer, key).every(pair => filled(object(pair).left) && filled(object(pair).right));
  return true;
}
// Rust trims Unicode White_Space; JavaScript trim also removes the source BOM.
const practiceTrim = (value: string): string => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
function normalizeAnswerText(value: unknown, trim: (value: string) => string): unknown {
  if (typeof value === "string") return trim(value) || null;
  if (Array.isArray(value)) return value.map(item => normalizeAnswerText(item, trim));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeAnswerText(item, trim)]));
  return value;
}
export function normalizeQuestionText(q: Record<string, unknown>, trim: (value: string) => string): void {
  for (const key of ["stem", "answerMode", "questionTypeId", "choiceVariant", "matchingVariant", "analysis", "sourceText", "scoringRubric", "scoreSourceText", "instructions", "writingGenre", "sourceLanguage", "targetLanguage"]) if (typeof q[key] === "string") q[key] = trim(q[key]) || null;
  for (const key of ["items", "options"]) for (const item of list(q, key)) for (const field of ["label", "content"]) if (typeof object(item)[field] === "string") object(item)[field] = trim(text(item, field)) || null;
  if (Object.hasOwn(q, "answerPayload")) q.answerPayload = normalizeAnswerText(q.answerPayload, trim);
}
export function validateQuestion(input: unknown): Question { return validateQuestionWithRules(input, false); }
export function validateParsedQuestion(input: unknown): Question { return validateQuestionWithRules(input, true); }
function validateQuestionWithRules(input: unknown, source: boolean): Question {
  check(input !== null && typeof input === "object" && !Array.isArray(input), "Question must be an object");
  const q = object(structuredClone(input)), trim = source ? sourceTrim : practiceTrim, fold = source ? sourceCasefold : (value: string) => value.toLowerCase();
  normalizeQuestionText(q, trim);
  for (const key of ["items", "options", "contentBlocks", "missingFields", "passage", "transcript"]) q[key] ??= [];
  for (const [key, value] of Object.entries({ audioStartSeconds: 0, examPlayCount: 2, allowReuse: false, confidence: 0, needsReview: true })) if (!Object.hasOwn(q, key)) q[key] = value;
  if (Object.hasOwn(q, "answerPayload")) {
    if (q.answerPayload && typeof q.answerPayload === "object" && !Array.isArray(q.answerPayload) && Object.keys(q.answerPayload).length === 0) q.answerPayload = null;
  }
  for (const item of list(q, "items")) invariant(object(item).id == null || Number.isSafeInteger(object(item).id), "LOCAL_ITEM_ID_INVALID", "Item IDs must be safe integers");
  const blocks = [...list(q, "contentBlocks"), ...list(q, "passage"), ...list(q, "transcript")];
  for (const block of blocks) invariant(text(block, "partType") === "blank" || ["textValue", "markdownValue", "latexValue"].some(key => source ? Boolean(trim(text(block, key))) : filled(object(block)[key])) || object(block).jsonValue != null, "LOCAL_CONTENT_EMPTY", "Content block is empty");
  const mode = text(q, "answerMode"), kind = text(q, "questionKind"), answer = object(q.answerPayload);
  const addresses = list(q, "contentBlocks").filter(block => text(block, "role") === LISTENING_ADDRESS_ROLE);
  check(addresses.length <= 1 && addresses.every(block => mode === "listening" && text(block, "partType") === "text" && typeof object(block).textValue === "string" && playbackAddress(object(block).textValue) === object(block).textValue), "Invalid listening playback address");
  if (mode === "fill_blank" && answerComplete(q)) {
    check(q.blankCount == null || q.blankCount === list(answer, "answers").length, "blankCount must match the number of reference answers");
    q.blankCount = list(answer, "answers").length;
  }
  validateContract("ParsedQuestion", q);
  check((contractSource.metadata.questionKindModes[kind] ?? mode) === mode, "questionKind does not match answerMode");
  const start = Number(q.audioStartSeconds ?? 0);
  check(q.audioEndSeconds == null || Number(q.audioEndSeconds) > start, "Audio end must be after start");
  check(mode === "listening" || !(q.audioRef !== null && typeof q.audioRef === "object" || list(q, "transcript").length || start !== 0 || q.audioEndSeconds != null || q.examPlayCount !== 2), "Audio fields require listening mode");
  check(!list(q, "transcript").some(block => text(block, "partType") === "blank"), "Transcript cannot contain blanks");
  const audioPath = text(q.audioRef, "objectKey");
  check(!audioPath || !/[\\:]/.test(audioPath) && audioPath.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Unsafe audio resource path");
  check((kind === "translation" || q.sourceLanguage == null) && (["translation", "writing"].includes(kind) || q.targetLanguage == null), "Language fields require translation or writing");
  check(kind === "writing" || ["minWords", "maxWords", "writingGenre"].every(key => q[key] == null), "Writing fields require writing");
  check(q.minWords == null || q.maxWords == null || Number(q.minWords) <= Number(q.maxWords), "Minimum words exceeds maximum");
  check(q.allowReuse !== true || mode === "word_bank", "allowReuse requires word_bank mode");
  check(q.blankCount == null || mode === "fill_blank", "blankCount requires fill_blank mode");
  check(composite(q) || !list(q, "passage").length, "passage requires a composite question");
  check(!list(q, "contentBlocks").some(block => text(block, "partType") === "blank"), "blank references belong in passage");
  for (const block of blocks) check((text(block, "partType") === "blank") === Boolean(text(block, "questionId")), "Invalid blank reference");
  invariant(!mode || ["choice", "word_bank"].includes(mode) || !list(q, "options").length && !text(q, "choiceVariant"), "LOCAL_CHOICE_FIELDS_INVALID", "Choice fields do not match answer mode");
  invariant(!mode || ["ordering", "matching"].includes(mode) || !list(q, "items").length, "LOCAL_ITEMS_MODE_INVALID", "Item fields do not match answer mode");
  invariant(!mode || mode === "matching" || !text(q, "matchingVariant"), "LOCAL_MATCHING_MODE_INVALID", "Matching fields do not match answer mode");
  invariant(mode !== "ordering" || list(q, "items").every(item => object(item).side == null), "LOCAL_ORDERING_SIDE_INVALID", "Ordering items cannot have sides");
  const labels = list(q, "options").filter(option => typeof object(option).label === "string").map(option => fold(text(option, "label")));
  invariant(unique(labels), "LOCAL_OPTION_LABEL_DUPLICATE", "Duplicate option labels");
  invariant(q.answerPayload == null || typeof q.answerPayload === "object" && !Array.isArray(q.answerPayload), "LOCAL_ANSWER_PAYLOAD_INVALID", "Invalid answer payload");
  const allowed = answerKeys[mode] ? [answerKeys[mode]] : Object.values(answerKeys);
  invariant(Object.keys(answer).every(key => allowed.includes(key)) && (mode !== "" || Object.keys(answer).length <= 1), "LOCAL_ANSWER_MODE_MISMATCH", "Answer fields do not match answer mode");
  for (const [key, value] of Object.entries(answer)) {
    if (value == null) continue;
    const valid = key === "value" ? typeof value === "boolean" : key === "text" ? typeof value === "string" && [...value].length <= 120000 :
      Array.isArray(value) && value.length <= 100 && value.every(item => item === null ||
        (["correct", "answers"].includes(key) ? typeof item === "string" : key === "order" ? Number.isSafeInteger(item) : key === "matches" && item !== null && typeof item === "object" && !Array.isArray(item) && Object.entries(item).every(([field, id]) => ["left", "right"].includes(field) && (id === null || Number.isSafeInteger(id)))));
    invariant(valid, "LOCAL_ANSWER_FIELD_INVALID", "Invalid answer field");
  }
  if (mode === "choice") {
    check(text(q, "choiceVariant") !== "single" || list(answer, "correct").length <= 1, "Single choice requires one answer");
    const selected = list(answer, "correct").filter(value => typeof value === "string").map(value => fold(trim(value as string))).filter(Boolean);
    invariant(unique(selected) && (!labels.length || selected.every(value => labels.includes(value))), "LOCAL_OPTION_REFERENCE_INVALID", "Answer references an invalid option");
    if (source && labels.length && answerComplete(q)) { const byLabel = new Map(list(q, "options").filter(option => text(option, "label")).map(option => [fold(text(option, "label")), text(option, "label")])); answer.correct = list(answer, "correct").map(value => byLabel.get(fold(String(value)))); }
  }
  if (mode === "ordering") {
    const order = list(answer, "order").filter(value => value !== null), ids = itemIds(q);
    invariant(unique(order) && (!ids.length || order.every(value => ids.includes(value))), "LOCAL_ORDER_REFERENCE_INVALID", "Answer references an invalid ordering item");
  }
  if (mode === "matching") {
    const left = list(answer, "matches").map(pair => object(pair).left).filter(value => value != null), right = list(answer, "matches").map(pair => object(pair).right).filter(value => value != null);
    invariant(unique(left) && (text(q, "matchingVariant") !== "one_to_one" || unique(right)) && (!list(q, "items").length || left.every(value => itemIds(q, "left").includes(value)) && right.every(value => itemIds(q, "right").includes(value))), "LOCAL_MATCH_REFERENCE_INVALID", "Answer references an invalid matching item");
  }
  invariant(["stem", "instructions", "sourceText", "options", "items", "contentBlocks", "answerPayload", "analysis", "passage"].some(key => {
    const value = q[key]; return value !== null && typeof value === "object" ? Object.keys(value).length > 0 : filled(value);
  }) || q.audioRef !== null && typeof q.audioRef === "object" || list(q, "transcript").length, "LOCAL_QUESTION_EMPTY", "Question is empty");
  const missing = ["stem", "questionTypeId", "answerMode"].filter(key => !filled(q[key]));
  if (["choice", "word_bank"].includes(mode)) {
    if (mode === "choice" && !text(q, "choiceVariant")) missing.push("choiceVariant");
    if (!text(q, "optionSourceId") && (list(q, "options").length < 2 || list(q, "options").some(option => !filled(object(option).label) || !filled(object(option).content)))) missing.push("options");
  }
  if (["matching", "ordering"].includes(mode)) {
    if (mode === "matching" && !text(q, "matchingVariant")) missing.push("matchingVariant");
    if (list(q, "items").length < 2 || !uniqueItems(q) || list(q, "items").some(item => !filled(object(item).content)) || mode === "matching" && (itemIds(q, "left").length < 2 || itemIds(q, "right").length < 2 || list(q, "items").some(item => object(item).side == null))) missing.push("items");
  }
  if (!composite(q) && !answerComplete(q)) missing.push("answerPayload");
  for (const key of ["analysis", "sourceText"]) if (!filled(q[key])) missing.push(key);
  if (mode === "listening" && !(q.audioRef !== null && typeof q.audioRef === "object") && !listeningAddress(q as unknown as Question)) missing.push("media");
  for (const key of ["media", "material"]) if (list(q, "missingFields").includes(key) && !missing.includes(key)) missing.push(key);
  if (missing.length || answerSourceConflictWithRules(q, source)) q.needsReview = true;
  q.missingFields = missing;
  return q as unknown as Question;
}

export function answerSourceConflict(q: unknown): boolean {
  return answerSourceConflictWithRules(q, false);
}
export function parsedAnswerSourceConflict(q: unknown): boolean { return answerSourceConflictWithRules(q, true); }
function answerSourceConflictWithRules(q: unknown, sourceRules: boolean): boolean {
  const trim = sourceRules ? sourceTrim : practiceTrim, compact = sourceRules ? sourceWithoutWhitespace : (value: string) => value.replace(/\p{White_Space}/gu, "");
  const stem = compact(text(q, "stem")), source = text(q, "sourceText");
  if (!stem || !compact(source).includes(stem)) return false;
  const lines = (sourceRules ? sourceLines(source) : source.split(/\r?\n/)).map(trim).filter(Boolean);
  if (lines.filter(line => /^[0-9]+[.、)．]/.test(line)).length > 1) return false;
  const references = lines.flatMap((line, index) => {
    const match = /^([^:：]+)[:：](.*)$/u.exec(line);
    return match && ["reference answer", "correct answer", "answer", "参考答案", "正确答案", "标准答案", "答案"].includes(trim(match[1]).toLowerCase()) ? [{ index, reference: trim(match[2]) }] : [];
  });
  if (references.length !== 1) return false;
  const { index, reference } = references[0];
  if (!reference || ["none", "null", "n/a", "unknown", "unavailable", "not supplied"].includes(reference.toLowerCase())) return false;
  const answer = object(object(q).answerPayload), mode = text(q, "answerMode");
  if (mode === "choice") {
    const labels = [...new Set([...reference.toUpperCase()].filter(char => !" ,，、/;；\t".includes(char)))];
    const allowed = list(q, "options").filter(option => typeof object(option).label === "string").map(option => text(option, "label").toUpperCase());
    if (!labels.length || labels.some(char => !/^[A-Z]$/.test(char) || allowed.length && !allowed.includes(char))) return false;
    const selected = list(answer, "correct");
    if (!selected.length || selected.some(value => typeof value !== "string")) return false;
    return JSON.stringify([...new Set(selected.map(value => (value as string).toUpperCase()))].sort()) !== JSON.stringify(labels.sort());
  }
  if (mode === "true_false") {
    const yes = ["true", "正确", "对", "√"].includes(reference.toLowerCase()), no = ["false", "错误", "错", "×"].includes(reference.toLowerCase());
    return (yes || no) && typeof answer.value === "boolean" && answer.value !== yes;
  }
  if (["short_answer", "fill_blank"].includes(mode) && index === lines.length - 1 && !/^[\[{'"]/.test(reference)) {
    const extracted = mode === "short_answer" ? answer.text : list(answer, "answers").length === 1 ? list(answer, "answers")[0] : null;
    const normalized = (value: string) => sourceRules ? sourceTrim(value).replace(new RegExp(`${SOURCE_WHITESPACE}+`, "gu"), " ") : practiceTrim(value).replace(/\p{White_Space}+/gu, " ");
    return typeof extracted === "string" && Boolean(trim(extracted)) && normalized(extracted) !== normalized(reference);
  }
  return false;
}

export function grade(q: unknown, answer: unknown): boolean | null {
  if (answerSourceConflict(q) || !canInteract(q) || !answerComplete(q) || ["media", "material", "options", "items", "choiceVariant", "matchingVariant", "stem"].some(key => list(q, "missingFields").includes(key))) return null;
  const actual = object(answer), expected = object(object(q).answerPayload);
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  switch (text(q, "answerMode")) {
    case "choice": {
      if (!Array.isArray(actual.correct) || actual.correct.some(value => typeof value !== "string")) return null;
      const canonical = (values: unknown[]) => [...new Set(values.map(value => String(value).toLowerCase()))].sort();
      return equal(canonical(actual.correct), canonical(list(expected, "correct")));
    }
    case "true_false": return typeof actual.value === "boolean" && typeof expected.value === "boolean" ? actual.value === expected.value : null;
    case "fill_blank": return Array.isArray(actual.answers) && actual.answers.every(value => typeof value === "string") ? equal(actual.answers.map(value => practiceTrim(value)), list(expected, "answers").map(value => practiceTrim(String(value)))) : null;
    case "ordering": return Array.isArray(actual.order) ? equal(actual.order, expected.order) : null;
    case "matching": {
      const canonical = (values: unknown[]) => values.map(value => JSON.stringify(Object.fromEntries(Object.entries(object(value)).sort(([left], [right]) => left.localeCompare(right))))).sort();
      return Array.isArray(actual.matches) ? equal(canonical(actual.matches), canonical(list(expected, "matches"))) : null;
    }
    default: return null;
  }
}

export function validateAttempt(q: unknown, answer: unknown): void {
  if (answer === null) return;
  const value = object(answer);
  if (!canInteract(q) && Object.keys(value).length === 1 && typeof value.text === "string" && [...value.text].length <= 120000) return;
  validateQuestion({ ...object(q), answerPayload: answer });
}

export class QuestionTreeError extends AppError {
  constructor(readonly questionId: string | null, message: string, code = "OPERATION_FAILED", params: Record<string, unknown> = {}) { super(code, message, params); }
}
export function validateTree(input: unknown[]): Question[] { return validateTreeWithRules(input, false); }
export function validateParsedTree(input: unknown[]): Question[] { return validateTreeWithRules(input, true); }
function validateTreeWithRules(input: unknown[], source: boolean): Question[] {
  const questions = input.map(value => { try { return source ? validateParsedQuestion(value) : validateQuestion(value); } catch (error) { if (error instanceof AppError) throw new QuestionTreeError(typeof object(value).id === "string" ? String(object(value).id) : null, error.message, error.code, error.params); throw error; } }), byId = new Map<string, Question>(), children = new Map<string, Question[]>(), fold = source ? sourceCasefold : (value: string) => value.toLowerCase();
  for (const q of questions) { if (!q.id || byId.has(q.id)) throw new QuestionTreeError(q.id ?? null, "Questions require unique IDs"); byId.set(q.id, q); if (q.parentId) children.set(q.parentId, [...children.get(q.parentId) ?? [], q]); }
  const validateComposite = (q: Question) => {
    if (!composite(q)) return;
    const check = (condition: unknown, message: string) => { if (!condition) throw new QuestionTreeError(q.id ?? null, message); };
    check(q.answerPayload == null, "Composite parents cannot have answers");
    const child = children.get(q.id!) ?? [], mode = q.answerMode ?? "";
    if (["word_bank", "cloze", "gap_fill"].includes(mode)) {
      const refs = list(q, "passage").filter(block => text(block, "partType") === "blank").map(block => text(block, "questionId"));
      check(unique(refs) && refs.length === child.length && child.every(item => refs.includes(item.id!)), "Blank references must match child questions exactly");
    }
    if (mode === "word_bank" && !q.allowReuse) check(unique(child.flatMap(item => item.answerPayload?.correct ?? []).filter(value => value != null).map(fold)), "Word bank answers cannot repeat");
  };
  for (const q of questions) {
    const check: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new QuestionTreeError(q.id ?? null, message); };
    const mode = q.answerMode ?? "", parent = q.parentId ? byId.get(q.parentId) : null;
    check(list(q, "passage").every(block => text(block, "partType") !== "blank" || byId.has(text(block, "questionId"))), "Passage blank references a missing question");
    if (q.parentId) {
      check(parent && composite(parent) && !["reading", "listening"].includes(mode), "Invalid composite ancestry");
      check(!["word_bank", "cloze"].includes(parent.answerMode ?? "") || mode === "choice" && q.choiceVariant === "single", "Gap children must be single choices");
      check(parent.answerMode !== "gap_fill" || mode === "fill_blank" && q.blankCount === 1, "Grammar gaps require single-blank children");
      check(parent.answerMode !== "listening" || ["choice", "fill_blank", "short_answer"].includes(mode), "Invalid listening child mode");
      check(parent.answerMode !== "word_bank" || q.optionSourceId === parent.id, "Word bank must share its options");
    }
    let current = q.parentId; const seen = new Set([q.id]);
    while (current) { check(!seen.has(current), "Cyclic question ancestry"); seen.add(current); const ancestor = byId.get(current); check(ancestor, "Missing ancestor"); current = ancestor.parentId; }
    if (q.optionSourceId) {
      const owner = byId.get(q.optionSourceId);
      check(owner && q.optionSourceId === q.parentId && owner.answerMode === "word_bank" && mode === "choice" && !q.options.length, "Invalid shared option pool");
      const labels = new Map(owner.options.filter(option => typeof option.label === "string").map(option => [fold(option.label!), option.label!])), selected = list(q.answerPayload, "correct").filter((value): value is string => typeof value === "string");
      check(!labels.size || selected.every(value => labels.has(fold(value))), "Answer references an unknown shared option");
      if (source && labels.size && answerComplete(q)) object(q.answerPayload).correct = selected.map(value => labels.get(fold(value))!);
    }
    if (!source) validateComposite(q);
  }
  // Source validation locates answer/ancestry failures before checking parent blank completeness.
  if (source) questions.forEach(validateComposite);
  for (const q of questions) {
    if (composite(q)) {
      if (!source) q.missingFields = q.missingFields.filter(field => field !== "material");
      if (q.answerMode !== "listening" && !q.passage?.length || !children.has(q.id!)) { q.needsReview = true; if (!q.missingFields.includes("material")) q.missingFields.push("material"); }
    }
  }
  return questions;
}
