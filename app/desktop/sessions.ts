import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Answer, Attempt, Paper, QuestionRow, Session, SessionPage, SessionSummary } from "../src/api.js";
import { Assets, hash } from "./assets.js";
import { sqlRows, transaction } from "./database.js";
import { invariant } from "./errors.js";
import { paperDigest, selectedRows } from "./paper.js";
import { answerComplete, answerSourceConflict, canInteract, composite, grade, hasAnswer, list, object, text, validateAttempt } from "./question-contract.js";
import { canonical, freeze, QuestionIndex, readQuestions, thaw } from "./questions.js";
import { validatePage } from "./question-list.js";
import { redactSnapshot } from "./redaction.js";
import { SessionClock } from "./session-clock.js";

type WireAttempt = Omit<Attempt, "snapshot"> & { snapshot?: QuestionRow };
export type SessionWire = Omit<Session, "attempts"> & { attempts: WireAttempt[]; snapshotDocument?: unknown[]; attemptsBase?: string; attemptCount?: number };
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const nullableBoolean = (value: unknown): boolean | null => value == null ? null : Boolean(value);
export function usable(snapshot: QuestionRow): boolean {
  return !snapshot.missingAssets && canInteract(snapshot.question) && Boolean(snapshot.question.stem) && !snapshot.question.missingFields.some(key => ["stem", "material", "media", "options", "items", "choiceVariant", "matchingVariant", "answerMode"].includes(key));
}
export function hasBasis(q: unknown): boolean { return !answerSourceConflict(q) && (Boolean(text(q, "scoringRubric").trim()) || answerComplete(q)); }

class SnapshotDocument {
  readonly content: unknown[] = [];
  private readonly references = new Map<string, { signature: string; index: number }[]>();
  private intern(field: string, id: string, value: unknown): number {
    const key = `${field}:${id}`, signature = canonical(value), references = this.references.get(key) ?? [];
    const previous = references.find(reference => reference.signature === signature);
    if (previous) return previous.index;
    const index = this.content.length; this.content.push(value); references.push({ signature, index }); this.references.set(key, references); return index;
  }
  share(snapshot: QuestionRow): void {
    const record = object(snapshot), refs: Record<string, unknown> = {};
    for (const field of ["materials", "groups", "visuals"]) if (list(snapshot, field).length) {
      refs[field] = list(snapshot, field).map(value => this.intern(field, text(value, "id"), value)); delete record[field];
    }
    if (snapshot.question.optionSourceId && snapshot.question.options.length) {
      refs.options = this.intern("options", snapshot.question.optionSourceId, snapshot.question.options); object(snapshot.question).options = null;
    }
    if (snapshot.warnings.length) { refs.warnings = this.intern("warnings", snapshot.rootId ?? "", snapshot.warnings); record.warnings = null; }
    if (Object.keys(refs).length) record.snapshotRefs = refs;
  }
}

