import { expect, it } from "vitest";
import { validatePageResult } from "./page-results.js";
import corpus from "../fixtures/tencent/page-results.json" with { type: "json" };
it.each(corpus)("matches historical page and context preservation: $name", sample => {
  const before = structuredClone(sample.input), run = () => validatePageResult(sample.input, sample.scope, sample.primary ?? undefined, sample.figureIds ?? undefined);
  if ("error" in sample) expect(run).toThrow(); else expect(run()).toEqual(sample.expected);
  expect(sample.input).toEqual(before);
});
