import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { AiDatabase, type CallTarget } from "./ai-database.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-ai-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const target: CallTarget = { inputDigest: "a".repeat(64), endpoint: "https://provider.example/v1", model: "model", promptVersion: "v1" };

it("persists unknown paid calls before sending and forbids replay after a restart", () => {
  const path = directory();
  const before = new AiDatabase(path);
  const id = before.createTask("b".repeat(64), 3);
  before.saveState(id, { stage: "submit", source: "sha256:local" });
  expect(before.claim(id, "submit", target).status).toBe("unknown");
  before.close();
  const after = new AiDatabase(path);
  try {
    expect(after.state(id)).toEqual({ stage: "submit", source: "sha256:local" });
    expect(after.receipt(id, "submit")).toMatchObject({ status: "unknown", ...target });
    expect(() => after.claim(id, "submit", target)).toThrow("already has a receipt");
    expect(() => after.claim(id, "submit", { ...target, model: "changed" })).toThrow("already has a receipt");
    expect(after.claim(id, "explicit-retry-1", target).status).toBe("unknown");
  } finally { after.close(); }
});

it("counts failed and unknown calls against budgets and retains immutable final receipts", () => {
  const db = new AiDatabase(directory());
  try {
    const id = db.createTask("c".repeat(64), 2);
    db.claim(id, "first", target);
    db.finish(id, "first", "failed", { code: "upstream_rejected" }, { inputTokens: 12, costMicros: 3 });
    db.claim(id, "second", target);
    expect(() => db.claim(id, "third", target)).toThrow("budget exhausted");
    expect(() => db.finish(id, "first", "succeeded", {}, {})).toThrow("already finalized");
    expect(db.receipt(id, "first")).toMatchObject({ status: "failed", usage: { inputTokens: 12, costMicros: 3 } });
    expect(db.receipt(id, "second")?.status).toBe("unknown");
  } finally { db.close(); }
});

it("binds a deterministic grading task identity to its original digest and one-call limit", () => {
  const db = new AiDatabase(directory());
  try {
    const id = db.createTask("a".repeat(64), 1);
    expect(db.createTask("a".repeat(64), 1, id)).toBe(id);
    expect(() => db.createTask("b".repeat(64), 1, id)).toThrow("different input or limits");
    expect(() => db.createTask("a".repeat(64), 2, id)).toThrow("different input or limits");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM ai_tasks").get()!.count).toBe(1);
  } finally { db.close(); }
});

it("enforces budgets across independent SQLite connections", () => {
  const path = directory();
  const first = new AiDatabase(path), second = new AiDatabase(path);
  try {
    const id = first.createTask("d".repeat(64), 1);
    first.claim(id, "one", target);
    expect(() => second.claim(id, "two", target)).toThrow("budget exhausted");
    expect(second.receipt(id, "one")?.status).toBe("unknown");
  } finally { first.close(); second.close(); }
});

it("keeps Tencent recognition receipts separate from the model allowance and cannot bypass it with a key prefix", () => {
  const db = new AiDatabase(directory());
  try {
    const id = db.createTask("a".repeat(64), 1);
    db.claim(id, "tencent:source", { ...target, endpoint: "https://ocr.tencentcloudapi.com", model: "multimodal-doc-parse" });
    db.claim(id, "tencent:not-recognition", { ...target, endpoint: "https://provider.example/responses" });
    expect(() => db.claim(id, "another-model", target)).toThrow("budget exhausted");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE task_id=?").get(id)!.n).toBe(2);
  } finally { db.close(); }
});

it("rejects credential-bearing receipt endpoints", () => {
  const db = new AiDatabase(directory());
  try {
    const id = db.createTask("c".repeat(64), 2);
    for (const endpoint of ["https://user:secret@provider.example", "https://provider.example?api_key=secret", "http://remote.example", "file:///private"]) {
      expect(() => db.claim(id, "invalid", { ...target, endpoint })).toThrow("Invalid model endpoint");
    }
    expect(db.receipt(id, "invalid")).toBeNull();
  } finally { db.close(); }
});

it("refuses unknown existing AI schemas without changing their bytes", () => {
  const path = directory(), file = join(path, "ai.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep')");
  db.close();
  const before = readFileSync(file);
  expect(() => new AiDatabase(path)).toThrow("Unsupported AI database");
  expect(readFileSync(file)).toEqual(before);
});
