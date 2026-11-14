import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fixture from "../fixtures/native-ipc.json" with { type: "json" };
import { PracticeStore } from "./store.js";
import { Sessions, type SessionWire } from "./sessions.js";
import { SessionClock } from "./session-clock.js";
import { previewPaper } from "./paper.js";
import { Backups } from "./backup.js";
import { LegacySettings } from "./legacy-settings.js";
import { fileDigest } from "./filesystem.js";

const paths: string[] = [], stores: PracticeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function open() { const path = mkdtempSync(join(tmpdir(), "practiq-native-parity-")); paths.push(path); const store = new PracticeStore(path); stores.push(store); return store; }
function identifiers(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => identifiers(item, replacements));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, identifiers(item, replacements)])) : value;
}
function session(value: SessionWire, phase: string): unknown {
  return identifiers(value, new Map([[value.id, "fixture-session"], [value.snapshotKey, "fixture-snapshot"], [value.attemptKey, phase]]));
}

it("reproduces frozen Rust IPC pagination, historical grading, manual overrides and restore from actual Node state", async () => {
  const store = open(), clock = new SessionClock(() => ({ wall: 1_800_000_000_000, tick: 1000n })), sessions = new Sessions(store.db, store.assets, clock);
  expect(store.request({ type: "banks_page", limit: 1, offset: 0 })).toEqual(fixture.pages.emptyBanks);
  store.saveBank("fixture-bank", "IPC fixture", "Synthetic input"); store.saveBank("empty-bank", "Empty bank", "");
  store.db.exec("UPDATE banks SET created_at=CASE id WHEN 'fixture-bank' THEN 2 ELSE 1 END");
  const sample = JSON.parse(readFileSync(new URL("../fixtures/sample.json", import.meta.url), "utf8"));
  const question = sample.questions.find((value: { answerMode: string }) => value.answerMode === "short_answer"); question.id = "subjective";
  store.request({ type: "save_question_tree", bank_id: "fixture-bank", root_id: null, questions: [question] });
  const preview = previewPaper(store.db, store.assets, { bank_ids: ["fixture-bank"], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ["subjective"], random: false, total_cents: 500 });
  const created = sessions.createPaper({ question_ids: preview.questionIds, kind: "self_test", minutes: null, scores: preview.scores, total_cents: 500, digest: preview.digest }, "en");
  sessions.writeAttempt(created.id, 0, { text: "Fixture answer" }, 0, false, false); sessions.submit(created.id, true);
  // Old receipts are retained state, not new provider responses exempt from current evidence checks.
  store.db.prepare("UPDATE attempts SET grading=? WHERE session_id=?").run(JSON.stringify({ lastRequest: fixture.receipts.unknown }), created.id);
  expect(session(sessions.session(created.id), "fixture-unknown-attempts")).toEqual(fixture.unknownSession);
  store.db.prepare("UPDATE attempts SET grading=?,earned_cents=300,result=0,grade_kind='ai' WHERE session_id=?").run(JSON.stringify({ ai: fixture.receipts.graded }), created.id);
  expect(session(sessions.session(created.id), "fixture-attempts")).toEqual(fixture.gradedSession);
  expect(store.request({ type: "banks_page", limit: 1, offset: 0 })).toEqual(fixture.pages.banks);
  expect(store.request({ type: "banks_page", limit: 1, offset: 1 })).toEqual(fixture.pages.nextBanks);
  expect(store.request({ type: "questions_page", bank_ids: ["fixture-bank"], search: "", mode: "", filter: "", limit: 1, offset: 0, include_stats: true })).toEqual(fixture.pages.questions);
  expect(identifiers(sessions.list(1, 0, "review"), new Map([[created.id, "fixture-session"]]))).toEqual(fixture.pages.sessions);
  store.db.prepare("UPDATE attempts SET grading=json_set(grading,'$.lastRequest',json(?)) WHERE session_id=?").run(JSON.stringify(fixture.receipts.historical), created.id);
  const receiptId = randomUUID();
  store.db.prepare("INSERT INTO grade_requests VALUES(?,?,?,?,?,?)").run(receiptId, created.id, 0, JSON.stringify({ requestId: receiptId, target: { kind: "direct", baseUrl: "https://model.example.com/v1", model: "fixture-model", promptVersion: 1 } }), JSON.stringify(fixture.receipts.historical), 1_800_000_000_000);
  const retainedReceipt = store.db.prepare("SELECT * FROM grade_requests WHERE id=?").get(receiptId);
  expect(() => store.grading.prepare(created.id, 0, false, "en", { kind: "electron", endpoint: "https://model.example.com/v1/responses", modelId: "fixture-model", promptVersion: "current" })).toThrow(expect.objectContaining({ code: "LOCAL_GRADING_TARGET_CHANGED" }));
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM grade_requests").get()!.count).toBe(1);
  expect(session(sessions.manualScore(created.id, 0, 400, "Reviewed against the supplied reference"), "fixture-manual-attempts")).toEqual(fixture.manualSession);
  const settings = new LegacySettings(store.directory); expect(settings.read().active).toBeNull();
  for (const config of [fixture.settings.service.config, fixture.settings.direct.config]) {
    settings.prepare(config, fileDigest(join(store.directory, "practiq.sqlite"), 512 * 1024 * 1024).sha256); settings.finish(true, store.db);
    expect(settings.read()).toEqual({ active: config, pending: null });
  }
  const target = open(), archive = join(target.directory, "native.zip"); await new Backups(store).export(archive);
  const restored = await new Backups(target).restore(archive, false);
  expect(identifiers(restored, new Map([[restored.recoveryPath, "<temporary>/recovery.zip"]]))).toEqual(fixture.restore);
  expect(new LegacySettings(target.directory).read().active).toEqual(fixture.settings.direct.config);
  expect(target.db.prepare("SELECT * FROM grade_requests WHERE id=?").get(receiptId)).toEqual(retainedReceipt);
  const reopened = new Sessions(target.db, target.assets, new SessionClock(() => ({ wall: 1_800_000_000_000, tick: 1000n })));
  expect(session(reopened.session(created.id), "fixture-manual-attempts")).toEqual(fixture.manualSession);
});
