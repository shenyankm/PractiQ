import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { answerSourceConflict, grade, hasAnswer, validateQuestion, validateTree } from "./question-contract.js";
import { parseJson, validateDocument } from "./document-contract.js";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/contracts.json", import.meta.url), "utf8")) as { name: string; input: { questions: unknown[] }; valid: boolean; missingFields: string[] }[];
it.each(fixtures)("matches the shared document contract corpus: $name", fixture => {
  if (fixture.valid) {
    const result = validateDocument(fixture.input);
    const q = (result.questions as { missingFields: string[] }[])[0];
    expect(q.missingFields).toEqual(fixture.missingFields);
  } else expect(() => validateDocument(fixture.input)).toThrow();
});
it.each(fixtures.slice(0, 9))("preserves existing $name question normalization", fixture => {
  const questions = validateTree(fixture.input.questions);
  expect(questions[0].missingFields).toEqual(fixture.missingFields);
});
const base = { id: "one", stem: "Is this true?", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, sourceText: "original", analysis: "explanation" };
it("does not grade conflicting, incomplete, missing-resource or subjective answers as wrong", () => {
  const q = validateQuestion(base);
  expect(grade(q, { value: true })).toBe(true);
  expect(grade(q, { value: false })).toBe(false);
  expect(grade(q, {})).toBeNull();
  expect(grade({ ...q, missingFields: ["media"] }, { value: false })).toBeNull();
  expect(grade({ ...q, answerPayload: null }, { value: false })).toBeNull();
  expect(grade({ ...q, sourceText: "Is this true?\n答案：错误" }, { value: true })).toBeNull();
  const subjective = validateQuestion({ ...base, answerMode: "short_answer", answerPayload: { text: "reference" } });
  expect(grade(subjective, { text: "response" })).toBeNull();
});

it("preserves false and zero answers while ignoring recursively empty drafts", () => {
  for (const value of [false, 0, { value: false }, { nested: [0] }]) expect(hasAnswer(value)).toBe(true);
  for (const value of [null, "  ", [], {}, { nested: [null, " ", {}] }]) expect(hasAnswer(value)).toBe(false);
});

it("keeps Rust whitespace semantics for stored text and exact blank answers", () => {
  const question = validateQuestion({ ...base, stem: "\u0085\ufeff Q \u0085", answerMode: "fill_blank", answerPayload: { answers: ["\u0085\ufeff Answer\u0085"] } });
  expect(question.stem).toBe("\ufeff Q"); expect(question.answerPayload).toEqual({ answers: ["\ufeff Answer"] });
  expect(grade(question, { answers: ["\ufeff Answer"] })).toBe(true);
  expect(grade(question, { answers: ["Answer"] })).toBe(false);
  expect(hasAnswer("\u0085")).toBe(false); expect(hasAnswer("\ufeff")).toBe(true); expect(hasAnswer("\u001c")).toBe(true);
  expect(answerSourceConflict({ ...base, stem: "\ufeffQ", sourceText: "Q\n答案：错误" })).toBe(false);
  expect(answerSourceConflict({ ...base, stem: "Q", sourceText: "Q\n\u0085答案：错误\u0085" })).toBe(true);
});

it("matches choices case-insensitively, blanks exactly after trimming, and pairs independently of object key order", () => {
  const choice = validateQuestion({ ...base, answerMode: "choice", choiceVariant: "multiple", options: [{ label: "A", content: "a" }, { label: "B", content: "b" }], answerPayload: { correct: ["A", "B"] } });
  expect(grade(choice, { correct: ["b", "a", "a"] })).toBe(true);
  const blank = validateQuestion({ ...base, answerMode: "fill_blank", answerPayload: { answers: [" True "] } });
  expect(grade(blank, { answers: [" True "] })).toBe(true);
  expect(grade(blank, { answers: ["true"] })).toBe(false);
  const matching = validateQuestion({ ...base, answerMode: "matching", matchingVariant: "one_to_one", items: [{ id: 0, side: "left", content: "a" }, { id: 1, side: "left", content: "b" }, { id: 0, side: "right", content: "c" }, { id: 1, side: "right", content: "d" }], answerPayload: { matches: [{ left: 0, right: 1 }, { left: 1, right: 0 }] } });
  expect(grade(matching, { matches: [{ right: 0, left: 1 }, { right: 1, left: 0 }] })).toBe(true);
});

it("rejects cyclic ancestry, mismatched modes, unsafe audio paths and invalid option references", () => {
  expect(() => validateTree([{ ...base, id: "a", parentId: "b", answerMode: "reading", answerPayload: null }, { ...base, id: "b", parentId: "a", answerMode: "reading", answerPayload: null }])).toThrow();
  expect(() => validateQuestion({ ...base, questionKind: "writing" })).toThrow("does not match");
  expect(() => validateQuestion({ ...base, answerMode: "listening", answerPayload: null, audioRef: { objectKey: "../audio.mp3", sha256: "a".repeat(64), mediaType: "audio/mpeg", sizeBytes: 10 } })).toThrow("Unsafe audio");
  expect(() => validateQuestion({ ...base, answerMode: "choice", choiceVariant: "single", options: [{ label: "A", content: "a" }, { label: "B", content: "b" }], answerPayload: { correct: ["C"] } })).toThrow("invalid option");
});

it("uses source conflict proofs only when a single unambiguous supplied answer matches the stem", () => {
  expect(answerSourceConflict({ ...base, sourceText: "Is this true?\n答案：错误" })).toBe(true);
  expect(answerSourceConflict({ ...base, sourceText: "1. Is this true?\n2. Another question\n答案：错误" })).toBe(false);
  expect(answerSourceConflict({ ...base, sourceText: "Different question\n答案：错误" })).toBe(false);
});

it("rejects non-UTF8 JSON and integer overflow before imported IDs can lose precision", () => {
  expect(() => parseJson(new Uint8Array([255]))).toThrow();
  expect(() => parseJson(Buffer.from('\ufeff{"count":1}'))).toThrow();
  expect(() => parseJson(Buffer.from('{"stem":"\\ud800"}'))).toThrow("invalid Unicode");
  expect(() => parseJson(Buffer.from('{"id":9007199254740993}'))).toThrow("Unsafe JSON number");
  expect(() => parseJson(Buffer.from('{"id":9007199254740991.1}'))).toThrow("loses fractional precision");
  expect(parseJson(Buffer.from('{"confidence":0.5,"count":1.0}'))).toEqual({ confidence: 0.5, count: 1 });
});
