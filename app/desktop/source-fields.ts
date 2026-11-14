import type { Question } from "../src/contracts.generated.js";
import { hash } from "./assets.js";
import { AppError, invariant } from "./errors.js";
import { ModelOutputError } from "./model.js";
import { composite, validateParsedTree } from "./question-contract.js";
import type { SourcePresenceHint } from "./source-chunks.js";
import { SourceText, sourceTrim } from "./source-text.js";
import { ocrPageViolations, sourceFidelityViolations, type OcrSourceEvidence } from "./source-fidelity.js";
import { validateUnitResult, validateUnitStructure } from "./unit-results.js";

export interface SourceFieldContext { index: number; expectedNodeCount: number | null; presence: Record<string, SourcePresenceHint> | null; requireTypeLabels?: boolean; ocr?: OcrSourceEvidence }
export function validateSourceContext(context: SourceFieldContext): void {
  const valid = (condition: unknown) => invariant(condition, "CHUNK_INPUTS_INVALID", "Invalid source-field validation scope");
  valid(Number.isSafeInteger(context.index) && context.index >= 0 && context.index < Number.MAX_SAFE_INTEGER);
  valid(context.expectedNodeCount === null || Number.isSafeInteger(context.expectedNodeCount) && context.expectedNodeCount >= 0 && context.expectedNodeCount <= 1000);
  valid(context.requireTypeLabels === undefined || typeof context.requireTypeLabels === "boolean");
  if (context.presence !== null) {
    valid(typeof context.presence === "object" && !Array.isArray(context.presence) && Object.keys(context.presence).length <= 1000);
    for (const [id, hints] of Object.entries(context.presence)) {
      valid(/^[1-9]\p{Nd}{0,8}$/u.test(id) && hints !== null && typeof hints === "object" && !Array.isArray(hints));
      valid(Object.keys(hints).every(key => ["need_stem", "need_options", "need_analysis", "need_answer", "stem_sha256", "answer_source"].includes(key)));
      valid([hints.need_stem, hints.need_options, hints.need_analysis].every(value => typeof value === "boolean") && (hints.need_answer === undefined || typeof hints.need_answer === "boolean"));
      valid(hints.stem_sha256 === undefined || typeof hints.stem_sha256 === "string" && /^[a-f0-9]{64}$/.test(hints.stem_sha256));
      valid(hints.answer_source === undefined || typeof hints.answer_source === "string" && new SourceText(hints.answer_source).length <= 120000);
    }
  }
  if (context.ocr !== undefined) {
    const ocr = context.ocr; valid(ocr !== null && typeof ocr === "object" && !Array.isArray(ocr) && Object.keys(ocr).every(key => ["text", "nativeTable"].includes(key)));
    valid(typeof ocr.text === "string" && new SourceText(ocr.text).length <= 2_000_000);
    if (ocr.nativeTable !== undefined) {
      const table = ocr.nativeTable; valid(table !== null && typeof table === "object" && !Array.isArray(table) && Object.keys(table).every(key => ["title", "headers"].includes(key)));
      valid(typeof table.title === "string" && new SourceText(table.title).length <= 1000 && Array.isArray(table.headers) && table.headers.length <= 10000 && table.headers.every(header => typeof header === "string" && new SourceText(header).length <= 2_000_000));
    }
  }
}
function anchor(question: Question): { prefix: string; index: number } | null {
  const match = /^(?:page|fragment):(\p{Nd}+):/u.exec(question.id ?? ""); if (!match) return null; let index = 0;
  for (const char of match[1]) { const point = char.codePointAt(0)!; let first = point; while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--; index = index * 10 + (point - first) % 10; }
  return { prefix: match[0], index };
}
function validateClosedTrees(questions: Question[], index: number): void {
  const byId = new Map(questions.filter(question => question.id).map(question => [question.id!, question])), references = new Set(questions.flatMap(question => [question.parentId, question.optionSourceId, ...(question.passage ?? []).map(block => block.questionId)].filter((value): value is string => Boolean(value))));
  const startsHere = questions.filter(composite).every(question => !anchor(question) || anchor(question)!.index === index + 1);
  const check = (tree: Question[]) => {
    const validated = validateParsedTree(tree);
    for (const [position, question] of tree.entries()) { question.answerPayload = validated[position].answerPayload; if (validated[position].needsReview) question.needsReview = true; if (validated[position].missingFields.includes("material") && !question.missingFields.includes("material")) question.missingFields.push("material"); }
  };
  if (startsHere && byId.size === questions.length && [...references].every(id => byId.has(id)) && questions.some(question => question.parentId && ["word_bank", "cloze", "gap_fill"].includes(byId.get(question.parentId)?.answerMode ?? ""))) { check(questions); return; }
  if (byId.size !== questions.length) return;
  for (const parent of questions) {
    const location = anchor(parent); if (!["word_bank", "cloze", "gap_fill"].includes(parent.answerMode ?? "") || !location || location.index !== index + 1) continue;
    const children = questions.filter(question => question.parentId === parent.id), blanks = (parent.passage ?? []).filter(block => block.partType === "blank").map(block => block.questionId);
    if (!children.length || blanks.length !== children.length || !children.every(question => question.id?.startsWith(location.prefix)) || !blanks.every(id => id?.startsWith(location.prefix))) continue;
    const tree = [parent, ...children], ids = new Set(tree.map(question => question.id)), others = tree.flatMap(question => [question.parentId, question.optionSourceId, ...(question === parent ? [] : (question.passage ?? []).map(block => block.questionId))]).filter(Boolean);
    if (others.every(id => ids.has(id))) check(tree);
  }
}

