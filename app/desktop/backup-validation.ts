import type { DatabaseSync } from "node:sqlite";
import { Assets } from "./assets.js";
import { validateContract } from "./contracts.js";
import { validatePracticeDatabase } from "./database.js";
import { readDiagnostics } from "./diagnostics.js";
import { invariant } from "./errors.js";
import { validateLegacyConfig } from "./legacy-settings.js";
import { validateSegment } from "./media.js";
import { composite, list, object, text, unique, validateAttempt, validateTree } from "./question-contract.js";
import { freeze, QuestionIndex, readQuestions, thaw } from "./questions.js";

export const BACKUP_LIMIT = 512 * 1024 * 1024;
export const BACKUP_MANIFEST_LIMIT = 16 * 1024 * 1024;
export const BACKUP_ARCHIVE_LIMIT = BACKUP_LIMIT + 2 * BACKUP_MANIFEST_LIMIT;
const details = { choice: "choice_questions", true_false: "true_false_questions", fill_blank: "fill_blank_questions", short_answer: "short_answer_questions", ordering: "ordering_questions", matching: "matching_questions", listening: "listening_questions", reading: "reading_questions", word_bank: "word_bank_questions", cloze: "cloze_questions", gap_fill: "gap_fill_questions" };
const navigation = `SELECT EXISTS(
  SELECT 1 FROM banks WHERE typeof(id)!='text' OR typeof(title)!='text'
      OR typeof(description)!='text' OR typeof(created_at)!='integer'
) OR EXISTS(
  SELECT 1 FROM sessions s LEFT JOIN attempts a ON a.session_id=s.id GROUP BY s.id
  HAVING COUNT(a.ordinal)=0 OR MIN(a.ordinal)!=0 OR MAX(a.ordinal)!=COUNT(a.ordinal)-1
      OR SUM(typeof(a.ordinal)!='integer')>0 OR typeof(s.position)!='integer'
      OR s.position<0 OR s.position>=COUNT(a.ordinal)
      OR typeof(s.created_at)!='integer'
      OR typeof(s.mode)!='text' OR typeof(s.bank_title)!='text'
      OR SUM(typeof(a.grade_kind)!='text' OR typeof(a.grading)!='text')>0
      OR typeof(s.last_active_at) NOT IN ('integer','null')
      OR typeof(s.submitted_at) NOT IN ('integer','null')
      OR typeof(s.finished_at) NOT IN ('integer','null')
      OR typeof(s.deadline_at) NOT IN ('integer','null')
      OR SUM(typeof(a.submitted_at) NOT IN ('integer','null')
          OR typeof(a.elapsed_ms)!='integer'
          OR typeof(a.max_cents) NOT IN ('integer','null')
          OR typeof(a.earned_cents) NOT IN ('integer','null')
          OR typeof(a.skipped)!='integer' OR typeof(a.flagged)!='integer'
          OR typeof(a.auto_result) NOT IN ('integer','null')
          OR typeof(a.result) NOT IN ('integer','null'))>0
) OR EXISTS(
  SELECT 1 FROM listening_playback
  WHERE typeof(updated_at)!='integer' OR typeof(active_elapsed_ms)!='integer'
) AS invalid`;

