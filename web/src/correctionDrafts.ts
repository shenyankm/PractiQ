import { accountStorageScope, storageKey } from "./accountClient";
import type { DocumentAnswerSource, DocumentCorrectionSave, ParsedQuestion } from "./contracts.generated";

export type EditorDraft = { original: ParsedQuestion; question: ParsedQuestion; answer: string; initialAnswer: string };
export type CorrectionDraft = { version: 1; taskId: string; fileName: string; checkpointId: string; questionIndex: number; revision: string | null; answerSource?: DocumentAnswerSource | null; editor: EditorDraft; pending: DocumentCorrectionSave | null; updatedAt: string };
const key = "practiq.correction-drafts.v1";
const scopedPrefix = (scope: string) => storageKey(key, scope) + ".requests.";
const maximum = 4 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => Error("无法读取或保存本机校对草稿。请保留当前页面，检查浏览器存储后重试；未确认请求不会自动重发。");
function question(value: unknown): value is ParsedQuestion {
  if (!value || typeof value !== "object") return false;
  const q = value as ParsedQuestion;
  return (q.stem === null || typeof q.stem === "string") && Array.isArray(q.contentBlocks) && Array.isArray(q.options) && Array.isArray(q.items) && Array.isArray(q.missingFields)
    && [q.passage, q.transcript].every(v => v == null || Array.isArray(v))
    && [q.contentBlocks, q.options, q.items, q.passage ?? [], q.transcript ?? []].every(items => items.every(item => item && typeof item === "object"));
}
function source(value: DocumentAnswerSource | null | undefined) {
  return value == null || typeof value === "object" && uuid.test(value.taskId) && typeof value.checkpointId === "string" && value.checkpointId.length > 0 && value.checkpointId.length <= 255 && Number.isSafeInteger(value.questionIndex) && value.questionIndex >= 0 && (value.replaceExisting == null || typeof value.replaceExisting === "boolean");
}
function decode(raw: string): CorrectionDraft[] {
  if (new TextEncoder().encode(raw).length > maximum) throw unavailable();
  const values: CorrectionDraft[] = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 50 || values.some(v => !v || v.version !== 1 || !uuid.test(v.taskId) || typeof v.fileName !== "string" || v.fileName.length > 255 || typeof v.checkpointId !== "string" || !v.checkpointId || v.checkpointId.length > 255 || !Number.isSafeInteger(v.questionIndex) || v.questionIndex < 0 || (v.revision !== null && !uuid.test(v.revision)) || typeof v.updatedAt !== "string" || !source(v.answerSource) || !v.editor || !question(v.editor.original) || !question(v.editor.question) || typeof v.editor.answer !== "string" || typeof v.editor.initialAnswer !== "string" || (v.pending !== null && (!v.pending || !uuid.test(v.pending.requestId) || v.pending.checkpointId !== v.checkpointId || v.pending.questionIndex !== v.questionIndex || v.pending.expectedRevision !== v.revision || !source(v.pending.answerSource) || !question(v.pending.question))))) throw unavailable();
  return values;
}
function identity(value: Pick<CorrectionDraft, "taskId" | "checkpointId" | "questionIndex">) { return JSON.stringify([value.taskId, value.checkpointId, value.questionIndex]); }
// shortcut: one mutable draft per question; add tab-specific drafts if simultaneous editing is needed.
function mutableDrafts(scope: string) { return decode(localStorage.getItem(storageKey(key, scope)) ?? "[]"); }
function sameEditor(a: CorrectionDraft, b: CorrectionDraft) { return identity(a) === identity(b) && a.revision === b.revision && JSON.stringify(a.editor) === JSON.stringify(b.editor) && JSON.stringify(a.answerSource ?? null) === JSON.stringify(b.answerSource ?? null); }
export function correctionDrafts(scope = accountStorageScope()): CorrectionDraft[] {
  try {
    const mutable = mutableDrafts(scope), pending: CorrectionDraft[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (!name?.startsWith(scopedPrefix(scope))) continue;
      const raw = localStorage.getItem(name);
      if (raw === null) continue;
      const value = decode(`[${raw}]`)[0];
      if (!value?.pending || scopedPrefix(scope) + value.pending.requestId !== name) throw unavailable();
      pending.push(value);
    }
    if (pending.length > 50) throw unavailable();
    return [...pending, ...mutable.filter(value => !pending.some(saved => sameEditor(value, saved)))];
  } catch { throw unavailable(); }
}
function changed() { window.dispatchEvent(new Event("correction-drafts-change")); }
function write(values: CorrectionDraft[], scope: string) {
  const raw = JSON.stringify(values);
  if (values.length > 20 || new TextEncoder().encode(raw).length > maximum) throw unavailable();
  if (values.length) localStorage.setItem(storageKey(key, scope), raw); else localStorage.removeItem(storageKey(key, scope));
  changed();
}
export function putCorrectionDraft(value: CorrectionDraft, scope = accountStorageScope()) {
  try {
    if (value.pending) {
      // Separate immutable keys keep one tab from losing another tab's unconfirmed request.
      const name = scopedPrefix(scope) + value.pending.requestId, raw = localStorage.getItem(name);
      if (raw !== null) {
        const old = decode(`[${raw}]`)[0];
        if (identity(old) !== identity(value) || JSON.stringify(old.pending) !== JSON.stringify(value.pending)) throw unavailable();
      } else {
        const existing = correctionDrafts(scope);
        if (existing.filter(v => v.pending).length >= 50 || new TextEncoder().encode(JSON.stringify([...existing, value])).length > maximum) throw unavailable();
        localStorage.setItem(name, JSON.stringify(value));
      }
      changed(); return;
    }
    write([...mutableDrafts(scope).filter(v => identity(v) !== identity(value)), value], scope);
  } catch { throw unavailable(); }
}
export function removeCorrectionDraft(value: Pick<CorrectionDraft, "taskId" | "checkpointId" | "questionIndex"> & { requestId?: string }, scope = accountStorageScope()) {
  try {
    const raw = value.requestId ? localStorage.getItem(scopedPrefix(scope) + value.requestId) : null;
    const confirmed = raw ? decode(`[${raw}]`)[0] : undefined;
    const drafts = mutableDrafts(scope).filter(v => identity(v) !== identity(value) || value.requestId && (!confirmed || !sameEditor(v, confirmed)));
    write(drafts, scope);
    if (value.requestId) localStorage.removeItem(scopedPrefix(scope) + value.requestId);
    changed();
  } catch { throw unavailable(); }
}
