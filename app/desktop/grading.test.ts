import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GradeResult } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { PracticeStore } from "./store.js";
import { previewPaper } from "./paper.js";
import { GRADING_PROMPT_VERSION, scaleScore, sourceMaximum, verifyGradeEvidence } from "./grading-result.js";
import { type GradePayload, type GradeTarget, unknownGrade } from "./grading.js";
import { ModelClient } from "./model.js";
import { subjectiveGrade } from "./subjective-grade.js";
import { Backups } from "./backup.js";

const stores: PracticeStore[] = [], databases: AiDatabase[] = [], paths: string[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); databases.splice(0).forEach(db => db.close()); paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const config = (): AiSnapshot => ({ revision: "test", preferences: { model: { provider: "openai", baseUrl: "https://provider.example/v1", modelId: "test", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 1, retryBaseSeconds: 1 }, maxCalls: 10, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_PRIVATE_KEY", tencentSecretId: "", tencentSecretKey: "" } });
const target: GradeTarget = { kind: "electron", endpoint: "https://provider.example/v1/responses", modelId: "test", promptVersion: GRADING_PROMPT_VERSION };
const scored = (maximum = 500, score = 300): GradeResult => ({ scoreCents: score, maxCents: maximum, reason: "Partial reference credit", evidence: [], reviewReasons: [], criteria: [{ criterion: "Reference credit", scoreCents: score, maxCents: maximum, referenceQuote: "Reference evidence", answerQuote: score ? "Student answer" : "", reason: "Compared the supplied text" }] });
function setup(kind = "practice", submit = true, changes = {}, answer = "Student answer") {
  const directory = mkdtempSync(join(tmpdir(), "practiq-grade-")); paths.push(directory);
  const store = new PracticeStore(directory); stores.push(store); const bank = store.saveBank(null, "评分", "");
  store.request({ type: "save_question_tree", bank_id: bank, root_id: null, questions: [{ id: "one", stem: "Explain the supplied evidence", questionTypeId: "简答", answerMode: "short_answer", answerPayload: { text: "Reference evidence" }, sourceText: "Original source", sourceScore: 5, scoringRubric: "Reference evidence", needsReview: false, ...changes }] });
  const preview = previewPaper(store.db, store.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ["one"], random: false, total_cents: kind === "practice" ? 0 : 1000 });
  const session = store.sessions.createPaper({ question_ids: preview.questionIds, kind, minutes: null, scores: preview.scores, total_cents: kind === "practice" ? 0 : 1000, digest: preview.digest });
  store.sessions.writeAttempt(session.id, 0, { text: answer }, 0, submit && kind === "practice", false);
  if (submit && kind !== "practice") store.sessions.submit(session.id, true);
  return { store, bank, id: session.id, prepare: (retry = false, locale = "zh-CN") => store.grading.prepare(session.id, 0, retry, locale, target) };
}
function provider(store: PracticeStore, value: unknown) {
  const database = new AiDatabase(store.directory); databases.push(database);
  const http = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "GradeResult", arguments: JSON.stringify(value) }], usage: { input_tokens: 10, output_tokens: 5 } })));
  return { database, http, model: new ModelClient(database, http) };
}

it("freezes assessment input and locale and saves uncertainty before any network work", () => {
  const { store, bank, id, prepare } = setup(), first = prepare(), payload = JSON.parse(first.payload) as GradePayload;
  expect(first.previous).toBeUndefined(); expect(payload).toMatchObject({ answer: "Student answer", feedbackLocale: "zh-CN", maxCents: 500 });
  expect(JSON.parse(String(store.db.prepare("SELECT response FROM grade_requests").get()!.response))).toEqual(unknownGrade());
  expect(store.sessions.session(id).attempts[0].grading?.lastRequest?.status).toBe("unknown");
  const original = store.questionDetail("one").question;
  store.request({ type: "save_question_tree", bank_id: bank, root_id: "one", questions: [{ ...original, stem: "Edited question", answerPayload: { text: "Changed reference" } }] });
  expect(prepare(false, "en")).toEqual({ ...first, previous: unknownGrade() });
  const retry = prepare(true, "en"); expect(retry.requestId).not.toBe(first.requestId); expect(JSON.parse(retry.payload).feedbackLocale).toBe("en");
  expect(retry.payload).not.toContain("Changed reference"); expect(first.payload).not.toContain("TEST_PRIVATE_KEY");
});

