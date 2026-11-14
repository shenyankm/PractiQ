import { expect, it } from "vitest";
import { sourceContext } from "./source-context.js";
import corpus from "../fixtures/tencent/source-context.json" with { type: "json" };
it.each(corpus)("preserves source-linked page context: $name", sample => {
  const before = structuredClone(sample.pages); expect(sourceContext(sample.pages, sample.pageReferences)).toEqual(sample.expected); expect(sample.pages).toEqual(before);
});
