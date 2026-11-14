import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentCorrectionSave, DocumentParseResult, DesktopDocumentReply, DesktopDocumentRequest, Question } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot, AiSettingsView } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { correctedResult, validateCorrection } from "./document-corrections.js";
import { ModelClient } from "./model.js";
import { modelDefaults, parsedQuestionDefaults } from "./model-defaults.js";
import { validateParsedQuestion } from "./question-contract.js";
import { canonical } from "./questions.js";
import { TencentClient } from "./tencent.js";
import { PracticeStore } from "./store.js";
import { DocumentTasks } from "./document-tasks.js";
import { SqliteStore } from "./graph-store.js";
import { DocumentRevisions } from "./document-corrections.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
const question = (value: Record<string, unknown> = {}) => parsedQuestionDefaults(validateParsedQuestion({ id: "q0", stem: "Original question", answerMode: "short_answer", questionTypeId: "Short answer", answerPayload: { text: "Original answer" }, sourceText: "Immutable supplied evidence", confidence: .8, needsReview: false, ...value })) as unknown as Question;
const document = (questions = [question()]): DocumentParseResult => modelDefaults("DocumentParseResult", { schemaVersion: 3, questions, groups: [], visualElements: [], warnings: [], confidenceScore: 80, missingFields: [] }) as unknown as DocumentParseResult;

