import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { oldSettingsSql, openPracticeDatabase, practiceSchema, transaction } from "./database.js";
import { PracticeStore } from "./store.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-electron-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("schema-11 storage parity", () => {
  it("opens existing practice data without changing snapshots or historical metadata", () => {
    const path = directory();
    const legacy = new DatabaseSync(join(path, "practiq.sqlite"));
    legacy.exec(practiceSchema);
    legacy.prepare("INSERT INTO banks VALUES(?,?,?,?)").run("old", "旧".repeat(16), "述".repeat(51), 123);
    legacy.prepare("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES(?,?,?,?,?)").run("session", "old title", 123, 0, "all");
    const snapshot = '{"questions":[],"opaque":"不可变"}';
    legacy.prepare("INSERT INTO session_documents VALUES(?,?)").run("session", snapshot);
    legacy.close();
    const store = new PracticeStore(path);
    try {
      expect(store.banksPage(10, 0).items[0]).toMatchObject({ id: "old", title: "旧".repeat(16), description: "述".repeat(51), createdAt: 123 });
      expect(store.db.prepare("SELECT content FROM session_documents").get()?.content).toBe(snapshot);
      expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(11);
    } finally { store.close(); }
  });

  it.each([0, 10, 12])("rejects a nonempty schema %s without modifying its bytes", version => {
    const path = directory();
    const file = join(path, "practiq.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE untouched(value TEXT); INSERT INTO untouched VALUES('keep'); PRAGMA user_version=${version}`);
    db.close();
    const before = readFileSync(file);
    expect(() => openPracticeDatabase(path)).toThrow("Only database schema 11");
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects schema drift before executing an injected trigger", () => {
    const path = directory();
    const file = join(path, "practiq.sqlite");
    const db = new DatabaseSync(file);
    db.exec(practiceSchema);
    db.exec("CREATE TRIGGER unsafe AFTER UPDATE ON settings BEGIN DELETE FROM banks; END");
    db.close();
    const before = readFileSync(file);
    expect(() => openPracticeDatabase(path)).toThrow("Unsupported database schema");
    expect(readFileSync(file)).toEqual(before);
  });

  it("upgrades only the known historical locale constraint and preserves legacy connection fields", () => {
    const path = directory();
    const db = new DatabaseSync(join(path, "practiq.sqlite"));
    db.exec(practiceSchema.replace("'zh-CN','zh-TW','en'", "'zh-CN','en'"));
    db.exec("UPDATE settings SET base_url='https://historical.example',model_id='old-model',locale='en'");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='settings'").get()?.sql).toBe(oldSettingsSql);
    db.close();
    const store = new PracticeStore(path);
    try {
      expect(store.language()).toBe("en");
      store.saveLanguage("zh-TW");
      expect(store.db.prepare("SELECT * FROM settings").get()).toMatchObject({ base_url: "https://historical.example", model_id: "old-model", locale: "zh-TW" });
    } finally { store.close(); }
  });

  it("blocks a pending restore before creating a practice database", () => {
    const path = directory();
    const db = new DatabaseSync(join(path, "service-settings-v1.sqlite"));
    db.exec("CREATE TABLE service_settings(id INTEGER PRIMARY KEY CHECK(id=1),active TEXT NOT NULL,pending TEXT); PRAGMA user_version=1");
    db.prepare("INSERT INTO service_settings VALUES(1,?,?)").run("null", '{"candidate_sha256":"unknown"}');
    db.close();
    expect(() => openPracticeDatabase(path)).toThrow("requires recovery");
    expect(() => readFileSync(join(path, "practiq.sqlite"))).toThrow();
  });

  it("rolls back failed writes", () => {
    const db = openPracticeDatabase(directory());
    try {
      expect(() => transaction(db, () => { db.exec("INSERT INTO banks VALUES('x','x','',1)"); throw new Error("interrupted"); })).toThrow("interrupted");
      expect(db.prepare("SELECT count(*) AS count FROM banks").get()?.count).toBe(0);
    } finally { db.close(); }
  });

  it("retains bank ordering, pagination, counts and Unicode limits", () => {
    const store = new PracticeStore(directory());
    try {
      const id = store.saveBank(null, " 😀 ", "述".repeat(50));
      expect(store.banks()).toEqual([{ id, title: "😀", count: 0 }]);
      expect(store.banksPage(1, 999).offset).toBe(0);
      expect(store.saveBank(id, "😀".repeat(15), "")).toBe(id);
      expect(() => store.saveBank(id, "😀".repeat(16), "")).toThrow("1–15");
      expect(() => store.saveBank(id, "valid", "述".repeat(51))).toThrow("at most 50");
      expect(() => store.banksPage(0, 0)).toThrow("Invalid pagination");
      expect(() => store.banksPage(1, Number.MAX_VALUE)).toThrow("Invalid pagination");
      expect(() => store.request({ type: "delete_bank", id, path: "/tmp/arbitrary" })).toThrow("Invalid request fields");
      expect(() => store.request({ type: "save_bank", id: 4, title: "x", description: "" })).toThrow("Invalid request fields");
      expect(() => store.request({ type: "toString" })).toThrow("not been migrated");
      expect(store.deleteBank(id)).toBeNull();
      expect(store.banks()).toEqual([]);
    } finally { store.close(); }
  });
});
