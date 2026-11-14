import { expect, it } from "vitest";
import { buildSourceEvidence } from "./source-evidence.js";
import { findDuplicateTrees, findSourceDuplicateTrees, removeDuplicateTrees } from "./duplicate-trees.js";
import { validateParsedQuestion } from "./question-contract.js";
import type { Question } from "../src/contracts.generated.js";

const question = (id: string, sourceText: string, patch: Record<string, unknown> = {}) => validateParsedQuestion({ id, stem: "Prompt", sourceText, answerMode: "short_answer", ...patch });
const span = (text: string) => ({ start: 0, end: [...text].length, overlapStart: 0, overlapEnd: 0 });
const sources = (questions: Question[]) => questions.map((_, questionIndex) => ({ questionIndex, stage: "document_parse" as const, unitIndex: 0 }));
const proof = (text: string, questions: Question[]) => buildSourceEvidence(text, questions, sources(questions), [span(text)]);

function repeatedTrees() {
  const questions = [1, 20].flatMap(root => {
    const parent = `p${root}`, children = [`c${root + 1}`, `c${root + 2}`];
    return [question(parent, `${root}. Word bank: Choose words\nMaterial: Snow is [blank:${root + 1}]. Grass is [blank:${root + 2}].\nA. white\nB. green`, { answerMode: "word_bank", stem: "Choose words", options: [{ label: "A", content: "white" }, { label: "B", content: "green" }], passage: [{ partType: "text", textValue: "Snow is " }, { partType: "blank", questionId: children[0] }, { partType: "text", textValue: ". Grass is " }, { partType: "blank", questionId: children[1] }] }), ...children.map((id, i) => question(id, `${root + i + 1}. Single choice: ${i ? "Grass" : "Snow"} is\nParent ID: ${root}. Shared option owner: ${root}.\nReference answer: ${i ? "B" : "A"}`, { parentId: parent, optionSourceId: parent, stem: `${i ? "Grass" : "Snow"} is`, answerMode: "choice", choiceVariant: "single", answerPayload: { correct: [i ? "B" : "A"] } }))];
  });
  return { questions, text: questions.map(q => q.sourceText).join("\n\n") };
}

it("normalizes only identities in complete proven trees and leaves parsed business fields unchanged", () => {
  const { questions, text } = repeatedTrees(), before = structuredClone(questions), evidence = proof(text, questions);
  expect(Object.values(evidence).every(Boolean)).toBe(true);
  expect(findDuplicateTrees(questions, [], [], evidence)).toEqual([[["p1", "c2", "c3"], ["p20", "c21", "c22"]]]);
  expect(questions).toEqual(before);
});

it.each(["missing-child", "unproven-quote", "blank-order", "option-owner"])("does not prove an incomplete or conflicting source tree: %s", fault => {
  const { questions, text } = repeatedTrees();
  if (fault === "missing-child") questions.splice(2, 1);
  else if (fault === "unproven-quote") questions[1].sourceText = "Snow is";
  else if (fault === "blank-order") questions[0].passage!.reverse();
  else questions[1].optionSourceId = "p20";
  const evidence = proof(text, questions);
  expect(evidence.p1).toBeNull(); expect(evidence.p20).toBeTruthy();
});

it.each(["Worksheet instructions", "Short answer: Prompt", "1. Short answer:", "1. Short answer: Prompt\nReference answer: A\n2. Short answer: Other"])("rejects preamble, partial and cross-record source quotes: %s", quote => {
  const text = "Worksheet instructions\n\n1. Short answer: Prompt\nReference answer: A\n2. Short answer: Other\nReference answer: B";
  const questions = [question("a", quote), question("b", "2. Short answer: Other\nReference answer: B", { stem: "Other" })];
  const evidence = proof(text, questions);
  expect(evidence.a).toBeNull(); expect(evidence.b).toBeTruthy();
});

it("refuses normalization without complete source, verified spans and one source-unit owner", () => {
  const text = "1. Short answer: Prompt", questions = [question("q", text)];
  expect(buildSourceEvidence(null, questions, sources(questions), [span(text)])).toEqual({});
  expect(buildSourceEvidence(text, questions, sources(questions), null)).toEqual({});
  expect(buildSourceEvidence(text, questions, sources(questions), [span(text)], { complete: false })).toEqual({});
  const ambiguous = [...sources(questions), { questionIndex: 0, stage: "document_parse" as const, unitIndex: 1 }];
  const evidence = buildSourceEvidence(text, questions, ambiguous, [span(text), span(text)]);
  expect(evidence.q).toBeNull(); expect(findDuplicateTrees(questions, [], [], evidence)).toEqual([]);
});

