import type { ContentBlock, ParsedGroup, Question, VisualElement } from "../src/contracts.generated.js";
import { AppError, invariant } from "./errors.js";
import type { MergeQuality, MergeSource } from "./merge-chunks.js";
import { modelDefaults } from "./model-defaults.js";
import { composite, QuestionTreeError, validateParsedQuestion, validateParsedTree } from "./question-contract.js";
import { canonical } from "./questions.js";
import { sourceCasefold } from "./source-casefold.js";
import { sourceTrim } from "./source-text.js";

export class SourceQuestionConflict extends AppError {
  constructor(message: string, readonly questionIndex: number) { super("OUTPUT_INVALID", message, { questionIndex }); }
}
function unresolvedBlank(question: Question, block: ContentBlock): void {
  block.partType = "text"; block.questionId = null;
  if (![block.textValue, block.markdownValue, block.latexValue].some(value => value && sourceTrim(value)) && block.jsonValue == null) block.textValue = "[____]";
  question.needsReview = true; question.missingFields = [...new Set<Question["missingFields"][number]>([...question.missingFields, "material"])];
}

/** Mutates merge-owned copies only; immutable unit results remain the retry evidence. */
export function finalizeQuestions(questions: Question[], groups: ParsedGroup[], visuals: VisualElement[], sources: MergeSource[], quality: MergeQuality): Question[] {
  const retained: Question[] = [], anchors = new Map<string, number>(), indexMap = new Map<number, number>(), anchorUnits = new Map<string, MergeSource[]>(), sourceUnits = new Map<number, MergeSource[]>();
  for (const source of sources) sourceUnits.set(source.questionIndex, [...sourceUnits.get(source.questionIndex) ?? [], source]);
  for (const [index, question] of questions.entries()) {
    const prior = question.id && /^(?:page|fragment):/.test(question.id) ? anchors.get(question.id) : undefined;
    if (prior !== undefined && composite(question)) {
      const current = sourceUnits.get(index) ?? [];
      if (!current.some(unit => (anchorUnits.get(question.id!) ?? []).some(old => unit.stage === old.stage && unit.unitIndex === old.unitIndex + 1))) throw new SourceQuestionConflict("Composite continuation lacks adjacent source evidence", index);
      anchorUnits.set(question.id!, current); let target = retained[prior];
      if (target.answerMode !== question.answerMode || (target.parentId ?? null) !== (question.parentId ?? null)) throw new SourceQuestionConflict("Conflicting composite source anchor", index);
      for (const field of ["passage", "transcript", "contentBlocks"] as const) {
        const blocks = target[field] ?? []; target[field] = blocks;
        const keys = new Set(blocks.map(block => canonical(modelDefaults("ContentBlock", block))));
        for (const block of question[field] ?? []) { const key = canonical(modelDefaults("ContentBlock", block)); if (!keys.has(key)) { blocks.push(block); keys.add(key); } }
      }
      for (const option of question.options) {
        const old = target.options.find(value => value.label && option.label && sourceCasefold(value.label) === sourceCasefold(option.label));
        if (old) { if ((old.content ?? null) !== (option.content ?? null)) throw new SourceQuestionConflict("Conflicting composite shared option", index); }
        else if (!target.options.some(value => canonical(modelDefaults("ParsedOption", value)) === canonical(modelDefaults("ParsedOption", option)))) target.options.push(option);
      }
      target.allowReuse ||= question.allowReuse;
      for (const field of ["questionKind", "questionTypeId", "instructions", "analysis", "scoringRubric", "scoreSourceText", "sourceScore", "audioRef", "audioEndSeconds"] as const) {
        const value = question[field], old = target[field];
        if (value != null) { if (old != null && canonical(old) !== canonical(value)) throw new SourceQuestionConflict("Conflicting composite metadata", index); Object.assign(target, { [field]: value }); }
      }
      for (const [field, fallback] of [["audioStartSeconds", 0], ["examPlayCount", 2]] as const) {
        const value = question[field] ?? fallback, old = target[field] ?? fallback;
        if (value !== fallback) { if (old !== fallback && old !== value) throw new SourceQuestionConflict("Conflicting composite audio metadata", index); Object.assign(target, { [field]: value }); }
      }
      target.needsReview ||= question.needsReview; target.confidence = Math.min(target.confidence, question.confidence); target.missingFields = [...new Set([...target.missingFields, ...question.missingFields])];
      try { target = validateParsedQuestion(target); } catch { throw new SourceQuestionConflict("Composite continuation violates question constraints", index); }
      retained[prior] = target; indexMap.set(index, prior);
    } else {
      indexMap.set(index, retained.length);
      if (question.id) {
        if (anchors.has(question.id)) throw new SourceQuestionConflict("Duplicate source question ID", index);
        anchors.set(question.id, retained.length); anchorUnits.set(question.id, sourceUnits.get(index) ?? []);
      }
      retained.push(question);
    }
  }
  for (const [index, question] of questions.entries()) if (question.parentId && anchors.has(question.parentId) && !composite(retained[anchors.get(question.parentId)!])) throw new SourceQuestionConflict("Parent source anchor must reference a composite question", index);
  const aliases = new Map([...anchors].map(([id, index]) => [id, `q${index}`]));
  for (const [index, question] of retained.entries()) {
    question.id = `q${index}`;
    if (question.parentId) {
      if (!aliases.has(question.parentId)) {
        if (question.optionSourceId === question.parentId) question.optionSourceId = null;
        question.parentId = null; question.needsReview = true; question.missingFields = [...new Set<Question["missingFields"][number]>([...question.missingFields, "material"])];
        question.missingFields = validateParsedQuestion(question).missingFields;
      } else question.parentId = aliases.get(question.parentId)!;
    }
    if (question.optionSourceId) question.optionSourceId = aliases.get(question.optionSourceId) ?? question.optionSourceId;
    for (const block of question.passage ?? []) if (block.questionId) { if (aliases.has(block.questionId)) block.questionId = aliases.get(block.questionId)!; else unresolvedBlank(question, block); }
  }
  const byId = new Map(retained.map(question => [question.id!, question]));
  const root = (id: string): string => { const seen = new Set([id]); while (byId.get(id)?.parentId) { id = byId.get(id)!.parentId!; if (seen.has(id)) return ""; seen.add(id); } return id; };
  for (const question of retained) if (["reading", "listening"].includes(question.answerMode ?? "")) for (const block of question.passage ?? []) if (block.partType === "blank" && block.questionId && root(block.questionId) !== question.id) unresolvedBlank(question, block);
  const mapped = (index: number): number => { const result = indexMap.get(index); invariant(result !== undefined, "UNIT_RESULT_INVALID", "A merged association references a missing question"); return result; };
  for (const value of [...groups, ...visuals]) value.questionIndexes = [...new Set((value.questionIndexes ?? []).map(mapped))];
  for (const value of [...sources, ...quality.issues]) value.questionIndex = mapped(value.questionIndex);
  const missing = new Set(quality.issues.filter(issue => issue.code === "MISSING_FIELDS").map(issue => issue.questionIndex));
  for (const [index, question] of retained.entries()) if (question.missingFields.length && !missing.has(index)) quality.issues.push({ questionIndex: index, code: "MISSING_FIELDS" });
  try { return validateParsedTree(retained); }
  catch (error) { if (error instanceof QuestionTreeError) { const index = retained.findIndex(question => question.id === error.questionId); if (index >= 0) throw new SourceQuestionConflict(error.message, index); } throw error; }
}
