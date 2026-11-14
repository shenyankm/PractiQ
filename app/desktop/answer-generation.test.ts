import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { DocumentParseResult, DocumentProcessing, GeneratedAnswer, Question } from "../src/contracts.generated.js";
import { AnswerResults, completedAnswer, pendingAnswers, questionHash } from "./answer-generation.js";
import { validateContract } from "./contracts.js";
import type { DocumentRecord } from "./document-tasks.js";
import { SqliteStore } from "./graph-store.js";
import { validateParsedQuestion, validateParsedTree } from "./question-contract.js";

const missingQuestion = () => validateParsedQuestion({ id: "q1", stem: "1 + 1?", questionTypeId: "Short answer", answerMode: "short_answer", sourceText: "1 + 1?", answerPayload: null, analysis: null, confidence: .9 });
it("fills only missing fields, preserves original evidence and always marks generation for review", () => {
  const original = { ...missingQuestion(), answerPayload: { text: "Supplied" } }, before = structuredClone(original);
  const completed = completedAnswer(original, { answerPayload: { text: "Must not replace" }, analysis: "Generated explanation" });
  expect(completed).toMatchObject({ answerPayload: { text: "Supplied" }, analysis: "Generated explanation", needsReview: true, sourceText: original.sourceText }); expect(original).toEqual(before);
  expect(completedAnswer({ ...missingQuestion(), analysis: "Supplied explanation" }, { answerPayload: { text: "2" }, analysis: "Replace" }).analysis).toBe("Supplied explanation");
  expect(completedAnswer({ ...missingQuestion(), answerMode: "true_false", answerPayload: { value: false } }, { answerPayload: { value: true } }).answerPayload).toEqual({ value: false });
  expect(completedAnswer(missingQuestion(), { answerPayload: null, analysis: null }).answerPayload).toBeNull();
});
it.each([
  { mode: "choice", fields: { choiceVariant: "single", options: [{ label: "A", content: "First" }, { label: "B", content: "Second" }] }, good: { correct: ["A"] }, bad: [{ correct: ["Z"] }, { correct: ["A", "B"] }, { correct: [] }] },
  { mode: "fill_blank", fields: { blankCount: 2 }, good: { answers: ["one", "two"] }, bad: [{ answers: ["one"] }, { answers: ["one", ""] }] },
  { mode: "ordering", fields: { items: [{ id: 0, content: "One" }, { id: 1, content: "Two" }] }, good: { order: [1, 0] }, bad: [{ order: [0] }, { order: [0, 9] }, { order: [0, 0] }] },
  { mode: "matching", fields: { matchingVariant: "one_to_one", items: [{ id: 0, side: "left", content: "One" }, { id: 1, side: "left", content: "Two" }, { id: 0, side: "right", content: "A" }, { id: 1, side: "right", content: "B" }] }, good: { matches: [{ left: 0, right: 0 }, { left: 1, right: 1 }] }, bad: [{ matches: [{ left: 0, right: 0 }] }, { matches: [{ left: 0, right: 9 }, { left: 1, right: 1 }] }, { matches: [{ left: 0, right: 0 }, { left: 1, right: 0 }] }] },
])("accepts complete $mode answers and rejects incomplete or invented identities", ({ mode, fields, good, bad }) => {
  const question = validateParsedQuestion({ ...missingQuestion(), answerMode: mode, ...fields });
  expect(completedAnswer(question, { answerPayload: good }).answerPayload).toEqual(good);
  for (const answerPayload of bad) expect(() => validateParsedTree([completedAnswer(question, { answerPayload })])).toThrow();
});
it.each([true, false])("retains literal generated boolean %s", value => expect(completedAnswer({ ...missingQuestion(), answerMode: "true_false" }, { answerPayload: { value } }).answerPayload).toEqual({ value }));
it("rejects unknown generation fields and empty generated answers", () => {
  expect(() => validateContract("GeneratedAnswer", { secret: "not a generated field" })).toThrow();
  expect(() => completedAnswer(missingQuestion(), { answerPayload: { text: "" } })).toThrow();
});

