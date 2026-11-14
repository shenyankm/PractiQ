import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { list, object, text, unique, validateParsedTree, validateTree } from "./question-contract.js";

export const MAX_JSON_BYTES = 32 * 1024 * 1024;
export function parseJson(bytes: Uint8Array): unknown {
  invariant(bytes.byteLength <= MAX_JSON_BYTES, "LOCAL_JSON_TOO_LARGE", "JSON exceeds its size limit");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.parse(source, (_key: string, value: unknown, context?: { source?: string }) => {
    invariant(!/[\ud800-\udfff]/u.test(_key) && (typeof value !== "string" || !/[\ud800-\udfff]/u.test(value)), "LOCAL_SCHEMA_INVALID", "JSON contains invalid Unicode", { path: "$", detail: "JSON contains invalid Unicode" });
    if (typeof value === "number") {
      invariant(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), "LOCAL_SCHEMA_INVALID", "Unsafe JSON number", { path: "$", detail: "Unsafe JSON number" });
      if (Number.isInteger(value) && context?.source) {
        const match = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(context.source)!;
        const coefficient = match[1] + (match[2] ?? ""), fraction = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
        invariant(fraction <= 0 || /^0+$/.test(coefficient) || coefficient.length - coefficient.replace(/0+$/, "").length >= fraction,
          "LOCAL_SCHEMA_INVALID", "JSON number loses fractional precision", { path: "$", detail: "JSON number loses fractional precision" });
      }
    }
    return value;
  });
}
export function validateProcessing(processing: unknown, ids: Set<string>): void {
  if (processing == null) return;
  validateContract("DocumentProcessing", processing);
  for (const [key, values] of [["questionSources", list(processing, "questionSources")], ["quality.issues", list(object(processing).quality, "issues")]] as const) for (const [i, item] of values.entries()) invariant(ids.has(text(item, "questionId")), "LOCAL_QUESTION_INDEX_INVALID", "Processing references a missing question", { key: `processing.${key}`, i });
  for (const key of ["chunks", "visuals"]) {
    const counts = object(object(processing)[key]);
    invariant(Number(counts.succeeded ?? 0) + Number(counts.skipped ?? 0) <= Number(counts.total ?? 0), "LOCAL_PROCESSING_COUNT_INVALID", "Invalid processing counts", { key });
  }
}
export function importDiagnostics(root: unknown): Record<string, unknown>[] {
  const record = object(root), result = object(record.result ?? root);
  invariant(record.status == null || ["PARTIAL", "SUCCEEDED"].includes(String(record.status)), "LOCAL_RESPONSE_INVALID", "Invalid import status");
  invariant(!Object.hasOwn(record, "importDiagnostics") || Array.isArray(record.importDiagnostics) && record.importDiagnostics.length <= 1000, "LOCAL_RESPONSE_INVALID", "Invalid import diagnostics");
  const diagnostics = list(root, "importDiagnostics").map(value => object(value));
  if (!diagnostics.length && (record.status != null || record.processing != null)) diagnostics.push({ questionIds: list(result, "questions").map(q => object(q).id), status: record.status ?? null, processing: record.processing ?? null });
  const ids = new Set(list(result, "questions").map(q => text(q, "id")));
  for (const [i, diagnostic] of diagnostics.entries()) {
    validateContract("BankImportDiagnostic", diagnostic);
    const scoped = new Set(list(diagnostic, "questionIds").map(String));
    validateProcessing(diagnostic.processing, scoped);
    invariant([...scoped].every(id => ids.has(id)), "LOCAL_QUESTION_INDEX_INVALID", "Import diagnostics reference a missing question", { key: "importDiagnostics", i });
  }
  return diagnostics;
}
export function validateDocument(input: unknown): Record<string, unknown> { return validateDocumentWithRules(input, false); }
export function validateParsedDocument(input: unknown): Record<string, unknown> { return validateDocumentWithRules(input, true); }
function validateDocumentWithRules(input: unknown, source: boolean): Record<string, unknown> {
  const root = object(structuredClone(input)), result = object(Object.hasOwn(root, "result") ? root.result : root);
  invariant(result.schemaVersion === 3, "LOCAL_JSON_VERSION", "Unsupported document schema version");
  if (Array.isArray(result.questions)) result.questions = source ? validateParsedTree(result.questions) : validateTree(result.questions);
  validateContract("DocumentParseResult", result);
  if (!list(result, "questions").length) {
    result.missingFields = [...new Set([...list(result, "missingFields"), "questions"])];
    for (const visual of list(result, "visualElements")) object(visual).documentOnly = true;
    validateContract("DocumentParseResult", result);
  }
  const ids = new Set(list(result, "questions").map(q => text(q, "id")));
  for (const [i, visual] of list(result, "visualElements").entries()) invariant(object(visual).documentOnly !== true || !list(visual, "questionIds").length, "LOCAL_QUESTION_INDEX_INVALID", "documentOnly visuals cannot reference questions", { key: "visualElements", i });
  for (const group of list(result, "groups")) invariant(text(group, "title").trim(), "LOCAL_GROUP_TITLE_EMPTY", "Group title is empty");
  for (const visual of list(result, "visualElements")) invariant(text(visual, "description").trim(), "LOCAL_VISUAL_DESCRIPTION_EMPTY", "Visual description is empty");
  for (const key of ["groups", "visualElements"]) for (const [i, group] of list(result, key).entries()) {
    invariant(unique(list(group, "questionIds")) && list(group, "questionIds").every(id => typeof id === "string" && ids.has(id)), "LOCAL_QUESTION_INDEX_INVALID", "Invalid question reference", { key, i });
    if (key === "visualElements" && Array.isArray(object(group).bbox)) {
      const bbox = object(group).bbox as number[];
      invariant(bbox.every(value => typeof value === "number" && value >= 0 && value <= 1) && bbox[2] > bbox[0] && bbox[3] > bbox[1], "LOCAL_VISUAL_BBOX_INVALID", "Invalid visual bounding box", { i });
    }
  }
  validateProcessing(root.processing, ids);
  importDiagnostics(root);
  return root;
}
