import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PracticeStore } from "./store.js";
import { LegacySettings, validateLegacyConfig } from "./legacy-settings.js";
import { emptyLearningData } from "./learning.js";
import { fileDigest } from "./filesystem.js";
import { openPracticeDatabase } from "./database.js";

const directories: string[] = [], stores: PracticeStore[] = [];
function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-restore-recovery-")); directories.push(path);
  const store = new PracticeStore(path); stores.push(store); store.saveBank(null, "Preserved", "");
  return { path, store, legacy: new LegacySettings(path) };
}
function reopen(store: PracticeStore): PracticeStore { store.close(); stores.splice(stores.indexOf(store), 1); const next = new PracticeStore(store.directory); stores.push(next); return next; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("resolves a published restore before allowing practice database operations", () => {
  const { path, store, legacy } = setup();
  const previous = emptyLearningData(), next = { ...emptyLearningData(), notes: { recovered: { body: "Recovered note", cause: null, updatedAt: 100 } } };
  const digest = fileDigest(join(path, "practiq.sqlite"), 512 * 1024 * 1024).sha256;
  legacy.prepare({ service_url: "http://127.0.0.1:8090" }, digest, { previous, next });
  expect(() => openPracticeDatabase(path)).toThrow("requires recovery");
  const recovered = reopen(store);
  expect(recovered.banks()[0].title).toBe("Preserved");
  expect(recovered.learning.data()).toEqual(next);
  expect(legacy.read()).toEqual({ active: { service_url: "http://127.0.0.1:8090" }, pending: null });
});

it("rolls settings and notes back when the candidate database was never published", () => {
  const { store, legacy } = setup(), previous = { ...emptyLearningData(), notes: { previous: { body: "Retain", cause: "other" as const, updatedAt: 10 } } };
  legacy.prepare({ service_url: "https://old.example" }, "b".repeat(64)); legacy.finish(true, store.db);
  legacy.prepare({ service_url: "https://next.example" }, "a".repeat(64), { previous, next: emptyLearningData() });
  const recovered = reopen(store);
  expect(recovered.learning.data()).toEqual(previous);
  expect(legacy.read()).toEqual({ active: { service_url: "https://old.example" }, pending: null });
});

it("leaves the durable restore pending when an unknown learning database prevents publication", () => {
  const { path, store, legacy } = setup();
  legacy.prepare(null, fileDigest(join(path, "practiq.sqlite"), 512 * 1024 * 1024).sha256, { previous: emptyLearningData(), next: emptyLearningData() });
  const db = new DatabaseSync(store.learning.path); db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep')"); db.close();
  const before = readFileSync(store.learning.path);
  expect(() => legacy.recover()).toThrow("Unsupported learning database");
  expect(legacy.read().pending).not.toBeNull(); expect(readFileSync(store.learning.path)).toEqual(before);
  expect(() => openPracticeDatabase(path)).toThrow("requires recovery");
});

it("keeps unknown nonempty settings databases intact and never repurposes historical provider fields", () => {
  const { store, legacy } = setup(), db = new DatabaseSync(legacy.path);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep')"); db.close();
  const before = readFileSync(legacy.path);
  expect(() => legacy.read()).toThrow("Unsupported service settings database");
  expect(() => legacy.prepare(null, "a".repeat(64))).toThrow("Unsupported service settings database");
  expect(readFileSync(legacy.path)).toEqual(before);
  expect(store.db.prepare("SELECT base_url,model_id FROM settings").get()).toMatchObject({ base_url: null, model_id: null });
  expect(validateLegacyConfig({ service_url: null, model: { base_url: "https://historical.example/v1/", model_id: " old-model " } })).toEqual({ service_url: null, model: { base_url: "https://historical.example/v1", model_id: "old-model" } });
  for (const service_url of ["https://user:secret@provider.example", "https://example.com?", "https://example.com#", "http://remote.example"]) expect(() => validateLegacyConfig({ service_url })).toThrow();
  expect(() => validateLegacyConfig({ service_url: null, executable: "/tmp/untrusted" })).toThrow("Unsupported legacy");
});
