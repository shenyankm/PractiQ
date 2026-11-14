import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { Sessions } from "./sessions.js";
import { SessionClock } from "./session-clock.js";
import { previewPaper } from "./paper.js";

const stores: PracticeStore[] = [];
function setup() {
  const store = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-sessions-"))); stores.push(store);
  const bank = store.saveBank(null, "验证", "");
  const save = (questions: unknown[]) => store.request({ type: "save_question_tree", bank_id: bank, root_id: null, questions });
  const question = (id: string) => ({ id, stem: `Question ${id}`, questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, sourceText: "Original source", analysis: "Explanation", needsReview: false });
  const preview = (ids: string[], total = 0) => previewPaper(store.db, store.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: ids, random: false, total_cents: total });
  const paper = (ids: string[], kind = "practice", total = 0) => { const result = preview(ids, total); return { question_ids: result.questionIds, kind, minutes: kind === "mock_exam" ? 1 : null, scores: result.scores, total_cents: total, digest: result.digest }; };
  return { store, bank, save, question, preview, paper };
}
afterEach(() => { for (const store of stores.splice(0)) { store.close(); rmSync(store.directory, { recursive: true, force: true }); } });

it("persists drafts and immutable practice snapshots through edits, submission, history and retry", () => {
  const { store, bank, save, question, paper } = setup(); save([question("one")]);
  const session = store.sessions.createPaper(paper(["one"]));
  store.sessions.writeAttempt(session.id, 0, { value: false }, 10, false, false);
  expect(store.sessions.list(10, 0, "active").items[0].draftAnswered).toBe(1);
  const original = store.questionDetail("one").question;
  store.request({ type: "save_question_tree", bank_id: bank, root_id: "one", questions: [{ ...original, stem: "Edited bank content", answerPayload: { value: false } }] });
  expect(store.sessions.session(session.id).attempts[0].snapshot?.question.stem).toBe("Question one");
  store.sessions.writeAttempt(session.id, 0, { value: false }, 20, true, false);
  store.sessions.writeAttempt(session.id, 0, { value: true }, 30, true, false);
  expect(store.sessions.session(session.id).attempts[0]).toMatchObject({ answer: { value: false }, result: false, autoResult: false, gradeKind: "auto" });
  expect(store.sessions.submit(session.id, true).finishedAt).toBeTypeOf("number");
  expect(store.sessions.list(10, 0, "finished").items[0]).toMatchObject({ count: 1, answered: 1, correct: 0, graded: 1 });
  const retry = store.sessions.retryWrong(session.id);
  expect(retry.attempts[0].snapshot?.question.stem).toBe("Question one");
  expect(retry.attempts[0].answer).toBeNull();
  store.deleteBank(bank);
  expect(store.sessions.session(session.id).attempts[0].snapshot?.question.stem).toBe("Question one");
});

it("hides exam answer evidence until submission and retains audited manual overrides", () => {
  const { store, save, question, paper } = setup();
  save([{ ...question("one"), answerMode: "short_answer", answerPayload: { text: "SECRET_REFERENCE" }, sourceText: "SECRET_REFERENCE", analysis: "SECRET_REFERENCE" }]);
  const session = store.sessions.createPaper(paper(["one"], "self_test", 100));
  expect(JSON.stringify(session)).not.toContain("SECRET_REFERENCE");
  expect(() => store.sessions.writeAttempt(session.id, 0, { text: "response" }, 1, true, false)).toThrow("locked");
  expect(() => store.sessions.manualScore(session.id, 0, 50, "reason")).toThrow("Invalid manual");
  store.sessions.writeAttempt(session.id, 0, { text: "response" }, 1, false, false);
  const submitted = store.sessions.submit(session.id, true);
  expect(JSON.stringify(submitted)).toContain("SECRET_REFERENCE");
  expect(submitted.attempts[0].result).toBeNull();
  expect(() => store.sessions.manualScore(session.id, 0, 50, " ")).toThrow("reason");
  store.sessions.manualScore(session.id, 0, 50, "Partial credit");
  const amended = store.sessions.manualScore(session.id, 0, 100, "Accepted correction");
  expect(amended.attempts[0]).toMatchObject({ result: true, earnedCents: 100, gradeKind: "manual" });
  expect(JSON.parse(String(store.db.prepare("SELECT grading FROM attempts WHERE session_id=?").get(session.id)!.grading)).manualHistory).toHaveLength(2);
  expect(store.sessions.complete(session.id).finishedAt).toBeTypeOf("number");
});

