import { expect, it } from "vitest";
import type { DocumentRecord } from "./document-tasks.js";
import { sourceIndexes } from "./source-selection.js";

const task = (input = {}) => ({ input } as DocumentRecord);
it("keeps original page and split tile indexes", () => {
  const parts = [{ sourcePage: 0 }, { sourcePage: 1 }, { sourcePage: 1 }];
  expect(sourceIndexes(task({ pages: [2] }), "vision_parse", 3, parts)).toEqual([1, 2]);
  expect(sourceIndexes(task({ pages: [2], reparseSelection: { units: [{ stage: "vision_parse", index: 2 }] } }), "vision_parse", 3, parts)).toEqual([2]);
  expect(() => sourceIndexes(task({ pages: [3] }), "vision_parse", 3, parts)).toThrow();
});
it("orders sparse fragments without renumbering them", () => {
  expect(sourceIndexes(task({ reparseSelection: { units: [{ stage: "document_parse", index: 3 }, { stage: "document_parse", index: 1 }, { stage: "document_parse", index: 3 }] } }), "document_parse", 5)).toEqual([1, 3]);
  expect(sourceIndexes(task(), "document_parse", 3)).toEqual([0, 1, 2]);
});
it.each([[], [{ stage: "result", index: 0 }], [{ stage: "document_parse", index: 99 }], [{ stage: "document_parse", index: -1 }], [{ stage: "document_parse", index: 0.5 }]])("rejects unavailable selected units: %j", units => {
  expect(() => sourceIndexes(task({ reparseSelection: { units } }), "document_parse", 3)).toThrow();
});
it("never treats source text offsets as pages", () => { expect(() => sourceIndexes(task({ pages: [1] }), "document_parse", 3)).toThrow(); });
