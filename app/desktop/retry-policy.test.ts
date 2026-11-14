import { expect, it } from "vitest";
import type { FailedUnit, UnitFailure } from "../src/contracts.generated.js";
import { RETRYABLE_CODES, retryFailures, selectRetryUnits } from "./retry-policy.js";
const failure = (index: number, code = "OUTPUT_INVALID"): UnitFailure => ({ stage: "document_parse", index, code, retryable: true });
const unit = (index: number): FailedUnit => ({ stage: "document_parse", index });
it("matches per-unit retry projection and skips exhausted units in an all-failures request", () => {
  const input = [failure(0), failure(1), failure(2)], counts = { "document_parse:0": 2 }, before = structuredClone({ input, counts }), projected = retryFailures(input, counts);
  expect(projected.map(item => item.retriesRemaining)).toEqual([0, 2, 2]);
  expect(selectRetryUnits(projected, [])).toEqual([unit(1), unit(2)]);
  expect(selectRetryUnits(projected, [unit(2), unit(2)])).toEqual([unit(2)]);
  expect({ input, counts }).toEqual(before);
});
it.each([...RETRYABLE_CODES])("preserves explicit eligibility for %s", code => expect(retryFailures([failure(0, code)], {})[0]).toMatchObject({ retryable: true, retriesRemaining: 2 }));
it("rejects exhausted, unavailable and nonretryable units atomically", () => {
  const input = retryFailures([failure(0), failure(1, "OUTPUT_TRUNCATED"), failure(2)], { "document_parse:0": 2 }), before = structuredClone(input);
  expect(() => selectRetryUnits(input, [unit(2), unit(0)])).toThrowError(expect.objectContaining({ code: "RETRY_LIMIT_EXCEEDED" }));
  for (const selected of [[unit(3)], [unit(1)], [unit(2), unit(3)]]) expect(() => selectRetryUnits(input, selected)).toThrowError(expect.objectContaining({ code: "INVALID_RETRY_UNITS" }));
  expect(() => selectRetryUnits([], [])).toThrow(); expect(input).toEqual(before);
});
