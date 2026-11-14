import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import fixture from "../fixtures/tencent/answer-generation.json" with { type: "json" };
import type { DocumentParseResult, DocumentProcessing, GeneratedAnswer, Question } from "../src/contracts.generated.js";
import { AnswerResults, completedAnswer, pendingAnswers, questionHash } from "./answer-generation.js";
import { validateContract } from "./contracts.js";
import type { DocumentRecord } from "./document-tasks.js";
import { SqliteStore } from "./graph-store.js";
import { validateParsedQuestion, validateParsedTree } from "./question-contract.js";

for (const row of fixture.cases) it(`retains Python generation rules: ${row.name}`, () => {
  const before = structuredClone(row), question = row.question as unknown as Question;
  const apply = () => { validateContract("GeneratedAnswer", row.generated); const candidate = completedAnswer(question, row.generated as GeneratedAnswer); validateParsedTree([candidate]); return candidate; };
  if (row.expected) expect(apply()).toEqual(row.expected); else expect(apply).toThrow();
  expect(row).toEqual(before);
});

const directories: string[] = [], stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.stop(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-answer-generation-")); directories.push(path); const store = new SqliteStore(path); stores.push(store);
  const task = { id: randomUUID(), input: { document: { sha256: "a".repeat(64) } }, executionFingerprint: "b".repeat(64) } as DocumentRecord;
  const question = validateParsedQuestion(fixture.cases[0].question), result: DocumentParseResult = { schemaVersion: 3, questions: [question], groups: [], visualElements: [], warnings: [], missingFields: [], confidenceScore: 100 };
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
