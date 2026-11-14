import { expect, it } from "vitest";
import { mergeChunks, type MergeUnit } from "./merge-chunks.js";
import corpus from "../fixtures/tencent/merge-chunks.json" with { type: "json" };
import { validateQuestion } from "./question-contract.js";

it.each(corpus)("matches historical source-overlap merge: $name", input => {
  const before = JSON.stringify(input); expect(mergeChunks(input.units as unknown as MergeUnit[], input.options)).toEqual(input.expected); expect(JSON.stringify(input)).toBe(before);
});

const question = (id: string) => validateQuestion({ id, stem: id, answerMode: "true_false", questionTypeId: "Judgment", answerPayload: { value: true }, sourceText: id, analysis: "Provided", confidence: 1, needsReview: false });
it("caps nodes without retaining half a composite tree and keeps unassociated sections", () => {
  const ordinary = Array.from({ length: 998 }, (_, index) => question(`item-${index}`)), parent = validateQuestion({ id: "article", stem: "Article", answerMode: "reading" }), children = [0, 1, 2].map(index => ({ ...question(`child-${index}`), parentId: "article" }));
  const result = mergeChunks([{ index: 0, questions: [...ordinary, parent, ...children], groups: [{ title: "Instructions", questionIndexes: [] }, { title: "Retained", questionIndexes: [0, 1000] }, { title: "Removed", questionIndexes: [1000] }] }]);
  expect(result.questions).toHaveLength(998); expect(result.sources).toHaveLength(998); expect(result.truncated).toBe(true);
  expect(result.warnings).toEqual(["Parsed 1002 nodes; retained 998 nodes without splitting a question group."]);
  expect(result.groups).toEqual([{ title: "Instructions", questionIndexes: [] }, { title: "Retained", questionIndexes: [0] }]);
});
it.each([false, true])("caps section count with associated=%s while preserving its retained indexes", associated => {
  const result = mergeChunks([{ index: 0, questions: [question("Q")], groups: Array.from({ length: 1001 }, (_, index) => ({ title: `Group ${index}`, questionIndexes: associated ? [0] : [] })) }]);
  expect(result.groups).toHaveLength(1000); expect(result.truncated).toBe(true); expect(result.warnings).toEqual(["Merged 1001 groups; only the first 1000 were kept."]);
});
it("compares declared nullable defaults and built-in labels without rewriting the retained question", () => {
  const first = { ...question("first"), stem: "Q", questionTypeId: "true_false", contentBlocks: [{ partType: "text", textValue: "Q" }], sourceText: "Q" }, second = { ...question("second"), stem: "Q", questionTypeId: null, contentBlocks: [{ partType: "text", textValue: "Q", role: null }], sourceText: "Q" };
  const result = mergeChunks([{ index: 0, questions: [first], groups: [] }, { index: 1, questions: [second], groups: [] }], { sourceText: "Q", spans: [{ start: 0, end: 1, overlapStart: 0, overlapEnd: 0 }, { start: 0, end: 1, overlapStart: 0, overlapEnd: 1 }] });
  expect(result.questions).toHaveLength(1); expect(result.questions[0].id).toBe("first"); expect(first.questionTypeId).toBe("true_false"); expect(result.sources.map(source => source.unitIndex)).toEqual([0, 1]);
});