it.each(["draft", "no-reference", "conflicting-reference", "self", "manual", "skipped"])("rejects %s grading without creating a paid-work receipt", kind => {
  const { store, id, prepare } = setup(kind === "manual" ? "self_test" : "practice", kind !== "draft", kind === "no-reference" ? { scoringRubric: null, answerPayload: null } : kind === "conflicting-reference" ? { sourceText: "Explain the supplied evidence\nAnswer: A different reference" } : {});
  if (kind === "self") store.sessions.selfAssess(id, 0, true);
  if (kind === "manual") store.sessions.manualScore(id, 0, 500, "Manual assessment");
  if (kind === "skipped") store.db.prepare("UPDATE attempts SET skipped=1").run();
  expect(prepare).toThrow(); expect(store.db.prepare("SELECT COUNT(*) AS count FROM grade_requests").get()!.count).toBe(0);
});

it("requires explicit regrading for a changed target or changed receipt and keeps legacy receipts", () => {
  const { store, id, prepare } = setup(), first = prepare();
  expect(() => store.grading.prepare(id, 0, false, "en", { ...target, modelId: "another" })).toThrow("target changed");
  const saved = JSON.parse(String(store.db.prepare("SELECT input FROM grade_requests").get()!.input)); saved.inputDigest = "0".repeat(64);
  store.db.prepare("UPDATE grade_requests SET input=?").run(JSON.stringify(saved)); expect(prepare).toThrow("differs from the frozen answer");
  const retry = prepare(true); expect(retry.requestId).not.toBe(first.requestId); expect(store.db.prepare("SELECT COUNT(*) AS count FROM grade_requests").get()!.count).toBe(2);
});

it("retains unknown grading on restart instead of starting it again", () => {
  const { store, id, prepare } = setup(), first = prepare();
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new PracticeStore(store.directory); stores.push(reopened);
  const replay = reopened.grading.prepare(id, 0, false, "en", target);
  expect(replay).toMatchObject({ requestId: first.requestId, payload: first.payload, previous: unknownGrade() }); expect(replay.generation).not.toBe(first.generation);
});

it("scales grounded source criteria once and preserves the original criteria and known usage", async () => {
  const { store, id, prepare } = setup("self_test"), prepared = prepare(), { database, http, model } = provider(store, scored());
  const response = await subjectiveGrade(database, model, prepared, config());
  expect(response).toMatchObject({ status: "graded", result: { scoreCents: 600, maxCents: 1000, assessmentMaxCents: 500, criteria: [{ scoreCents: 300, maxCents: 500 }] }, usage: [{ inputTokens: 10, outputTokens: 5 }], calls: [{ status: "succeeded", usageStatus: "known" }] });
  expect(http).toHaveBeenCalledTimes(1); const request = JSON.parse(String(http.mock.calls[0][1]?.body)); expect(request.input[0].content[0].text).toContain("untrusted assessment DATA"); expect(request.input[1].content[0].text).not.toContain("Original source");
  const result = store.grading.record(id, 0, prepared, response);
  expect(result.attempts[0]).toMatchObject({ earnedCents: 600, maxCents: 1000, gradeKind: "ai", result: false });
  expect(await subjectiveGrade(database, model, prepared, config())).toEqual(response); expect(http).toHaveBeenCalledTimes(1);
  expect(prepare().previous).toEqual(response);
});

it.each(["reference", "answer", "duplicate", "sum", "maximum", "model-override", "empty-abstention"])("retains usage but does not apply %s model grading", async kind => {
  const { store, id, prepare } = setup(), result = scored();
  if (kind === "reference") result.criteria![0].referenceQuote = "Invented external knowledge";
  if (kind === "answer") result.criteria![0].answerQuote = "Invented student wording";
  if (kind === "duplicate") { result.criteria!.push({ ...result.criteria![0] }); result.maxCents = 1000; result.scoreCents = 600; }
  if (kind === "sum") result.scoreCents = 400;
  if (kind === "maximum") result.maxCents = 1000;
  if (kind === "model-override") result.assessmentMaxCents = 500;
  if (kind === "empty-abstention") { result.scoreCents = null; result.criteria = []; }
  const prepared = prepare(), { database, model } = provider(store, result), response = await subjectiveGrade(database, model, prepared, config());
  expect(response).toMatchObject({ status: "ungraded", usage: [{ inputTokens: 10, outputTokens: 5 }] });
  expect(store.grading.record(id, 0, prepared, response).attempts[0]).toMatchObject({ earnedCents: null, result: null, gradeKind: "ungraded" });
});