it("retains full source fields omitted from a quote instead of deduplicating different supplied answers", () => {
  const records = ["1. Short answer: Prompt\nReference answer: A", "2. Short answer: Prompt\nReference answer: B"], text = records.join("\n");
  const questions = records.map((record, i) => question(`q${i}`, record.split("\n")[0]));
  const evidence = proof(text, questions);
  expect(evidence.q0!.full_source).not.toEqual(evidence.q1!.full_source);
  expect(findDuplicateTrees(questions, [], [], evidence)).toEqual([]);
});

it("keeps original-source repeats reviewable when parsed scores or answers differ", () => {
  const { questions, text } = repeatedTrees(), evidence = proof(text, questions);
  questions[3].sourceScore = 5;
  expect(findDuplicateTrees(questions, [], [], evidence)).toEqual([]);
  expect(findSourceDuplicateTrees(questions, evidence)).toEqual([[["p1", "c2", "c3"], ["p20", "c21", "c22"]]]);
});

it("retains cross-tree groups and distinct source visuals instead of treating them as interchangeable copies", () => {
  const { questions, text } = repeatedTrees(), evidence = proof(text, questions);
  expect(findDuplicateTrees(questions, [{ title: "Shared section", questionIndexes: [0, 3] }], [], evidence)).toEqual([]);
  expect(findDuplicateTrees(questions, [], [{ kind: "image", description: "First figure", questionIndexes: [0] }, { kind: "image", description: "Different figure", questionIndexes: [3] }], evidence)).toEqual([]);
});

it("proves historical tabular rows only after explicit safe-row validation and preserves arbitrary business JSON", () => {
  const header = "id\troot_task\tquestion_type\tstem\tparent_id\toption_owner\tmaterial\toptions\tanswer\tevidence";
  const rows = [1, 20].map(id => `${id}\t${id}\tShort answer\tPrompt\t\t\t\t\tA\t{\"business-id\":9}`), text = [header, ...rows].join("\n"), questions = rows.map((row, i) => question(`q${i}`, row));
  expect(buildSourceEvidence(text, questions, sources(questions), [span(text)], { sourceType: "csv" })).toEqual({});
  const evidence = buildSourceEvidence(text, questions, sources(questions), [span(text)], { sourceType: "csv", tabularRowsSafe: true });
  expect(evidence.q0).toBeTruthy(); expect(evidence.q0!.full_source).toEqual(evidence.q1!.full_source);
  expect(evidence.q0!.full_source).toMatchObject({ record: expect.arrayContaining([expect.stringContaining('{"business-id":9}')]) });
});

it("stores prototype-like model IDs as ordinary evidence keys without changing object prototypes", () => {
  const text = "1. Short answer: Prompt", evidence = proof(text, [question("__proto__", text)]);
  expect(Object.getPrototypeOf(evidence)).toBeNull();
  expect(Object.hasOwn(evidence, "__proto__")).toBe(true); expect(evidence["__proto__"]).toBeTruthy();
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

it("remaps sources, groups, visuals and review metadata when explicitly removing a proven whole-tree copy", () => {
  const { questions, text } = repeatedTrees(), copies = findDuplicateTrees(questions, [], [], proof(text, questions));
  questions[0].confidence = 0.9; questions[3].confidence = 0.2;
  const groups = [0, 3].map(index => ({ title: "Section", questionIndexes: [index, index + 1, index + 2] }));
  const visuals = [{ kind: "image" as const, description: "Shared source", questionIndexes: [0, 3] }], provenance = sources(questions).map((item, index) => ({ ...item, unitIndex: index < 3 ? 0 : 1 }));
  const quality = { reviewRequired: true, reviewQuestionCount: 6, issues: [{ questionIndex: 4, code: "NEEDS_REVIEW" as const }] };
  const [retained, warnings] = removeDuplicateTrees(questions, groups, visuals, provenance, quality, copies);
  expect(retained.map(q => q.id)).toEqual(["p1", "c2", "c3"]); expect(retained[0].confidence).toBe(0.2);
  expect(groups).toEqual([{ title: "Section", questionIndexes: [0, 1, 2] }]); expect(visuals[0].questionIndexes).toEqual([0]);
  expect(provenance).toHaveLength(6); expect(provenance.every(item => item.questionIndex < 3)).toBe(true);
  expect(quality.issues).toEqual([{ questionIndex: 1, code: "NEEDS_REVIEW" }]); expect(warnings.join(" ")).toContain("explicit opt-in");
});

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
