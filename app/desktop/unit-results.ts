import { parseEntities } from "parse-entities";
import type { ArtifactReference, ParsedGroup, Question, UnitParseResult, VisualElement } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { validateContract } from "./contracts.js";
import { parseJson } from "./document-contract.js";
import { AppError, invariant } from "./errors.js";
import { executionJson, SqliteStore } from "./graph-store.js";
import { answerComplete, parsedAnswerSourceConflict, composite, list, normalizeQuestionText, object, text, validateParsedQuestion } from "./question-contract.js";
import { sourceTrim, SOURCE_WHITESPACE } from "./source-text.js";
import { sourceCasefold } from "./source-casefold.js";
import { canonical } from "./questions.js";

function renderedStrings(value: unknown): string[] { return typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(renderedStrings) : value !== null && typeof value === "object" ? Object.values(value).flatMap(renderedStrings) : []; }
const renderedFields = new Set(["stem", "instructions", "analysis", "scoringRubric", "answerPayload", "options", "items", "passage", "contentBlocks", "transcript"]);
export function renderedText(question: Question): string { return renderedStrings(Object.fromEntries(Object.entries(question).filter(([key]) => renderedFields.has(key)))).join(" "); }
export function missingFormulas(source: string, rendered: string): string[] {
  if (!source.includes("$") && !source.includes("\\(") && !source.includes("\\[")) return [];
  const normalize = (value: string) => parseEntities(value).replace(new RegExp(`${SOURCE_WHITESPACE}+|\\\\(?:quad|,)`, "gu"), "").replaceAll("\\geq", "\\ge").replaceAll("\\leq", "\\le"), closing: Record<string, string> = { $: "$", $$: "$$", "\\(": "\\)", "\\[": "\\]" }, missing: string[] = [];
  let delimiter: string | undefined, start = 0, target: string | undefined;
  for (const match of source.matchAll(/(?<!\\)(\$\$?|\\[()\[\]])/g)) {
    if (delimiter === undefined) { delimiter = closing[match[0]]; start = match.index + match[0].length; }
    else if (match[0] === delimiter) { const formula = source.slice(start, match.index); if (sourceTrim(formula)) { target ??= normalize(rendered); if (!target.includes(normalize(formula))) missing.push(formula); } delimiter = undefined; }
  }
  return missing;
}
export function validateUnitResult(input: unknown): { questions: Question[]; groups: ParsedGroup[] } {
  invariant(input !== null && typeof input === "object" && !Array.isArray(input), "UNIT_RESULT_INVALID", "Unit result must be an object");
  const value = object(structuredClone(input)); for (const key of ["questions", "groups"]) if (!Object.hasOwn(value, key)) value[key] = [];
  invariant(Array.isArray(value.questions) && value.questions.length <= 1000 && Array.isArray(value.groups) && value.groups.length <= 1000, "UNIT_RESULT_INVALID", "Invalid unit question or group list");
  for (const raw of list(value, "questions")) {
    const question = object(raw); normalizeQuestionText(question, sourceTrim); const mode = text(question, "answerMode");
    invariant(question.passage !== null && question.transcript !== null, "UNIT_RESULT_INVALID", "Passage and transcript must be lists when supplied");
    if (["choice", "true_false", "fill_blank", "short_answer", "ordering", "matching", "reading", "word_bank", "cloze", "listening", "gap_fill"].includes(mode)) {
      for (const field of [...(mode !== "fill_blank" ? ["blankCount"] : []), ...(!["choice", "word_bank"].includes(mode) && !list(question, "options").length ? ["choiceVariant"] : [])]) if (question[field] != null) { question[field] = null; question.needsReview = true; }
    }
    if (Array.isArray(question.missingFields) && question.missingFields.every(flag => typeof flag === "string")) { if (question.missingFields.length) question.needsReview = true; question.missingFields = question.missingFields.filter(flag => ["media", "material"].includes(String(flag))); }
  }
  value.questions = list(value, "questions").map(validateParsedQuestion);
  validateContract("UnitParseResult", value);
  return validateUnitStructure({ questions: value.questions as Question[], groups: list(value, "groups") as ParsedGroup[] });
}
export function validateUnitStructure({ questions, groups }: { questions: Question[]; groups: ParsedGroup[] }): { questions: Question[]; groups: ParsedGroup[] } {
  const ids = new Map<string, Question>();
  for (const group of groups) { group.title = sourceTrim(group.title); invariant(group.title.length, "UNIT_RESULT_INVALID", "Group title must not be blank"); }
  for (let index = 0; index < questions.length; index++) {
    let question = questions[index];
    if (question.audioRef) { question = validateParsedQuestion({ ...question, audioRef: null, needsReview: true }); questions[index] = question; }
    if (question.answerMode === "choice" && answerComplete(question) && question.options.length) {
      const labels = new Map(question.options.filter(option => option.label).map(option => [sourceCasefold(option.label!), option.label!]));
      if (labels.size) object(question.answerPayload).correct = list(question.answerPayload, "correct").map(value => labels.get(sourceCasefold(String(value))));
    }
    if (question.id != null) { invariant(!ids.has(question.id), "UNIT_RESULT_INVALID", "Unit question IDs must be unique"); ids.set(question.id, question); }
    if (parsedAnswerSourceConflict(question)) question.needsReview = true;
  }
  const groupText = new Map<number, string[]>();
  for (const group of groups) for (const index of group.questionIndexes) { invariant(Number.isSafeInteger(index) && index >= 0 && index < questions.length, "UNIT_RESULT_INVALID", "Group indexes must refer to fragment questions, including parents"); const values = groupText.get(index) ?? []; values.push(renderedStrings({ title: group.title, instructions: group.instructions }).join(" ")); groupText.set(index, values); }
  questions.forEach((question, index) => {
    const parent = question.parentId && ids.get(question.parentId); invariant(!parent || composite(parent), "UNIT_RESULT_INVALID", "A unit parent must be a composite question");
    const rendered = renderedText(question) + " " + (groupText.get(index) ?? []).join(" ");
    if (question.answerMode !== "listening" && missingFormulas(question.sourceText ?? "", rendered).length) { question.needsReview = true; if (!question.missingFields.includes("material")) question.missingFields.push("material"); }
    if (question.confidence < 0.5) question.needsReview = true;
  });
  return { questions, groups };
}

