import { expect, it } from "vitest";
import { parsePages, validPages, validReparseSelection } from "../../shared/cloud/importSelection";

it("parses explicit source-page ranges without silently skipping invalid input", () => {
  expect(parsePages(" ")).toBeUndefined();
  expect(parsePages("3-5,1,4")).toEqual([1, 3, 4, 5]);
  for (const value of ["0", "5-3", "1.5", "1-2001", "1,bad", "1--3"]) expect(() => parsePages(value)).toThrow();
  expect(validPages([true])).toBe(false);
  expect(validPages([])).toBe(false);
  expect(validReparseSelection({ checkpointId: "cp", units: [{ stage: "vision_parse", index: 0 }] })).toBe(true);
  for (const value of [{ checkpointId: "cp", units: [] }, { checkpointId: "cp", units: [{ stage: "result", index: 0 }] }, { checkpointId: "cp", units: [{ stage: "vision_parse", index: -1 }] }]) expect(validReparseSelection(value)).toBe(false);
});
