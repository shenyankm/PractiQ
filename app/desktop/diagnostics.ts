import type { DatabaseSync } from "node:sqlite";
import { importDiagnostics, MAX_JSON_BYTES } from "./document-contract.js";
import { invariant } from "./errors.js";
import { list, object, text } from "./question-contract.js";

export function readDiagnostics(db: DatabaseSync, bank: string): Record<string, unknown>[] {
  const records = db.prepare("SELECT w.message FROM import_warnings w JOIN imports i ON i.id=w.import_id WHERE i.bank_id=? AND w.position=-1 ORDER BY i.created_at,i.rowid").all(bank);
  if (!records.length) return [];
  const ids = new Set(db.prepare("SELECT id FROM questions WHERE bank_id=?").all(bank).map(row => String(row.id)));
  const diagnostics: Record<string, unknown>[] = [];
  for (const row of records) {
    const raw = String(row.message);
    invariant(Buffer.byteLength(raw) <= MAX_JSON_BYTES, "LOCAL_RESPONSE_INVALID", "Import diagnostics exceed size limit");
    const values: unknown = JSON.parse(raw);
    invariant(Array.isArray(values) && values.length <= 1000, "LOCAL_RESPONSE_INVALID", "Too many import diagnostics");
    for (const [i, value] of values.entries()) {
      const refs = list(value, "questionIds").filter(id => typeof id === "string") as string[];
      // Validate the retained record before filtering references to deleted questions.
      importDiagnostics({ result: { questions: refs.map(id => ({ id })) }, importDiagnostics: [value] });
      const missing = refs.filter(id => !ids.has(id));
      if (missing.length) invariant(!db.prepare("SELECT EXISTS(SELECT 1 FROM questions WHERE bank_id<>? AND id IN (SELECT value FROM json_each(?))) AS foreign_ref").get(bank, JSON.stringify(missing))!.foreign_ref, "LOCAL_QUESTION_INDEX_INVALID", "Import diagnostics reference another bank", { key: "importDiagnostics", i });
      const diagnostic = object(structuredClone(value));
      diagnostic.questionIds = refs.filter(id => ids.has(id));
      const processing = object(diagnostic.processing);
      if (Array.isArray(processing.questionSources)) processing.questionSources = processing.questionSources.filter(item => ids.has(text(item, "questionId")));
      const quality = object(processing.quality);
      if (Array.isArray(quality.issues)) quality.issues = quality.issues.filter(item => ids.has(text(item, "questionId")));
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}
