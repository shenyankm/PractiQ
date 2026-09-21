import { expect, it } from "vitest";
import { cents } from "./paper";
it("parses exact decimal points without floating point rounding", () => {
  expect(cents("0.29")).toBe(29);
  expect(cents("100")).toBe(10000);
  expect(() => cents("1.001")).toThrow();
  expect(() => cents("-1")).toThrow();
});
