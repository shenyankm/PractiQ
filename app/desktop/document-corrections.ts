import type { DocumentAnswerEvidence, DocumentAnswerMatches, DocumentAnswerProposal, DocumentAnswerSource, DocumentCorrections, DocumentCorrectionSave, DocumentParseResult, Question } from "../src/contracts.generated.js";
import { associatedQuestion, matchAnswers } from "./answer-matching.js";
import { validateContract } from "./contracts.js";
import { transaction } from "./database.js";
import { parseJson, validateParsedDocument } from "./document-contract.js";
import { DOCUMENT_TTL_MS, DocumentTasks, type DocumentRecord } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { executionJson, SqliteStore } from "./graph-store.js";
import { parsedQuestionDefaults } from "./model-defaults.js";
import { object, validateParsedQuestion, validateParsedTree } from "./question-contract.js";
import { canonical } from "./questions.js";

const EDITABLE = new Set(["stem", "instructions", "questionTypeId", "answerMode", "choiceVariant", "matchingVariant", "blankCount", "questionKind", "contentBlocks", "options", "items", "answerPayload", "analysis", "scoringRubric"]);
const HISTORY_BYTES = 8 * 1024 * 1024;

export function correctedResult(original: DocumentParseResult, corrections: DocumentCorrections, revision?: string | null): DocumentParseResult {
  const result = structuredClone(original), pending = new Map<number, Question>(); let found = revision == null;
  for (const edit of corrections.edits ?? []) {
    invariant(Number.isSafeInteger(edit.questionIndex) && edit.questionIndex >= 0 && edit.questionIndex < result.questions.length, "CORRECTION_CONFLICT", "Revision no longer matches its result");
    pending.set(edit.questionIndex, edit.question);
    if (revision != null && edit.requestId.toLowerCase() === revision.toLowerCase()) { found = true; break; }
  }
  invariant(found, "CORRECTION_NOT_FOUND", "Revision does not exist for this checkpoint");
  for (const [index, question] of pending) result.questions[index] = structuredClone(question);
  return result;
}

export function validateCorrection(original: Question, edited: Question, result: DocumentParseResult, index: number): Question {
  try {
    const before = parsedQuestionDefaults(original), after = parsedQuestionDefaults(validateParsedQuestion(edited));
    for (const key of Object.keys(before)) if (!EDITABLE.has(key) && !["needsReview", "missingFields"].includes(key)) invariant(canonical(before[key]) === canonical(after[key]), "CORRECTION_PROTECTED_FIELD", "Source evidence, resources and relationships cannot be edited");
    const oldBlocks = before.contentBlocks as Record<string, unknown>[], newBlocks = after.contentBlocks as Record<string, unknown>[];
    invariant(oldBlocks.length === newBlocks.length && oldBlocks.every((block, position) => Object.keys(block).every(key => ["textValue", "markdownValue", "latexValue"].includes(key) || canonical(block[key]) === canonical(newBlocks[position][key]))), "CORRECTION_PROTECTED_FIELD", "Content structure and resource data cannot be edited");
    const question = validateParsedQuestion({ ...before, ...Object.fromEntries([...EDITABLE].map(key => [key, after[key]])), needsReview: true });
    const candidate = structuredClone(result); candidate.questions[index] = question;
    const questions = validateParsedTree(candidate.questions); validateParsedDocument({ ...candidate, questions });
    return parsedQuestionDefaults(questions[index]) as unknown as Question;
  } catch (error) { if (error instanceof AppError && error.code === "CORRECTION_PROTECTED_FIELD") throw error; throw new AppError("CORRECTION_INVALID", "Correction conflicts with its question contract or group references"); }
}

