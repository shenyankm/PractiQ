import type { FailedUnit, UnitFailure } from "../src/contracts.generated.js";
import { invariant } from "./errors.js";

export const MAX_UNIT_RETRIES = 2;
export const RETRYABLE_CODES = new Set(["OUTPUT_INVALID", "OUTPUT_STALLED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_AUTH_ERROR", "AI_PROVIDER_BALANCE_REQUIRED"]);
export const retryKey = (unit: Pick<FailedUnit, "stage" | "index"> | Pick<UnitFailure, "stage" | "index">): string => `${unit.stage}:${unit.index}`;
export function retryFailures(failures: UnitFailure[], counts: Record<string, number>): UnitFailure[] {
  return failures.map(failure => { const remaining = RETRYABLE_CODES.has(failure.code) ? Math.max(0, MAX_UNIT_RETRIES - (counts[retryKey(failure)] ?? 0)) : 0; return { ...failure, retryable: remaining > 0, retriesRemaining: remaining }; });
}
export function selectRetryUnits(failures: UnitFailure[], requested: FailedUnit[]): FailedUnit[] {
  const exhausted = new Set(failures.filter(failure => RETRYABLE_CODES.has(failure.code) && !failure.retriesRemaining).map(retryKey));
  invariant(!requested.some(unit => exhausted.has(retryKey(unit))), "RETRY_LIMIT_EXCEEDED", "Failed unit retry limit exceeded");
  const eligible = new Map(failures.filter(failure => failure.retryable).map(failure => [retryKey(failure), { stage: failure.stage, index: failure.index } as FailedUnit]));
  const selected = requested.length ? [...new Map(requested.map(unit => [retryKey(unit), unit])).values()] : [...eligible.values()];
  invariant(selected.length && selected.every(unit => eligible.has(retryKey(unit))), "INVALID_RETRY_UNITS", "Select existing retryable failed units"); return selected;
}
