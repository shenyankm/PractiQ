import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PracticeStore } from "./store.js";
import { emptyLearningData } from "./learning.js";
import { openPracticeDatabase } from "./database.js";
import { previewPaper } from "./paper.js";

const directories: string[] = [], stores: PracticeStore[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-learning-")); directories.push(path); return path; }
function setup() {
  const value = new PracticeStore(directory()); stores.push(value); const bank = value.saveBank(null, "Original", "");
  value.request({ type: "save_question_tree", bank_id: bank, root_id: null, questions: [{ id: "one", stem: "Original", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, analysis: "analysis", sourceText: "source" }] });
  const preview = previewPaper(value.db, value.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ["one"], random: false, total_cents: 0 });
  const start = () => value.sessions.createPaper({ question_ids: ["one"], kind: "practice", minutes: null, scores: [], total_cents: 0, digest: preview.digest });
  return { value, bank, start };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("keeps passive reads empty and initializes learning only on an explicit write", () => {
  const { value } = setup();
  expect(value.learning.note("one")).toBeNull(); expect(value.learning.data()).toEqual(emptyLearningData()); expect(existsSync(value.learning.path)).toBe(false);
  const note = value.learning.saveNote("one", "Review this", "knowledge");
  expect(value.learning.note("one")).toEqual(note);
  expect(value.learning.status()).toMatchObject({ due: true, changedNotes: 1 });
  expect(value.learning.backup()).toMatchObject({ version: 1, lastBackupAt: null, notes: { one: note } });
  expect(() => value.learning.saveNote("one", "x".repeat(20001), null)).toThrow("invalid learning data");
  expect(value.learning.note("one")).toEqual(note);
  value.learning.saveNote("one", "", null); expect(value.learning.note("one")).toBeNull(); expect(value.learning.backup().notes).toEqual({});
});

it("preserves unknown settings and rejects symbolic-link databases without creating their targets", () => {
  const { value } = setup(), db = new DatabaseSync(value.learning.path);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep'); PRAGMA user_version=1"); db.close();
  const before = readFileSync(value.learning.path);
  expect(() => value.learning.data()).toThrow("Unsupported learning database");
  expect(() => value.learning.publish(emptyLearningData())).toThrow("Unsupported learning database");
  expect(readFileSync(value.learning.path)).toEqual(before);
  rmSync(value.learning.path);
  const outside = join(value.directory, "outside.sqlite"); symlinkSync(outside, value.learning.path);
  expect(() => value.learning.saveNote("one", "note", null)).toThrow("regular file"); expect(existsSync(outside)).toBe(false);
  const path = directory(); symlinkSync(outside, join(path, "practiq.sqlite"));
  expect(() => openPracticeDatabase(path)).toThrow("regular file"); expect(existsSync(outside)).toBe(false);
});

it("attributes historical statistics to frozen bank and type after editing and deleting live content", () => {
  const { value, bank, start } = setup(), session = start();
  value.sessions.writeAttempt(session.id, 0, { value: true }, 1, true, false); value.sessions.submit(session.id, true);
  const original = value.questionDetail("one").question;
  value.request({ type: "save_question_tree", bank_id: bank, root_id: "one", questions: [{ ...original, answerMode: "fill_blank", answerPayload: { answers: ["changed"] } }] });
  value.deleteBank(bank);
  const today = new Date(); today.setHours(0, 0, 0, 0); const since = new Date(today); since.setDate(since.getDate() - 6);
  const overview = value.learning.overview(7, +today, +since);
  expect(overview.counts).toMatchObject({ submitted: 1, auto: { graded: 1, correct: 1 }, ungraded: 0 });
  expect(overview.banks[0]).toMatchObject({ id: bank, title: "Original", available: false });
  expect(overview.kinds.map(item => item.kind)).toEqual(["true_false"]);
  expect(() => value.learning.overview(7, Date.now() + 1000, 0)).toThrow("statistics window");
});

it("prioritizes repeated wrong answers and carries live mistake causes", () => {
  const { value, start } = setup();
  value.learning.saveNote("one", "Watch the condition", "misread");
  for (let i = 0; i < 2; i++) { const session = start(); value.sessions.writeAttempt(session.id, 0, { value: false }, 1, true, false); value.sessions.submit(session.id, true); }
  value.db.prepare("UPDATE attempts SET submitted_at=?").run(Date.now() - 2 * 86400000);
  const today = new Date(); today.setHours(0, 0, 0, 0); const since = new Date(today); since.setDate(since.getDate() - 6);
  expect(value.learning.overview(7, +today, +since).review[0]).toMatchObject({ rootId: "one", reason: "repeated_wrong", causes: ["misread"], count: 1 });
});