/** Revision writes hold the task admission lock until their SQLite Store commit finishes. */
export class DocumentRevisions {
  constructor(readonly tasks: DocumentTasks, readonly store: SqliteStore) {}
  private namespace(task: DocumentRecord): string[] { return ["document_tasks", task.id, "corrections"]; }
  private live(task: DocumentRecord): void { invariant(Date.now() < task.createdAt + DOCUMENT_TTL_MS, "TASK_EXPIRED", "Document task expired; saved evidence remains unchanged"); }
  private checkpoint(task: DocumentRecord): string {
    this.live(task);
    invariant(task.checkpointId, "CORRECTION_NOT_READY", "No saved checkpoint is available"); return task.checkpointId;
  }
  read(task: DocumentRecord): DocumentCorrections {
    const checkpointId = this.checkpoint(task), raw = this.store.read(this.namespace(task), checkpointId)?.value;
    const saved = raw ? structuredClone(raw) as unknown as DocumentCorrections : { checkpointId, edits: [] };
    validateContract("DocumentCorrections", saved); saved.edits ??= [];
    invariant(saved.checkpointId === checkpointId && Buffer.byteLength(canonical(saved)) <= HISTORY_BYTES && new Set(saved.edits.map(edit => edit.requestId.toLowerCase())).size === saved.edits.length, "CORRECTION_CONFLICT", "Saved revision history is invalid for this checkpoint");
    for (const edit of saved.edits) {
      invariant(Number.isSafeInteger(edit.questionIndex) && Number.isFinite(Date.parse(edit.savedAt)), "CORRECTION_CONFLICT", "Saved revision metadata is invalid");
      edit.question = parsedQuestionDefaults(validateParsedQuestion(edit.question)) as unknown as Question;
    }
    return saved;
  }
  private selection(source: DocumentAnswerSource): DocumentAnswerSource {
    validateContract("DocumentAnswerSource", source); return { ...source, taskId: source.taskId.toLowerCase(), replaceExisting: source.replaceExisting ?? false };
  }
  private target(id: string, checkpointId: string) {
    const task = this.tasks.record(id); this.live(task); const original = this.tasks.result(task);
    invariant(task.state === "COMPLETED" && task.checkpointId && task.checkpointId === checkpointId && original, "STALE_CHECKPOINT", "Read the current completed question checkpoint first");
    const corrections = this.read(task); return { task, original, corrections, result: correctedResult(original, corrections) };
  }
  private answerSource(id: string) {
    let task: DocumentRecord;
    try { task = this.tasks.record(id); this.live(task); }
    catch (error) { if (error instanceof AppError) throw new AppError("ANSWER_SOURCE_UNAVAILABLE", "The answer source is unavailable; retain your draft"); throw error; }
    const result = this.tasks.result(task);
    invariant(task.state === "COMPLETED" && task.input.documentRole === "answers" && task.checkpointId && result, "ANSWER_SOURCE_UNAVAILABLE", "Choose a completed document imported with the answer-sheet role");
    return { task, result, checkpointId: task.checkpointId };
  }
  matches(id: string, checkpointId: string, answerId: string): DocumentAnswerMatches {
    const target = this.target(id, checkpointId);
    invariant(answerId.toLowerCase() !== target.task.id, "ANSWER_MATCH_INVALID", "Choose a separate answer document");
    const answers = this.answerSource(answerId);
    return { checkpointId, answerTaskId: answers.task.id, answerCheckpointId: answers.checkpointId, matches: matchAnswers(target.result, answers.result) };
  }
  private associate(task: DocumentRecord, original: DocumentParseResult, result: DocumentParseResult, index: number, selection: DocumentAnswerSource) {
    const source = this.answerSource(selection.taskId);
    invariant(source.task.id !== task.id && source.checkpointId === selection.checkpointId, "ANSWER_SOURCE_STALE", "The selected answer checkpoint changed");
    invariant(Number.isSafeInteger(index) && index >= 0 && index < result.questions.length && Number.isSafeInteger(selection.questionIndex) && selection.questionIndex < source.result.questions.length, "ANSWER_MATCH_INVALID", "Question or answer index is outside its checkpoint");
    const target = result.questions[index]; invariant(target.answerPayload === null || selection.replaceExisting, "ANSWER_REPLACEMENT_REQUIRED", "Explicitly confirm replacement of the supplied answer");
    const supplied = source.result.questions[selection.questionIndex], question = validateCorrection(original.questions[index], associatedQuestion(target, supplied), result, index);
    const evidence: DocumentAnswerEvidence = { selection, sourceSha256: source.task.input.document.sha256, fileName: source.task.input.document.fileName ?? null, sourceText: supplied.sourceText ?? null };
    return { question, evidence };
  }
  proposal(id: string, checkpointId: string, index: number, input: DocumentAnswerSource): DocumentAnswerProposal {
    const target = this.target(id, checkpointId), source = this.selection(input), proposed = this.associate(target.task, target.original, target.result, index, source);
    return { checkpointId, answerSource: source, question: proposed.question, corrections: target.corrections };
  }
  save(id: string, input: DocumentCorrectionSave): DocumentCorrections {
    const bytes = Buffer.from(executionJson(input)); invariant(bytes.length <= 1024 * 1024, "REQUEST_TOO_LARGE", "Correction request exceeds its byte limit");
    const request = parseJson(bytes) as DocumentCorrectionSave; validateContract("DocumentCorrectionSave", request);
    request.requestId = request.requestId.toLowerCase(); request.expectedRevision = request.expectedRevision?.toLowerCase() ?? null;
    if (request.answerSource) request.answerSource = this.selection(request.answerSource);
    return transaction(this.tasks.db, () => {
      const task = this.tasks.record(id), checkpointId = this.checkpoint(task);
      invariant(checkpointId === request.checkpointId, "STALE_CHECKPOINT", "The reviewed checkpoint changed");
      const original = this.tasks.result(task);
      invariant(task.state === "COMPLETED" && original?.questions.length, "CORRECTION_NOT_READY", "Wait for a completed result before correcting");
      invariant(Number.isSafeInteger(request.questionIndex) && request.questionIndex < original.questions.length, "CORRECTION_INVALID", "Question index is outside the result");
      const saved = this.read(task), previousIndex = saved.edits!.findIndex(edit => edit.requestId.toLowerCase() === request.requestId);
      if (previousIndex >= 0) {
        const previous = saved.edits![previousIndex]; invariant(previous.questionIndex === request.questionIndex && canonical(previous.answerEvidence?.selection ?? null) === canonical(request.answerSource ?? null), "REQUEST_CONFLICT", "Request ID belongs to another correction or answer source");
        let replayed: Question;
        try { replayed = validateCorrection(original.questions[request.questionIndex], request.question, correctedResult(original, { ...saved, edits: saved.edits!.slice(0, previousIndex) }), request.questionIndex); }
        catch { throw new AppError("REQUEST_CONFLICT", "Request ID belongs to another correction"); }
        invariant(canonical(previous.question) === canonical(replayed), "REQUEST_CONFLICT", "Request ID belongs to another correction"); return saved;
      }
      invariant(request.expectedRevision === (saved.edits!.at(-1)?.requestId.toLowerCase() ?? null), "CORRECTION_CONFLICT", "Another correction was saved; reload before saving");
      const current = correctedResult(original, saved); let evidence: DocumentAnswerEvidence | null = null;
      if (request.answerSource) {
        const expected = this.associate(task, original, current, request.questionIndex, request.answerSource), received = validateCorrection(original.questions[request.questionIndex], request.question, current, request.questionIndex);
        invariant(canonical(expected.question) === canonical(received), "ANSWER_MATCH_INVALID", "The correction differs from its selected supplied answer"); evidence = expected.evidence;
      }
      const question = validateCorrection(original.questions[request.questionIndex], request.question, current, request.questionIndex);
      invariant(saved.edits!.length < 500, "CORRECTION_HISTORY_LIMIT", "Correction history reached its entry limit");
      const next: DocumentCorrections = { checkpointId, edits: [...saved.edits!, { requestId: request.requestId, questionIndex: request.questionIndex, question, savedAt: new Date().toISOString(), answerEvidence: evidence }] };
      invariant(Buffer.byteLength(canonical(next)) <= HISTORY_BYTES, "CORRECTION_HISTORY_LIMIT", "Correction history reached its byte limit"); validateContract("DocumentCorrections", next);
      this.store.updateSync(this.namespace(task), checkpointId, previous => {
        invariant(canonical(previous ?? { checkpointId, edits: [] }) === canonical(object(saved)), "CORRECTION_CONFLICT", "Revision history changed before commit"); return object(next);
      });
      return next;
    });
  }
}
