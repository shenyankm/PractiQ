import { expect, it } from "vitest";
import { mergeChunks, type MergeUnit } from "./merge-chunks.js";
import { validateQuestion } from "./question-contract.js";

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

it("keeps independent page results separate and preserves their source stage", () => {
  const units = [0, 1].map(index => ({ index, questions: [question("Q")], groups: [{ title: "Section", questionIndexes: [0] }] })), before = structuredClone(units), result = mergeChunks(units, { overlapping: false });
  expect(result.questions).toHaveLength(2); expect(result.groups).toHaveLength(2); expect(result.sources).toEqual([{ questionIndex: 0, stage: "vision_parse", unitIndex: 0 }, { questionIndex: 1, stage: "vision_parse", unitIndex: 1 }]); expect(units).toEqual(before);
});
it.each(["absent", "ambiguous", "conflicting", "nonadjacent", "disabled"])("does not collapse overlap with %s proof", kind => {
  const first = question("Q"), second = { ...first, id: "other" }, sourceText = kind === "absent" ? "Unrelated" : kind === "ambiguous" ? "Q Q" : "Q", later = kind === "nonadjacent" ? 2 : 1;
  if (kind === "conflicting") second.answerPayload = { value: false };
  const spans = Array.from({ length: later + 1 }, (_, index) => ({ start: 0, end: sourceText.length, overlapStart: 0, overlapEnd: index ? sourceText.length : 0 })), result = mergeChunks([{ index: 0, questions: [first], groups: [] }, { index: later, questions: [second], groups: [] }], { sourceText, spans, overlapping: kind !== "disabled" });
  expect(result.questions).toHaveLength(2);
  if (kind === "conflicting") expect(result.quality.issues.filter(issue => issue.code === "OVERLAP_CONFLICT")).toHaveLength(2);
  if (kind === "ambiguous") expect(result.quality.issues.some(issue => issue.code === "AMBIGUOUS_OVERLAP")).toBe(true);
  if (kind === "absent") expect(result.quality.issues.some(issue => issue.code === "SOURCE_TEXT_NOT_FOUND")).toBe(true);
});
it("merges a unique adjacent overlap conservatively and remaps all associations", () => {
  const first = question("Q"), second = { ...first, id: "other", confidence: .6, needsReview: true }, group = { title: "Section", questionIndexes: [0] }, units = [{ index: 0, questions: [first], groups: [group] }, { index: 1, questions: [second], groups: [group] }], before = structuredClone(units);
  const result = mergeChunks(units, { sourceText: "Q", spans: [{ start: 0, end: 1, overlapStart: 0, overlapEnd: 0 }, { start: 0, end: 1, overlapStart: 0, overlapEnd: 1 }] });
  expect(result.questions).toHaveLength(1); expect(result.questions[0]).toMatchObject({ id: "Q", confidence: .6, needsReview: true }); expect(result.groups).toEqual([group]); expect(result.sources.map(source => source.questionIndex)).toEqual([0, 0]); expect(units).toEqual(before);
});
it("retains standalone section instructions and rejects invalid source ranges", () => {
  expect(mergeChunks([{ index: 0, questions: [], groups: [{ title: "Instructions", questionIndexes: [] }] }]).groups).toEqual([{ title: "Instructions", questionIndexes: [] }]);
  for (const index of [-1, .5]) expect(() => mergeChunks([{ index, questions: [], groups: [] }])).toThrow();
  expect(() => mergeChunks([{ index: 0, questions: [], groups: [] }], { sourceText: "Q", spans: [{ start: 0, end: 2, overlapStart: 0, overlapEnd: 0 }] })).toThrow();
});
