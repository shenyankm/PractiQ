import { expect, it } from "vitest";
import { cents, defaultPaperCount } from "./paper";
it("parses exact decimal points without floating point rounding", () => {
  expect(cents("0.29")).toBe(29);
  expect(cents("100")).toBe(10000);
  expect(() => cents("1.001")).toThrow();
  expect(() => cents("-1")).toThrow();
});
it("defaults to a native feasible count without splitting groups", () => {
  expect(defaultPaperCount([3,6,9,12,15,18,21,24])).toBe(18);
  expect(defaultPaperCount([24,48])).toBe(24);
  expect(defaultPaperCount([])).toBe(0);
});