it.each(["wrong", "abstain"])("distinguishes a %s answer from missing assessment evidence", async kind => {
  const { store, id, prepare } = setup("practice", true, { scoringRubric: null }), result = scored(500, 0);
  if (kind === "abstain") { result.scoreCents = null; result.criteria = []; result.reviewReasons = ["Reference evidence is ambiguous"]; }
  const prepared = prepare(), { database, model } = provider(store, result), response = await subjectiveGrade(database, model, prepared, config());
  expect(response.status).toBe(kind === "wrong" ? "graded" : "ungraded"); expect(response.result?.reviewReasons).toContain("未提供详细评分细则");
  expect(store.grading.record(id, 0, prepared, response).attempts[0]).toMatchObject(kind === "wrong" ? { earnedCents: 0, result: false, gradeKind: "ai" } : { earnedCents: null, result: null, gradeKind: "ungraded" });
});

it("preserves bounded decimal-string model scores from the original grading contract", async () => {
  const { store, prepare } = setup(), { database, model } = provider(store, { ...scored(), scoreCents: "300" });
  expect(await subjectiveGrade(database, model, prepare(), config())).toMatchObject({ status: "graded", result: { scoreCents: 300 } });
});

it("preserves manual/self decisions and applies only the newest grading request", () => {
  const { store, id, prepare } = setup("self_test"), first = prepare(), second = prepare(true), response = { status: "graded", result: { ...scored(1000, 600), assessmentMaxCents: 500, criteria: scored().criteria } };
  expect(store.grading.record(id, 0, first, response).attempts[0].earnedCents).toBeNull();
  store.sessions.manualScore(id, 0, 800, "Accepted review");
  expect(store.grading.record(id, 0, second, response).attempts[0]).toMatchObject({ gradeKind: "manual", earnedCents: 800 });
  const practice = setup(), pending = practice.prepare(); practice.store.sessions.selfAssess(practice.id, 0, true);
  expect(practice.store.grading.record(practice.id, 0, pending, { status: "graded", result: { ...scored(), assessmentMaxCents: 500 } }).attempts[0]).toMatchObject({ gradeKind: "self", earnedCents: null, maxCents: null, result: true });
});

it("keeps an earlier usable AI score when an explicit retry has an unknown result", () => {
  const { store, id, prepare } = setup(), first = prepare(); store.grading.record(id, 0, first, { status: "graded", result: { ...scored(), assessmentMaxCents: 500 } });
  const retry = prepare(true), session = store.grading.record(id, 0, retry, unknownGrade());
  expect(session.attempts[0]).toMatchObject({ gradeKind: "ai", earnedCents: 300, grading: { ai: { status: "graded" }, lastRequest: { status: "unknown" } } });
});

it("fences late results after restoring a backup containing the same session", async () => {
  const { store, id, prepare } = setup(), prepared = prepare(), outside = mkdtempSync(join(tmpdir(), "practiq-grade-backup-")); paths.push(outside); const backup = join(outside, "backup.zip");
  await new Backups(store).export(backup); await new Backups(store).restore(backup, false);
  expect(() => store.grading.record(id, 0, prepared, { status: "graded", result: { ...scored(), assessmentMaxCents: 500 } })).toThrow("database was reopened");
  expect(store.sessions.session(id).attempts[0].earnedCents).toBeNull(); expect(prepare().previous?.status).toBe("unknown");
});

it("retains a long frozen student answer within the existing grading limit", async () => {
  const { store, prepare } = setup("practice", true, {}, "x".repeat(100000)), { database, model, http } = provider(store, scored(500, 0));
  expect((await subjectiveGrade(database, model, prepare(), config())).status).toBe("graded"); expect(http).toHaveBeenCalledTimes(1);
});

it("uses exact integer score scaling and ties-to-even source maxima", () => {
  expect(scaleScore(99999999, 99999998, 100000000)).toBe(99999997);
  expect(sourceMaximum({ sourceScore: 1.125 }, 10000)).toBe(112); expect(sourceMaximum({ sourceScore: 1.135 }, 10000)).toBe(114);
  expect(() => verifyGradeEvidence({ ...scored(), criteria: [] }, { scoringRubric: "Reference evidence", sourceScore: 5 }, "Student answer")).toThrow();
});

const evidenceCases = JSON.parse(readFileSync(new URL("../fixtures/grading-evidence-v2.json", import.meta.url), "utf8")).cases as { name: string; valid: boolean; input: { question: unknown; answer: string }; result: GradeResult }[];
it.each(evidenceCases)("matches the original grading evidence corpus: $name", entry => {
  const verify = () => verifyGradeEvidence(entry.result, entry.input.question, entry.input.answer);
  if (entry.valid) expect(verify).not.toThrow(); else expect(verify).toThrow();
});
