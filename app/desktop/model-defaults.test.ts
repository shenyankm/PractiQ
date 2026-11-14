import { expect, it } from "vitest";
import { compactModel } from "./model-defaults.js";

it("omits question defaults and empty optional collections without changing its input", () => {
  const input = { questions: [{ id: "q", stem: "Prompt", answerMode: "short_answer", parentId: null, needsReview: true, audioStartSeconds: 0, examPlayCount: 2, allowReuse: false, options: [], items: [], passage: [], transcript: [] }], groups: [], figures: [] };
  const before = structuredClone(input);
  expect(compactModel("OcrPageParseResult", input)).toEqual({ questions: [{ id: "q", stem: "Prompt", answerMode: "short_answer" }] });
  expect(input).toEqual(before);
});

it("retains nondefault review, playback and reuse values", () => {
  const input = { questions: [{ needsReview: false, audioStartSeconds: 1, examPlayCount: 3, allowReuse: true }] };
  expect(compactModel("OcrPageParseResult", input)).toEqual(input);
});

it("compacts nested declared models while retaining their business fields", () => {
  const input = { questions: [{ options: [{ label: "A", content: "Word", contentBlocks: [], unused: "discard" }], items: [{ id: "i", content: "Subquestion", label: null }], contentBlocks: [{ partType: "text", textValue: "Source", role: null, jsonValue: null }] }], figures: [{ elementIndex: 3, questionIndexes: [0], description: "Figure", role: null, label: null, kind: "image" }] };
  expect(compactModel("OcrPageParseResult", input)).toEqual({ questions: [{ options: [{ label: "A", content: "Word" }], items: [{ id: "i", content: "Subquestion" }], contentBlocks: [{ partType: "text", textValue: "Source" }] }], figures: [{ elementIndex: 3, questionIndexes: [0], description: "Figure" }] });
});

it("retains nulls and empty collections inside arbitrary JSON evidence", () => {
  const value = { questions: [{ answerPayload: { text: null, order: [], arbitrary: { nested: null } }, contentBlocks: [{ partType: "json", jsonValue: { null: null, empty: [], unknown: "keep" } }] }] };
  expect(compactModel("OcrPageParseResult", value)).toEqual(value);
});

it("discards undeclared model fields without admitting them into a correction draft", () => {
  expect(compactModel("OcrPageParseResult", { questions: [], injected: "discard" })).toEqual({});
});
it("keeps arbitrary JSON nulls and required/nullable arrays while omitting model defaults", () => {
  const value = { questions: [{ stem: "Q", answerPayload: { value: null, order: [] }, contentBlocks: [{ partType: "json", jsonValue: { null: null, empty: [] } }] }], groups: [{ title: "Section", questionIndexes: [] }], figures: [{ elementIndex: 0, description: "Table", tableRows: [] }] };
  expect(compactModel("OcrPageParseResult", value)).toEqual(value);
});
