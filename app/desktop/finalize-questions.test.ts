import { expect, it } from "vitest";
import type { ParsedGroup, Question, VisualElement } from "../src/contracts.generated.js";
import { finalizeQuestions, SourceQuestionConflict } from "./finalize-questions.js";
import type { MergeQuality, MergeSource } from "./merge-chunks.js";
import { validateParsedQuestion } from "./question-contract.js";
const question = (values: Record<string, unknown> = {}) => validateParsedQuestion({ id: "page:1:root", stem: "Article", answerMode: "reading", sourceText: "Article", confidence: .9, ...values });
function finish(questions: Question[], indexes = questions.map((_, index) => index)) {
  const groups: ParsedGroup[] = [{ title: "Section", questionIndexes: questions.map((_, index) => index) }], visuals: VisualElement[] = [{ kind: "image", description: "Source", page: 0, bbox: null, questionIndexes: questions.map((_, index) => index) }];
  const sources: MergeSource[] = indexes.map((unitIndex, questionIndex) => ({ questionIndex, unitIndex, stage: "vision_parse" })), quality: MergeQuality = { reviewRequired: false, reviewQuestionCount: 0, issues: [] };
  return { questions: finalizeQuestions(questions, groups, visuals, sources, quality), groups, visuals, sources, quality };
}
it("merges adjacent composite continuations and remaps groups, figures, sources and child links", () => {
  const first = question({ passage: [{ partType: "text", textValue: "First passage." }], instructions: "Read carefully", confidence: .9 }), later = question({ passage: [{ partType: "text", textValue: "Second passage." }], analysis: "Supplied analysis", confidence: .6 }), child = question({ id: "page:2:1", parentId: first.id, stem: "Prompt?", answerMode: "short_answer" });
  const result = finish([first, later, child]);
  expect(result.questions.map(q => q.id)).toEqual(["q0", "q1"]); expect(result.questions[0]).toMatchObject({ confidence: .6, instructions: "Read carefully", analysis: "Supplied analysis", passage: [{ partType: "text", textValue: "First passage." }, { partType: "text", textValue: "Second passage." }] });
  expect(result.questions[1].parentId).toBe("q0"); expect(result.groups[0].questionIndexes).toEqual([0, 1]); expect(result.visuals[0].questionIndexes).toEqual([0, 1]); expect(result.sources.map(s => s.questionIndex)).toEqual([0, 0, 1]);
});
it.each([[], [0, 0], [0, 2]].map(indexes => ({ indexes })))("requires adjacent durable source evidence before merging a continuation: %j", ({ indexes }) => expect(() => finish([question(), question()], indexes)).toThrow(SourceQuestionConflict));
it.each(["analysis", "instructions", "scoringRubric", "sourceScore", "audioEndSeconds", "examPlayCount", "audioStartSeconds"])("rejects conflicting composite %s and identifies the source question", field => {
  const numeric = ["sourceScore", "audioEndSeconds", "examPlayCount", "audioStartSeconds"].includes(field), first = question({ answerMode: field.startsWith("audio") || field === "examPlayCount" ? "listening" : "reading", [field]: numeric ? 3 : "First" }), later = question({ answerMode: field.startsWith("audio") || field === "examPlayCount" ? "listening" : "reading", [field]: numeric ? 4 : "Changed" });
  try { finish([first, later]); throw new Error("Expected source conflict"); } catch (error) { expect(error).toBeInstanceOf(SourceQuestionConflict); expect((error as SourceQuestionConflict).questionIndex).toBe(1); }
});
it("retains shared options, coalesces Unicode-equivalent labels and remaps the child owner", () => {
  const first = question({ answerMode: "word_bank", options: [{ label: "ß", content: "First" }], passage: [{ partType: "text", textValue: "Choose " }, { partType: "blank", questionId: "child" }] }), later = question({ answerMode: "word_bank", options: [{ label: "SS", content: "First" }, { label: "B", content: "Second" }] }), child = question({ id: "child", parentId: first.id, optionSourceId: first.id, stem: "Choose", answerMode: "choice", choiceVariant: "single", answerPayload: { correct: ["ss"] } });
  const result = finish([first, later, child]); expect(result.questions[0].options.map(o => o.label)).toEqual(["ß", "B"]); expect(result.questions[1]).toMatchObject({ parentId: "q0", optionSourceId: "q0", answerPayload: { correct: ["ß"] } }); expect(result.questions[0].passage[1].questionId).toBe("q1");
  expect(() => finish([question({ answerMode: "word_bank", options: [{ label: "A", content: "First" }] }), question({ answerMode: "word_bank", options: [{ label: "a", content: "Different" }] })])).toThrow(SourceQuestionConflict);
});
it("rejects duplicate ordinary identities and a non-composite parent", () => {
  expect(() => finish([question({ answerMode: "short_answer" }), question({ answerMode: "short_answer" })])).toThrow(SourceQuestionConflict);
  expect(() => finish([question({ id: "ordinary", answerMode: "short_answer" }), question({ id: "child", parentId: "ordinary", answerMode: "short_answer" })])).toThrow(SourceQuestionConflict);
});
it("retains orphaned material as reviewable text and never links a blank across unrelated roots", () => {
  const orphan = question({ id: "orphan", parentId: "missing", answerMode: "short_answer" }), root = question({ passage: [{ partType: "blank", questionId: "orphan" }, { partType: "blank", questionId: "missing" }] }), result = finish([root, orphan]);
  expect(result.questions[1]).toMatchObject({ parentId: null, needsReview: true }); expect(result.questions[0].passage.map(b => b.partType)).toEqual(["text", "text"]); expect(result.questions[0].passage.every(b => b.questionId === null && b.textValue === "[____]")).toBe(true);
  expect(result.quality.issues).toContainEqual({ questionIndex: 0, code: "MISSING_FIELDS" });
});
it("retains nondefault listening metadata and rejects incompatible continuation modes", () => {
  const result = finish([question({ answerMode: "listening", transcript: [{ partType: "text", textValue: "First" }] }), question({ answerMode: "listening", examPlayCount: 3, audioStartSeconds: 2, transcript: [{ partType: "text", textValue: "Second" }] })]);
  expect(result.questions[0]).toMatchObject({ examPlayCount: 3, audioStartSeconds: 2, transcript: [{ textValue: "First" }, { textValue: "Second" }] });
  expect(() => finish([question(), question({ answerMode: "listening" })])).toThrow(SourceQuestionConflict);
});
