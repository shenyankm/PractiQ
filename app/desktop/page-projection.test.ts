import { expect, it } from "vitest";
import { completePageResult } from "./page-projection.js";
import { validatePageFigure, tableMarkdown } from "./page-figures.js";
import { validateParsedQuestion } from "./question-contract.js";

const question = () => validateParsedQuestion({ id: "q", stem: "Prompt?", answerMode: "short_answer", needsReview: false });
const table = () => validatePageFigure({ kind: "table", description: "Source table", bbox: [0, 0, 1, 1], questionIndexes: [0], tableRows: [["Item", "Value"], ["x", "y"]] });
it("projects literal table material with verified coordinates and keeps the input immutable", () => {
  const input = { questions: [question()], groups: [], figures: [table()] }, before = structuredClone(input), result = completePageResult(input, 2, [0]);
  expect(input).toEqual(before); expect(result.parsed.questions[0].contentBlocks[0]).toMatchObject({ partType: "table", markdownValue: tableMarkdown(table()) });
  expect(result.parsed.questions[0].sourceText).toContain("| x | y |"); expect(result.visuals[0]).toMatchObject({ page: 2, bbox: [0, 0, 1, 1], questionIndexes: [0] });
  expect(result.visuals[0]).not.toHaveProperty("tableRows"); expect(completePageResult(input, 2, []).visuals[0].bbox).toBeNull();
});
it("propagates answer roles only across equivalent tables owned by the same question", () => {
  const first = question(), second = question(), figure = table(), markdown = tableMarkdown(figure)!;
  first.contentBlocks = [{ partType: "table", role: "analysis", markdownValue: markdown }]; second.contentBlocks = [{ partType: "table", markdownValue: markdown }];
  const result = completePageResult({ questions: [first, second], groups: [], figures: [figure] }, 0, []);
  expect(result.visuals[0].role).toBe("answer"); expect(result.parsed.questions[0].contentBlocks).toHaveLength(1);
  expect(result.parsed.questions[0].contentBlocks[0].role).toBe("answer"); expect(result.parsed.questions[1].contentBlocks[0].role).toBeUndefined();
});
it("preserves answer-bearing table roles and marks missing table material for review", () => {
  const figure = table(); figure.role = "answer";
  expect(completePageResult({ questions: [question()], groups: [], figures: [figure] }, 0, []).parsed.questions[0].contentBlocks[0].role).toBe("answer");
  figure.tableRows = null;
  expect(completePageResult({ questions: [question()], groups: [], figures: [figure] }, 0, []).parsed.questions[0]).toMatchObject({ needsReview: true, missingFields: expect.arrayContaining(["material"]) });
});
it("bounds shared table copies without erasing existing evidence", () => {
  const input = question(); input.contentBlocks = []; input.sourceText = "original";
  const figure = table(); figure.tableRows = [["header"], ["x".repeat(90000)]]; figure.questionIndexes = Array.from({ length: 10 }, (_, index) => index);
  const result = completePageResult({ questions: Array.from({ length: 10 }, () => structuredClone(input)), groups: [], figures: [figure] }, 0, []);
  expect(result.parsed.questions.filter(question => question.contentBlocks.length)).toHaveLength(5);
  expect(result.parsed.questions.slice(5).every(question => question.needsReview && question.sourceText === "original")).toBe(true);
});
it("caps blocks and source text by code points, retaining original blocks", () => {
  const input = question(); input.contentBlocks = Array.from({ length: 1000 }, () => ({ partType: "text" as const, textValue: "original" })); input.sourceText = "😀".repeat(119999);
  const result = completePageResult({ questions: [input], groups: [], figures: [table()] }, 2, [0]);
  expect(result.parsed.questions[0].contentBlocks).toEqual(input.contentBlocks); expect([...result.parsed.questions[0].sourceText!]).toHaveLength(120000); expect(result.parsed.questions[0].needsReview).toBe(true);
});
