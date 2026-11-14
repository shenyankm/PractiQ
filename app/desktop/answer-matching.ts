import type { DocumentAnswerMatch, DocumentParseResult, Question } from "../src/contracts.generated.js";
import { printedPrefix } from "./answer-evidence.js";
import { invariant } from "./errors.js";
import { composite } from "./question-contract.js";
import { SOURCE_WHITESPACE, sourceDecimalDigits, sourceTrim } from "./source-text.js";

export function printedNumber(question: Question): string | null {
  for (const value of [question.sourceText, question.stem]) { const match = printedPrefix().exec(value ?? ""); if (match?.index === 0) return sourceDecimalDigits(match.groups!.number); }
  return null;
}
export function matchAnswers(target: DocumentParseResult, answers: DocumentParseResult): DocumentAnswerMatch[] {
  const byNumber = new Map<string, number[]>(), counts = new Map<string, number>(), numbers = target.questions.map(question => composite(question) ? null : printedNumber(question));
  for (const number of numbers) if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
  for (const [index, question] of answers.questions.entries()) { const number = printedNumber(question); if (question.answerPayload !== null && number !== null) byNumber.set(number, [...byNumber.get(number) ?? [], index]); }
  return target.questions.flatMap((question, questionIndex) => {
    if (composite(question)) return [];
    const number = numbers[questionIndex], candidates = number === null ? [] : byNumber.get(number) ?? [];
    return [{ questionIndex, candidates: candidates.slice(0, 2000), status: question.answerPayload !== null ? "has_answer" : !candidates.length ? "unmatched" : candidates.length === 1 && counts.get(number!) === 1 ? "unique" : "ambiguous" }];
  });
}

/** Convert supplied literal formats only; incompatible labels still require normal tree validation. */
export function associatedQuestion(target: Question, supplied: Question): Question {
  invariant(supplied.answerPayload !== null, "ANSWER_MATCH_INVALID", "The selected answer record has no supplied answer");
  let payload = structuredClone(supplied.answerPayload); const text = payload.text;
  const integer = (value: string) => { const number = Number(sourceDecimalDigits(value)); invariant(Number.isSafeInteger(number), "ANSWER_MATCH_INVALID", "Supplied answer item exceeds the safe integer range"); return number; };
  if (typeof text === "string") {
    const value = sourceTrim(text), values = value.split(new RegExp(`[,，、;；${SOURCE_WHITESPACE.slice(1, -1)}]+`, "u"));
    if (target.answerMode === "choice") payload = { correct: values.filter(Boolean) };
    else if (target.answerMode === "true_false") { const labels: Record<string, boolean> = { true: true, false: false, 正确: true, 错误: false, 对: true, 错: false, "√": true, "×": false }; if (Object.hasOwn(labels, value.toLowerCase())) payload = { value: labels[value.toLowerCase()] }; }
    else if (target.answerMode === "fill_blank" && target.blankCount === 1) payload = { answers: [text] };
    else if (target.answerMode === "ordering" && values.every(value => /^\p{Nd}+$/u.test(value))) payload = { order: values.map(integer) };
    else if (target.answerMode === "matching") {
      const pairs = value.split(/[\n;；]+/u).map(value => new RegExp(String.raw`^${SOURCE_WHITESPACE}*(\p{Nd}+)${SOURCE_WHITESPACE}*=${SOURCE_WHITESPACE}*(\p{Nd}+)${SOURCE_WHITESPACE}*$`, "u").exec(value));
      if (pairs.length && pairs.every(Boolean)) payload = { matches: pairs.map(pair => ({ left: integer(pair![1]), right: integer(pair![2]) })) };
    }
  }
  return { ...structuredClone(target), answerPayload: payload, analysis: target.analysis ?? supplied.analysis, scoringRubric: target.scoringRubric ?? supplied.scoringRubric, needsReview: true };
}
