import { randomUUID } from "node:crypto";
import { openPracticeDatabase, transaction } from "./database.js";
import { AppError, invariant } from "./errors.js";
import { Assets } from "./assets.js";
import { composite as isComposite, list } from "./question-contract.js";
import { QuestionIndex, readQuestions, saveQuestionTree } from "./questions.js";
import { readDiagnostics } from "./diagnostics.js";
import { queryQuestions, type Query } from "./question-list.js";
import { previewPaper } from "./paper.js";
import { Sessions } from "./sessions.js";
import { Learning } from "./learning.js";
import { LegacySettings } from "./legacy-settings.js";
import { BankPackages } from "./bank-packages.js";
import { Backups } from "./backup.js";
import { Grading, type GradeTarget, type PreparedGrade } from "./grading.js";
import type { GradingResponse } from "../src/api.js";
import type { MistakeCause } from "../src/api.js";
import { COMPOSITE_MODES } from "../src/contracts.generated.js";
import type { BankChoice, BankPage } from "../src/api.js";

const composite = COMPOSITE_MODES.map(() => "?").join(",");
export class PracticeStore {
  private runtime;
  private recoveryRequired = false;
  constructor(readonly directory: string) { new LegacySettings(directory).recover(); this.runtime = this.open(); }
  private open() { const db = openPracticeDatabase(this.directory), assets = new Assets(this.directory, db), sessions = new Sessions(db, assets); return { db, assets, sessions, grading: new Grading(db, assets, sessions), learning: new Learning(this.directory, db), packages: new BankPackages(db, assets) }; }
  get db() { return this.runtime.db; }
  get assets() { return this.runtime.assets; }
  get sessions() { return this.runtime.sessions; }
  get grading() { return this.runtime.grading; }
  get learning() { return this.runtime.learning; }
  get packages() { return this.runtime.packages; }
  close() { if (!this.recoveryRequired) this.db.close(); }
  private async backup(path: string) {
    const result = await new Backups(this).export(path);
    try { this.learning.markBackup(); return result; } catch { return { ...result, reminderError: "LOCAL_BACKUP_REMINDER_FAILED" }; }
  }
  suspend() { if (!this.recoveryRequired) { this.db.close(); this.recoveryRequired = true; } }
  reopen() { invariant(this.recoveryRequired, "LOCAL_DATABASE_RESTART", "Database is already open"); this.runtime = this.open(); this.recoveryRequired = false; }

