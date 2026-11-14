import { expect, it } from "vitest";
import { compactModel } from "./model-defaults.js";
import corpus from "../fixtures/tencent/model-compaction.json" with { type: "json" };
it.each(corpus)("preserves historical compact OCR context drafts %#", sample => {
  const before = structuredClone(sample.input); expect(compactModel("OcrPageParseResult", sample.input)).toEqual(sample.expected); expect(sample.input).toEqual(before);
});
it("keeps arbitrary JSON nulls and required/nullable arrays while omitting model defaults", () => {
  const value = { questions: [{ stem: "Q", answerPayload: { value: null, order: [] }, contentBlocks: [{ partType: "json", jsonValue: { null: null, empty: [] } }] }], groups: [{ title: "Section", questionIndexes: [] }], figures: [{ elementIndex: 0, description: "Table", tableRows: [] }] };
  expect(compactModel("OcrPageParseResult", value)).toEqual(value);
});
