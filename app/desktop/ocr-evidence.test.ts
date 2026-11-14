import { expect, it } from "vitest";
import { ocrAnswerText } from "./ocr-evidence.js";
import corpus from "../fixtures/tencent/ocr-evidence.json" with { type: "json" };
it.each(corpus)("preserves native table answer evidence and conservative fallback %#", sample => { expect(ocrAnswerText(sample.page)).toBe(sample.expected); });
it("rejects active XML declarations and malformed layouts", () => {
  for (const layout of ['<!DOCTYPE t [<!ENTITY x "data">]><t>&x;</t>', '<table><tr><td>broken']) expect(() => ocrAnswerText({ page: 0, format: "table", figures: [], elements: [{ layout_xml: layout }] })).toThrow();
});
