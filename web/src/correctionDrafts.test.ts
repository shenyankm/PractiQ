import { expect, it } from "vitest";
import { correctionDrafts, putCorrectionDraft, removeCorrectionDraft, type CorrectionDraft } from "../../shared/cloud/correctionDrafts";
import { question, task } from "./test-fixtures";

function draft(): CorrectionDraft {
  const q = question();
  return { version: 1, taskId: task.threadId, fileName: task.fileName, checkpointId: task.checkpointId!, questionIndex: 0, revision: null, editor: { original: q, question: q, answer: "", initialAnswer: "" }, pending: null, updatedAt: "2026-11-06T00:00:00Z" };
}
it("keeps each unconfirmed request in a separate immutable recovery record", () => {
  const original = draft();
  putCorrectionDraft(original);
  const first = { ...original, pending: { requestId: crypto.randomUUID(), checkpointId: original.checkpointId, expectedRevision: null, questionIndex: 0, question: question() } };
  const second = { ...first, pending: { ...first.pending, requestId: crypto.randomUUID() } };
  putCorrectionDraft(first); putCorrectionDraft(second);
  expect(correctionDrafts().map(v => v.pending!.requestId).sort()).toEqual([first.pending.requestId, second.pending.requestId].sort());
  expect(() => putCorrectionDraft({ ...first, pending: { ...first.pending, questionIndex: 1 } })).toThrow();
  expect(correctionDrafts()).toHaveLength(2);
  removeCorrectionDraft({ ...first, requestId: first.pending.requestId });
  expect(correctionDrafts().map(v => v.pending!.requestId)).toEqual([second.pending.requestId]);
});
it("retains another tab's newer draft when confirming an older request", () => {
  const original = draft();
  putCorrectionDraft(original);
  const pending = { ...original, pending: { requestId: crypto.randomUUID(), checkpointId: original.checkpointId, expectedRevision: null, questionIndex: 0, question: question() } };
  putCorrectionDraft(pending);
  const newer = { ...original, editor: { ...original.editor, answer: "A newer draft" } };
  putCorrectionDraft(newer);
  removeCorrectionDraft({ ...pending, requestId: pending.pending.requestId });
  expect(correctionDrafts()).toEqual([newer]);
});
it("rejects malformed stored input and oversized drafts without erasing the previous record", () => {
  const original = draft(); putCorrectionDraft(original);
  expect(() => putCorrectionDraft({ ...original, editor: { ...original.editor, answer: "x".repeat(4 * 1024 * 1024) } })).toThrow();
  expect(correctionDrafts()).toEqual([original]);
  localStorage.setItem("practiq.correction-drafts.v1", "broken");
  expect(() => correctionDrafts()).toThrow();
  expect(() => putCorrectionDraft(original)).toThrow();
  expect(localStorage.getItem("practiq.correction-drafts.v1")).toBe("broken");
});
