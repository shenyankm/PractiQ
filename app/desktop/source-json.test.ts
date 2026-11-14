import { expect, it } from "vitest";
import { parseSourceJson, sourceNumberString } from "./source-json.js";
import numbers from "../fixtures/tencent/source-numbers.json" with { type: "json" };
import { referenceSupplied } from "./source-chunks.js";

it.each(numbers)("matches Python source number spelling: $token", input => expect(sourceNumberString(input.token)).toBe(input.expected));
it("retains original numeric types and integer precision for source proof comparison", () => {
  expect(parseSourceJson('{"a":[1,0]}')).toMatchObject({ floatTokens: false, unsafeIntegers: false });
  expect(parseSourceJson('{"a":[1.0,0]}').floatTokens).toBe(true);
  expect(parseSourceJson('[9007199254740993]').unsafeIntegers).toBe(true);
  expect(parseSourceJson('9007199254740993').scalarNumber).toBe('9007199254740993');
  for (const token of ["NaN", "Infinity", "-Infinity"]) { expect(parseSourceJson(token).floatTokens).toBe(true); expect(referenceSupplied(token)).toBe(true); }
});
it.each(['{"a":1,"\\u0061":2}', '{"a":1,"a":2}', '[1,]', '{"a":undefined}', '01', '+1', 'nan', 'infinity', '1 2', 'true false', '[NaN NaN]', '{"a":NaN,}', '"unterminated', '9'.repeat(4301)])("rejects invalid or duplicate source JSON %s", value => expect(() => parseSourceJson(value)).toThrow());
it("bounds source recursion without losing explicit unknown evidence", () => {
  expect(() => parseSourceJson('['.repeat(1002)+'0'+']'.repeat(1002))).toThrow();
  expect(referenceSupplied('["",null]')).toBe(false);
  expect(referenceSupplied('[false,0]')).toBe(true);
  expect(referenceSupplied('{"empty":[]}')).toBe(false);
});
