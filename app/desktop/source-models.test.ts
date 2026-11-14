import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hash } from "./assets.js";
import { validateParsedTree } from "./question-contract.js";
import { sourceCasefold } from "./source-casefold.js";
import { validateUnitResult } from "./unit-results.js";

it.each([["ß", "SS"], ["Σ", "ς"], ["ﬀ", "FF"], ["K", "K"], ["İ", "i\u0307"], ["ſ", "S"]])("rejects case-fold duplicate labels %s/%s and canonicalizes supplied answers", (label, equivalent) => {
  const input = { questions: [{ id: "one", stem: "Q", answerMode: "choice", choiceVariant: "multiple", options: [{ label, content: "First" }, { label: equivalent, content: "Second" }], answerPayload: { correct: [label] } }] };
  expect(() => validateUnitResult(input)).toThrow();
  const valid = { questions: [{ ...input.questions[0], options: [{ label, content: "First" }, { label: "Z", content: "Other" }], answerPayload: { correct: [equivalent] } }] };
  expect(validateUnitResult(valid).questions[0].answerPayload).toEqual({ correct: [label] });
});
it.each([null, { correct: [null] }, { correct: ["SS"] }, { correct: ["ss"] }])("retains partial shared answers and canonicalizes only actual labels: %#", answerPayload => {
  const questions = [
    { id: "bank", stem: "Bank", answerMode: "word_bank", options: [{ label: "ß", content: "First" }, { label: "B", content: "Second" }], passage: [{ partType: "blank", questionId: "child" }], missingFields: ["material"] },
    { id: "child", parentId: "bank", optionSourceId: "bank", stem: "Choose", answerMode: "choice", choiceVariant: "single", answerPayload },
  ];
  const result = validateParsedTree(questions); expect(result[0].missingFields).toContain("material");
  expect(result[1].answerPayload).toEqual(answerPayload?.correct[0] ? { correct: ["ß"] } : answerPayload);
  expect(() => validateParsedTree([questions[0], { ...questions[1], answerPayload: { correct: ["Z"] } }])).toThrow();
});
it.each(["\u0085", "\x1c", "\r", "\u2028"])("keeps source answer conflicts and rejects blank display blocks across %j", whitespace => {
  const q = { stem: "Q", answerMode: "true_false", answerPayload: { value: true }, sourceText: `Q${whitespace}答案：错误`, confidence: 1, needsReview: false };
  expect(validateUnitResult({ questions: [q] }).questions[0].needsReview).toBe(true);
  expect(() => validateUnitResult({ questions: [{ stem: "Q", answerMode: "short_answer", contentBlocks: [{ partType: "text", textValue: whitespace }] }] })).toThrow();
});
it("uses frozen source case folding without context-dependent lowercasing", () => {
  expect(sourceCasefold("ΟΣ ς ß SS ﬀ ı İ K 🦑")).toBe("οσ σ ss ss ff ı i\u0307 k 🦑");
  expect(hash(readFileSync(new URL("./source-casefold.json", import.meta.url)))).toBe("e20a1c5a238d4169dc1b50cfcac4392c11267b352b5b61ae87f2f54e0ea54f7f");
});
