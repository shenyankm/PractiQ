import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ModelOutputError } from "./model.js";
import { validateSourceContext, validateSourceFields, type SourceFieldContext } from "./source-fields.js";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/tencent/source-fields.json", import.meta.url), "utf8")) as { cases: { name: string; input: unknown; context: SourceFieldContext; expected?: unknown; rejected?: boolean }[] };
const fidelity = JSON.parse(readFileSync(new URL("../fixtures/tencent/source-fidelity.json", import.meta.url), "utf8")) as typeof corpus;
const ocr = JSON.parse(readFileSync(new URL("../fixtures/tencent/ocr-fidelity.json", import.meta.url), "utf8")) as typeof corpus;
it.each([...corpus.cases, ...fidelity.cases, ...ocr.cases])("matches historical source-field/closed-tree/text/OCR validation: $name", input => {
  if (input.rejected) expect(() => validateSourceFields(input.input, input.context)).toThrow(ModelOutputError);
  else expect(validateSourceFields(input.input, input.context)).toEqual(input.expected);
});
it("reports every supplied missing field in one bounded correction without changing the draft", () => {
  const input = corpus.cases.find(test => test.name === "all-fields-missing")!, before = JSON.stringify(input.input);
  try { validateSourceFields(input.input, input.context); throw new Error("Expected source-field rejection"); }
  catch (error) { expect(error).toBeInstanceOf(ModelOutputError); const feedback = (error as ModelOutputError).feedback; for (const field of ["stem", "options", "analysis", "answerPayload"]) expect(feedback).toContain(`requires extracted ${field}`); }
  expect(JSON.stringify(input.input)).toBe(before);
});
it.each([NaN, -1, 1.5, 1001])("rejects an invalid source record count %s before model work", expectedNodeCount => {
  expect(() => validateSourceContext({ index: 0, expectedNodeCount, presence: null })).toThrow();
});
it("rejects malformed persisted hints and untrusted feedback identifiers", () => {
  for (const presence of [{ secret: { need_stem: true } }, { "1": null }, { "1": { need_stem: true, need_options: true, need_analysis: true, unknown: "PRIVATE" } }, { "1": { need_stem: true, need_options: false, need_analysis: false, stem_sha256: "bad" } }]) expect(() => validateSourceContext({ index: 0, expectedNodeCount: 1, presence } as unknown as SourceFieldContext)).toThrow();
});
it("rejects malformed OCR source scopes before model work", () => {
  for (const ocr of [null, {}, { text: 1 }, { text: "", untrusted: "PRIVATE" }, { text: "", nativeTable: null }, { text: "", nativeTable: { title: "Science", headers: [null] } }]) expect(() => validateSourceContext({ index: 0, expectedNodeCount: null, presence: null, ocr } as unknown as SourceFieldContext)).toThrow();
});
