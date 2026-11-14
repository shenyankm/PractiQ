import { expect, it } from "vitest";
import { validateOcrPageAssociations } from "./ocr-associations.js";
import corpus from "../fixtures/tencent/ocr-associations.json" with { type: "json" };
it.each(corpus)("preserves immutable OCR identities, order and bounds %#", sample => {
  const before = structuredClone(sample.input), run = () => validateOcrPageAssociations(sample.input, sample.inventory, sample.scope, sample.primary ?? undefined);
  if ("error" in sample) expect(run).toThrow(); else expect(run()).toEqual(sample.expected);
  expect(sample.input).toEqual(before);
});

it("rejects an omitted ordinary question from the PRIMARY page", () => {
  const text = "1. First question?\n2. Second question?", scope = { index: 0, expectedNodeCount: null, presence: null, ocr: { text } };
  const input = { questions: [{ id: "page:1:1", stem: "First question?", sourceText: "First question?", answerMode: "short_answer" }], figures: [] };
  expect(() => validateOcrPageAssociations(input, [], scope, undefined, { elements: [{ type: 2, text_info: { content: text } }] })).toThrow();
});

it.each(["\\frac{a}{b}", "\\sqrt{x}", "x_i^2", "\\int_0^1 x dx"])("requires literal source formulas even when the model omits the quote: %s", formula => {
  const text = `1. Compute the expression? Given $${formula}$.`, scope = { index: 0, expectedNodeCount: null, presence: null, ocr: { text } };
  const question = { id: "page:1:1", stem: "Compute the expression?", sourceText: "Compute the expression?", answerMode: "short_answer", contentBlocks: [{ partType: "text", textValue: "Compute the expression?" }] };
  const page = { elements: [{ type: 2, text_info: { content: text } }] };
  expect(() => validateOcrPageAssociations({ questions: [question] }, [], scope, undefined, page)).toThrow();
  const retained = { ...question, contentBlocks: [...question.contentBlocks, { partType: "formula", latexValue: formula }] };
  const result = validateOcrPageAssociations({ questions: [retained] }, [], scope, undefined, page);
  expect(result.page.questions[0].contentBlocks).toContainEqual(expect.objectContaining({ partType: "formula", latexValue: formula }));
});

it("preserves answer-bearing figure payloads when enriching the fixed OCR inventory", () => {
  const scope = { index: 0, expectedNodeCount: null, presence: null }, inventory = [{ elementIndex: 3, bbox: null }];
  const input = { questions: [{ id: "q", stem: "Prompt", answerMode: "short_answer" }], figures: [{ elementIndex: 3, questionIndexes: [0], description: "Answer table", kind: "table", role: "answer", tableRows: [["Name", "Value"], ["A", "1"]] }] };
  const primary = validateOcrPageAssociations(input, inventory, scope).page;
  input.figures[0].role = "material";
  expect(() => validateOcrPageAssociations(input, inventory, scope, primary)).toThrow();
  input.figures[0].role = "answer"; input.figures[0].tableRows.push(["B", "2"]);
  expect(validateOcrPageAssociations(input, inventory, scope, primary).page.figures[0]).toMatchObject({ role: "answer", tableRows: [["Name", "Value"], ["A", "1"], ["B", "2"]], bbox: null });
});