/** Trusted source evidence is validated before spending, then reused during paid correction. */
export function validateSourceFields(input: unknown, context: SourceFieldContext): ReturnType<typeof validateUnitResult> {
  validateSourceContext(context);
  let parsed: ReturnType<typeof validateUnitResult>;
  try { parsed = validateUnitResult(input); } catch (error) { throw new ModelOutputError(error instanceof AppError ? error.message : "Return a complete UnitParseResult with valid question/group fields and actual JSON arrays."); }
  const violations: string[] = [], { questions } = parsed;
  if (context.expectedNodeCount !== null && questions.length !== context.expectedNodeCount) violations.push(`Expected exactly ${context.expectedNodeCount} questions for the validated source records, including parent records; received ${questions.length}`);
  if (context.presence !== null) {
    const presence = new Map(Object.entries(context.presence).map(([id, hints]) => [`${context.ocr ? "page" : "fragment"}:${context.index + 1}:${id}`, hints]));
    if (new Set(questions.map(question => question.id)).size !== presence.size || questions.some(question => !question.id || !presence.has(question.id))) violations.push("Question IDs must match the validated source record IDs for this fragment");
    for (const question of questions) {
      const hints = question.id && presence.get(question.id); if (!hints) continue;
      const supplied = { stem: Boolean(question.stem && sourceTrim(question.stem)), options: question.options.length > 0 && question.options.every(option => option.content && sourceTrim(option.content)), analysis: Boolean(question.analysis && sourceTrim(question.analysis)) };
      for (const [field, present] of Object.entries(supplied)) if (hints[`need_${field}` as keyof SourcePresenceHint] && !present) violations.push(`Source record ${question.id} requires extracted ${field}; preserve the supplied content`);
      if (hints.stem_sha256 && hash(question.stem ?? "") !== hints.stem_sha256) violations.push(`Source record ${question.id} must preserve the complete printed stem`);
      if (hints.need_answer && question.answerPayload == null) violations.push(`Source record ${question.id} requires extracted answerPayload; preserve the supplied reference answer`);
      if (hints.answer_source) question.sourceText = hints.answer_source;
    }
  }
  try { validateUnitStructure(parsed); } catch (error) { throw new ModelOutputError(error instanceof AppError ? error.message : "Retain valid source question/group relationships"); }
  if (violations.length) throw new ModelOutputError(violations.join("; ").slice(0, 20000));
  const byId = new Map(questions.filter(question => question.id).map(question => [question.id!, question]));
  for (const question of questions) {
    const location = anchor(question);
    if (context.requireTypeLabels && question.answerMode != null && question.questionTypeId == null && !(composite(question) && location && location.index > 0 && location.index < context.index + 1)) violations.push("Known answerMode requires questionTypeId; preserve the literal source label or its recognized answerMode. Do not erase the known answerMode");
    if (context.ocr && !composite(question) && location && location.index !== context.index + 1) violations.push(`Extract only question starts on PRIMARY page ${context.index + 1}; do not copy a context question or rewrite its source ID`);
    const owner = question.optionSourceId && byId.get(question.optionSourceId);
    if (owner && (owner.answerMode !== "word_bank" || question.parentId !== owner.id)) violations.push("optionSourceId must reference the parent word bank");
  }
  violations.push(...(context.ocr ? ocrPageViolations(questions, parsed.groups, context.ocr) : []), ...sourceFidelityViolations(questions, context.ocr));
  if (violations.length) throw new ModelOutputError(violations.join("; ").slice(0, 20000));
  try { validateClosedTrees(questions, context.index); } catch (error) { throw new ModelOutputError(error instanceof AppError ? error.message : "Retain a valid closed composite tree with one passage blank per child"); }
  return parsed;
}