export interface UnitPayload { parsed: UnitParseResult; visuals: VisualElement[]; agentReview?: unknown; contextSkipped?: boolean }
export interface UnitIdentity { stage: "document_parse" | "vision_parse"; index: number; round: number; inputDigest: string }
export interface SavedUnit extends UnitIdentity { sourceSha256: string; executionVersion: string; status: "succeeded" | "failed" | "unknown" | "rejected"; resultRef: ArtifactReference | null; code: string | null }
function identity(value: UnitIdentity): void { invariant(["document_parse", "vision_parse"].includes(value.stage) && Number.isSafeInteger(value.index) && value.index >= 0 && Number.isSafeInteger(value.round) && value.round >= 0 && /^[a-f0-9]{64}$/.test(value.inputDigest), "UNIT_RESULT_INVALID", "Invalid unit identity"); }
function validatePayload(value: unknown): UnitPayload {
  const payload = object(value); invariant(Object.keys(payload).every(key => ["parsed", "visuals", "agentReview", "contextSkipped"].includes(key)) && Object.hasOwn(payload, "parsed") && (payload.visuals === undefined || Array.isArray(payload.visuals) && payload.visuals.length <= 1000) && (payload.contextSkipped === undefined || typeof payload.contextSkipped === "boolean"), "UNIT_RESULT_INVALID", "Invalid saved unit payload");
  const parsed = validateUnitResult(payload.parsed), visuals = structuredClone(list(payload, "visuals")) as VisualElement[];
  for (const visual of visuals) { validateContract("VisualElement", visual); if (visual.bbox) invariant(visual.bbox.every(value => value >= 0 && value <= 1) && visual.bbox[2] > visual.bbox[0] && visual.bbox[3] > visual.bbox[1], "UNIT_RESULT_INVALID", "Invalid unit visual bounds"); }
  return { parsed, visuals, ...(Object.hasOwn(payload, "agentReview") ? { agentReview: structuredClone(payload.agentReview) } : {}), ...(payload.contextSkipped === undefined ? {} : { contextSkipped: payload.contextSkipped as boolean }) };
}

