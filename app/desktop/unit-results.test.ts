import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AiStorage } from "./ai-storage.js";
import { SqliteStore } from "./graph-store.js";
import { missingFormulas, UnitResults, validateUnitResult, type UnitIdentity } from "./unit-results.js";

const base = { id: "one", stem: "Is this true?", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, sourceText: "original", analysis: "explanation", needsReview: false, confidence: 1 };
const payload = () => ({ parsed: { questions: [{ ...base }] }, visuals: [], agentReview: { status: "repair_rejected", original: { ...base } } });
const unit: UnitIdentity = { stage: "document_parse", index: 0, round: 0, inputDigest: "b".repeat(64) };
const fixtures: { path: string; store: SqliteStore }[] = [];
function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-unit-result-")), store = new SqliteStore(path), storage = new AiStorage(path), taskId = randomUUID(), source = "a".repeat(64);
  fixtures.push({ path, store }); return { path, store, storage, taskId, source, results: new UnitResults(store, storage, taskId, source, "test-v1") };
}
afterEach(() => { for (const { path, store } of fixtures.splice(0)) { store.stop(); rmSync(path, { recursive: true, force: true }); } });

it("retains optional-metadata recovery, confidence and original repair evidence without mutating input", async () => {
  const { results } = setup(), input = payload(); Object.assign(input.parsed.questions[0], { blankCount: 2, choiceVariant: "single", confidence: 0.2, missingFields: ["blankCount"] });
  const before = structuredClone(input); await results.save(unit, input); const saved = (await results.get(unit))!;
  expect(saved.payload?.parsed.questions?.[0]).toMatchObject({ blankCount: null, choiceVariant: null, needsReview: true, confidence: 0.2, missingFields: [] });
  expect(saved.payload?.agentReview).toEqual(input.agentReview); expect(input).toEqual(before);
});

it("reopens a successful unit from the JavaScript Store and verifies its immutable artifact", async () => {
  const { path, store, storage, taskId, source, results } = setup(), record = await results.save(unit, payload()), expected = await results.get(unit);
  expect(record.status).toBe("succeeded"); store.stop();
  const reopened = new SqliteStore(path); fixtures.push({ path, store: reopened });
  expect(await new UnitResults(reopened, storage, taskId, source, "test-v1").get(unit)).toEqual(expected);
});

it("retains a decimal source score through normalization, validation and durable unit reuse", async () => {
  const { results } = setup(), input = payload(); Object.assign(input.parsed.questions[0], { sourceScore: 0.29 });
  await results.save(unit, input);
  expect((await results.get(unit))?.payload?.parsed.questions?.[0].sourceScore).toBe(0.29);
});

it("retains unknown outcomes until explicit work replaces them and fences late rounds and failures", async () => {
  const { results } = setup(); await results.failure(unit, "PROVIDER_RESULT_UNKNOWN", true);
  expect(await results.get(unit)).toMatchObject({ record: { status: "unknown" }, payload: null });
  const newer = { ...unit, round: 1 }, saved = await results.save(newer, payload());
  expect(await results.failure({ ...unit, round: 2 }, "FAILED")).toEqual(saved);
  expect(await results.save(unit, { parsed: { questions: [{ ...base, stem: "late" }] } })).toEqual(saved);
  expect((await results.get(newer))?.payload?.parsed.questions?.[0].stem).toBe(base.stem);
});

