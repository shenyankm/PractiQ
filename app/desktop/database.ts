import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./errors.js";
import { regularFileExists } from "./filesystem.js";

export const practiceSchema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
export const oldSettingsSql = "CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT,model_id TEXT,locale TEXT CHECK(locale IS NULL OR locale IN('zh-CN','en')))";
const sidecarSql = "CREATE TABLE service_settings(id INTEGER PRIMARY KEY CHECK(id=1),active TEXT NOT NULL,pending TEXT)";

function schema(db: DatabaseSync): string[] {
  return db.prepare("SELECT type||':'||name||':'||COALESCE(sql,'') AS definition FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name")
    .all().map(row => String(row.definition).replaceAll("\r\n", "\n"));
}

export function validatePracticeDatabase(db: DatabaseSync): void {
  invariant(db.prepare("PRAGMA user_version").get()?.user_version === 11,
    "LOCAL_BACKUP_DATABASE_VERSION", "Only database schema 11 is supported; existing data remains unchanged");
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(practiceSchema);
    const definitions = schema(expected);
    const settings = definitions.find(row => row.startsWith("table:settings:"))!;
    const candidate = schema(db).map(row => row === `table:settings:${oldSettingsSql}` ? settings : row);
    invariant(JSON.stringify(candidate) === JSON.stringify(definitions),
      "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported database schema; existing data remains unchanged");
  } finally { expected.close(); }
}

function checkRestore(directory: string): void {
  const path = join(directory, "service-settings-v1.sqlite");
  if (!regularFileExists(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    const objects = db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count;
    if (version === 0 && objects === 0) return;
    invariant(version === 1 && JSON.stringify(schema(db)) === JSON.stringify([`table:service_settings:${sidecarSql}`]),
      "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported service settings database");
    const state = db.prepare("SELECT active,pending FROM service_settings WHERE id=1").get();
    invariant(state, "LOCAL_DATABASE_UNAVAILABLE", "Service settings state is missing");
    // A pending restore must be resolved before *any* practice database writes.
    invariant(state.pending === null, "LOCAL_DATABASE_RESTART", "Database restoration requires recovery before continuing");
  } finally { db.close(); }
}

export function openPracticeDatabase(directory: string): DatabaseSync {
  checkRestore(directory);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "practiq.sqlite");
  if (regularFileExists(path)) {
    const candidate = new DatabaseSync(path, { readOnly: true });
    try {
      candidate.exec("PRAGMA trusted_schema=OFF");
      const version = candidate.prepare("PRAGMA user_version").get()?.user_version;
      const objects = candidate.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count;
      if (version !== 0 || objects !== 0) validatePracticeDatabase(candidate);
    } finally { candidate.close(); }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF");
    if (db.prepare("PRAGMA user_version").get()?.user_version === 0) {
      invariant(db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count === 0,
        "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Cannot initialize a nonempty database");
      db.exec(practiceSchema);
    }
    validatePracticeDatabase(db);
    if (db.prepare("SELECT sql FROM sqlite_master WHERE name='settings'").get()?.sql === oldSettingsSql) {
      transaction(db, () => {
        validatePracticeDatabase(db);
        db.exec("ALTER TABLE settings RENAME TO old_settings");
        db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT,model_id TEXT,locale TEXT CHECK(locale IS NULL OR locale IN('zh-CN','zh-TW','en')))");
        db.exec("INSERT INTO settings SELECT * FROM old_settings; DROP TABLE old_settings");
        validatePracticeDatabase(db);
      });
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function sqlRows(db: DatabaseSync, sql: string, parameters: SQLInputValue[]): Iterable<unknown[]> {
  const statement = db.prepare(sql); statement.setReturnArrays(true);
  return statement.iterate(...parameters) as unknown as Iterable<unknown[]>;
}
