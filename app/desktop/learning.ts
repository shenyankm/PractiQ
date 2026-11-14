import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { BackupStatus, LearningCounts, LearningOverview, MistakeCause, QuestionNote, ReviewItem } from "../src/api.js";
import { sqlRows, transaction } from "./database.js";
import { invariant } from "./errors.js";
import { regularFileExists } from "./filesystem.js";
import { HISTORICAL_COUNTS, REVIEW_TREES } from "./learning-queries.js";
import { composite, object } from "./question-contract.js";

export const LEARNING_DATA_LIMIT = 4 * 1024 * 1024;
const schema = "CREATE TABLE learning_data(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL)";
const DAY = 86400000;
const causes = ["knowledge", "misread", "calculation", "other"];
export interface LearningData { version: 1; notes: Record<string, QuestionNote>; lastBackupAt: number | null; removedNoteChanges?: number }
export const emptyLearningData = (): LearningData => ({ version: 1, notes: {}, lastBackupAt: null });
export function validateLearningData(input: unknown): LearningData {
  const data = object(input);
  invariant(data.version === 1 && Object.keys(data).every(key => ["version", "notes", "lastBackupAt", "removedNoteChanges"].includes(key)) &&
    data.notes !== null && typeof data.notes === "object" && !Array.isArray(data.notes) && Object.keys(data.notes).length <= 10000 &&
    (data.lastBackupAt == null || Number.isSafeInteger(data.lastBackupAt) && Number(data.lastBackupAt) >= 0) &&
    (data.removedNoteChanges == null || Number.isSafeInteger(data.removedNoteChanges) && Number(data.removedNoteChanges) >= 0 && Number(data.removedNoteChanges) <= 0xffffffff), "LOCAL_RESPONSE_INVALID", "Unsupported or invalid learning data");
  for (const [id, raw] of Object.entries(data.notes)) {
    const note = object(raw);
    invariant(id.length > 0 && Buffer.byteLength(id) <= 128 && Object.keys(note).every(key => ["body", "cause", "updatedAt"].includes(key)) && typeof note.body === "string" && [...note.body].length <= 20000 && (note.cause == null || typeof note.cause === "string" && causes.includes(note.cause)) && Number.isSafeInteger(note.updatedAt) && Number(note.updatedAt) >= 0, "LOCAL_RESPONSE_INVALID", "Unsupported or invalid learning data");
  }
  const normalized = { version: 1 as const, notes: Object.fromEntries(Object.entries(data.notes).map(([id, raw]) => { const note = object(raw); return [id, { body: note.body, cause: note.cause ?? null, updatedAt: note.updatedAt }]; })), lastBackupAt: data.lastBackupAt ?? null, ...(data.removedNoteChanges != null ? { removedNoteChanges: data.removedNoteChanges } : {}) };
  invariant(Buffer.byteLength(JSON.stringify(normalized)) <= LEARNING_DATA_LIMIT, "LOCAL_RESPONSE_INVALID", "Learning data exceeds its size limit");
  return normalized as LearningData;
}
function empty(db: DatabaseSync): boolean { return db.prepare("PRAGMA user_version").get()?.user_version === 0 && db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count === 0; }
function read(db: DatabaseSync): LearningData {
  db.exec("PRAGMA trusted_schema=OFF");
  invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 &&
    JSON.stringify(db.prepare("SELECT type,name,COALESCE(sql,'') AS sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()) === JSON.stringify([{ type: "table", name: "learning_data", sql: schema }]), "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported learning database");
  const row = db.prepare("SELECT content FROM learning_data WHERE id=1").get();
  invariant(row && typeof row.content === "string" && Buffer.byteLength(row.content) <= LEARNING_DATA_LIMIT, "LOCAL_RESPONSE_INVALID", "Learning data exceeds its size limit");
  return validateLearningData(JSON.parse(row.content));
}
export class Learning {
  readonly path: string;
  constructor(directory: string, readonly db: DatabaseSync) { this.path = join(directory, "learning-v1.sqlite"); }
  private exists(): boolean { return regularFileExists(this.path); }
  data(): LearningData {
    if (!this.exists()) return emptyLearningData();
    const db = new DatabaseSync(this.path, { readOnly: true });
    try { db.exec("PRAGMA trusted_schema=OFF"); return empty(db) ? emptyLearningData() : read(db); }
    finally { db.close(); }
  }
  update(update: (data: LearningData) => LearningData): void {
    this.exists();
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF");
      transaction(db, () => {
        if (empty(db)) { db.exec(`${schema}; PRAGMA user_version=1`); db.prepare("INSERT INTO learning_data VALUES(1,?)").run(JSON.stringify(emptyLearningData())); }
        const data = validateLearningData(update(read(db)));
        db.prepare("UPDATE learning_data SET content=? WHERE id=1").run(JSON.stringify(data));
      });
    } finally { db.close(); }
  }
  publish(data: LearningData): void { this.update(() => validateLearningData(data)); }
  backup(): LearningData {
    const data = this.data(), ids = new Set(this.db.prepare("SELECT id FROM questions").all().map(row => String(row.id)));
    return { version: 1, notes: Object.fromEntries(Object.entries(data.notes).filter(([id, note]) => ids.has(id) && (note.body || note.cause != null))), lastBackupAt: null };
  }
  note(id: string): QuestionNote | null {
    invariant(this.db.prepare("SELECT EXISTS(SELECT 1 FROM questions WHERE id=?) AS present").get(id)!.present, "LOCAL_WORK_UNAVAILABLE", "Question no longer exists");
    const note = this.data().notes[id]; return note && (note.body || note.cause != null) ? note : null;
  }
  saveNote(id: string, body: string, cause: MistakeCause | null): QuestionNote {
    invariant(this.db.prepare("SELECT EXISTS(SELECT 1 FROM questions WHERE id=?) AS present").get(id)!.present, "LOCAL_WORK_UNAVAILABLE", "Question no longer exists");
    invariant(cause === null || causes.includes(cause), "LOCAL_FILTER_INVALID", "Invalid mistake cause");
    const note = { body, cause, updatedAt: Date.now() };
    this.update(data => {
      const since = data.lastBackupAt ?? 0, ids = new Set(this.db.prepare("SELECT id FROM questions").all().map(row => String(row.id)));
      let removed = data.removedNoteChanges ?? 0;
      for (const [noteId, note] of Object.entries(data.notes)) if (!ids.has(noteId)) { if (note.updatedAt > since) removed = Math.min(0xffffffff, removed + 1); delete data.notes[noteId]; }
      if (removed > 0) data.removedNoteChanges = removed;
      Object.defineProperty(data.notes, id, { value: note, enumerable: true, configurable: true, writable: true }); return data;
    });
    return note;
  }
  status(time = Date.now()): BackupStatus {
    const data = this.data(), since = data.lastBackupAt ?? 0;
    const attempts = Number(this.db.prepare("SELECT count(*) AS count FROM attempts WHERE submitted_at>?").get(since)!.count);
    const notes = Object.values(data.notes).filter(note => note.updatedAt > since).length + (data.removedNoteChanges ?? 0);
    const banks = Boolean(this.db.prepare("SELECT EXISTS(SELECT 1 FROM banks) AS present").get()!.present);
    return { lastBackupAt: data.lastBackupAt ?? null, newAttempts: attempts, changedNotes: notes, due: data.lastBackupAt != null ? time - data.lastBackupAt >= 7 * DAY && (attempts > 0 || notes > 0) : banks || notes > 0 };
  }
  markBackup(): void { this.update(data => { data.lastBackupAt = Date.now(); delete data.removedNoteChanges; return data; }); }
  overview(days: number, today: number, since: number): LearningOverview {
    const time = Date.now();
    invariant([7, 30].includes(days) && [today, since].every(Number.isSafeInteger) && since >= 0 && since <= today && today <= time && time - today <= 26 * 3600000 && Math.abs(today - since - (days - 1) * DAY) <= 2 * 3600000, "LOCAL_FILTER_INVALID", "Invalid learning statistics window");
    const counts = emptyCounts(), banks = new Map<string, { title: string; counts: LearningCounts }>(), kinds = new Map<string, LearningCounts>();
    for (const [skipped, result, grade, bank, title, kind] of sqlRows(this.db, HISTORICAL_COUNTS, [since, time])) {
      add(counts, Boolean(skipped), result, String(grade));
      const bankId = String(bank), type = String(kind);
      if (!banks.has(bankId)) banks.set(bankId, { title: String(title), counts: emptyCounts() });
      add(banks.get(bankId)!.counts, Boolean(skipped), result, String(grade));
      if (!kinds.has(type)) kinds.set(type, emptyCounts()); add(kinds.get(type)!, Boolean(skipped), result, String(grade));
    }
    const current = new Set(this.db.prepare("SELECT id FROM banks").all().map(row => String(row.id)));
    return { days, since, through: time, counts, banks: [...banks].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => ({ id, title: value.title, available: current.has(id), counts: value.counts })), kinds: [...kinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([kind, counts]) => ({ kind, counts })), review: this.review(today, time).slice(0, 20), backup: this.status(time) };
  }
  private review(today: number, time: number): ReviewItem[] {
    const notes = this.data().notes, history = new Map<string, { last: number; latest?: { at: number; result: boolean }; wrong: number }>();
    for (const row of this.db.prepare("SELECT question_id,submitted_at,result FROM attempts WHERE question_id IS NOT NULL AND submitted_at IS NOT NULL AND skipped=0 AND submitted_at<=? ORDER BY submitted_at DESC,rowid DESC").iterate(time)) {
      const id = String(row.question_id), at = Number(row.submitted_at), current = history.get(id) ?? { last: 0, wrong: 0 };
      current.last = Math.max(current.last, at); if (!current.latest && row.result !== null) current.latest = { at, result: Boolean(row.result) }; if (row.result === 0) current.wrong++;
      history.set(id, current);
    }
    const candidates = new Map<string, { item: ReviewItem; last: number; priority: number }>();
    for (const [root, id, mode, bank, title, stem] of sqlRows(this.db, REVIEW_TREES, [])) {
      const rootId = String(root), questionId = String(id), candidate = candidates.get(rootId) ?? { item: { rootId, bankId: String(bank), bankTitle: String(title), stem: stem === null ? null : String(stem), count: 0, reason: "stale", causes: [], lastAnsweredAt: 0 }, last: 0, priority: 3 };
      const cause = Object.hasOwn(notes, questionId) ? notes[questionId].cause : null;
      if (cause && !candidate.item.causes.includes(cause)) candidate.item.causes.push(cause);
      if (!composite({ answerMode: mode })) {
        candidate.item.count++;
        const previous = history.get(questionId);
        if (previous) { candidate.last = Math.max(candidate.last, previous.last); if (previous.latest) candidate.priority = Math.min(candidate.priority, previous.latest.result ? time - previous.latest.at >= 7 * DAY ? 2 : 3 : previous.wrong >= 2 ? 0 : 1); }
      }
      candidates.set(rootId, candidate);
    }
    return [...candidates.values()].filter(value => value.last < today && value.priority < 3).sort((a, b) => a.priority - b.priority || a.last - b.last || (a.item.rootId < b.item.rootId ? -1 : a.item.rootId > b.item.rootId ? 1 : 0)).map(({ item, last, priority }) => ({ ...item, lastAnsweredAt: last, reason: ["repeated_wrong", "wrong", "stale"][priority] as ReviewItem["reason"] }));
  }
}
function emptyCounts(): LearningCounts { return { submitted: 0, skipped: 0, ungraded: 0, auto: { graded: 0, correct: 0 }, selfAssessed: { graded: 0, correct: 0 }, ai: { graded: 0, correct: 0 }, manual: { graded: 0, correct: 0 } }; }
function add(counts: LearningCounts, skipped: boolean, result: unknown, kind: string): void {
  counts.submitted++; if (skipped) { counts.skipped++; return; }
  if (result === null) { counts.ungraded++; return; }
  const key = ({ auto: "auto", self: "selfAssessed", ai: "ai", manual: "manual" } as const)[kind as "auto"];
  if (!key) { counts.ungraded++; return; }
  counts[key].graded++; if (result) counts[key].correct++;
}
