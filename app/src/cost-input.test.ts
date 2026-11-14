import { expect, it } from "vitest";
import { costDraft, costPreferences, formatMicros, parseMicros } from "../../shared/cost";

it.each([["", null], ["0", 0], ["0.000001", 1], ["1.000001", 1000001], ["9007199254.740991", Number.MAX_SAFE_INTEGER]] as const)("parses %s without floating arithmetic", (value, expected) => { expect(parseMicros(value)).toBe(expected); if (expected !== null) expect(parseMicros(formatMicros(expected))).toBe(expected); });
it.each(["-1", "NaN", "Infinity", "1e-6", "0.0000001", "9007199254.740992", " 1 ", "1.", "01"])("rejects %s instead of rounding or coercing it", value => { expect(() => parseMicros(value)).toThrow(); });
it("keeps unset prices distinct from an explicitly configured free price", () => { const value = costDraft(); expect(costPreferences(value).inputMicrosPerMillion).toBeNull(); value.inputMicrosPerMillion = "0"; expect(costPreferences(value).inputMicrosPerMillion).toBe(0); expect(costDraft(costPreferences(value))).toEqual(value); });
