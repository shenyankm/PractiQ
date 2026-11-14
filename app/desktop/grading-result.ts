import type { GradeResult } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { object, text } from "./question-contract.js";

export const GRADING_PROMPT_VERSION = "electron-subjective-grade-v1";
export function sourceMaximum(question: unknown, fallback: number): number {
  const score = object(question).sourceScore;
  if (typeof score !== "number") return fallback;
  const value = score * 100, floor = Math.floor(value), rounded = value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
  return Number.isSafeInteger(rounded) && rounded >= 1 && rounded <= 100000000 ? rounded : fallback;
}
export function scaleScore(score: number, maximum: number, assessment: number): number {
  return Number((BigInt(score) * BigInt(maximum) + BigInt(Math.floor(assessment / 2))) / BigInt(assessment));
}
export function validateGradeResult(value: unknown): asserts value is GradeResult {
  validateContract("GradeResult", value);
  const result = value as GradeResult;
  invariant(result.reason.trim() && (result.scoreCents === null || result.scoreCents <= result.maxCents) && [...result.evidence, ...result.reviewReasons].every(value => [...value].length <= 20000), "LOCAL_RESPONSE_INVALID", "Invalid grading explanation or score");
}
export function verifyGradeEvidence(result: GradeResult, question: unknown, answer: string): void {
  validateGradeResult(result);
  const criteria = result.criteria ?? [];
  if (result.scoreCents === null) {
    invariant(result.reviewReasons.some(reason => reason.trim()) && criteria.length === 0, "GRADING_EVIDENCE_INVALID", "Abstention needs a review reason and no scored criteria"); return;
  }
  const maximum = result.assessmentMaxCents ?? result.maxCents, expected = text(question, "scoringRubric") && object(question).sourceScore ? sourceMaximum(question, result.maxCents) : result.maxCents;
  invariant(maximum === expected && criteria.length > 0 && criteria.reduce((sum, criterion) => sum + criterion.maxCents, 0) === maximum && result.scoreCents === scaleScore(criteria.reduce((sum, criterion) => sum + criterion.scoreCents, 0), result.maxCents, maximum), "GRADING_EVIDENCE_INVALID", "Scoring criteria do not match the assessment totals");
  const references = [text(question, "scoringRubric"), text(object(question).answerPayload, "text")], names = new Set<string>();
  for (const criterion of criteria) {
    invariant(criterion.criterion.trim() && !names.has(criterion.criterion) && criterion.reason.trim() && criterion.scoreCents <= criterion.maxCents && criterion.referenceQuote.trim() && references.some(reference => reference.includes(criterion.referenceQuote)) && (criterion.scoreCents === 0 || criterion.answerQuote.trim()) && answer.includes(criterion.answerQuote), "GRADING_EVIDENCE_INVALID", "Scoring quotations are not grounded in the supplied reference and answer");
    names.add(criterion.criterion);
  }
}