  banks(): BankChoice[] {
    return this.db.prepare(`SELECT b.id,b.title,(SELECT COUNT(*) FROM questions q WHERE q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN (${composite}))) AS count FROM banks b ORDER BY b.created_at DESC,b.id DESC`)
      .all(...COMPOSITE_MODES).map(row => ({ id: String(row.id), title: String(row.title), count: Number(row.count) }));
  }
  banksPage(limit: number, offset: number): BankPage {
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(offset) && offset >= 0,
      "LOCAL_FILTER_INVALID", "Invalid pagination");
    const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM banks").get()!.count);
    offset = Math.min(offset, Math.floor(Math.max(0, total - 1) / limit) * limit);
    const items = this.db.prepare(`WITH page AS (SELECT * FROM banks ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?) SELECT b.id,b.title,b.description,b.created_at,COUNT(q.id) AS count FROM page b LEFT JOIN questions q ON q.bank_id=b.id AND (q.mode IS NULL OR q.mode NOT IN (${composite})) GROUP BY b.id ORDER BY b.created_at DESC,b.id DESC`)
      .all(limit, offset, ...COMPOSITE_MODES).map(row => ({ id: String(row.id), title: String(row.title), description: String(row.description), createdAt: Number(row.created_at), count: Number(row.count) }));
    return { items, total, offset };
  }
  saveBank(id: string | null, title: string, description: string): string {
    title = title.trim();
    invariant([...title].length >= 1 && [...title].length <= 15, "LOCAL_NAME_INVALID", "Bank names must contain 1–15 characters");
    invariant([...description].length <= 50, "LOCAL_DESCRIPTION_TOO_LONG", "Descriptions must contain at most 50 characters");
    id ??= randomUUID();
    this.db.prepare("INSERT INTO banks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description")
      .run(id, title, description, Date.now());
    return id;
  }
  deleteBank(id: string): null {
    this.db.prepare("DELETE FROM banks WHERE id=?").run(id);
    this.collectAssets();
    return null;
  }
  language(): string | null { const value = this.db.prepare("SELECT locale FROM settings WHERE id=1").get()!.locale; return value === null ? null : String(value); }
  saveLanguage(locale: string): string {
    invariant(["zh-CN", "zh-TW", "en"].includes(locale), "LOCAL_FILTER_INVALID", "Unsupported language");
    this.db.prepare("UPDATE settings SET locale=? WHERE id=1").run(locale);
    return locale;
  }
  questionDetail(id: string) {
    const rows = readQuestions(this.db, this.assets, [], [id]), index = new QuestionIndex(rows), row = rows.find(row => row.id === id && !row.question.parentId);
    invariant(row, "LOCAL_FILTER_INVALID", "Question root is missing");
    const root = index.hydrate(row), tree = index.trees.get(id)!, ids = new Set(tree.map(item => item.id));
    root.answerableCount = tree.filter(item => !isComposite(item.question)).length;
    root.favorite = tree.some(item => item.favorite);
    root.importDiagnostics = readDiagnostics(this.db, row.bankId).filter(value => list(value, "questionIds").some(id => ids.has(String(id)))) as unknown as typeof root.importDiagnostics;
    root.children = tree.filter(item => item.id !== id);
    return root;
  }
  reviewQuestion(id: string, reviewed: boolean): number | null {
    return transaction(this.db, () => {
      invariant(this.db.prepare("SELECT EXISTS(SELECT 1 FROM questions WHERE id=? AND parent_id IS NULL) AS present").get(id)!.present, "LOCAL_REVIEW_ROOT_INVALID", "Select a complete question to review");
      const at = reviewed ? Math.max(0, Date.now()) : null;
      const tree = "WITH RECURSIVE tree(id) AS (SELECT id FROM questions WHERE id=? UNION SELECT q.id FROM questions q JOIN tree t ON q.parent_id=t.id)";
      if (at !== null) this.db.prepare(`${tree} INSERT OR REPLACE INTO question_reviews SELECT id,? FROM tree`).run(id, at);
      else this.db.prepare(`${tree} DELETE FROM question_reviews WHERE question_id IN (SELECT id FROM tree)`).run(id);
      return at;
    });
  }
  favorite(id: string, value: boolean): boolean {
    const result = this.db.prepare("WITH RECURSIVE subtree(id) AS (SELECT id FROM questions WHERE id=? UNION SELECT q.id FROM questions q JOIN subtree s ON q.parent_id=s.id) UPDATE questions SET favorite=? WHERE id IN subtree").run(id, Number(value));
    invariant(result.changes !== 0, "LOCAL_FAVORITE_DELETED", "Question is missing");
    return value;
  }
  deleteQuestion(id: string): null {
    const row = this.db.prepare("SELECT parent_id FROM questions WHERE id=?").get(id);
    invariant(row && row.parent_id === null, "LOCAL_GROUP_DELETE_CHILD", "Delete the complete question group");
    this.db.prepare("DELETE FROM questions WHERE id=?").run(id);
    this.collectAssets();
    return null;
  }
  private collectAssets(): void { try { this.assets.collect(); } catch { console.warn("Resource cleanup deferred"); } }
  request(input: unknown, locale = "zh-CN"): unknown {
    invariant(!this.recoveryRequired, "LOCAL_DATABASE_RESTART", "Database recovery is required; restart the application");
    invariant(input && typeof input === "object" && !Array.isArray(input), "LOCAL_FILTER_INVALID", "Invalid request");
    const request = input as Record<string, unknown>;
    const shapes: Record<string, Record<string, string>> = {
      banks: {}, banks_page: { limit: "number", offset: "number" },
      save_bank: { id: "nullableString", title: "string", description: "string" },
      delete_bank: { id: "string" }, language: {}, save_language: { locale: "string" }, info: {}, unfinished_session: {},
      save_question_tree: { bank_id: "string", root_id: "nullableString", questions: "array" },
      question_detail: { id: "string" }, delete_question: { id: "string" }, favorite: { id: "string", value: "boolean" }, review_question: { id: "string", reviewed: "boolean" }, asset: { hash: "string" },
      questions_page: { bank_ids: "strings", search: "string", mode: "string", filter: "string", limit: "number", offset: "number", include_stats: "optionalBoolean" },
      question_stats: { bank_ids: "strings", search: "string", mode: "string", filter: "string" },
      preview_paper: { request: "object" }, start_paper: { paper: "object" },
      session: { id: "string", snapshot_key: "optionalString" }, position: { id: "string", position: "number", snapshot_key: "optionalString" },
      sessions_page: { limit: "number", offset: "number", filter: "optionalString" },
      save_draft: { id: "string", ordinal: "number", answer: "json", elapsed_ms: "number" },
      save_attempt: { id: "string", ordinal: "number", answer: "json", elapsed_ms: "number", submit: "boolean", skip: "boolean", snapshot_key: "optionalString" },
      submit_paper: { id: "string", submit_drafts: "boolean" }, complete_review: { id: "string" }, retry_wrong: { id: "string" },
      flag: { id: "string", ordinal: "number", value: "boolean", snapshot_key: "optionalString" },
      self_assess: { id: "string", ordinal: "number", result: "boolean", snapshot_key: "optionalString" },
      manual_score: { id: "string", ordinal: "number", cents: "number", reason: "string", snapshot_key: "optionalString" },
      question_note: { id: "string" }, save_question_note: { id: "string", body: "string", cause: "nullableString" },
      backup_status: {}, learning_overview: { days: "number", today_start: "number", since: "number" },
      _preview_bank_zip: { path: "string" }, _export_bank: { bank_id: "string", path: "string" },
      import: { ticket: "string", bank_id: "nullableString", title: "string", skip_duplicates: "optionalBoolean", duplicate_check: "optionalString" },
      import_duplicates: { ticket: "string", bank_id: "string" },
      _import_document_bank: { value: "object", resources: "array", selection: "object" },
      merge_banks: { bank_ids: "strings", title: "string" }, add_example_bank: {},
      _backup: { path: "string" }, _restore: { path: "string", recover_assets: "optionalBoolean" },
      _prepare_grade: { id: "string", ordinal: "number", retry: "boolean", target: "object" },
      _record_grade: { id: "string", ordinal: "number", prepared: "object", response: "object", snapshot_key: "optionalString" },
    };
    const shape = typeof request.type === "string" && Object.hasOwn(shapes, request.type) ? shapes[request.type] : null;
    invariant(shape, "OPERATION_FAILED", "This operation has not been migrated yet");
    invariant(Object.keys(request).every(key => key === "type" || Object.hasOwn(shape, key)) && Object.entries(shape).every(([key, kind]) =>
      kind === "nullableString" ? request[key] === null || typeof request[key] === "string" : kind === "array" ? Array.isArray(request[key]) : kind === "strings" ? Array.isArray(request[key]) && request[key].every(value => typeof value === "string") : kind === "optionalBoolean" ? request[key] === undefined || typeof request[key] === "boolean" : kind === "optionalString" ? request[key] === undefined || typeof request[key] === "string" : kind === "json" ? Object.hasOwn(request, key) && request[key] !== undefined : kind === "object" ? request[key] !== null && typeof request[key] === "object" && !Array.isArray(request[key]) : typeof request[key] === kind),
    "LOCAL_FILTER_INVALID", "Invalid request fields");
    switch (request.type) {
      case "_import_document_bank": return this.packages.importDocument(request.value, request.resources as unknown[], request.selection as import("../src/contracts.generated.js").DesktopDocumentBankSelection);
      case "_prepare_grade": return this.grading.prepare(request.id as string, request.ordinal as number, request.retry as boolean, locale, request.target as unknown as GradeTarget);
      case "_record_grade": return this.grading.record(request.id as string, request.ordinal as number, request.prepared as unknown as PreparedGrade, request.response as unknown as GradingResponse, request.snapshot_key as string | undefined);
      case "_backup": return this.backup(request.path as string);
      case "_restore": return new Backups(this).restore(request.path as string, request.recover_assets === true);
      case "_preview_bank_zip": return this.packages.previewZip(request.path as string);
      case "_export_bank": return this.packages.export(request.bank_id as string, request.path as string);
      case "import": return this.packages.import(request.ticket as string, request.bank_id as string | null, request.title as string, request.skip_duplicates === true, request.duplicate_check as string | undefined);
      case "import_duplicates": return this.packages.duplicates(request.ticket as string, request.bank_id as string);
      case "merge_banks": return this.packages.merge(request.bank_ids as string[], request.title as string, locale);
      case "add_example_bank": return this.packages.addExample();
      case "banks": return this.banks();
      case "banks_page": return this.banksPage(request.limit as number, request.offset as number);
      case "save_bank": return this.saveBank(request.id as string | null, request.title as string, request.description as string);
      case "delete_bank": return this.deleteBank(request.id as string);
      case "language": return this.language();
      case "save_language": return this.saveLanguage(request.locale as string);
      case "unfinished_session": return this.sessions.list(1, 0, "active").items[0] ?? null;
      case "save_question_tree": return saveQuestionTree(this.db, this.assets, request.bank_id as string, request.root_id as string | null, request.questions as unknown[]);
      case "question_detail": return this.questionDetail(request.id as string);
      case "delete_question": return this.deleteQuestion(request.id as string);
      case "favorite": return this.favorite(request.id as string, request.value as boolean);
      case "review_question": return this.reviewQuestion(request.id as string, request.reviewed as boolean);
      case "asset": { const asset = this.packages.asset(request.hash as string); invariant(asset, "LOCAL_ASSET_MISSING", "Resource is missing"); return Uint8Array.from(asset.bytes).buffer; }
      case "questions_page": return queryQuestions(this.db, request as unknown as Query, { limit: request.limit as number, offset: request.offset as number }, request.include_stats === true);
      case "question_stats": return queryQuestions(this.db, request as unknown as Query);
      case "preview_paper": return previewPaper(this.db, this.assets, request.request);
      case "start_paper": return this.sessions.createPaper(request.paper, locale);
      case "session": return this.sessions.session(request.id as string, request.snapshot_key as string | undefined);
      case "sessions_page": return this.sessions.list(request.limit as number, request.offset as number, (request.filter as string) || "all");
      case "save_draft": this.sessions.writeAttempt(request.id as string, request.ordinal as number, request.answer, request.elapsed_ms as number, false, false); return null;
      case "save_attempt": this.sessions.writeAttempt(request.id as string, request.ordinal as number, request.answer, request.elapsed_ms as number, request.submit as boolean, request.skip as boolean); return this.sessions.session(request.id as string, request.snapshot_key as string | undefined);
      case "position": return this.sessions.position(request.id as string, request.position as number, request.snapshot_key as string | undefined);
      case "submit_paper": return this.sessions.submit(request.id as string, request.submit_drafts as boolean);
      case "complete_review": return this.sessions.complete(request.id as string);
      case "retry_wrong": return this.sessions.retryWrong(request.id as string, locale);
      case "flag": return this.sessions.flag(request.id as string, request.ordinal as number, request.value as boolean, request.snapshot_key as string | undefined);
      case "self_assess": return this.sessions.selfAssess(request.id as string, request.ordinal as number, request.result as boolean, request.snapshot_key as string | undefined);
      case "manual_score": return this.sessions.manualScore(request.id as string, request.ordinal as number, request.cents as number, request.reason as string, request.snapshot_key as string | undefined);
      case "question_note": return this.learning.note(request.id as string);
      case "save_question_note": return this.learning.saveNote(request.id as string, request.body as string, request.cause as MistakeCause | null);
      case "backup_status": return this.learning.status();
      case "learning_overview": return this.learning.overview(request.days as number, request.today_start as number, request.since as number);
      case "info": return { dataDirectory: this.directory, version: "0.2.2" };
      default: throw new AppError("OPERATION_FAILED", "Unsupported operation");
    }
  }
}
