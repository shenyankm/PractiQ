import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "./errors.js";
import { transaction } from "./database.js";
import { regularFileExists } from "./filesystem.js";

const schema = `
BEGIN IMMEDIATE;
CREATE TABLE ai_tasks(id TEXT PRIMARY KEY,source_digest TEXT NOT NULL,max_calls INTEGER NOT NULL CHECK(max_calls>0),state TEXT NOT NULL CHECK(json_valid(state)),created_at INTEGER NOT NULL);
CREATE TABLE ai_calls(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES ai_tasks(id),call_key TEXT NOT NULL,input_digest TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,prompt_version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('unknown','succeeded','failed')),result TEXT CHECK(result IS NULL OR json_valid(result)),usage TEXT CHECK(usage IS NULL OR json_valid(usage)),created_at INTEGER NOT NULL,finished_at INTEGER,UNIQUE(task_id,call_key));
CREATE INDEX ai_calls_task ON ai_calls(task_id,created_at,id);
PRAGMA user_version=1;
COMMIT;`;
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
export interface CallTarget { inputDigest: string; endpoint: string; model: string; promptVersion: string }
export interface CallReceipt extends CallTarget {
  id: string; taskId: string; key: string; status: "unknown" | "succeeded" | "failed";
  result: unknown; usage: unknown;
}

function definitions(db: DatabaseSync) {
  return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
}
function validate(db: DatabaseSync) {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(schema);
    invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 &&
      JSON.stringify(definitions(db)) === JSON.stringify(definitions(expected)),
    "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported AI database; existing data remains unchanged");
  } finally { expected.close(); }
}

/** Durable paid-call claims are independent of LangGraph checkpoint replay. */
export class AiDatabase {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "ai.sqlite");
    if (regularFileExists(path)) {
      const candidate = new DatabaseSync(path, { readOnly: true });
      try {
        candidate.exec("PRAGMA trusted_schema=OFF");
        const version = candidate.prepare("PRAGMA user_version").get()?.user_version;
        const objects = candidate.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count;
        if (version !== 0 || objects !== 0) validate(candidate);
      } finally { candidate.close(); }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON");
      if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) {
        invariant(this.db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count === 0,
          "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Cannot initialize a nonempty AI database");
        this.db.exec(schema);
      }
      validate(this.db);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  createTask(sourceDigest: string, maxCalls: number, id: string = randomUUID()): string {
    invariant(digest(sourceDigest) && Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 10000,
      "LOCAL_FILTER_INVALID", "Invalid source digest or model-call budget");
    invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id), "LOCAL_FILTER_INVALID", "Invalid task identity");
    const previous = this.db.prepare("SELECT source_digest,max_calls FROM ai_tasks WHERE id=?").get(id);
    if (previous) { invariant(previous.source_digest === sourceDigest && previous.max_calls === maxCalls, "AI_CALL_CONFLICT", "Task identity is bound to different input or limits"); return id; }
    this.db.prepare("INSERT INTO ai_tasks VALUES(?,?,?,'{}',?)").run(id, sourceDigest, maxCalls, Date.now());
    return id;
  }
  saveState(id: string, state: unknown): void {
    const serialized = JSON.stringify(state);
    invariant(serialized !== undefined && Buffer.byteLength(serialized) <= 16 * 1024 * 1024,
      "LOCAL_FILE_TOO_LARGE", "AI task state exceeds its limit");
    invariant(this.db.prepare("UPDATE ai_tasks SET state=? WHERE id=?").run(serialized, id).changes === 1,
      "LOCAL_FILTER_INVALID", "AI task does not exist");
  }
  state(id: string): unknown {
    const row = this.db.prepare("SELECT state FROM ai_tasks WHERE id=?").get(id);
    invariant(row, "LOCAL_FILTER_INVALID", "AI task does not exist");
    return JSON.parse(String(row.state));
  }
  updateState(id: string, update: (state: unknown) => unknown): void { transaction(this.db, () => this.saveState(id, update(this.state(id)))); }
  receipt(taskId: string, key: string): CallReceipt | null {
    const row = this.db.prepare("SELECT * FROM ai_calls WHERE task_id=? AND call_key=?").get(taskId, key);
    if (!row) return null;
    return { id: String(row.id), taskId: String(row.task_id), key: String(row.call_key),
      inputDigest: String(row.input_digest), endpoint: String(row.endpoint), model: String(row.model), promptVersion: String(row.prompt_version),
      status: row.status as CallReceipt["status"], result: row.result === null ? null : JSON.parse(String(row.result)), usage: row.usage === null ? null : JSON.parse(String(row.usage)) };
  }
  claim(taskId: string, key: string, target: CallTarget): CallReceipt {
    invariant(key.length > 0 && key.length <= 512 && digest(target.inputDigest) && target.endpoint.length > 0 && target.endpoint.length <= 2048 &&
      target.model.length > 0 && target.model.length <= 255 && target.promptVersion.length > 0 && target.promptVersion.length <= 255,
    "LOCAL_FILTER_INVALID", "Invalid paid-call identity");
    const url = new URL(target.endpoint);
    invariant(!url.username && !url.password && !target.endpoint.includes("?") && !target.endpoint.includes("#") &&
      (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "LOCAL_URL_INVALID", "Invalid model endpoint");
    return transaction(this.db, () => {
      // Even a matching unknown claim cannot be sent again; only a new explicit retry may claim a new key.
      invariant(!this.receipt(taskId, key), "LOCAL_WORK_UNAVAILABLE", "This paid call already has a receipt; inspect its outcome before an explicit retry");
      const task = this.db.prepare("SELECT max_calls FROM ai_tasks WHERE id=?").get(taskId);
      invariant(task, "LOCAL_FILTER_INVALID", "AI task does not exist");
      // Recognition has its own bounded source plan; only model calls consume the model allowance.
      if (target.endpoint !== "https://ocr.tencentcloudapi.com") {
        const count = Number(this.db.prepare("SELECT count(*) AS count FROM ai_calls WHERE task_id=? AND endpoint!='https://ocr.tencentcloudapi.com'").get(taskId)!.count);
        invariant(count < Number(task.max_calls), "MODEL_BUDGET_EXCEEDED", "Model-call budget exhausted");
      }
      this.db.prepare("INSERT INTO ai_calls(id,task_id,call_key,input_digest,endpoint,model,prompt_version,status,created_at) VALUES(?,?,?,?,?,?,?,'unknown',?)")
        .run(randomUUID(), taskId, key, target.inputDigest, target.endpoint, target.model, target.promptVersion, Date.now());
      return this.receipt(taskId, key)!;
    });
  }
  finish(taskId: string, key: string, status: "succeeded" | "failed", result: unknown, usage: unknown): void {
    const resultJson = JSON.stringify(result), usageJson = JSON.stringify(usage);
    invariant(["succeeded", "failed"].includes(status) && resultJson !== undefined && usageJson !== undefined &&
      Buffer.byteLength(resultJson) <= 16 * 1024 * 1024 && Buffer.byteLength(usageJson) <= 64 * 1024,
    "LOCAL_FILTER_INVALID", "Invalid paid-call result");
    invariant(this.db.prepare("UPDATE ai_calls SET status=?,result=?,usage=?,finished_at=? WHERE task_id=? AND call_key=? AND status='unknown'")
      .run(status, resultJson, usageJson, Date.now(), taskId, key).changes === 1,
    "LOCAL_WORK_UNAVAILABLE", "Paid-call receipt is missing or already finalized");
  }
}
