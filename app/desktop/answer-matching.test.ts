import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { DocumentAnswerMatch, DocumentParseResult, Question } from "../src/contracts.generated.js";
import { associatedQuestion, matchAnswers, printedNumber } from "./answer-matching.js";
import { canonical } from "./questions.js";

const reference = JSON.parse(readFileSync(new URL("../fixtures/tencent/answer-matching.json", import.meta.url), "utf8")) as {
  printed: { question: Question; expected: string | null }[];
  conversions: { name: string; target: Question; supplied: Question; expected?: Question; code?: string }[];
  matching: { target: DocumentParseResult; answers: DocumentParseResult; expected: DocumentAnswerMatch[] }[];
};
it.each(reference.printed)("matches the reference printed number for $question.sourceText", item => { expect(printedNumber(item.question)).toBe(item.expected); });
it.each(reference.conversions)("converts only the supplied literal: $name", item => {
  const before = canonical(item);
  if (item.code) expect(() => associatedQuestion(item.target, item.supplied)).toThrow(expect.objectContaining({ code: item.code }));
  else expect(associatedQuestion(item.target, item.supplied)).toEqual(item.expected);
  expect(canonical(item)).toBe(before);
});
it.each(reference.matching)("retains ambiguous/missing numbers, existing false answers and original ordering", item => {
  const before = canonical(item); expect(matchAnswers(item.target, item.answers)).toEqual(item.expected); expect(canonical(item)).toBe(before);
});
it("does not silently round supplied ordering or matching item IDs beyond the wire integer range", () => {
  const example = reference.conversions.find(item => item.target.answerMode === "ordering")!;
  expect(() => associatedQuestion(example.target, { ...example.supplied, answerPayload: { text: "9007199254740993" } })).toThrow(expect.objectContaining({ code: "ANSWER_MATCH_INVALID" }));
  expect(() => associatedQuestion({ ...example.target, answerMode: "matching" }, { ...example.supplied, answerPayload: { text: "9007199254740993=0" } })).toThrow(expect.objectContaining({ code: "ANSWER_MATCH_INVALID" }));
});