export class Sessions {
  private readonly epoch = randomUUID();
  private cachedDocument?: { id: string; document: Record<string, unknown> };
  private cachedAttempts?: { key: string; attempts: WireAttempt[] };
  constructor(readonly db: DatabaseSync, readonly assets: Assets, readonly clock = new SessionClock()) {}
  now(): number {
    if (this.clock.started) return this.clock.now();
    const saved = Number(this.db.prepare("SELECT COALESCE(MAX(MAX(created_at,COALESCE(last_active_at,created_at),COALESCE(submitted_at,created_at),COALESCE(finished_at,created_at))),0) AS saved FROM sessions").get()!.saved);
    return this.clock.atLeast(saved);
  }
  document(id: string): Record<string, unknown> {
    if (this.cachedDocument?.id === id) return this.cachedDocument.document;
    const row = this.db.prepare("SELECT content FROM session_documents WHERE session_id=?").get(id);
    invariant(row, "LOCAL_SESSION_CORRUPTED", "Session snapshot is missing");
    const document = object(JSON.parse(String(row.content)));
    this.cachedDocument = { id, document }; return document;
  }
  private context(id: string, questionId: string): QuestionRow[] {
    const doc = this.document(id), rows = list(doc, "questions"), byId = new Map(rows.map(row => [text(row, "id"), row]));
    const selected = new Set<string>(), pending = [questionId];
    while (pending.length) {
      const current = pending.pop()!; if (!current || selected.has(current)) continue; selected.add(current);
      const row = byId.get(current); invariant(row, "LOCAL_SESSION_CORRUPTED", "Snapshot question is missing");
      pending.push(text(object(row).question, "parentId"), text(object(row).question, "optionSourceId"));
    }
    const owner = text(object(byId.get(questionId)).question, "optionSourceId");
    if (owner && object(object(byId.get(owner)).question).allowReuse !== true) for (const row of rows) if (text(object(row).question, "parentId") === owner) selected.add(text(row, "id"));
    return thaw({ ...doc, questions: rows.filter(row => selected.has(text(row, "id"))) });
  }
  createPaper(input: unknown, locale = "zh-CN"): SessionWire {
    const paper = object(input);
    invariant(Object.keys(paper).every(key => ["question_ids", "kind", "minutes", "scores", "total_cents", "digest"].includes(key)) && Array.isArray(paper.question_ids) && paper.question_ids.every(id => typeof id === "string") && typeof paper.kind === "string" && (paper.minutes === null || Number.isSafeInteger(paper.minutes)) && Array.isArray(paper.scores) && paper.scores.every(score => Number.isSafeInteger(score)) && Number.isSafeInteger(paper.total_cents) && typeof paper.digest === "string", "LOCAL_FILTER_INVALID", "Invalid paper");
    const p = paper as unknown as Paper;
    const id = transaction(this.db, () => {
      const selected = selectedRows(readQuestions(this.db, this.assets, [], p.question_ids), p.question_ids);
      invariant(paperDigest(selected) === p.digest, "LOCAL_PAPER_CHANGED", "Question content changed; preview the paper again");
      const leaves = selected.filter(row => !composite(row.question)), exam = p.kind !== "practice";
      invariant(["practice", "self_test", "mock_exam"].includes(p.kind) && (p.kind === "mock_exam" ? p.minutes !== null && p.minutes >= 1 && p.minutes <= 1440 : p.minutes === null), "LOCAL_EXAM_MODE_INVALID", "Invalid exam mode");
      invariant(!exam || p.scores.length === leaves.length && p.scores.every(score => score >= 1 && score <= 100000000) && p.total_cents >= 1 && p.total_cents <= 100000000 && p.scores.reduce((sum, score) => sum + score, 0) === p.total_cents, "LOCAL_EXAM_SCORES_INVALID", "Invalid exam scores");
      const id = randomUUID(), created = this.now(), banks = [...new Map(leaves.map(row => [row.bankId, row.bankTitle])).values()];
      const zh = locale !== "en", traditional = locale === "zh-TW", first = banks[0] ?? (zh ? "题库" : "Question bank");
      const bankTitle = banks.length > 1 ? zh ? `${first}等 ${banks.length} ${traditional ? "個題庫" : "个题库"}` : `${first} and ${banks.length - 1} other ${banks.length === 2 ? "bank" : "banks"}` : first;
      const mode = p.kind === "self_test" ? zh ? traditional ? "不限時自測" : "不限时自测" : "Self-test" : p.kind === "mock_exam" ? zh ? traditional ? "限時模考" : "限时模考" : "Timed mock exam" : zh ? traditional ? "練習" : "练习" : "Practice";
      const title = `${bankTitle} · ${mode} · ${leaves.length} ${zh ? traditional ? "題" : "题" : leaves.length === 1 ? "question" : "questions"}`;
      this.db.prepare("INSERT INTO sessions(id,bank_title,created_at,position,mode,kind,deadline_at) VALUES(?,?,?,0,'ordered',?,?)").run(id, title, created, p.kind, p.minutes === null ? null : created + p.minutes * 60000);
      this.db.prepare("INSERT INTO session_documents VALUES(?,?)").run(id, canonical(freeze(selected)));
      const insert = this.db.prepare("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,max_cents) VALUES(?,?,?,?,?)");
      leaves.forEach((row, i) => insert.run(id, i, row.id, row.id, exam ? p.scores[i] : null));
      return id;
    });
    return this.session(id);
  }
  private expire(id?: string): void {
    const at = this.now();
    const ids = this.db.prepare(`SELECT id FROM sessions WHERE deadline_at<=? AND submitted_at IS NULL${id ? " AND id=?" : ""}`).all(...(id ? [at, id] : [at]));
    for (const row of ids) this.submitCore(String(row.id), true);
  }
  private submitCore(id: string, submitDrafts: boolean): void {
    this.now();
    transaction(this.db, () => {
      const session = this.db.prepare("SELECT kind,submitted_at,finished_at FROM sessions WHERE id=?").get(id);
      invariant(session, "LOCAL_WORK_UNAVAILABLE", "Session is missing");
      if (session.submitted_at !== null || session.finished_at !== null) return;
      const rows = thaw(this.document(id)); this.assets.markMissing(rows as unknown as Record<string, unknown>[]);
      const index = new QuestionIndex(rows);
      const pending = this.db.prepare("SELECT ordinal,snapshot_question_id,answer,max_cents FROM attempts WHERE session_id=? AND submitted_at IS NULL").all(id);
      const update = this.db.prepare("UPDATE attempts SET submitted_at=?,skipped=?,auto_result=?,result=?,grade_kind=?,earned_cents=? WHERE session_id=? AND ordinal=?");
      for (const attempt of pending) {
        const snapshot = index.snapshot(String(attempt.snapshot_question_id)), answer: unknown = JSON.parse(String(attempt.answer)), skip = !submitDrafts || !hasAnswer(answer), max = nullableNumber(attempt.max_cents);
        const auto = !skip && usable(snapshot) ? grade(snapshot.question, answer) : null;
        const earned = max !== null && usable(snapshot) && hasBasis(snapshot.question) ? skip ? 0 : auto === null ? null : auto ? max : 0 : null;
        const result = max === null ? auto : earned === null ? null : earned === max;
        update.run(this.clock.now(), Number(skip), auto === null ? null : Number(auto), result === null ? null : Number(result), auto !== null || earned !== null ? "auto" : "ungraded", earned, id, Number(attempt.ordinal));
      }
      this.db.prepare("UPDATE sessions SET submitted_at=?,finished_at=CASE WHEN kind='practice' THEN ? ELSE finished_at END WHERE id=?").run(this.clock.now(), this.clock.now(), id);
    });
  }
  session(id: string, suppliedKey?: string): SessionWire {
    this.expire(id);
    const row = this.db.prepare("SELECT id,bank_title,created_at,finished_at,position,mode,kind,deadline_at,submitted_at FROM sessions WHERE id=?").get(id);
    invariant(row, "LOCAL_WORK_UNAVAILABLE", "Session is missing");
    const records = this.db.prepare("SELECT a.*,q.favorite FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.session_id=? ORDER BY a.ordinal").all(id);
    const attempts: WireAttempt[] = records.map(a => ({ ordinal: Number(a.ordinal), answer: JSON.parse(String(a.answer)) as Answer | null, autoResult: nullableBoolean(a.auto_result), result: nullableBoolean(a.result), gradeKind: String(a.grade_kind) as Attempt["gradeKind"], submittedAt: nullableNumber(a.submitted_at), skipped: Boolean(a.skipped), elapsedMs: Number(a.elapsed_ms), maxCents: nullableNumber(a.max_cents), earnedCents: nullableNumber(a.earned_cents), flagged: Boolean(a.flagged), grading: JSON.parse(String(a.grading)), favorite: nullableBoolean(a.favorite) }));
    const snapshotKey = hash(canonical([id, this.epoch, row.kind, row.finished_at, row.submitted_at, records.map(a => [a.snapshot_question_id, a.submitted_at])]));
    const separator = suppliedKey?.indexOf(":") ?? -1, previousSnapshot = separator >= 0 ? suppliedKey!.slice(0, separator) : suppliedKey, previousAttempts = separator >= 0 ? suppliedKey!.slice(separator + 1) : undefined;
    const document = new SnapshotDocument(), exam = row.kind !== "practice", finished = row.submitted_at !== null || row.finished_at !== null;
    if (previousSnapshot !== snapshotKey) {
      const rows = thaw(this.document(id)), index = new QuestionIndex(rows), submitted = new Map(records.map(a => [String(a.snapshot_question_id), a.submitted_at !== null])), open = new Map<string, boolean>();
      for (const row of rows) if (row.question.answerMode === "listening") open.set(row.id, (index.trees.get(row.id) ?? []).filter(child => submitted.has(child.id)).every(child => submitted.get(child.id)));
      attempts.forEach((attempt, i) => { const snapshot = index.snapshot(String(records[i].snapshot_question_id)); redactSnapshot(snapshot, exam, finished, attempt.submittedAt !== null, open); document.share(snapshot); attempt.snapshot = snapshot; });
    }
    if (exam && row.submitted_at === null) for (const attempt of attempts) { attempt.result = null; attempt.autoResult = null; }
    const mutable = attempts.map(attempt => { const copy = { ...attempt }; delete copy.snapshot; return copy; });
    const bytes = canonical([id, snapshotKey, mutable]), attemptKey = hash(bytes), cached = this.cachedAttempts;
    const session: SessionWire = { id, title: String(row.bank_title), createdAt: Number(row.created_at), finishedAt: nullableNumber(row.finished_at), position: Number(row.position), mode: String(row.mode), kind: row.kind as Session["kind"], deadlineAt: nullableNumber(row.deadline_at), submittedAt: nullableNumber(row.submitted_at), snapshotKey, attemptKey, attempts,
      bankIds: this.db.prepare("SELECT q.bank_id FROM attempts a JOIN questions q ON q.id=a.question_id WHERE a.session_id=? GROUP BY q.bank_id ORDER BY MIN(a.ordinal)").all(id).map(row => String(row.bank_id)) };
    if (row.deadline_at !== null && row.submitted_at === null) session.clockNow = this.clock.now();
    if (document.content.length) session.snapshotDocument = document.content;
    if (previousSnapshot === snapshotKey && cached && previousAttempts === cached.key && cached.attempts.length === mutable.length && cached.attempts.every((attempt, i) => attempt.ordinal === mutable[i].ordinal)) {
      session.attempts = mutable.filter((attempt, i) => canonical(attempt) !== canonical(cached.attempts[i])); session.attemptsBase = cached.key; session.attemptCount = mutable.length;
    }
    this.cachedAttempts = Buffer.byteLength(bytes) <= 8 * 1024 * 1024 ? { key: attemptKey, attempts: mutable } : undefined;
    return session;
  }
  writeAttempt(id: string, ordinal: number, answer: unknown, elapsed: number, submit: boolean, skip: boolean): void {
    this.expire(id);
    const session = this.db.prepare("SELECT kind,submitted_at,finished_at,created_at FROM sessions WHERE id=?").get(id);
    invariant(session, "LOCAL_WORK_UNAVAILABLE", "Session is missing");
    invariant(session.kind === "practice" || !(submit || skip || session.submitted_at !== null), "LOCAL_EXAM_LOCKED", "Exam answers are locked");
    invariant(Number.isSafeInteger(ordinal) && ordinal >= 0 && Number.isSafeInteger(elapsed) && elapsed >= 0 && Buffer.byteLength(JSON.stringify(answer)) <= 256 * 1024, "LOCAL_ANSWER_INVALID", "Invalid answer");
    invariant(session.finished_at === null, "LOCAL_PRACTICE_FINISHED", "Practice has finished");
    invariant(elapsed <= this.now() - Number(session.created_at) + 60000, "LOCAL_ELAPSED_INVALID", "Elapsed time exceeds session duration");
    transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT snapshot_question_id,submitted_at FROM attempts WHERE session_id=? AND ordinal=?").get(id, ordinal);
      invariant(attempt, "LOCAL_WORK_UNAVAILABLE", "Attempt is missing");
      const rows = this.context(id, String(attempt.snapshot_question_id));
      if (submit && !skip) this.assets.markMissing(rows as unknown as Record<string, unknown>[]);
      const index = new QuestionIndex(rows), snapshot = index.snapshot(String(attempt.snapshot_question_id)), q = snapshot.question;
      validateAttempt(q, answer);
      const owner = q.optionSourceId && index.byId.get(q.optionSourceId);
      if (owner && !owner.question.allowReuse) {
        const siblings = rows.filter(row => row.question.parentId === owner.id).map(row => row.id);
        const others = this.db.prepare("SELECT answer FROM attempts WHERE session_id=? AND ordinal<>? AND snapshot_question_id IN (SELECT value FROM json_each(?))").all(id, ordinal, JSON.stringify(siblings));
        invariant(!others.some(other => list(answer, "correct").some(value => list(JSON.parse(String(other.answer)), "correct").some(previous => typeof value === "string" && typeof previous === "string" && value.toLowerCase() === previous.toLowerCase()))), "LOCAL_WORD_REUSED", "Word-bank answers cannot repeat");
      }
      if (attempt.submitted_at === null) {
        const auto = submit && !skip && !snapshot.missingAssets ? grade(q, answer) : null;
        this.db.prepare("UPDATE attempts SET answer=?,elapsed_ms=MAX(elapsed_ms,?),submitted_at=?,skipped=?,auto_result=?,result=?,grade_kind=? WHERE session_id=? AND ordinal=?")
          .run(JSON.stringify(answer), elapsed, submit ? this.clock.now() : null, Number(submit && skip), auto === null ? null : Number(auto), auto === null ? null : Number(auto), auto !== null ? "auto" : "ungraded", id, ordinal);
      }
      this.db.prepare("UPDATE sessions SET position=?,last_active_at=? WHERE id=?").run(ordinal, this.clock.now(), id);
    });
  }
  submit(id: string, submitDrafts: boolean): SessionWire { this.submitCore(id, submitDrafts); this.db.prepare("UPDATE sessions SET last_active_at=? WHERE id=?").run(this.clock.now(), id); return this.session(id); }
  complete(id: string): SessionWire { this.now(); this.db.prepare("UPDATE sessions SET finished_at=COALESCE(finished_at,?),last_active_at=? WHERE id=? AND submitted_at IS NOT NULL").run(this.clock.now(), this.clock.now(), id); return this.session(id); }
  position(id: string, position: number, key?: string): SessionWire {
    invariant(Number.isSafeInteger(position) && position >= 0, "LOCAL_FILTER_INVALID", "Invalid session position"); this.now();
    this.db.prepare("UPDATE sessions SET position=?,last_active_at=? WHERE id=? AND finished_at IS NULL AND EXISTS(SELECT 1 FROM attempts WHERE session_id=? AND ordinal=?)").run(position, this.clock.now(), id, id, position);
    const session = this.session(id, key); if (position < (session.attemptCount ?? session.attempts.length)) session.position = position; return session;
  }
  flag(id: string, ordinal: number, value: boolean, key?: string): SessionWire {
    invariant(Number.isSafeInteger(ordinal) && ordinal >= 0, "LOCAL_FILTER_INVALID", "Invalid attempt ordinal"); this.expire(id);
    this.db.prepare("UPDATE attempts SET flagged=? WHERE session_id=? AND ordinal=? AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND submitted_at IS NULL AND finished_at IS NULL)").run(Number(value), id, ordinal, id);
    return this.session(id, key);
  }
  selfAssess(id: string, ordinal: number, result: boolean, key?: string): SessionWire {
    invariant(Number.isSafeInteger(ordinal) && ordinal >= 0, "LOCAL_FILTER_INVALID", "Invalid attempt ordinal");
    transaction(this.db, () => {
      const attempt = this.db.prepare("SELECT s.kind,a.submitted_at,a.skipped,a.auto_result,a.snapshot_question_id FROM attempts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=? AND a.ordinal=?").get(id, ordinal);
      invariant(attempt, "LOCAL_SELF_ASSESSMENT_INELIGIBLE", "This answer cannot be self-assessed");
      const snapshot = new QuestionIndex(this.context(id, String(attempt.snapshot_question_id))).snapshot(String(attempt.snapshot_question_id));
      this.now(); invariant(attempt.kind === "practice" && attempt.submitted_at !== null && !attempt.skipped && (attempt.auto_result === null || snapshot.question.answerMode === "fill_blank"), "LOCAL_SELF_ASSESSMENT_INELIGIBLE", "This answer cannot be self-assessed");
      this.db.prepare("UPDATE attempts SET result=?,grade_kind='self',max_cents=NULL,earned_cents=NULL WHERE session_id=? AND ordinal=?").run(Number(result), id, ordinal);
      this.db.prepare("UPDATE sessions SET last_active_at=? WHERE id=?").run(this.clock.now(), id);
    });
    return this.session(id, key);
  }
  manualScore(id: string, ordinal: number, cents: number, reason: string, key?: string): SessionWire {
    invariant(Number.isSafeInteger(ordinal) && ordinal >= 0 && Number.isSafeInteger(cents), "LOCAL_MANUAL_SCORE_INVALID", "Invalid manual score");
    invariant(reason.trim() && Buffer.byteLength(reason) <= 20000, "LOCAL_OVERRIDE_REASON_REQUIRED", "An override reason is required"); this.now();
    const manual = JSON.stringify({ scoreCents: cents, reason, at: this.clock.now() });
    const result = this.db.prepare("UPDATE attempts SET earned_cents=?3,result=(?3=max_cents),grade_kind='manual',grading=json_set(grading,'$.manual',json(?4),'$.manualHistory',json_insert(COALESCE(json_extract(grading,'$.manualHistory'),'[]'),'$[#]',json(?4))) WHERE session_id=?1 AND ordinal=?2 AND max_cents>=?3 AND ?3>=0 AND EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND submitted_at IS NOT NULL)").run(id, ordinal, cents, manual);
    invariant(result.changes === 1, "LOCAL_MANUAL_SCORE_INVALID", "Invalid manual score");
    this.db.prepare("UPDATE sessions SET last_active_at=? WHERE id=?").run(this.clock.now(), id); return this.session(id, key);
  }
  retryWrong(id: string, locale = "zh-CN"): SessionWire {
    const session = this.session(id), rows = thaw(this.document(id)), index = new QuestionIndex(rows);
    const roots = new Set(session.attempts.filter(a => a.result === false || a.earnedCents != null && a.maxCents != null && a.earnedCents < a.maxCents).map(a => a.snapshot?.rootId));
    invariant(roots.size, "LOCAL_WORK_UNAVAILABLE", "No mistakes to retry");
    const selected = rows.filter(row => roots.has(index.roots.get(row.id))), sid = randomUUID();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES(?,?,?,0,'ordered')").run(sid, locale === "en" ? "Retry session mistakes" : locale === "zh-TW" ? "本次錯題重練" : "本次错题重练", this.now());
      this.db.prepare("INSERT INTO session_documents VALUES(?,?)").run(sid, canonical(freeze(selected)));
      const insert = this.db.prepare("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id) VALUES(?,?,?,?)");
      selected.filter(row => !composite(row.question)).forEach((row, i) => insert.run(sid, i, row.id, row.id));
    });
    return this.session(sid);
  }
  list(limit: number, offset: number, filter = "all"): SessionPage {
    validatePage(limit, offset);
    const conditions: Record<string, string> = { all: "1", active: "s.finished_at IS NULL AND s.submitted_at IS NULL", review: "s.finished_at IS NULL AND s.submitted_at IS NOT NULL", finished: "s.finished_at IS NOT NULL" };
    invariant(Object.hasOwn(conditions, filter), "LOCAL_FILTER_INVALID", "Invalid session filter"); this.expire();
    const condition = conditions[filter];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS total FROM sessions s WHERE ${condition} AND EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id)`).get()!.total);
    offset = Math.min(offset, Math.floor(Math.max(0, total - 1) / limit) * limit);
    const sql = `WITH page AS (SELECT * FROM sessions s WHERE ${condition} AND EXISTS(SELECT 1 FROM attempts a WHERE a.session_id=s.id) ORDER BY COALESCE(last_active_at,created_at) DESC,id DESC LIMIT ?1 OFFSET ?2) SELECT s.id,s.bank_title,s.created_at,s.finished_at,COUNT(*),SUM(a.submitted_at IS NOT NULL),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents=a.max_cents ELSE a.result=1 END),SUM(CASE WHEN a.max_cents IS NOT NULL THEN a.earned_cents IS NOT NULL ELSE a.result IS NOT NULL END),SUM(a.skipped),SUM(a.elapsed_ms),SUM(a.grade_kind='self'),SUM(a.grade_kind='auto'),s.kind,s.submitted_at,SUM(a.max_cents),SUM(a.earned_cents),SUM(a.max_cents IS NOT NULL AND a.earned_cents IS NULL),s.deadline_at,COALESCE(s.last_active_at,s.created_at) FROM page s JOIN attempts a ON a.session_id=s.id GROUP BY s.id ORDER BY COALESCE(s.last_active_at,s.created_at) DESC,s.id DESC`;
    const items = [...sqlRows(this.db, sql, [limit, offset])].map(row => ({ id: String(row[0]), title: String(row[1]), createdAt: Number(row[2]), finishedAt: nullableNumber(row[3]), count: Number(row[4]), answered: Number(row[5]), correct: Number(row[6] ?? 0), graded: Number(row[7]), skipped: Number(row[8]), elapsedMs: Number(row[9]), selfGraded: Number(row[10]), autoGraded: Number(row[11]), kind: row[12], submittedAt: nullableNumber(row[13]), totalCents: nullableNumber(row[14]), earnedCents: nullableNumber(row[15]), pendingGrades: Number(row[16]), deadlineAt: nullableNumber(row[17]), lastActiveAt: Number(row[18]) })) as SessionSummary[];
    for (const session of items) {
      session.draftAnswered = this.db.prepare("SELECT answer FROM attempts WHERE session_id=? AND submitted_at IS NULL AND answer<>'null'").all(session.id).filter(row => hasAnswer(JSON.parse(String(row.answer)))).length;
      if (session.deadlineAt !== null && session.submittedAt === null) session.clockNow = this.now();
    }
    return { items, total, offset };
  }
}
