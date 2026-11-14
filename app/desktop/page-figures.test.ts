import { expect, it } from "vitest";
import { tableContentKey, tableMarkdown, validatePageFigure } from "./page-figures.js";
import corpus from "../fixtures/tencent/page-figures.json" with { type: "json" };
it.each(corpus.cases)("matches source figure/table normalization %#", sample => {
  if ("error" in sample) expect(() => validatePageFigure(sample.input)).toThrow();
  else { const figure = validatePageFigure(sample.input); expect(figure).toEqual(sample.expected); expect(tableMarkdown(figure)).toBe(sample.markdown); }
});
it.each(corpus.keys)("compares table cells without losing literal content %#", sample => expect(tableContentKey(sample.input)).toBe(sample.expected));
