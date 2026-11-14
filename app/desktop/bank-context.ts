import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { invariant } from "./errors.js";
import { list, object, text } from "./question-contract.js";
import { hash } from "./assets.js";
import { readDiagnostics } from "./diagnostics.js";
import type { QuestionRow } from "../src/api.js";

export function remapQuestion(input: unknown, ids: Map<string, string>): Record<string, unknown> {
  const q = object(structuredClone(input));
  const mapped = (id: string) => { const value = ids.get(id); invariant(value, "LOCAL_QUESTION_INDEX_INVALID", "Unknown question reference", { key: "questions", i: id }); return value; };
  for (const key of ["id", "parentId", "optionSourceId"]) if (typeof q[key] === "string") q[key] = mapped(q[key] as string);
  for (const block of list(q, "passage")) if (typeof object(block).questionId === "string") object(block).questionId = mapped(text(block, "questionId"));
  return q;
}

export function remapDiagnostics(values: Record<string, unknown>[], ids: Map<string, string>): Record<string, unknown>[] {
  return values.map(value => {
    const diagnostic = object(structuredClone(value));
    diagnostic.questionIds = list(diagnostic, "questionIds").flatMap(id => ids.has(String(id)) ? [ids.get(String(id))!] : []);
    const processing = object(diagnostic.processing), quality = object(processing.quality);
    for (const [parent, key] of [[processing, "questionSources"], [quality, "issues"]] as const) if (Array.isArray(parent[key])) {
      parent[key] = list(parent, key).filter(item => ids.has(text(item, "questionId"))).map(item => ({ ...object(item), questionId: ids.get(text(item, "questionId"))! }));
    }
    return diagnostic;
  });
}

export function writeDiagnostics(db: DatabaseSync, importId: string, diagnostics: Record<string, unknown>[]): void {
  if (!diagnostics.length) return;
  const previous = db.prepare("SELECT message FROM import_warnings WHERE import_id=? AND position=-1").get(importId);
  const saved: unknown[] = previous ? JSON.parse(String(previous.message)) : [];
  for (const diagnostic of diagnostics) if (!saved.some(value => JSON.stringify(value) === JSON.stringify(diagnostic))) saved.push(diagnostic);
  invariant(saved.length <= 1000, "LOCAL_RESPONSE_INVALID", "Too many import diagnostics");
  db.prepare("INSERT OR REPLACE INTO import_warnings VALUES(?,-1,?)").run(importId, JSON.stringify(saved));
}

export function putContext(db: DatabaseSync, bank: string, result: unknown, ids: Map<string, string>, importId: string, diagnostics: Record<string, unknown>[]): void {
  const warnings = list(result, "warnings").map(String);
  for (const field of list(result, "missingFields")) if (!warnings.includes(`PRACTIQ_MISSING:${field}`)) warnings.push(`PRACTIQ_MISSING:${field}`);
  const warning = db.prepare("INSERT INTO import_warnings VALUES(?,?,?)");
  warnings.forEach((value, index) => warning.run(importId, index, value));
  const mapped = (value: unknown) => { const id = ids.get(String(value)); invariant(id, "LOCAL_QUESTION_INDEX_INVALID", "Missing context question", { key: "questionIds", i: String(value) }); return id; };
  for (const group of list(result, "groups")) {
    const id = randomUUID(); db.prepare("INSERT INTO sections VALUES(?,?,?,?)").run(id, bank, text(group, "title"), object(group).instructions as string ?? null);
    for (const reference of list(group, "questionIds")) db.prepare("INSERT INTO section_questions VALUES(?,?)").run(id, mapped(reference));
  }
  for (const value of list(result, "visualElements")) {
    const id = randomUUID(), visual = object(structuredClone(value)), references = list(visual, "questionIds"); delete visual.questionIds;
    db.prepare("INSERT INTO visuals VALUES(?,?,?,?)").run(id, bank, JSON.stringify(visual), Number(!references.length));
    for (const reference of references) db.prepare("INSERT INTO question_visuals VALUES(?,?)").run(id, mapped(reference));
  }
  for (const diagnostic of diagnostics) for (const source of list(object(diagnostic).processing, "questionSources")) {
    db.prepare("INSERT OR IGNORE INTO question_sources VALUES(?,?,?)").run(mapped(text(source, "questionId")), text(source, "stage"), Number(object(source).unitIndex));
  }
  writeDiagnostics(db, importId, remapDiagnostics(diagnostics, ids));
}