it("expires off-page timed exams, submits saved drafts and leaves missing references ungraded", () => {
  const { store, save, question, paper } = setup();
  save([question("one")]); save([{ ...question("missing"), answerPayload: null }]);
  let reading = { wall: 1000000, tick: 100n };
  const sessions = new Sessions(store.db, store.assets, new SessionClock(() => reading));
  const session = sessions.createPaper(paper(["one", "missing"], "mock_exam", 200));
  sessions.writeAttempt(session.id, 0, { value: true }, 1000, false, false);
  sessions.writeAttempt(session.id, 1, { value: false }, 1000, false, false);
  reading = { wall: -1000000, tick: 60101n };
  expect(sessions.list(1, 999, "active").items).toEqual([]);
  const expired = sessions.session(session.id);
  expect(expired.submittedAt).toBe(1060001);
  expect(expired.attempts[0]).toMatchObject({ answer: { value: true }, earnedCents: 100, result: true });
  expect(expired.attempts[1]).toMatchObject({ answer: { value: false }, earnedCents: null, result: null, gradeKind: "ungraded" });
});

it("uses revision patches without resending immutable snapshots", () => {
  const { store, save, question, paper } = setup(); save([question("one")]); save([question("two")]);
  const session = store.sessions.createPaper(paper(["one", "two"])), key = `${session.snapshotKey}:${session.attemptKey}`;
  const unchanged = store.sessions.position(session.id, 1, key);
  expect(unchanged.attempts).toEqual([]);
  expect(unchanged).toMatchObject({ attemptsBase: session.attemptKey, attemptCount: 2, position: 1 });
  store.sessions.writeAttempt(session.id, 1, { value: false }, 10, false, false);
  const updated = store.sessions.session(session.id, `${unchanged.snapshotKey}:${unchanged.attemptKey}`);
  expect(updated.attempts).toHaveLength(1);
  expect(updated.attempts[0]).toMatchObject({ ordinal: 1, answer: { value: false } });
  expect(updated.attempts[0].snapshot).toBeUndefined();
});

it("preserves automatic results when self-assessment is allowed and rejects it for objective choice types", () => {
  const { store, save, question, paper } = setup();
  save([{ ...question("blank"), answerMode: "fill_blank", answerPayload: { answers: ["Answer"] } }]); save([question("one")]);
  const session = store.sessions.createPaper(paper(["blank", "one"]));
  store.sessions.writeAttempt(session.id, 0, { answers: ["answer"] }, 1, true, false);
  store.sessions.writeAttempt(session.id, 1, { value: true }, 1, true, false);
  const assessed = store.sessions.selfAssess(session.id, 0, true);
  expect(assessed.attempts[0]).toMatchObject({ result: true, autoResult: false, gradeKind: "self" });
  expect(() => store.sessions.selfAssess(session.id, 1, false)).toThrow("cannot be self-assessed");
});

it("rejects stale previews and unsatisfiable grouped question counts", () => {
  const { store, bank, save, question, paper } = setup(); save([question("one")]);
  const stale = paper(["one"]), original = store.questionDetail("one").question;
  store.request({ type: "save_question_tree", bank_id: bank, root_id: "one", questions: [{ ...original, stem: "Changed" }] });
  expect(() => store.sessions.createPaper(stale)).toThrow("changed");
  expect(() => previewPaper(store.db, store.assets, { bank_ids: [bank], search: "", mode: "", filter: "", selection: "count", count: 2, quotas: {}, question_ids: [], random: false, total_cents: 0 })).toThrow("without splitting");
});
