import { expect, it } from "vitest";
import { AppError, invariant } from "./errors.js";
import { parseJson } from "./document-contract.js";
import { remapQuestion } from "./bank-context.js";

it("preserves interpolation parameters across the actual invariant and IPC error boundary", () => {
  const params = { key: "questionIds", i: 3 }; expect(() => invariant(true, "LOCAL_QUESTION_INDEX_INVALID", "Invalid reference", params)).not.toThrow();
  try { invariant(false, "LOCAL_QUESTION_INDEX_INVALID", "Invalid reference", params); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).toJSON()).toEqual({ code: "LOCAL_QUESTION_INDEX_INVALID", message: "Invalid reference", params }); }
  expect(params).toEqual({ key: "questionIds", i: 3 });
});

it("retains safe schema diagnostics without copying model/document content into the error", () => {
  try { parseJson(Buffer.from('{"private_fixture":"TEST_ONLY_PRIVATE_TEXT","value":9007199254740992}')); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(AppError); const value = (error as AppError).toJSON(); expect(value.params).toEqual({ path: "$", detail: "Unsafe JSON number" }); expect(JSON.stringify(value)).not.toContain("TEST_ONLY_PRIVATE_TEXT"); }
});

it("reports the actual missing question reference without changing it or its mapping", () => {
  const question = { id: "missing-question" }, ids = new Map<string, string>();
  expect(() => remapQuestion(question, ids)).toThrow(expect.objectContaining({ code: "LOCAL_QUESTION_INDEX_INVALID", params: { key: "questions", i: "missing-question" } }));
  expect(question).toEqual({ id: "missing-question" }); expect(ids.size).toBe(0);
});
