import { expect, it } from "vitest";
import { ocrQuestionIssues } from "./ocr-validation.js";
import { validateOcrPageAssociations } from "./ocr-associations.js";
import { missingFormulas } from "./unit-results.js";
import { validateParsedQuestion } from "./question-contract.js";
const question = (stem = "Prompt?", id: string | null = "page:1:1") => validateParsedQuestion({ id, stem, sourceText: stem, answerMode: "short_answer", needsReview: false, confidence: 1 });
it.each(["1. First?\n2. Second?", "First?\nSecond?"])("retains numbered and unnumbered source reading order: %s", text => {
  const questions = [question("Second?", "page:1:2"), question("First?")], before = structuredClone(questions);
  expect(ocrQuestionIssues(text, questions, [])).toContain("Retain source reading order for questions; remap groups and figure indexes after correction"); expect(questions).toEqual(before);
});
it("keeps repeated records separate and requires omitted source questions", () => {
  expect(ocrQuestionIssues("1. Prompt?\n1. Prompt?", [question()], []).join(" ")).toContain("separate record");
  expect(ocrQuestionIssues("1. Prompt?\n2. Other?", [question()], [])).toContain("Retain source question 2: Other?");
});
it("does not treat numbered options or parent material as new questions", () => {
  const q = question("Which sentence is a question?"); q.options = [{ label: "1", content: "Where are you?" }, { label: "2", content: "How are you?" }];
  expect(ocrQuestionIssues("1. Which sentence is a question?\n1) Where are you?\n2) How are you?\n3. Other?", [q], [])).toEqual(["Retain source question 3: Other?"]);
});
it("requires literal formulas in displayed content rather than only sourceText", () => {
  const q = question(); q.sourceText = "1. Prompt? $x+1$";
  expect(ocrQuestionIssues(q.sourceText, [q], []).join(" ")).toContain("displayed content");
  q.contentBlocks = [{ partType: "formula", latexValue: "x+1" }]; expect(ocrQuestionIssues(q.sourceText, [q], [])).toEqual([]);
  q.contentBlocks = []; expect(ocrQuestionIssues("1. Prompt?", [q], [], false, "$x+1$", "$x+1$")).toEqual([]);
});
it("does not borrow another question's answer-key formulas", () => {
  const q = question(), text = "1. Prompt?\nAnswers\n1. Supplied\n2. $other$";
  expect(ocrQuestionIssues(text, [q], [])).toEqual([]);
  expect(ocrQuestionIssues(text.replace("1. Supplied", "1. $mine$"), [q], []).join(" ")).toContain("displayed content");
});
it("marks ambiguous statements and prefix formulas for review without inventing questions", () => {
  const q = question(); q.needsReview = false;
  expect(ocrQuestionIssues("7. An ambiguous statement", [q], [])).toEqual([]); expect(q.needsReview).toBe(true);
  q.needsReview = false; expect(ocrQuestionIssues("$prefix$\n1. Prompt?", [q], [])).toEqual([]); expect(q.needsReview).toBe(true);
});
it("treats native table numbering as cell material", () => expect(ocrQuestionIssues("7. Extra?", [question()], [], true)).toEqual([]));
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