export function copyContext(db: DatabaseSync, bank: string, sourceBanks: string[], rows: QuestionRow[], ids: Map<string, string>): void {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const group of row.groups) {
      const key = `group:${group.id}`; if (seen.has(key)) continue; seen.add(key);
      const id = randomUUID(); db.prepare("INSERT INTO sections VALUES(?,?,?,?)").run(id, bank, group.title, group.instructions ?? null);
      for (const reference of group.questionIds) if (ids.has(reference)) db.prepare("INSERT INTO section_questions VALUES(?,?)").run(id, ids.get(reference)!);
    }
    for (const value of row.visuals) {
      const key = `visual:${value.id}`; if (seen.has(key)) continue; seen.add(key);
      const targets = value.questionIds.length ? value.questionIds : rows.filter(source => source.bankId === row.bankId).map(source => source.id);
      const id = randomUUID(), content = object(structuredClone(value)); delete content.id; delete content.questionIds;
      db.prepare("INSERT INTO visuals VALUES(?,?,?,0)").run(id, bank, JSON.stringify(content));
      for (const target of targets) if (ids.has(target)) db.prepare("INSERT INTO question_visuals VALUES(?,?)").run(id, ids.get(target)!);
    }
    for (const source of row.sources) db.prepare("INSERT OR IGNORE INTO question_sources VALUES(?,?,?)").run(ids.get(row.id)!, text(source, "stage"), Number(object(source).unitIndex));
  }
  const scope = JSON.stringify(sourceBanks);
  for (const row of db.prepare("SELECT title,instructions FROM sections s WHERE bank_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM section_questions WHERE section_id=s.id) ORDER BY rowid").all(scope)) {
    db.prepare("INSERT INTO sections VALUES(?,?,?,?)").run(randomUUID(), bank, String(row.title), row.instructions);
  }
  for (const row of db.prepare("SELECT content FROM visuals v WHERE bank_id IN (SELECT value FROM json_each(?)) AND document_level=1 AND (json_extract(content,'$.documentOnly')=1 OR NOT EXISTS(SELECT 1 FROM questions WHERE bank_id=v.bank_id)) ORDER BY rowid").all(scope)) {
    db.prepare("INSERT INTO visuals VALUES(?,?,?,1)").run(randomUUID(), bank, JSON.stringify({ ...object(JSON.parse(String(row.content))), documentOnly: true }));
  }
  const imports = db.prepare("SELECT id FROM imports WHERE bank_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,rowid").all(scope);
  const sources = new Map<string, string>();
  for (const original of imports) {
    const source = randomUUID(); db.prepare("INSERT INTO imports VALUES(?,?,?,?)").run(source, bank, hash(`merge:${original.id}`), Date.now());
    sources.set(String(original.id), source);
    db.prepare("INSERT INTO import_warnings SELECT ?,position,message FROM import_warnings WHERE import_id=? AND position>=0").run(source, original.id);
  }
  for (const original of db.prepare("SELECT id,import_id FROM questions WHERE bank_id IN (SELECT value FROM json_each(?)) AND import_id IS NOT NULL").all(scope)) {
    const target = ids.get(String(original.id)), source = sources.get(String(original.import_id));
    if (target && source) db.prepare("UPDATE questions SET import_id=? WHERE id=?").run(source, target);
  }
  const diagnostics = sourceBanks.flatMap(source => readDiagnostics(db, source));
  if (diagnostics.length) {
    const source = randomUUID(); db.prepare("INSERT INTO imports VALUES(?,?,?,?)").run(source, bank, hash(`diagnostics:${source}`), Date.now());
    writeDiagnostics(db, source, remapDiagnostics(diagnostics, ids));
  }
}
