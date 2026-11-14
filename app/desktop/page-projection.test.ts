import { expect, it } from "vitest";
import { completePageResult } from "./page-projection.js";
import corpus from "../fixtures/tencent/page-projection.json" with { type: "json" };
it.each(corpus)("preserves page table roles and visual projection: $name", sample => {
  const before = structuredClone(sample.input); expect(completePageResult(sample.input, sample.index, sample.verified)).toEqual(sample.expected); expect(sample.input).toEqual(before);
});

it("bounds shared table copies without erasing existing evidence", () => {
  const sample = corpus.find(sample => sample.input.questions.length && sample.input.figures.some(figure => figure.tableRows?.length))!;
  const question = structuredClone(sample.input.questions[0]); question.contentBlocks = []; question.sourceText = "original"; question.needsReview = false;
  const figure = structuredClone(sample.input.figures.find(figure => figure.tableRows?.length)!);
  figure.tableRows = [["header"], ["x".repeat(90000)]]; figure.questionIndexes = Array.from({ length: 10 }, (_, index) => index);
  const page = { questions: Array.from({ length: 10 }, () => structuredClone(question)), groups: [], figures: [figure] };
  const result = completePageResult(page, 0, []);
  expect(result.parsed.questions.filter(question => question.contentBlocks.length)).toHaveLength(5);
  expect(result.parsed.questions.slice(5).every(question => question.needsReview && question.sourceText === "original")).toBe(true);
});
it("caps blocks and source text by code points, retaining original blocks", () => {
  const sample = corpus.find(sample => sample.input.questions.length && sample.input.figures.some(figure => figure.tableRows?.length))!;
  const question = structuredClone(sample.input.questions[0]); question.contentBlocks = Array.from({ length: 1000 }, () => ({ partType: "text" as const, textValue: "original" })); question.sourceText = "😀".repeat(119999); question.needsReview = false;
  const figure = structuredClone(sample.input.figures.find(figure => figure.tableRows?.length)!); figure.questionIndexes = [0];
  const result = completePageResult({ questions: [question], groups: [], figures: [figure] }, 2, [0]);
  expect(result.parsed.questions[0].contentBlocks).toEqual(question.contentBlocks);
  expect([...result.parsed.questions[0].sourceText!]).toHaveLength(120000);
  expect(result.parsed.questions[0].needsReview).toBe(true);
  expect(result.visuals[0].page).toBe(2); expect(result.visuals[0].bbox).toEqual(figure.bbox);
  expect(completePageResult({ questions: [question], groups: [], figures: [figure] }, 2, []).visuals[0].bbox).toBeNull();
});