function context(groups: unknown[], visuals: unknown[], ids: Set<string>): void {
  for (const [values, model] of [[groups, "DocumentGroup"], [visuals, "DocumentVisual"]] as const) for (const value of values) {
    const item = object(structuredClone(value)); delete item.id;
    validateContract(model, item);
    invariant(unique(list(item, "questionIds")) && list(item, "questionIds").every(id => typeof id === "string" && ids.has(id)), "LOCAL_BACKUP_RELATIONS", "Context references a duplicate or missing question");
  }
}
function validateTables(db: DatabaseSync): void {
  const union = Object.entries(details).map(([mode, table]) => `SELECT question_id,'${mode}' AS mode FROM ${table}`).join(" UNION ALL ");
  for (const row of db.prepare(`WITH details AS (${union}) SELECT COALESCE(q.mode,'') AS mode,COUNT(d.question_id) AS count,COALESCE(SUM(d.mode!=COALESCE(q.mode,'')),0) AS mismatches FROM questions q LEFT JOIN details d ON d.question_id=q.id GROUP BY q.id`).all()) {
    invariant(row.mismatches === 0 && row.count === Number(Boolean(row.mode)), "LOCAL_BACKUP_RELATIONS", "Question must have exactly one matching detail row");
  }
  const invalid = db.prepare(`SELECT EXISTS(SELECT 1 FROM questions q JOIN questions p ON p.id=q.parent_id WHERE q.bank_id!=p.bank_id)
    OR EXISTS(SELECT 1 FROM questions q JOIN imports i ON i.id=q.import_id WHERE q.bank_id!=i.bank_id)
    OR EXISTS(SELECT 1 FROM word_bank_questions WHERE option_set_id!=question_id)
    OR EXISTS(SELECT 1 FROM option_sets o JOIN questions q ON q.id=o.id WHERE q.mode NOT IN ('choice','word_bank'))
    OR EXISTS(SELECT 1 FROM section_questions x JOIN sections s ON s.id=x.section_id JOIN questions q ON q.id=x.question_id WHERE s.bank_id!=q.bank_id)
    OR EXISTS(SELECT 1 FROM question_visuals x JOIN visuals v ON v.id=x.visual_id JOIN questions q ON q.id=x.question_id WHERE v.bank_id!=q.bank_id) AS invalid`).get()!.invalid;
  invariant(!invalid, "LOCAL_BACKUP_RELATIONS", "Inconsistent question context or option ownership");
}

