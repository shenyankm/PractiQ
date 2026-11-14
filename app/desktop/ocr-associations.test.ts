import { expect, it } from "vitest";
import { validateOcrPageAssociations } from "./ocr-associations.js";
import corpus from "../fixtures/tencent/ocr-associations.json" with { type: "json" };
it.each(corpus)("preserves immutable OCR identities, order and bounds %#", sample => {
  const before = structuredClone(sample.input), run = () => validateOcrPageAssociations(sample.input, sample.inventory, sample.scope, sample.primary ?? undefined);
  if ("error" in sample) expect(run).toThrow(); else expect(run()).toEqual(sample.expected);
  expect(sample.input).toEqual(before);
});

import pageCorpus from "../fixtures/tencent/ocr-page-results.json" with { type: "json" };
it.each(pageCorpus)("validates the complete historical OCR callback: $name", sample => {
  const before = structuredClone(sample.input), run = () => validateOcrPageAssociations(sample.input, sample.inventory, sample.scope, sample.primary ?? undefined, sample.page ?? undefined);
  if ("error" in sample) expect(run).toThrow(); else expect(run()).toEqual(sample.expected);
  expect(sample.input).toEqual(before);
});
