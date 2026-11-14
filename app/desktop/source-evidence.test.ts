import { expect, it } from "vitest";
import corpus from "../fixtures/tencent/source-evidence.json" with { type: "json" };
import { buildSourceEvidence } from "./source-evidence.js";
import { findDuplicateTrees, findSourceDuplicateTrees, removeDuplicateTrees } from "./duplicate-trees.js";

it.each(corpus)("matches historical source tree proof: $kind $name", input => {
  const args = structuredClone(input.args), options = input.options;
  const run = () => {
    if (input.kind === "build") return buildSourceEvidence(args[0], args[1], args[2], args[3], { textUnits: options.text_units, sourceType: options.source_type, tabularRowsSafe: options.tabular_rows_safe, complete: options.complete });
    if (input.kind === "find") return findDuplicateTrees(args[0], args[1], args[2], options.source_evidence);
    if (input.kind === "source") return findSourceDuplicateTrees(args[0], options.source_evidence);
    return removeDuplicateTrees(...args);
  };
  if ("error" in input) expect(run).toThrow();
  else { expect(run()).toEqual(input.expected); expect(args).toEqual(input.after); }
});

import { validateParsedQuestion } from "./question-contract.js";
it.each([NaN, Infinity, -Infinity])("rejects nonfinite JSON evidence even without source quotes: %s", value => {
  const question = validateParsedQuestion({ id: "q", stem: "Prompt", answerMode: "short_answer", contentBlocks: [{ partType: "table", jsonValue: { value: null } }] });
  question.contentBlocks[0].jsonValue = { value };
  expect(() => findDuplicateTrees([question], [], [])).toThrow();
});

it("revalidates shared-option labels after explicit complete-tree removal", () => {
  const questions = [0, 1].flatMap(index => [
    validateParsedQuestion({ id: `p${index}`, stem: "Bank", answerMode: "word_bank", options: [{ label: "A", content: "Word" }], passage: [{ partType: "blank", questionId: `c${index}` }] }),
    validateParsedQuestion({ id: `c${index}`, parentId: `p${index}`, optionSourceId: `p${index}`, stem: "Gap", answerMode: "choice", choiceVariant: "single", answerPayload: { correct: ["a"] } }),
  ]), quality = { reviewRequired: true, reviewQuestionCount: 4, issues: [] };
  const [retained] = removeDuplicateTrees(questions, [], [], [], quality, [[["p0", "c0"], ["p1", "c1"]]]);
  expect(retained.map(question => question.id)).toEqual(["p0", "c0"]); expect(retained[1].answerPayload).toEqual({ correct: ["A"] });
});

it("validates large table evidence without a spread-argument overflow", () => {
  const question = validateParsedQuestion({ id: "table", stem: "Prompt", answerMode: "short_answer", contentBlocks: [{ partType: "table", jsonValue: { values: [] } }] });
  question.contentBlocks[0].jsonValue = { values: [...Array<number>(150000).fill(0), NaN] };
  expect(() => findDuplicateTrees([question], [], [])).toThrowError(expect.objectContaining({ code: "OUTPUT_INVALID" }));
});
