import { expect, it } from "vitest";
import type { ParsedGroup, Question } from "../src/contracts.generated.js";
import { ocrQuestionIssues } from "./ocr-validation.js";
import { validateOcrPageAssociations } from "./ocr-associations.js";
import { missingFormulas } from "./unit-results.js";
import corpus from "../fixtures/tencent/ocr-validation.json" with { type: "json" };
it.each(corpus)("retains OCR source reading order, formulas and ambiguity: $name", sample => {
  const questions = structuredClone(sample.questions) as Question[], groups = sample.groups as ParsedGroup[];
  expect(ocrQuestionIssues(sample.text, questions, groups, sample.nativeTable, sample.figures, sample.formulaText)).toEqual(sample.expected);
  expect(questions).toEqual(sample.after);
});
it("keeps literal BOM evidence and Python whitespace rules in formula checks", () => {
  expect(missingFormulas("$x\ufeffy$", "xy")).toEqual(["x\ufeffy"]);
  expect(missingFormulas("$x\u0085y$", "xy")).toEqual([]);
  expect(missingFormulas("$\ufeff$", "")).toEqual(["\ufeff"]);
});
it("validates immutable OCR formula elements and displayed figure text in the model callback", () => {
  const input = { questions: [{ id: "page:1:1", stem: "Calculate?", questionTypeId: "Short answer", answerMode: "short_answer", confidence: .9, needsReview: false }], figures: [] }, scope = { index: 0, expectedNodeCount: null, presence: null, ocr: { text: "1. Calculate?" } }, page = { elements: [{ text: "1. Calculate?", formula_info: "x+1" }] };
  expect(() => validateOcrPageAssociations(input, [], scope, undefined, page)).toThrow();
  const withFormula = { ...input, figures: [{ elementIndex: 7, description: "Source formula", extractedText: "x+1" }] };
  expect(validateOcrPageAssociations(withFormula, [{ elementIndex: 7, bbox: null }], scope, undefined, page).page.questions).toHaveLength(1);
});
