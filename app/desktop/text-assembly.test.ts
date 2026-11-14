import { expect, it } from "vitest";
import { assembleTextUnits, TextMergeConflict } from "./text-assembly.js";
import corpus from "../fixtures/tencent/text-assembly.json" with { type: "json" };

it.each(corpus)("matches historical final text assembly: $name", sample => {
  const input = structuredClone(sample.input), before = structuredClone(input), run = () => assembleTextUnits(input.units, input.sourceText, input.spans, input.options);
  if ("conflict" in sample) expect(run).toThrow(TextMergeConflict); else expect(run()).toEqual(sample.expected);
  expect(input).toEqual(before);
});
