import { expect, it } from "vitest";
import { retainSourceAnswers } from "./answer-evidence.js";
import type { Question } from "../src/contracts.generated.js";
import corpus from "../fixtures/tencent/answer-evidence.json" with { type: "json" };

it.each(corpus)("matches historical answer evidence: $name", input => {
  const questions = structuredClone(input.input) as unknown as Question[];
  expect(retainSourceAnswers(questions, input.primary, input.contexts, input.answerSheet)).toEqual(input.removed);
  expect(questions).toEqual(input.expected);
});

import edges from "../fixtures/tencent/answer-evidence-edges.json" with { type: "json" };
import { validateParsedQuestion } from "./question-contract.js";
it.each(edges)("preserves scalar and JSON source distinctions: $source", input => {
  const questions = [structuredClone(input.input) as unknown as Question];
  expect(retainSourceAnswers(questions, input.source, [])).toEqual(input.removed);
  expect(questions[0]).toEqual(input.expected);
});
it("indexes a large source without borrowing answers or mutating unrelated metadata", () => {
  const count = 4000, questions = Array.from({ length: count }, (_, index) => validateParsedQuestion({ id: `q:${index + 1}`, stem: `Prompt ${index}?`, answerMode: "short_answer", answerPayload: { text: `Answer ${index}` } }));
  const source = questions.map((q, index) => `${index + 1}. ${q.stem}\nAnswer: Answer ${index}`).join("\n");
  const original = structuredClone(questions); expect(retainSourceAnswers(questions, source, [])).toEqual([]); expect(questions).toEqual(original);
  questions[2000].answerPayload = { text: "Answer 1999" }; expect(retainSourceAnswers(questions, source, [])).toEqual([[2000, ["answerPayload"]]]);
});
