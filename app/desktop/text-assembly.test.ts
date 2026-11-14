import { expect, it } from "vitest";
import { assembleTextUnits, type TextAssemblyUnit } from "./text-assembly.js";
import { validateParsedQuestion } from "./question-contract.js";
import type { Question, ParsedGroup } from "../src/contracts.generated.js";

const question = (patch: Record<string, unknown> = {}) => validateParsedQuestion({ id: "source", stem: "Printed source", answerMode: "short_answer", questionTypeId: "short_answer", sourceText: "Printed source", confidence: 0.8, ...patch });
const unit = (index: number, questions: Question[], groups: ParsedGroup[] = []): TextAssemblyUnit => ({ index, payload: { parsed: { questions, groups }, visuals: [] } });
const span = (start: number, end: number) => ({ start, end, overlapStart: start, overlapEnd: start });
const supplied = "1. Printed source\nReference answer: {\"text\": \"Printed answer\"}\nAnalysis: Printed explanation";

it("retains supplied answers, explanations and provenance without changing saved unit artifacts", () => {
  const units = [unit(0, [question({ answerPayload: { text: "Printed answer" }, analysis: "Printed explanation" })])], before = structuredClone(units);
  const output = assembleTextUnits(units, supplied, [span(0, supplied.length)]);
  expect(output).toMatchObject({ status: "SUCCEEDED", result: { confidenceScore: 80, questions: [{ answerPayload: { text: "Printed answer" }, analysis: "Printed explanation" }] }, processing: { chunks: { total: 1, succeeded: 1 }, questionSources: [{ questionId: "q0", stage: "document_parse", unitIndex: 0 }] } });
  expect(units).toEqual(before);
});

it("removes unproven model answers and explanations while retaining the question for review", () => {
  const units = [unit(0, [question({ answerPayload: { text: "Guess" }, analysis: "Invented explanation" })])];
  const output = assembleTextUnits(units, "1. Printed source", [span(0, 17)]);
  expect(output.result.questions[0]).toMatchObject({ stem: "Printed source", answerPayload: null, analysis: null, needsReview: true });
  expect(output.result.warnings.join(" ")).toContain("removed unverified");
  expect(units[0].payload!.parsed.questions![0].answerPayload).toEqual({ text: "Guess" });
});

it("retains completed questions and explicit failure details in partial results", () => {
  const units = [unit(0, [question()]), { index: 1, payload: null, failureCode: "OUTPUT_INVALID" }];
  const output = assembleTextUnits(units, "1. Printed source", [span(0, 17), span(17, 17)]);
  expect(output).toMatchObject({ status: "PARTIAL", result: { missingFields: ["questions"], questions: [{ stem: "Printed source" }] }, processing: { chunks: { total: 2, succeeded: 1 }, failures: [{ stage: "document_parse", index: 1, code: "OUTPUT_INVALID" }], quality: { reviewRequired: true } } });
});

it("reports an empty extraction as incomplete without fabricating questions", () => {
  const output = assembleTextUnits([unit(0, [])], "Section only", [span(0, 12)]);
  expect(output).toMatchObject({ status: "PARTIAL", result: { questions: [], confidenceScore: 0, missingFields: ["questions"] }, processing: { quality: { reviewRequired: true } } });
  expect(output.result.warnings.join(" ")).toContain("No questions were extracted");
});

it.each([false, true])("removes proven duplicates only after explicit opt-in: %s", deduplicateQuestions => {
  const lines = [1, 20].map(id => `${id}. Short answer: What label was printed? Answer: Printed`), text = lines.join("\n");
  const questions = lines.map((sourceText, i) => question({ id: `fragment:1:${i ? 20 : 1}`, stem: "What label was printed?", sourceText, answerPayload: { text: "Printed" } }));
  const output = assembleTextUnits([unit(0, questions)], text, [span(0, text.length)], { deduplicateQuestions });
  expect(output.result.questions).toHaveLength(deduplicateQuestions ? 1 : 2);
  if (!deduplicateQuestions) expect(output.result.warnings.join(" ")).toContain("All copies were retained");
});

it("keeps suspected duplicates when truncation prevents complete source proof", () => {
  const text = "1. Short answer: Printed source\n2. Short answer: Printed source";
  const output = assembleTextUnits([unit(0, [question({ id: "fragment:1:1" }), question({ id: "fragment:1:2" })])], text, [span(0, text.length)], { deduplicateQuestions: true, truncated: true });
  expect(output.result.questions).toHaveLength(2); expect(output.status).toBe("PARTIAL");
});

it("preserves section-only units, continuation material and the lower continuation confidence", () => {
  const units = [unit(0, [], [{ title: "Section", instructions: "Keep this instruction", questionIndexes: [] }]), ...["First", "Second"].map((text, i) => unit(i + 1, [question({ id: "fragment:2:article", stem: "Article", answerMode: "reading", questionTypeId: "reading", passage: [{ partType: "text", textValue: text }], sourceText: text, confidence: i ? 0.2 : 0.95 })]))];
  const output = assembleTextUnits(units, "Page 1FirstSecond", [span(0, 6), span(6, 11), span(11, 17)]);
  expect(output.result.questions[0]).toMatchObject({ passage: [{ textValue: "First" }, { textValue: "Second" }], confidence: 0.2 });
  expect(output.result.groups).toContainEqual(expect.objectContaining({ title: "Section", instructions: "Keep this instruction" }));
  expect(output.result.confidenceScore).toBe(20);
  expect(output.processing.questionSources.map(item => item.unitIndex)).toEqual([1, 2]);
});

it.each([[0.00005, 0], [0.00015, 0], [0.0255, 2.5], [0.02555, 2.6], [0.125, 12.5], [0.1255, 12.6], [0.9955, 99.6], [1, 100]])("retains reference confidence rounding for %s", (confidence, expected) => {
  const output = assembleTextUnits([unit(0, [question({ confidence })])], "1. Printed source", [span(0, 17)]);
  expect(output.result.confidenceScore).toBe(expected);
});

it.each(["repaired", "repair_rejected", "no_discrepancy"])("retains source-review status and the human-review warning: %s", status => {
  const input = unit(0, [question()]); input.payload!.agentReview = { status, missingQuestions: true, reports: [{ issues: [{ code: "SOURCE_WARNING", evidence: "Literal source", instruction: "Review the source" }] }] };
  const output = assembleTextUnits([input], "1. Printed source", [span(0, 17)]);
  expect(output).toMatchObject({ status: "PARTIAL", result: { missingFields: ["questions"] }, processing: { quality: { reviewRequired: true } } });
  expect(output.result.warnings.join(" ")).toContain(`AI source review, unit 1: ${status}`);
  expect(output.result.warnings.join(" ")).toContain("Not a guarantee of extraction accuracy");
});

it.each([-1, 1])("rejects a unit without a verified source span: %s", index => {
  expect(() => assembleTextUnits([unit(index, [question()])], "Source", [span(0, 6)])).toThrowError(expect.objectContaining({ code: "UNIT_RESULT_INVALID" }));
});
