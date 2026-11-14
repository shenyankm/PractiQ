import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { invariant } from "./errors.js";
import { fileDigest, regularFileExists, syncDirectory } from "./filesystem.js";
import { transaction, validatePracticeDatabase } from "./database.js";
import { Learning, LEARNING_DATA_LIMIT, validateLearningData, type LearningData } from "./learning.js";
import { object } from "./question-contract.js";

const schema = "CREATE TABLE service_settings(id INTEGER PRIMARY KEY CHECK(id=1),active TEXT NOT NULL,pending TEXT)";
export interface LegacyConnection { base_url: string | null; model_id: string | null }
export interface LegacyConfig { service_url: string | null; model?: LegacyConnection }
export interface LearningRestore { previous: LearningData; next: LearningData }
interface PendingRestore { candidate_sha256: string; previous: LegacyConfig | null; next: LegacyConfig | null; learning?: LearningRestore }
interface State { active: LegacyConfig | null; pending: PendingRestore | null }
function strict(input: unknown, fields: string[]): Record<string, unknown> {
  invariant(input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => fields.includes(key)), "LOCAL_RESPONSE_INVALID", "Unsupported legacy settings fields"); return object(input);
}
function url(value: unknown): string | null {
  invariant(value == null || typeof value === "string", "LOCAL_URL_INVALID", "Invalid legacy URL");
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim(); invariant(Buffer.byteLength(raw) <= 2048, "LOCAL_URL_TOO_LONG", "Legacy URL exceeds its size limit");
  const parsed = new URL(raw), loopback = parsed.hostname === "localhost" || parsed.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/.test(parsed.hostname);
  invariant(parsed.protocol === "https:" || parsed.protocol === "http:" && loopback, "LOCAL_URL_HTTPS_REQUIRED", "HTTPS is required for a non-loopback endpoint");
  invariant(parsed.hostname && !parsed.username && !parsed.password && !raw.includes("?") && !raw.includes("#"), "LOCAL_URL_CREDENTIALS_FORBIDDEN", "Legacy URLs cannot contain credentials, queries or fragments");
  return parsed.href.replace(/\/+$/, "");
}
export function validateLegacyConfig(input: unknown): LegacyConfig | null {
  if (input === null) return null;
  const record = strict(input, ["service_url", "model"]), config: LegacyConfig = { service_url: url(record.service_url) };
  if (record.model != null) {
    const model = strict(record.model, ["base_url", "model_id"]);
    invariant(model.model_id == null || typeof model.model_id === "string", "LOCAL_MODEL_ID_INVALID", "Invalid historical model ID");
    const id = typeof model.model_id === "string" ? model.model_id.trim() || null : null;
    invariant(id === null || [...id].length <= 255 && !/\p{Cc}/u.test(id), "LOCAL_MODEL_ID_INVALID", "Invalid historical model ID");
    config.model = { base_url: url(model.base_url), model_id: id };
  }
  return config;
}
function validateState(active: unknown, pending: unknown): State {
  const state: State = { active: validateLegacyConfig(active), pending: null };
  if (pending !== null) {
    const p = strict(pending, ["candidate_sha256", "previous", "next", "learning"]);
    invariant(typeof p.candidate_sha256 === "string" && /^[a-f0-9]{64}$/.test(p.candidate_sha256), "LOCAL_RESPONSE_INVALID", "Invalid service settings restore digest");
    state.pending = { candidate_sha256: p.candidate_sha256, previous: validateLegacyConfig(p.previous ?? null), next: validateLegacyConfig(p.next ?? null) };
    if (p.learning != null) {
      const learning = strict(p.learning, ["previous", "next"]);
      state.pending.learning = { previous: validateLearningData(learning.previous), next: validateLearningData(learning.next) };
    }
  }
  return state;
}
function empty(db: DatabaseSync): boolean { return db.prepare("PRAGMA user_version").get()?.user_version === 0 && db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count === 0; }
function read(db: DatabaseSync): State {
  db.exec("PRAGMA trusted_schema=OFF");
  invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 &&
    JSON.stringify(db.prepare("SELECT type,name,COALESCE(sql,'') AS sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all()) === JSON.stringify([{ type: "table", name: "service_settings", sql: schema }]), "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported service settings database");
  const row = db.prepare("SELECT active,pending FROM service_settings WHERE id=1").get();
  invariant(row && typeof row.active === "string" && Buffer.byteLength(row.active) <= 8192 && (row.pending === null || typeof row.pending === "string" && Buffer.byteLength(row.pending) <= 2 * LEARNING_DATA_LIMIT + 32768), "LOCAL_RESPONSE_INVALID", "Service settings exceed their size limit");
  return validateState(JSON.parse(row.active), row.pending === null ? null : JSON.parse(String(row.pending)));
}
/** Historical settings are backup metadata; they never configure the embedded AI. */
export class LegacySettings {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, "service-settings-v1.sqlite"); }
  read(): State {
    if (!regularFileExists(this.path)) return { active: null, pending: null };
    const db = new DatabaseSync(this.path, { readOnly: true });
    try { db.exec("PRAGMA trusted_schema=OFF"); return empty(db) ? { active: null, pending: null } : read(db); }
    finally { db.close(); }
  }
  private update(change: (state: State) => State): void {
    regularFileExists(this.path);
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
      transaction(db, () => {
        if (empty(db)) { db.exec(`${schema}; PRAGMA user_version=1`); db.prepare("INSERT INTO service_settings VALUES(1,'null',NULL)").run(); }
        const next = change(read(db)), state = validateState(next.active, next.pending), active = JSON.stringify(state.active), pending = state.pending ? JSON.stringify(state.pending) : null;
        invariant(Buffer.byteLength(active) <= 8192 && (pending === null || Buffer.byteLength(pending) <= 2 * LEARNING_DATA_LIMIT + 32768), "LOCAL_RESPONSE_INVALID", "Service settings exceed their size limit");
        db.prepare("UPDATE service_settings SET active=?,pending=? WHERE id=1").run(active, pending);
      });
    } finally { db.close(); }
    syncDirectory(this.directory);
  }
  prepare(next: LegacyConfig | null, digest: string, learning?: LearningRestore): void {
    this.update(state => { invariant(!state.pending, "LOCAL_DATABASE_RESTART", "Service settings restoration is pending"); return { ...state, pending: { candidate_sha256: digest, previous: state.active, next, ...(learning ? { learning } : {}) } }; });
  }
  finish(published: boolean, practice: DatabaseSync): void {
    this.update(state => {
      invariant(state.pending, "LOCAL_DATABASE_RESTART", "Service settings restoration is not pending");
      const pending = state.pending;
      if (pending.learning) new Learning(this.directory, practice).publish(published ? pending.learning.next : pending.learning.previous);
      return { active: published ? pending.next : pending.previous, pending: null };
    });
  }
  recover(): void {
    const state = this.read(); if (!state.pending) return;
    const path = join(this.directory, "practiq.sqlite");
    invariant(regularFileExists(path), "LOCAL_DATABASE_RESTART", "Practice database recovery is required");
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA trusted_schema=OFF"); db.prepare("PRAGMA schema_version").get(); validatePracticeDatabase(db);
    } finally { db.close(); }
    const published = fileDigest(path, 512 * 1024 * 1024).sha256 === state.pending.candidate_sha256;
    const practice = new DatabaseSync(path, { readOnly: true });
    try { this.finish(published, practice); } finally { practice.close(); }
  }
}
