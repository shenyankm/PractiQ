import { expect, it } from "vitest";
import type { ParsedGroup, Question, VisualElement } from "../src/contracts.generated.js";
import { finalizeQuestions, SourceQuestionConflict } from "./finalize-questions.js";
import type { MergeQuality, MergeSource } from "./merge-chunks.js";
import corpus from "../fixtures/tencent/finalize-questions.json" with { type: "json" };

it.each(corpus)("matches historical composite identity and association finalization: $name", input => {
  const args = structuredClone(input.input) as unknown as { questions: Question[]; groups: ParsedGroup[]; visuals: VisualElement[]; sources: MergeSource[]; quality: MergeQuality };
  if ("errorIndex" in input) {
    try { finalizeQuestions(args.questions, args.groups, args.visuals, args.sources, args.quality); throw new Error("Expected source conflict"); }
    catch (error) { expect(error).toBeInstanceOf(SourceQuestionConflict); expect((error as SourceQuestionConflict).questionIndex).toBe(input.errorIndex); }
  } else expect({ ...args, questions: finalizeQuestions(args.questions, args.groups, args.visuals, args.sources, args.quality) }).toEqual(input.expected);
});