it.each(["source", "input", "execution", "stage", "index", "media", "reference-schema", "missing", "extra"])("refuses a saved unit with changed %s identity", async damage => {
  const { results, store, storage, taskId, source } = setup(), saved = await results.save(unit, payload());
  if (damage === "source" || damage === "execution") {
    const other = new UnitResults(store, storage, taskId, damage === "source" ? "c".repeat(64) : source, damage === "execution" ? "test-v2" : "test-v1");
    await expect(other.get(unit)).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" }); return;
  }
  if (damage === "input") { await expect(results.get({ ...unit, inputDigest: "d".repeat(64) })).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" }); return; }
  const record = structuredClone(saved) as unknown as Record<string, unknown>;
  if (damage === "stage") record.stage = "vision_parse";
  if (damage === "index") record.index = 1;
  if (damage === "media") record.resultRef = { ...saved.resultRef, mediaType: "text/plain" };
  if (damage === "reference-schema") record.resultRef = { ...saved.resultRef, sha256: "invalid" };
  if (damage === "missing") delete record.resultRef;
  if (damage === "extra") record.extra = true;
  await store.put(results.namespace, "document_parse-0", record);
  await expect(results.get(unit)).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" });
});

it("reports checksum damage without overwriting the stored evidence", async () => {
  const { path, results } = setup(), saved = await results.save(unit, payload()), target = join(path, "ai-storage", saved.resultRef!.objectKey), damaged = Buffer.alloc(saved.resultRef!.sizeBytes, 120);
  writeFileSync(target, damaged);
  await expect(results.get(unit)).rejects.toMatchObject({ code: "DOCUMENT_CHECKSUM_MISMATCH" }); expect(readFileSync(target)).toEqual(damaged);
});

it("refuses malformed saved JSON even when its storage checksum is valid", async () => {
  const { results, store, storage, source } = setup(), saved = await results.save(unit, payload()), resultRef = await storage.putArtifact(Buffer.from("{"), source, "unit-result", 0, "application/json");
  await store.put(results.namespace, "document_parse-0", { ...saved, resultRef });
  await expect(results.get(unit)).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" }); expect(storage.artifact(resultRef).toString()).toBe("{");
});

it("keeps fragment continuations while rejecting duplicate IDs, non-composite parents and invalid group indexes", () => {
  expect(validateUnitResult({ questions: [{ ...base, parentId: "previous-page" }] }).questions[0].parentId).toBe("previous-page");
  for (const value of [
    { questions: [base, base] }, { questions: [base, { ...base, id: "child", parentId: "one" }] },
    { questions: [base], groups: [{ title: "Invalid", questionIndexes: [1] }] }, { questions: [base], groups: [{ title: "Invalid", questionIndexes: [-1] }] },
    { questions: null }, { groups: null }, { questions: [null] }, { unexpected: true }, { questions: [{ ...base, passage: null }] }, { questions: [{ ...base, transcript: null }] },
    { questions: [base], groups: [{ title: "   ", questionIndexes: [] }] },
  ]) expect(() => validateUnitResult(value)).toThrow();
  expect(validateUnitResult({})).toEqual({ questions: [], groups: [] });
});

it("keeps the original null-list and whitespace normalization for parsed questions and group titles", () => {
  const result = validateUnitResult({ questions: [{ ...base, answerMode: " true_false ", options: null, items: null, contentBlocks: null, missingFields: null }], groups: [{ title: " Section ", questionIndexes: [0] }] });
  expect(result.questions[0]).toMatchObject({ answerMode: "true_false", options: [], items: [], contentBlocks: [], missingFields: [], needsReview: false }); expect(result.groups[0].title).toBe("Section");
});

it("keeps Python whitespace semantics for extracted fields, answers, and group titles", () => {
  const result = validateUnitResult({ questions: [{ ...base, stem: "\u001c\ufeffQ\u0085", answerMode: "fill_blank", answerPayload: { answers: ["\u001c\ufeffAnswer\u0085"] } }], groups: [{ title: "\u001c\ufeffGroup\u0085", questionIndexes: [0] }] });
  expect(result.questions[0].stem).toBe("\ufeffQ"); expect(result.questions[0].answerPayload).toEqual({ answers: ["\ufeffAnswer"] }); expect(result.groups[0].title).toBe("\ufeffGroup");
});

it("discards invented model audio and preserves missing-media review on listening questions", () => {
  const value = validateUnitResult({ questions: [{ ...base, answerMode: "listening", answerPayload: null, audioRef: { objectKey: "audio/test.mp3", sha256: "a".repeat(64), mediaType: "audio/mpeg", sizeBytes: 10 } }] }).questions[0];
  expect(value).toMatchObject({ audioRef: null, needsReview: true, missingFields: ["media"] });
});

it("canonicalizes complete choice answers to supplied option labels and leaves partial answers reviewable", () => {
  const question = { ...base, answerMode: "choice", choiceVariant: "multiple", options: [{ label: "A", content: "First" }, { label: "b", content: "Second" }] };
  expect(validateUnitResult({ questions: [{ ...question, answerPayload: { correct: ["a", "B"] } }] }).questions[0].answerPayload).toEqual({ correct: ["A", "b"] });
  const partial = validateUnitResult({ questions: [{ ...question, answerPayload: { correct: ["a", null] } }] }).questions[0];
  expect(partial.answerPayload).toEqual({ correct: ["a", null] }); expect(partial.missingFields).toContain("answerPayload");
  expect(validateUnitResult({ questions: [{ ...question, options: [{ content: "Unknown label" }], answerPayload: { correct: ["a"] } }] }).questions[0].answerPayload).toEqual({ correct: ["a"] });
});

it("marks missing literal math and source-answer conflicts for review while retaining group math and listening exceptions", () => {
  const missing = validateUnitResult({ questions: [{ ...base, sourceText: "$x^2$" }] }).questions[0];
  expect(missing).toMatchObject({ needsReview: true, missingFields: ["material"] });
  const kept = validateUnitResult({ questions: [{ ...base, sourceText: "$x^2$" }], groups: [{ title: "Use $x^2$", questionIndexes: [0] }] }).questions[0];
  expect(kept).toMatchObject({ needsReview: false, missingFields: [] });
  const conflict = validateUnitResult({ questions: [{ ...base, sourceText: "Is this true?\n答案：错误" }] }).questions[0]; expect(conflict.needsReview).toBe(true);
  const listening = validateUnitResult({ questions: [{ ...base, answerMode: "listening", answerPayload: null, sourceText: "$x^2$" }] }).questions[0]; expect(listening.missingFields).not.toContain("material");
});

it.each([
  ["$x^2$ and \\(a+b\\)", "x^2", ["a+b"]], ["$$x \\geq 2$$", "x \\ge 2", []],
  ["$a &lt; b$", "a < b", []], ["$a\\quad +\\,b$", "a+b", []], ["\\$money and $x$", "x", []],
  ["$a\u0085b$", "ab", []],
])("compares literal formula evidence conservatively: %s", (source, rendered, expected) => { expect(missingFormulas(source as string, rendered as string)).toEqual(expected); });

it("scans an unclosed formula without repeated backtracking", () => { expect(missingFormulas("$" + "unclosed ".repeat(10000), "")).toEqual([]); });

it("validates visuals before publishing a usable unit", async () => {
  const { results, store } = setup();
  for (const visuals of [[null], [{ description: "invalid", bbox: [0, 0, 2, 1] }]]) await expect(results.save(unit, { ...payload(), visuals })).rejects.toThrow();
  expect(await store.get(results.namespace, "document_parse-0")).toBeNull();
});

it("persists merge rejection while retaining original bytes and requires a newer explicit round", async () => {
  const { results, storage } = setup(), saved = await results.save(unit, payload()), original = storage.artifact(saved.resultRef!);
  await results.reject(saved); await results.reject(saved);
  const rejected = (await results.get(unit))!.record; expect(rejected).toEqual({ ...saved, status: "rejected", code: "OUTPUT_INVALID" }); expect(storage.artifact(saved.resultRef!)).toEqual(original);
  expect(await results.save(unit, payload())).toEqual(rejected); expect(await results.failure(unit, "FAILED")).toEqual(rejected);
  const next = { ...unit, round: 1 }; expect(await results.failure(next, "OUTPUT_STALLED")).toMatchObject({ round: 1, status: "failed" });
  await expect(results.reject(saved)).rejects.toMatchObject({ code: "UNIT_RESULT_INVALID" });
  expect(await results.save({ ...unit, round: 2 }, payload())).toMatchObject({ status: "succeeded", round: 2 }); expect(storage.artifact(saved.resultRef!)).toEqual(original);
});
