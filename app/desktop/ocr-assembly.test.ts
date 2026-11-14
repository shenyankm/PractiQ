import { expect, it } from "vitest";
import { assembleOcrUnits } from "./ocr-assembly.js";
import { UnitMergeConflict } from "./assembly-finish.js";
import corpus from "../fixtures/tencent/ocr-assembly.json" with { type: "json" };
it.each(corpus)("preserves complete OCR merge and final projection: $name", async sample => {
  const before = structuredClone(sample.units), run = () => assembleOcrUnits(sample.units, sample.pages, sample.options, async visuals => { expect(visuals).toEqual(sample.cropInput); return structuredClone(sample.crop); });
  if ("conflict" in sample) await expect(run()).rejects.toBeInstanceOf(UnitMergeConflict); else expect(await run()).toEqual(sample.expected);
  expect(sample.units).toEqual(before);
});