/** The cache stores validated results; provider-call receipts independently decide whether a call can run. */
export class UnitResults {
  readonly namespace: string[];
  constructor(readonly store: SqliteStore, readonly storage: AiStorage, readonly taskId: string, readonly sourceSha256: string, readonly executionVersion: string) {
    invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(taskId) && /^[a-f0-9]{64}$/.test(sourceSha256) && executionVersion.length > 0 && executionVersion.length <= 255, "UNIT_RESULT_INVALID", "Invalid unit execution scope"); this.namespace = ["document_tasks", taskId.toLowerCase(), "units"];
  }
  private key(unit: Pick<UnitIdentity, "stage" | "index">): string { return `${unit.stage}-${unit.index}`; }
  private verify(value: unknown, unit: UnitIdentity): SavedUnit {
    const record = object(value) as unknown as SavedUnit; identity(record);
    const fields = ["stage", "index", "round", "inputDigest", "sourceSha256", "executionVersion", "status", "resultRef", "code"];
    invariant(Object.keys(record).length === fields.length && fields.every(key => Object.hasOwn(record, key)) && record.stage === unit.stage && record.index === unit.index && record.inputDigest === unit.inputDigest && record.sourceSha256 === this.sourceSha256 && record.executionVersion === this.executionVersion && ["succeeded", "failed", "unknown", "rejected"].includes(record.status) && (record.code === null || typeof record.code === "string" && /^[A-Z0-9_]{1,64}$/.test(record.code)), "UNIT_RESULT_INVALID", "Saved unit belongs to a different source, input or execution");
    if (record.resultRef) { validateContract("ArtifactReference", record.resultRef); invariant(record.resultRef.mediaType === "application/json" && record.resultRef.objectKey.startsWith(`practiq-agent/artifacts/${this.sourceSha256}/unit-result/${unit.index}-`), "UNIT_RESULT_INVALID", "Saved unit result has an invalid managed reference"); }
    invariant(record.status === "succeeded" ? record.resultRef !== null && record.code === null : record.status === "rejected" ? record.resultRef !== null && record.code === "OUTPUT_INVALID" : record.resultRef === null && record.code !== null, "UNIT_RESULT_INVALID", "Saved unit outcome is incomplete"); return record;
  }
  async get(unit: UnitIdentity): Promise<{ record: SavedUnit; payload: UnitPayload | null } | null> {
    identity(unit); const saved = await this.store.get(this.namespace, this.key(unit)); if (!saved) return null;
    try { const record = this.verify(saved.value, unit); return { record, payload: record.resultRef ? validatePayload(parseJson(this.storage.artifact(record.resultRef))) : null }; }
    catch (error) { if (error instanceof AppError && error.code === "DOCUMENT_CHECKSUM_MISMATCH") throw error; throw new AppError("UNIT_RESULT_INVALID", "Saved unit content failed validation; its bytes remain unchanged"); }
  }
  private async publish(unit: UnitIdentity, candidate: SavedUnit): Promise<SavedUnit> {
    let published = candidate;
    await this.store.update(this.namespace, this.key(unit), previous => {
      if (previous) { const saved = this.verify(previous, unit); if (saved.round > unit.round || saved.status === "rejected" && saved.round === unit.round || saved.status === "succeeded" && candidate.status !== "succeeded") { published = saved; return previous; } }
      return candidate as unknown as Record<string, unknown>;
    }); return published;
  }
  async save(unit: UnitIdentity, value: unknown): Promise<SavedUnit> {
    identity(unit); const payload = validatePayload(value), bytes = Buffer.from(executionJson(payload)), resultRef = await this.storage.putArtifact(bytes, this.sourceSha256, "unit-result", unit.index, "application/json");
    return this.publish(unit, { ...unit, sourceSha256: this.sourceSha256, executionVersion: this.executionVersion, status: "succeeded", resultRef, code: null });
  }
  async failure(unit: UnitIdentity, code: string, unknown = false): Promise<SavedUnit> {
    identity(unit); invariant(/^[A-Z0-9_]{1,64}$/.test(code), "UNIT_RESULT_INVALID", "Invalid unit failure code");
    return this.publish(unit, { ...unit, sourceSha256: this.sourceSha256, executionVersion: this.executionVersion, status: unknown ? "unknown" : "failed", resultRef: null, code });
  }
  async reject(unit: SavedUnit): Promise<void> {
    this.verify(unit, unit); invariant(unit.status === "succeeded" && unit.resultRef, "UNIT_RESULT_INVALID", "Only a proven successful unit can be rejected at merge"); this.storage.artifact(unit.resultRef);
    await this.store.update(this.namespace, this.key(unit), previous => {
      invariant(previous, "UNIT_RESULT_INVALID", "Rejected unit is missing"); const saved = this.verify(previous, unit);
      invariant(saved.round === unit.round && canonical(saved.resultRef) === canonical(unit.resultRef) && ["succeeded", "rejected"].includes(saved.status), "UNIT_RESULT_INVALID", "Merge rejection belongs to a different unit result");
      return { ...saved, status: "rejected", code: "OUTPUT_INVALID" };
    });
  }
}
