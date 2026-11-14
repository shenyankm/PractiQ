import { expect, it } from "vitest";
import { validatePageResult } from "./page-results.js";

const scope = { index: 0, expectedNodeCount: null, presence: null };
function source() {
  return {
    questions: ["q1", "q2"].map(id => ({ id, stem: id, answerMode: "short_answer", contentBlocks: [{ partType: "text", textValue: "Literal source" }, { partType: "formula", latexValue: "x^2" }] })),
    groups: [{ title: "Section", instructions: "Keep these instructions", questionIndexes: [0] }],
    figures: [{ kind: "table", description: "Source table", bbox: [0.1, 0.1, 0.8, 0.6], questionIndexes: [0], role: "answer", label: "Table 1", extractedText: "Original text", tableRows: [["Name", "Value"], ["A", "1"]] }],
  };
}

it("retains literal formulas, tables and source associations without mutating input", () => {
  const input = source(), before = structuredClone(input), page = validatePageResult(input, scope, undefined, [7]);
  expect(page).toMatchObject({ questions: before.questions, groups: before.groups, figures: before.figures, figureIds: [7] });
  expect(input).toEqual(before);
});

it("removes empty material blocks and marks the missing material for review", () => {
  const page = validatePageResult({ questions: [{ id: "q", stem: "Prompt", contentBlocks: [{ partType: "text" }, { partType: "text", textValue: "Retained" }] }] }, scope);
  expect(page.questions[0].contentBlocks).toHaveLength(1);
  expect(page.questions[0]).toMatchObject({ needsReview: true, missingFields: expect.arrayContaining(["material"]) });
});

it.each([null, [], { injected: true }, { figures: "not an array" }, { figures: Array(1001).fill({}) }])("rejects malformed or excessive page payloads: %#", input => {
  expect(() => validatePageResult(input, scope)).toThrow();
});

it.each([[], [7, 8], [-1], [0.5], [Number.MAX_SAFE_INTEGER + 1]].map(ids => ({ ids })))("rejects invalid fixed figure identities: %#", ({ ids }) => {
  expect(() => validatePageResult(source(), scope, undefined, ids)).toThrow();
});

it("rejects duplicate figure identities and out-of-page question associations", () => {
  const input = source(); input.figures.push(structuredClone(input.figures[0]));
  expect(() => validatePageResult(input, scope, undefined, [7, 7])).toThrow();
  input.figures[0].questionIndexes = [2];
  expect(() => validatePageResult(input, scope)).toThrow();
});

it("retains an unassociated figure when no questions were extracted", () => {
  const input = source(); input.questions = []; input.groups = [];
  const page = validatePageResult(input, scope);
  expect(page.figures[0].questionIndexes).toEqual([]);
  expect(input.figures[0].questionIndexes).toEqual([0]);
});

it("allows context additions and reordered question indexes while preserving PRIMARY owners", () => {
  const input = source(), primary = validatePageResult(input, scope, undefined, [7]);
  input.questions.reverse(); input.questions[1].contentBlocks.push({ partType: "text", textValue: "Added context" });
  input.groups[0].questionIndexes = [1]; input.figures[0].questionIndexes = [1]; input.figures[0].tableRows.push(["B", "2"]); input.figures[0].extractedText += " and added context";
  expect(validatePageResult(input, scope, primary, [7])).toMatchObject({ figureIds: [7], figures: [{ questionIndexes: [1], tableRows: [["Name", "Value"], ["A", "1"], ["B", "2"]] }] });
});

it.each(["relabel", "omit", "add"])("rejects context changes to ordinary question identities: %s", action => {
  const input = source(), primary = validatePageResult(input, scope);
  if (action === "relabel") input.questions[0].id = "context-question";
  else if (action === "omit") input.questions.pop();
  else input.questions.push({ ...structuredClone(input.questions[0]), id: "extra" });
  expect(() => validatePageResult(input, scope, primary)).toThrow();
});

it.each(["remove", "replace", "reorder"])("rejects context changes to literal PRIMARY material: %s", action => {
  const input = source(), primary = validatePageResult(input, scope);
  if (action === "remove") input.questions[0].contentBlocks.pop();
  else if (action === "replace") input.questions[0].contentBlocks[0].textValue = "Rewritten";
  else input.questions[0].contentBlocks.reverse();
  expect(() => validatePageResult(input, scope, primary)).toThrow();
});

it.each(["group", "instructions", "owner", "empty-context-group"])("rejects lost or unassociated PRIMARY groups: %s", action => {
  const input = source(), primary = validatePageResult(input, scope);
  if (action === "group") input.groups = [];
  else if (action === "instructions") input.groups[0].instructions = "Rewritten";
  else if (action === "owner") input.groups[0].questionIndexes = [1];
  else input.groups.push({ title: "Context", instructions: "", questionIndexes: [] });
  expect(() => validatePageResult(input, scope, primary)).toThrow();
});

it.each(["identity", "kind", "bounds", "owner", "cells", "text", "role", "label"])("rejects changes to immutable PRIMARY figure %s", field => {
  const input = source(), primary = validatePageResult(input, scope, undefined, [7]), figure = input.figures[0];
  if (field === "kind") figure.kind = "image";
  else if (field === "bounds") figure.bbox[0] = 0.2;
  else if (field === "owner") figure.questionIndexes = [1];
  else if (field === "cells") figure.tableRows[1][1] = "Changed";
  else if (field === "text") figure.extractedText = "Rewritten";
  else if (field === "role") figure.role = "material";
  else if (field === "label") figure.label = "Table 2";
  expect(() => validatePageResult(input, scope, primary, [field === "identity" ? 8 : 7])).toThrow();
});
