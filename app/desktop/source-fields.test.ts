import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ModelOutputError } from "./model.js";
import { validateSourceContext, validateSourceFields, type SourceFieldContext } from "./source-fields.js";

const quote = '1. Single choice: Q\nA. red\nB. blue\nReference answer: ["A"]\nAnalysis: Explanation';
const question = () => ({ id: "fragment:1:1", stem: "Q", answerMode: "choice", questionTypeId: "Single choice", choiceVariant: "single", options: [{ label: "A", content: "red" }, { label: "B", content: "blue" }], answerPayload: { correct: ["A"] }, analysis: "Explanation", sourceText: quote, confidence: .9, needsReview: false });
const context: SourceFieldContext = { index: 0, expectedNodeCount: 1, presence: { "1": { need_stem: true, need_options: true, need_analysis: true, need_answer: true, stem_sha256: createHash("sha256").update("Q").digest("hex"), answer_source: quote } }, requireTypeLabels: true };
it("retains supplied fields and literal source, leaving the model draft immutable", () => {
  const input = { questions: [question()], groups: [] }, before = structuredClone(input);
  expect(validateSourceFields(input, context).questions[0]).toMatchObject(question()); expect(input).toEqual(before);
});
it.each([{ stem: null }, { stem: "rewritten" }, { options: [] }, { analysis: null }, { answerPayload: null }, { id: null }, { id: "fragment:1:2" }, { questionTypeId: null }])("requires each known supplied field and identity: %#", patch => {
  expect(() => validateSourceFields({ questions: [{ ...question(), ...patch }] }, context)).toThrow(ModelOutputError);
});
it.each([0, 2])("rejects a changed known question count: %s", count => expect(() => validateSourceFields({ questions: Array.from({ length: count }, question) }, context)).toThrow(ModelOutputError));
it("reports every supplied missing field in one bounded correction without changing the draft", () => {
  const input = { questions: [{ ...question(), stem: null, options: [], analysis: null, answerPayload: null }] }, before = structuredClone(input);
  try { validateSourceFields(input, context); throw new Error("Expected source-field rejection"); }
  catch (error) { expect(error).toBeInstanceOf(ModelOutputError); for (const field of ["stem", "options", "analysis", "answerPayload"]) expect((error as ModelOutputError).feedback).toContain(`requires extracted ${field}`); }
  expect(input).toEqual(before);
});
it("does not demand unavailable answers when source presence is unknown", () => {
  const parsed = validateSourceFields({ questions: [{ ...question(), answerMode: "short_answer", stem: null, choiceVariant: null, options: [], answerPayload: null }] }, { index: 0, expectedNodeCount: null, presence: null });
  expect(parsed.questions[0]).toMatchObject({ answerPayload: null, needsReview: true });
});
it.each(["page:1:1", "page:２:1", "fragment:1:1"])("does not copy a context question onto a different PRIMARY page: %s", id => expect(() => validateSourceFields({ questions: [{ ...question(), id }] }, { index: 2, expectedNodeCount: null, presence: null, ocr: { text: "" } })).toThrow(ModelOutputError));
it("validates native group indexes and keeps explicit groups", () => {
  const input = { questions: [question()], groups: [{ title: "Section", questionIndexes: [0] }] };
  expect(validateSourceFields(input, context).groups[0].questionIndexes).toEqual([0]);
  expect(() => validateSourceFields({ ...input, groups: [{ title: "Section", questionIndexes: [1] }] }, context)).toThrow(ModelOutputError);
});
it.each([NaN, -1, 1.5, 1001])("rejects an invalid source record count %s before model work", expectedNodeCount => {
  expect(() => validateSourceContext({ index: 0, expectedNodeCount, presence: null })).toThrow();
});
it("rejects malformed persisted hints and untrusted feedback identifiers", () => {
  for (const presence of [{ secret: { need_stem: true } }, { "1": null }, { "1": { need_stem: true, need_options: true, need_analysis: true, unknown: "PRIVATE" } }, { "1": { need_stem: true, need_options: false, need_analysis: false, stem_sha256: "bad" } }]) expect(() => validateSourceContext({ index: 0, expectedNodeCount: 1, presence } as unknown as SourceFieldContext)).toThrow();
});
it("rejects malformed OCR source scopes before model work", () => {
  for (const ocr of [null, {}, { text: 1 }, { text: "", untrusted: "PRIVATE" }, { text: "", nativeTable: null }, { text: "", nativeTable: { title: "Science", headers: [null] } }]) expect(() => validateSourceContext({ index: 0, expectedNodeCount: null, presence: null, ocr } as unknown as SourceFieldContext)).toThrow();
});