async function setup(result = document()) {
  const path = mkdtempSync(join(tmpdir(), "practiq-corrections-")), db = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls: 16, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const view: AiSettingsView = { revision: config.revision, preferences: config.preferences, configured: { modelApiKey: false, tencentSecretId: false, tencentSecretKey: false } }, http = vi.fn(async () => { throw Error("Corrections must never call providers"); });
  const api = new DocumentApi(path, db, checkpoints, new ModelClient(db, http), new TencentClient(db, http));
  for (const stage of ["prepare", "recognize", "structure"] as const) vi.spyOn(api.runtime.stages, stage).mockResolvedValue({ artifacts: [] });
  vi.spyOn(api.runtime.stages, "assemble").mockImplementation(async context => {
    const resultRef = await api.storage.putArtifact(Buffer.from(canonical(result)), context.task.input.document.sha256, "result", 0, "application/json"); return { result: resultRef, artifacts: [resultRef], status: "SUCCEEDED" };
  });
  const bytes = Buffer.from("Immutable source bytes"), sha256 = hash(bytes), source = { fileName: "corrections.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await api.storage.putSource(source, bytes);
  const receipt = await api.request({ type: "create", revision: config.revision, value: { requestId: randomUUID(), document: source } }, config) as Extract<DesktopDocumentReply, { type: "create" }>;
  const id = receipt.value.threadId; await api.runtime.wait(id); expect(api.tasks.record(id).state).toBe("COMPLETED");
  const original = api.tasks.result(api.tasks.record(id))!, checkpointId = api.tasks.record(id).checkpointId!;
  const request = async <T extends DesktopDocumentRequest["type"]>(command: Extract<DesktopDocumentRequest, { type: T }>) => await api.request(command, view) as Extract<DesktopDocumentReply, { type: T }>;
  const save = (value: Partial<DocumentCorrectionSave> = {}) => ({ requestId: randomUUID(), checkpointId, expectedRevision: null, questionIndex: 0, question: { ...original.questions[0], stem: "Human correction" }, ...value });
  const f = { path, db, checkpoints, config, view, api, http, id, checkpointId, original, request, save }; fixtures.push(f); return f;
}

it("persists revisions independently, replays lost replies and imports exact historical snapshots", async () => {
  const f = await setup(), revision = f.view.revision, before = f.api.tasks.record(f.id), input = f.save();
  expect((await f.request({ type: "corrections", revision, threadId: f.id })).value).toEqual({ checkpointId: f.checkpointId, edits: [] });
  const first = await f.request({ type: "save_correction", revision, threadId: f.id, value: input });
  expect(first.value.edits).toHaveLength(1); expect(first.value.edits![0].question).toMatchObject({ stem: "Human correction", needsReview: true, sourceText: f.original.questions[0].sourceText });
  const stored = f.api.store.read(["document_tasks", f.id, "corrections"], f.checkpointId);
  expect(await f.request({ type: "save_correction", revision, threadId: f.id, value: { ...input, requestId: input.requestId.toUpperCase() } })).toEqual(first);
  expect(f.api.store.read(["document_tasks", f.id, "corrections"], f.checkpointId)).toEqual(stored);
  const secondInput = f.save({ expectedRevision: input.requestId, question: { ...f.original.questions[0], stem: "Second revision" } });
  const second = await f.request({ type: "save_correction", revision, threadId: f.id, value: secondInput }); expect(second.value.edits).toHaveLength(2);
  expect((await f.request({ type: "save_correction", revision, threadId: f.id, value: input })).value).toEqual(second.value);
  const original = (await f.request({ type: "bank", revision, value: { threadId: f.id, checkpointId: f.checkpointId, scope: "full" } })).value;
  const practice = new PracticeStore(f.path);
  try {
    for (const [revisionId, stem] of [[input.requestId, "Human correction"], [secondInput.requestId, "Second revision"]]) {
      const selection = { threadId: f.id, checkpointId: f.checkpointId, scope: "full" as const, revisionId }, bank = (await f.request({ type: "bank", revision, value: selection })).value;
      expect(bank.result.questions[0].stem).toBe(stem); expect(bank.result.questions[0].sourceText).toBe(f.original.questions[0].sourceText); expect(bank.result.warnings!.at(-1)).toContain("Human-corrected revision");
      expect(await practice.packages.importDocument(bank, [], selection)).toMatchObject({ count: 1 });
    }
    expect(practice.banks()).toHaveLength(2);
  } finally { practice.close(); }
  expect(original.result).toEqual(f.original); expect((await f.request({ type: "detail", revision, threadId: f.id })).value.result).toEqual(f.original);
  expect((await f.request({ type: "preview", revision, threadId: f.id, includeResult: false })).value.corrections).toEqual(second.value);
  expect(f.api.tasks.record(f.id)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it("allows only one concurrent optimistic save and preserves the winning receipt", async () => {
  const f = await setup(), values = [f.save(), f.save({ question: { ...f.original.questions[0], stem: "Other window" } })];
  const results = await Promise.allSettled(values.map(value => f.request({ type: "save_correction", revision: f.view.revision, threadId: f.id, value })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CORRECTION_CONFLICT" } });
  expect(f.api.revisions.read(f.api.tasks.record(f.id)).edits).toHaveLength(1); expect(f.http).not.toHaveBeenCalled();
});

it.each(["id", "sourceText", "confidence", "parentId", "optionSourceId", "sourceScore", "audioRef", "passage", "transcript"])("protects %s from manual corrections", async field => {
  const f = await setup(), values: Record<string, unknown> = { id: "other", sourceText: "Fabricated", confidence: .99, parentId: "other", optionSourceId: "other", sourceScore: 5, audioRef: { objectKey: "sound.wav", sha256: "a".repeat(64), sizeBytes: 3, mediaType: "audio/wav" }, passage: [{ partType: "text", textValue: "new material" }], transcript: [{ partType: "text", textValue: "invented speech" }] };
  const input = f.save({ question: { ...f.original.questions[0], [field]: values[field] } });
  await expect(f.request({ type: "save_correction", revision: f.view.revision, threadId: f.id, value: input })).rejects.toMatchObject({ code: ["audioRef", "passage", "transcript"].includes(field) ? "CORRECTION_INVALID" : "CORRECTION_PROTECTED_FIELD" });
  expect(f.api.revisions.read(f.api.tasks.record(f.id)).edits).toEqual([]); expect(f.http).not.toHaveBeenCalled();
});

it("checks unknown revisions, request collisions, checkpoint identity and completed state before saving", async () => {
  const f = await setup(), input = f.save(), save = (value: DocumentCorrectionSave) => f.request({ type: "save_correction", revision: f.view.revision, threadId: f.id, value }); await save(input);
  await expect(save({ ...input, question: { ...input.question, stem: "Changed retry" } })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  await expect(save(f.save({ checkpointId: "other" }))).rejects.toMatchObject({ code: "STALE_CHECKPOINT" });
  await expect(save(f.save({ questionIndex: 100 }))).rejects.toMatchObject({ code: "CORRECTION_INVALID" });
  await expect(f.request({ type: "bank", revision: f.view.revision, value: { threadId: f.id, checkpointId: f.checkpointId, scope: "full", revisionId: randomUUID() } })).rejects.toMatchObject({ code: "CORRECTION_NOT_FOUND" });
  const task = f.api.tasks.record(f.id); f.api.tasks.update(f.id, task.runId, record => { record.state = "WAITING_REVIEW"; });
  await expect(save(input)).rejects.toMatchObject({ code: "CORRECTION_NOT_READY" });
  f.api.tasks.update(f.id, task.runId, record => { record.state = "COMPLETED"; record.createdAt -= 181 * 24 * 3600 * 1000; });
  await expect(f.request({ type: "corrections", revision: f.view.revision, threadId: f.id })).rejects.toMatchObject({ code: "TASK_EXPIRED" }); await expect(save(input)).rejects.toMatchObject({ code: "TASK_EXPIRED" });
});

it("does not record unavailable answer bindings or oversized and invalid Unicode requests", async () => {
  const f = await setup(), save = (value: DocumentCorrectionSave) => f.request({ type: "save_correction", revision: f.view.revision, threadId: f.id, value });
  await expect(save(f.save({ answerSource: { taskId: randomUUID(), checkpointId: "saved", questionIndex: 0 } }))).rejects.toMatchObject({ code: "ANSWER_SOURCE_UNAVAILABLE" });
  await expect(save(f.save({ question: { ...f.original.questions[0], stem: "\ud800" } }))).rejects.toMatchObject({ code: "LOCAL_SCHEMA_INVALID" });
  expect(() => f.api.revisions.save(f.id, f.save({ question: { ...f.original.questions[0], answerPayload: { text: "x".repeat(1024 * 1024) } } }))).toThrow(expect.objectContaining({ code: "REQUEST_TOO_LARGE" }));
  expect(f.api.revisions.read(f.api.tasks.record(f.id)).edits).toHaveLength(0); expect(f.http).not.toHaveBeenCalled();
});

it("rejects protected content-block structure but permits human text within existing blocks", () => {
  const original = document([question({ contentBlocks: [{ partType: "text", role: "material", textValue: "Original", jsonValue: { image: "opaque resource data" } }] })]);
  const edited = structuredClone(original.questions[0]); edited.contentBlocks[0].textValue = "Human correction";
  expect(validateCorrection(original.questions[0], edited, original, 0).contentBlocks[0].textValue).toBe("Human correction");
  for (const change of [() => edited.contentBlocks.push(edited.contentBlocks[0]), () => { edited.contentBlocks[0].role = "answer"; }, () => { edited.contentBlocks[0].jsonValue = { image: "changed" }; }]) {
    const candidate = structuredClone(edited); change(); expect(() => validateCorrection(original.questions[0], edited, original, 0)).toThrow(expect.objectContaining({ code: "CORRECTION_PROTECTED_FIELD" })); Object.assign(edited, candidate);
  }
  expect(original.questions[0].contentBlocks[0].textValue).toBe("Original");
});

it("stops replay at the named revision and keeps nested snapshots independent", () => {
  const original = document(), first = randomUUID(), second = randomUUID(), corrections = { checkpointId: "checkpoint", edits: [{ requestId: first, questionIndex: 0, question: question({ stem: "First" }), savedAt: new Date().toISOString() }, { requestId: second, questionIndex: 0, question: question({ stem: "Second" }), savedAt: new Date().toISOString() }] };
  const projected = correctedResult(original, corrections, first); expect(projected.questions[0].stem).toBe("First"); projected.questions[0].answerPayload!.text = "Changed copy";
  expect(corrections.edits[0].question.answerPayload!.text).toBe("Original answer"); expect(original.questions[0].stem).toBe("Original question");
  expect(() => correctedResult(original, corrections, randomUUID())).toThrow(expect.objectContaining({ code: "CORRECTION_NOT_FOUND" }));
  expect(() => correctedResult(original, { ...corrections, edits: [{ ...corrections.edits[0], questionIndex: 2 }] })).toThrow(expect.objectContaining({ code: "CORRECTION_CONFLICT" }));
});

it("normalizes shared-option replay against its historical tree after later parent edits", async () => {
  const root = question({ id: "bank", stem: "Word bank", answerMode: "word_bank", answerPayload: null, options: [{ label: "A", content: "First" }, { label: "B", content: "Second" }], passage: [{ partType: "text", textValue: "Choose " }, { partType: "blank", questionId: "child" }] });
  const child = question({ id: "child", parentId: "bank", optionSourceId: "bank", stem: "Choose", answerMode: "choice", choiceVariant: "single", answerPayload: { correct: ["A"] } });
  const f = await setup(document([root, child])), input = f.save({ questionIndex: 1, question: { ...f.original.questions[1], answerPayload: { correct: ["b"] } } }), save = (value: DocumentCorrectionSave) => f.api.revisions.save(f.id, value);
  const first = save(input); expect(first.edits![0].question.answerPayload!.correct).toEqual(["B"]);
  const second = save(f.save({ expectedRevision: input.requestId, question: { ...f.original.questions[0], options: [{ label: "a", content: "First" }, { label: "b", content: "Second" }] } }));
  expect(save(input)).toEqual(second);
  const bank = (await f.request({ type: "bank", revision: f.view.revision, value: { threadId: f.id, checkpointId: f.checkpointId, scope: "full", revisionId: second.edits!.at(-1)!.requestId } })).value;
  expect(bank.result.questions[1].answerPayload!.correct).toEqual(["b"]); expect(f.api.tasks.result(f.api.tasks.record(f.id))).toEqual(f.original);
});

it.each(["entries", "bytes"])("bounds correction history by %s and retains its previous version on rejection", async bound => {
  const f = await setup(), corrected = question({ stem: bound === "bytes" ? "x".repeat(120000) : "Human corrected", analysis: bound === "bytes" ? "a".repeat(50000) : null, needsReview: true }), saved = { checkpointId: f.checkpointId, edits: [] as { requestId: string; questionIndex: number; question: Question; savedAt: string; answerEvidence: null }[] };
  const edit = () => ({ requestId: randomUUID(), questionIndex: 0, question: corrected, savedAt: new Date().toISOString(), answerEvidence: null });
  if (bound === "entries") for (let index = 0; index < 500; index++) saved.edits.push(edit());
  else while (Buffer.byteLength(canonical({ ...saved, edits: [...saved.edits, edit()] })) < 8 * 1024 * 1024) saved.edits.push(edit());
  await f.api.store.put(["document_tasks", f.id, "corrections"], f.checkpointId, saved);
  const before = f.api.store.read(["document_tasks", f.id, "corrections"], f.checkpointId);
  expect(() => f.api.revisions.save(f.id, f.save({ expectedRevision: saved.edits.at(-1)!.requestId, question: corrected }))).toThrow(expect.objectContaining({ code: "CORRECTION_HISTORY_LIMIT" }));
  expect(f.api.store.read(["document_tasks", f.id, "corrections"], f.checkpointId)).toEqual(before); expect(f.http).not.toHaveBeenCalled();
});

it.each(["stem", "answerPayload", "analysis", "scoringRubric"])("permits an explicit human edit of %s without changing source evidence", field => {
  const original = document(), before = canonical(original), values = { stem: "Human correction", answerPayload: { text: "Human answer" }, analysis: "Human explanation", scoringRubric: "Human rubric" };
  const edited = { ...original.questions[0], [field]: values[field as keyof typeof values] }, result = validateCorrection(original.questions[0], edited, original, 0);
  expect(result[field as keyof Question]).toEqual(values[field as keyof typeof values]); expect(canonical(original)).toBe(before);
});

async function savedAnswers(f: Awaited<ReturnType<typeof setup>>, questions = [question({ stem: "1. Answer", answerPayload: { text: "Supplied answer" }, sourceText: "1. Supplied answer", analysis: "Supplied explanation" })], role: "answers" | "questions" = "answers") {
  const bytes = Buffer.from(`Saved answer fixture ${randomUUID()}`), sha256 = hash(bytes), source = { fileName: "答案卷.txt", sourceType: "text" as const, mediaType: "text/plain", sizeBytes: bytes.length, sha256, objectKey: sourceKey("text", sha256) }; await f.api.storage.putSource(source, bytes);
  vi.mocked(f.api.runtime.stages.assemble).mockImplementationOnce(async () => { const result = await f.api.storage.putArtifact(Buffer.from(canonical(document(questions))), sha256, "result", 0, "application/json"); return { result, artifacts: [result], status: "SUCCEEDED" }; });
  const receipt = await f.api.request({ type: "create", revision: f.config.revision, value: { requestId: randomUUID(), document: source, documentRole: role } }, f.config) as Extract<DesktopDocumentReply, { type: "create" }>;
  await f.api.runtime.wait(receipt.value.threadId); const task = f.api.tasks.record(receipt.value.threadId); expect(task.state).toBe("COMPLETED");
  return { id: task.id, checkpointId: task.checkpointId!, task, source };
}

it("previews, confirms and snapshots supplied-answer evidence without provider calls or altering original tasks", async () => {
  const f = await setup(document([question({ stem: "1. Target", answerPayload: null })])), answers = await savedAnswers(f), revision = f.view.revision, targetBefore = f.api.tasks.record(f.id);
  const selected = { taskId: answers.id.toUpperCase(), checkpointId: answers.checkpointId, questionIndex: 0 };
  const matches = await f.request({ type: "answer_matches", revision, threadId: f.id, checkpointId: f.checkpointId, answerTaskId: answers.id }); expect(matches.value.matches).toEqual([{ questionIndex: 0, candidates: [0], status: "unique" }]);
  const proposal = (await f.request({ type: "answer_proposal", revision, threadId: f.id, checkpointId: f.checkpointId, questionIndex: 0, answerSource: selected })).value;
  expect(proposal.question).toMatchObject({ answerPayload: { text: "Supplied answer" }, needsReview: true, sourceText: f.original.questions[0].sourceText, analysis: "Supplied explanation" }); expect(proposal.corrections.edits).toEqual([]);
  const request = f.save({ question: proposal.question, answerSource: selected }), saved = (await f.request({ type: "save_correction", revision, threadId: f.id, value: request })).value;
  expect(saved.edits![0].answerEvidence).toEqual({ selection: { ...selected, taskId: answers.id, replaceExisting: false }, sourceSha256: answers.source.sha256, fileName: answers.source.fileName, sourceText: "1. Supplied answer" });
  expect(f.api.revisions.save(f.id, request)).toEqual(saved);
  const bank = async (revisionId: string, questionIndexes?: number[]) => (await f.request({ type: "bank", revision, value: { threadId: f.id, checkpointId: f.checkpointId, scope: "full", revisionId, ...(questionIndexes ? { questionIndexes } : {}) } })).value;
  expect((await bank(request.requestId)).result.warnings!.some(warning => warning.includes(answers.source.sha256) && warning.includes("1. Supplied answer"))).toBe(true);
  const manual = f.save({ expectedRevision: request.requestId, question: { ...proposal.question, stem: "Manual wording" } }); f.api.revisions.save(f.id, manual);
  expect((await bank(manual.requestId, [0])).result.warnings!.some(warning => warning.includes(answers.source.sha256))).toBe(true);
  const changed = f.save({ expectedRevision: manual.requestId, question: { ...manual.question, answerPayload: { text: "Manual replacement" } } }); f.api.revisions.save(f.id, changed);
  expect((await bank(changed.requestId)).result.warnings!.some(warning => warning.includes(answers.source.sha256))).toBe(false);
  expect((await bank(request.requestId)).result.questions[0].answerPayload).toEqual({ text: "Supplied answer" });
  expect(f.api.tasks.record(f.id)).toEqual(targetBefore); expect(f.api.tasks.record(answers.id)).toEqual(answers.task); expect(f.api.tasks.result(targetBefore)).toEqual(f.original); expect(f.http).not.toHaveBeenCalled();
});

it("requires explicit replacement and rejects changed proposals or changed answer-source identities", async () => {
  const f = await setup(document([question({ stem: "1. Target" })])), answers = await savedAnswers(f), selection = { taskId: answers.id, checkpointId: answers.checkpointId, questionIndex: 0 }, propose = (source = selection) => f.api.revisions.proposal(f.id, f.checkpointId, 0, source);
  expect(() => propose()).toThrow(expect.objectContaining({ code: "ANSWER_REPLACEMENT_REQUIRED" }));
  const source = { ...selection, replaceExisting: true }, proposal = propose(source), input = f.save({ question: proposal.question, answerSource: source });
  expect(() => f.api.revisions.save(f.id, { ...input, question: { ...input.question, answerPayload: { text: "Invented answer" } } })).toThrow(expect.objectContaining({ code: "ANSWER_MATCH_INVALID" }));
  expect(() => propose({ ...selection, checkpointId: "changed" })).toThrow(expect.objectContaining({ code: "ANSWER_SOURCE_STALE" }));
  const saved = f.api.revisions.save(f.id, input); expect(saved.edits).toHaveLength(1);
  expect(() => f.api.revisions.save(f.id, { ...input, answerSource: { ...source, questionIndex: 1 } })).toThrow(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
  f.api.tasks.update(answers.id, answers.task.runId, record => { record.state = "FAILED"; });
  expect(f.api.revisions.save(f.id, input)).toEqual(saved);
  expect(() => f.api.revisions.save(f.id, f.save({ expectedRevision: input.requestId, question: proposal.question, answerSource: source }))).toThrow(expect.objectContaining({ code: "ANSWER_SOURCE_UNAVAILABLE" }));
  expect(f.http).not.toHaveBeenCalled();
});

it.each(["role", "stopped", "expired", "missing", "index", "target", "self", "empty-answer"])("rejects an invalid answer association: %s", async mode => {
  const f = await setup(document([question({ stem: "1. Target", answerPayload: null })])), answers = await savedAnswers(f, [question({ stem: "1. Answer", answerPayload: mode === "empty-answer" ? null : { text: "Supplied" } })], mode === "role" ? "questions" : "answers");
  if (mode === "stopped") f.api.tasks.update(answers.id, answers.task.runId, record => { record.state = "WAITING_REVIEW"; });
  if (mode === "expired") f.api.tasks.update(answers.id, answers.task.runId, record => { record.createdAt -= 181 * 24 * 3600 * 1000; });
  const selection = { taskId: mode === "missing" ? randomUUID() : mode === "self" ? f.id : answers.id, checkpointId: answers.checkpointId, questionIndex: mode === "index" ? 9 : 0 };
  expect(() => f.api.revisions.proposal(f.id, mode === "target" ? "stale" : f.checkpointId, 0, selection)).toThrow(expect.objectContaining({ code: mode === "target" ? "STALE_CHECKPOINT" : ["index", "empty-answer"].includes(mode) ? "ANSWER_MATCH_INVALID" : "ANSWER_SOURCE_UNAVAILABLE" }));
  expect(f.api.revisions.read(f.api.tasks.record(f.id)).edits).toEqual([]); expect(f.http).not.toHaveBeenCalled();
});

it("retains selected answer provenance and all existing warnings with Unicode-safe source excerpts", async () => {
  const original = document([question({ id: "q0", stem: "1. First", answerPayload: null }), question({ id: "q1", stem: "2. Second", answerPayload: null })]); original.warnings = Array.from({ length: 1000 }, (_, index) => `Original warning ${index}`);
  const f = await setup(original), excerpt = "😀".repeat(1201) + "TAIL", answers = await savedAnswers(f, [question({ id: "a0", stem: "1. Answer", answerPayload: { text: "First" }, sourceText: "1. First source" }), question({ id: "a1", stem: "2. Answer", answerPayload: { text: "Second" }, sourceText: excerpt })]);
  let expectedRevision: string | null = null;
  for (const index of [0, 1]) {
    const source = { taskId: answers.id, checkpointId: answers.checkpointId, questionIndex: index }, proposal = f.api.revisions.proposal(f.id, f.checkpointId, index, source), input = f.save({ expectedRevision, questionIndex: index, question: proposal.question, answerSource: source }); f.api.revisions.save(f.id, input); expectedRevision = input.requestId;
  }
  const bank = (await f.request({ type: "bank", revision: f.view.revision, value: { threadId: f.id, checkpointId: f.checkpointId, scope: "full", revisionId: expectedRevision!, questionIndexes: [1] } })).value;
  expect(bank.result.questions).toHaveLength(1); expect(bank.result.warnings).toHaveLength(1000); expect(bank.result.warnings!.slice(0, 999)).toEqual(original.warnings!.slice(0, 999));
  const warnings = bank.result.warnings!.at(-1)!; expect(warnings).toContain("Original warning 999"); expect(warnings).toContain("Human-corrected revision"); expect(warnings).toContain("Selected-question export");
  expect(warnings).toContain("original question 2"); expect(warnings).not.toContain("original question 1"); expect(warnings).toContain("😀".repeat(1200)); expect(warnings).not.toContain("TAIL"); expect(f.api.tasks.result(f.api.tasks.record(f.id))!.warnings).toEqual(original.warnings);
});

it("holds task admission through Store commit, survives reopen and rolls back a failed write", async () => {
  const f = await setup(), otherTasks = new DocumentTasks(f.path, f.api.storage, f.db), otherStore = new SqliteStore(f.path), input = f.save(); otherTasks.db.exec("PRAGMA busy_timeout=1");
  try {
    const update = f.api.store.updateSync.bind(f.api.store), original = f.api.tasks.record(f.id);
    const locked = vi.spyOn(f.api.store, "updateSync").mockImplementation((...args) => {
      expect(() => otherTasks.update(f.id, original.runId, () => {})).toThrow(/locked/); update(...args);
    });
    const saved = f.api.revisions.save(f.id, input); expect(locked).toHaveBeenCalledOnce(); locked.mockRestore();
    const reopened = new DocumentRevisions(otherTasks, otherStore); expect(reopened.read(otherTasks.record(f.id))).toEqual(saved); expect(reopened.save(f.id, input)).toEqual(saved);
    const next = f.save({ expectedRevision: input.requestId });
    f.api.store.db.exec("CREATE TRIGGER fail_revision BEFORE UPDATE ON store_items BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;");
    expect(() => f.api.revisions.save(f.id, next)).toThrow("simulated disk failure"); expect(reopened.read(otherTasks.record(f.id))).toEqual(saved);
    f.api.store.db.exec("DROP TRIGGER fail_revision"); expect(f.api.revisions.save(f.id, next).edits).toHaveLength(2);
    expect(f.api.tasks.record(f.id)).toEqual(original); expect(f.http).not.toHaveBeenCalled();
  } finally { otherStore.stop(); otherTasks.close(); }
});