const directories: string[] = [], stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.stop(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-answer-generation-")); directories.push(path); const store = new SqliteStore(path); stores.push(store);
  const task = { id: randomUUID(), input: { document: { sha256: "a".repeat(64) } }, executionFingerprint: "b".repeat(64) } as DocumentRecord;
  const question = missingQuestion(), result: DocumentParseResult = { schemaVersion: 3, questions: [question], groups: [], visualElements: [], warnings: [], missingFields: [], confidenceScore: 100 };
  const processing: DocumentProcessing = { chunks: { total: 1, succeeded: 1, skipped: 0 }, visuals: { total: 0, succeeded: 0, skipped: 0 }, truncated: false, failures: [], questionSources: [], quality: { reviewRequired: false, reviewQuestionCount: 0, issues: [] } };
  return { path, store, task, question, result, processing, records: new AnswerResults(store, task) };
}

it("selects only answerable leaf questions with missing answer or analysis", () => {
  const f = setup(), complete = { ...f.question, answerPayload: { text: "2" }, analysis: "Provided" }, missingMaterial = { ...f.question, missingFields: ["media"] } as Question, composite = { ...f.question, answerMode: "reading" } as Question;
  expect(pendingAnswers([f.question, complete, missingMaterial, composite])).toEqual([f.question]);
  expect(pendingAnswers([{ ...f.question, answerMode: "true_false", answerPayload: { value: false }, analysis: "Provided" }])).toEqual([]);
  const { answerPayload: _absent, ...withoutAnswer } = { ...f.question, analysis: "Supplied explanation" };
  expect(pendingAnswers([withoutAnswer as Question])).toEqual([withoutAnswer]);
  expect(() => completedAnswer(withoutAnswer as Question, { answerPayload: { text: "" } })).toThrow();
});

it("persists immutable generation and projects without writes after reopening", async () => {
  const f = setup(), before = structuredClone({ result: f.result, processing: f.processing });
  await f.records.save(f.question, { answerPayload: { text: "2" }, analysis: "One plus one." }, null);
  const version = f.store.db.prepare("SELECT * FROM store_items").all(), projected = f.records.project(f.result, f.processing);
  expect(projected.result.questions[0]).toMatchObject({ answerPayload: { text: "2" }, needsReview: true, sourceText: f.question.sourceText });
  expect(projected.result.warnings).toEqual(["AI 生成答案与解析（需人工核对）：q1"]);
  expect(projected.processing.quality).toMatchObject({ reviewRequired: true, reviewQuestionCount: 1, issues: [{ questionId: "q1", code: "NEEDS_REVIEW" }] });
  expect({ result: f.result, processing: f.processing }).toEqual(before); expect(f.store.db.prepare("SELECT * FROM store_items").all()).toEqual(version);
  f.store.stop(); const reopened = new SqliteStore(f.path); stores.push(reopened); expect(new AnswerResults(reopened, f.task).project(f.result, f.processing)).toEqual(projected);
  expect(new AnswerResults(reopened, f.task).project({ ...f.result, questions: [{ ...f.question, stem: "Changed" }] }, f.processing).result.questions[0].answerPayload).toBeNull();
  await expect(new AnswerResults(reopened, f.task).save(f.question, { answerPayload: { text: "3" } }, null)).rejects.toMatchObject({ code: "AI_CALL_CONFLICT" });
});

it.each(["MODEL_BUDGET_EXCEEDED", "OUTPUT_INVALID", "ANSWER_UNAVAILABLE"])("keeps extraction when generation fails with %s", async code => {
  const f = setup(); await f.records.save(f.question, null, code);
  const projected = f.records.project(f.result, f.processing); expect(projected.failed).toBe(true); expect(projected.result.questions).toEqual(f.result.questions);
  expect(projected.result.warnings[0]).toContain(code === "MODEL_BUDGET_EXCEEDED" ? "任务调用预算不足" : "未能生成答案与解析");
});

it.each(["sourceSha256", "executionFingerprint", "questionHash", "resultHash"])("rejects changed saved %s evidence", async field => {
  const f = setup(); await f.records.save(f.question, { answerPayload: { text: "2" } }, null);
  await f.store.update(f.records.namespace, questionHash(f.question), previous => ({ ...previous!, [field]: "c".repeat(64) }));
  expect(() => f.records.project(f.result, f.processing)).toThrow();
});