export function validateBackupContents(db: DatabaseSync, assets: Assets): void {
  validatePracticeDatabase(db);
  for (const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'").all()) {
    const name = String(table.name), quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const conditions = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => {
      const key = quote(String(column.name)), types = column.type === "TEXT" ? "'text','null'" : column.type === "INTEGER" ? "'integer','null'" : "'integer','real','null'";
      return `(typeof(${key}) NOT IN (${types})${column.notnull || column.pk ? ` OR ${key} IS NULL` : ""})`;
    });
    invariant(!db.prepare(`SELECT 1 FROM ${quote(name)} WHERE ${conditions.join(" OR ")} LIMIT 1`).get(), "LOCAL_BACKUP_RELATIONS", "Invalid database storage class");
  }
  const settings = db.prepare("SELECT base_url,model_id,locale FROM settings WHERE id=1").get();
  invariant(settings && (settings.locale === null || ["zh-CN", "zh-TW", "en"].includes(String(settings.locale))), "LOCAL_RESPONSE_INVALID", "Invalid locale");
  validateLegacyConfig({ service_url: null, model: { base_url: settings.base_url, model_id: settings.model_id } });
  const checks = db.prepare("PRAGMA integrity_check").all();
  invariant(checks.length === 1 && Object.values(checks[0])[0] === "ok", "LOCAL_BACKUP_INTEGRITY", "Database integrity check failed");
  invariant(!db.prepare("PRAGMA foreign_key_check").get() && !db.prepare(navigation).get()!.invalid, "LOCAL_BACKUP_RELATIONS", "Invalid database relationships or storage classes");
  const rows = readQuestions(db, assets), ids = new Set(rows.map(row => row.id));
  for (const row of db.prepare("SELECT content FROM visuals").all()) context([], [JSON.parse(String(row.content))], ids);
  validateTree(rows.map(row => row.question)); validateTables(db);
  for (const bank of db.prepare("SELECT id FROM banks").all()) readDiagnostics(db, String(bank.id));
  const document = freeze(rows); context(list(document, "groups"), list(document, "visuals"), ids);
  for (const saved of db.prepare("SELECT session_id,content FROM session_documents").iterate()) {
    const raw = String(saved.content); invariant(Buffer.byteLength(raw) <= BACKUP_LIMIT, "LOCAL_BACKUP_SNAPSHOT_FIELD", "Snapshot exceeds backup limit", { key: "session_documents.content" });
    const document = object(JSON.parse(raw)), rows = thaw(document);
    invariant(rows.every(row => row.id === row.question.id), "LOCAL_BACKUP_RELATIONS", "Frozen question identity mismatch");
    const questions = validateTree(rows.map(row => row.question)); rows.forEach((row, i) => { row.question = questions[i]; });
    context(list(document, "groups"), list(document, "visuals"), new Set(rows.map(row => row.id)));
    const index = new QuestionIndex(rows), remaining = new Set(rows.filter(row => !composite(row.question)).map(row => row.id)), selected = new Map<string, Set<string>>();
    for (const attempt of db.prepare("SELECT snapshot_question_id,answer FROM attempts WHERE session_id=? ORDER BY ordinal").iterate(saved.session_id)) {
      const id = String(attempt.snapshot_question_id), raw = String(attempt.answer);
      invariant(remaining.delete(id), "LOCAL_BACKUP_RELATIONS", "Attempt refers to a duplicate or missing question");
      invariant(Buffer.byteLength(raw) <= 256 * 1024, "LOCAL_ANSWER_INVALID", "Answer exceeds size limit");
      const answer = JSON.parse(raw), question = index.snapshot(id).question; validateAttempt(question, answer);
      const owner = question.optionSourceId && index.byId.get(question.optionSourceId);
      if (owner && !owner.question.allowReuse) {
        const used = selected.get(owner.id) ?? new Set<string>(); selected.set(owner.id, used);
        for (const option of list(answer, "correct")) {
          const key = String(option).replace(/[A-Z]/g, value => value.toLowerCase());
          invariant(!used.has(key), "LOCAL_WORD_REUSED", "An exclusive word-bank option is reused"); used.add(key);
        }
      }
    }
    invariant(!remaining.size, "LOCAL_BACKUP_RELATIONS", "Snapshot questions are missing attempts");
    const session = db.prepare("SELECT kind FROM sessions WHERE id=?").get(saved.session_id)!;
    for (const play of db.prepare("SELECT question_id,used,position,active FROM listening_playback WHERE session_id=?").all(saved.session_id)) {
      const q = index.byId.get(String(play.question_id))?.question, position = Number(play.position), used = Number(play.used);
      invariant(q?.answerMode === "listening" && Number.isSafeInteger(used) && used >= 0 && Number.isFinite(position) && position >= (q.audioStartSeconds ?? 0) && position <= (q.audioEndSeconds ?? 86400) + 0.1 && (!play.active || used > 0) && (session.kind === "practice" || used <= (q.examPlayCount ?? 2)), "LOCAL_BACKUP_RELATIONS", "Invalid saved playback state");
    }
  }
  invariant(!db.prepare("SELECT 1 FROM sessions s LEFT JOIN session_documents d ON d.session_id=s.id WHERE d.session_id IS NULL").get(), "LOCAL_BACKUP_RELATIONS", "Session snapshot is missing");
}

export function validateBackupAudio(db: DatabaseSync, durations: Map<string, number>): void {
  if (!durations.size) return;
  const validate = (q: unknown) => { const duration = durations.get(text(object(q).audioRef, "sha256")); if (duration !== undefined) validateSegment(q, duration); };
  for (const row of db.prepare("SELECT audio_ref,start_seconds,end_seconds FROM listening_questions").iterate()) validate({ audioRef: JSON.parse(String(row.audio_ref)), audioStartSeconds: row.start_seconds, audioEndSeconds: row.end_seconds });
  for (const row of db.prepare("SELECT content FROM session_documents").iterate()) for (const value of list(JSON.parse(String(row.content)), "questions")) validate(object(value).question);
}
