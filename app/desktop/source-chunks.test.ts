import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sourcePresencePlan, splitChunkPlan } from "./source-chunks.js";
import { SourceText, sourceLines, sourceTrim, sourceWithoutWhitespace } from "./source-text.js";

const typedSource = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}. Short answer: Prompt ${i}\nReference answer: A\n`).join("");
it.each([{ count: 1, expected: [1] }, { count: 16, expected: [16] }, { count: 17, expected: [16, 1] }, { count: 33, expected: [16, 16, 1] }])("bounds independent-question density without losing bytes: $count", ({ count, expected }) => {
  const text = typedSource(count), plan = splitChunkPlan(text), source = new SourceText(text);
  expect(plan.nodeCounts).toEqual(expected); expect(plan.header).toBeNull();
  expect(plan.spans.map(s => source.slice(s.start, s.end)).join("")).toBe(text);
  expect(plan.spans.every(s => s.overlapStart === s.start && s.overlapEnd === s.start)).toBe(true);
});

it("respects a small target without splitting a known question", () => {
  const text = typedSource(3), plan = splitChunkPlan(text, 20), source = new SourceText(text);
  expect(plan.nodeCounts).toEqual([1, 1, 1]);
  expect(plan.spans.map(s => source.slice(s.start, s.end))).toEqual([0, 1, 2].map(i => `${i + 1}. Short answer: Prompt ${i}\nReference answer: A\n`));
});

it.each([0, -1, 0.5, 40001])("rejects invalid hard-limit targets: %s", target => {
  expect(() => splitChunkPlan("Source", target)).toThrowError(expect.objectContaining({ code: "DOCUMENT_CHUNK_TOO_LARGE" }));
});

it("refuses an oversized known question and conservatively splits unstructured text", () => {
  expect(() => splitChunkPlan("1. Short answer: " + "x".repeat(40001))).toThrowError(expect.objectContaining({ code: "DOCUMENT_CHUNK_TOO_LARGE" }));
  expect(splitChunkPlan("x".repeat(50000)).spans.map(s => s.end - s.start)).toEqual([30000, 20000]);
});

const bank = "1. Word bank: Choose words\nMaterial: Snow is [blank:2]. Grass is [blank:3].\nA. white\nB. green\n2. Single choice: Snow is\nParent ID: 1. Shared option owner: 1.\nReference answer: A\n3. Single choice: Grass is\nParent ID: 1. Shared option owner: 1.\nReference answer: B";
it("keeps a closed shared-option tree together and does not require repeated child options", () => {
  const plan = splitChunkPlan(bank, 20), hints = sourcePresencePlan(bank, plan.spans)[0]!;
  expect(plan.nodeCounts).toEqual([3]); expect(hints["1"].need_options).toBe(true);
  expect(hints["1"].need_answer).toBe(false); expect(hints["2"]).toMatchObject({ need_options: false, need_answer: true });
  expect(sourcePresencePlan(bank, [{ start: 0, end: bank.indexOf("2. Single"), overlapStart: 0, overlapEnd: 0 }])).toEqual([null]);
});

it.each(["1. Short answer: Q\n1. Short answer: Other", "2. Single choice: Gap\nParent ID: 9. Shared option owner: 9.", bank.replace("[blank:3]", "[blank:99]")])("does not infer closed-tree identities from malformed source: %#", text => {
  const plan = splitChunkPlan(text); expect(plan.nodeCounts.every(count => count === null)).toBe(true);
  expect(sourcePresencePlan(text, plan.spans).every(hint => hint === null)).toBe(true);
});

it("retains literal field requirements and the printed-stem checksum", () => {
  const text = "1. Single choice: Prompt\nA. Alpha\nB. Beta\nReference answer: A\nAnalysis: Explanation", plan = splitChunkPlan(text);
  expect(sourcePresencePlan(text, plan.spans)[0]!["1"]).toMatchObject({ need_stem: true, need_options: true, need_analysis: true, need_answer: true, stem_sha256: createHash("sha256").update("Prompt").digest("hex"), answer_source: text });
});

it.each(["null", "unknown", "N/A", "[]", '{"text":""}'])("does not advertise unavailable answer evidence: %s", answer => {
  const text = `1. Short answer: Q\nReference answer: ${answer}`, plan = splitChunkPlan(text);
  expect(sourcePresencePlan(text, plan.spans)[0]!["1"].need_answer).toBe(false);
});
it.each(["false", "0", '{"text":"Given"}'])("recognizes supplied zero/false/nonempty evidence: %s", answer => {
  const text = `1. Short answer: Q\nReference answer: ${answer}`, plan = splitChunkPlan(text);
  expect(sourcePresencePlan(text, plan.spans)[0]!["1"].need_answer).toBe(true);
});

it.each(["Reference answer: A\nReference answer: B", "Reference answer: A\nSupplied answer: A", "Reference answer: A\nAnswer status: generated", "Reference answer: A\nNo reference answer is supplied for this question."])("does not turn ambiguous or generated answers into supplied evidence: %#", fields => {
  const text = `1. Short answer: Q\n${fields}`, plan = splitChunkPlan(text);
  expect(sourcePresencePlan(text, plan.spans)[0]!["1"].need_answer).toBe(false);
});

it("does not claim literal-stem proof for unrecognized body layouts or incomplete input", () => {
  const text = "1. Short answer: Q\nUnlabelled continuation", plan = splitChunkPlan(text);
  expect(plan.nodeCounts).toEqual([null]); expect(sourcePresencePlan(text, plan.spans)[0]!["1"].stem_sha256).toBeUndefined();
  expect(sourcePresencePlan(text, plan.spans, { complete: false })).toEqual([null]);
});

it("keeps a verified legacy table header and bounded row groups only after safe-row validation", () => {
  const header = "id\troot_task\tparent_id\toption_owner\tquestion_type\tstem\toptions\treference_answer\tevidence\tanswer_status";
  const rows = Array.from({ length: 17 }, (_, i) => `${i + 1}\t${i + 1}\t\t\tSingle choice\tPrompt ${i}\t[{"label":"A","content":"Alpha"},{"label":"B","content":"Beta"}]\tA\t{"analysis":"Explanation"}\tsupplied`), text = [header, ...rows].join("\n"), options = { sourceType: "csv", tabularRowsSafe: true };
  const plan = splitChunkPlan(text, 30000, options);
  expect(plan).toMatchObject({ header, nodeCounts: [16, 1] });
  expect(sourcePresencePlan(text, plan.spans, options)[0]!["1"]).toMatchObject({ need_stem: true, need_options: true, need_analysis: true, need_answer: true });
  expect(sourcePresencePlan(text, plan.spans, { sourceType: "csv" })).toEqual([null, null]);
});

it.each([{ start: -1, end: 5 }, { start: 0, end: 9999 }, { start: 0.5, end: 5 }])("rejects invalid presence-proof ranges: %#", range => {
  expect(() => sourcePresencePlan(typedSource(1), [{ ...range, overlapStart: 0, overlapEnd: 0 }])).toThrowError(expect.objectContaining({ code: "SOURCE_SELECTION_INVALID" }));
});

it("uses code points for spans while retaining UTF-16 string slices and rejects split surrogate offsets", () => {
  const source = new SourceText("A🙂文𝟘Z"); expect(source.length).toBe(5); expect(source.slice(1, 4)).toBe("🙂文𝟘"); expect(source.point(3)).toBe(2); expect(source.point(7)).toBe(5); expect(() => source.point(2)).toThrow(); expect(() => source.slice(-1, 2)).toThrow();
});
it("retains Python whitespace, BOM and line-break semantics for source proofs", () => {
  expect(sourceTrim("\u0085\x1c🙂\u2003")).toBe("🙂"); expect(sourceTrim("\ufeffA\ufeff")).toBe("\ufeffA\ufeff"); expect(sourceWithoutWhitespace("A\u0085B\ufeffC\x1f")).toBe("AB\ufeffC");
  expect(sourceLines("A\r\nB\u0085C\x1e")).toEqual(["A", "B", "C"]); expect(sourceLines("A\r\nB\u0085C\x1e", true)).toEqual(["A\r\n", "B\u0085", "C\x1e"]); expect(sourceLines("")).toEqual([]);
});
it("does not expose cached hints to mutation or infer presence from incomplete source", () => {
  const text = "1. Short answer: Q\nReference answer: A", plan = splitChunkPlan(text), first = sourcePresencePlan(text, plan.spans); first[0]!["1"].need_stem = false;
  expect(sourcePresencePlan(text, plan.spans)[0]!["1"].need_stem).toBe(true); expect(sourcePresencePlan(text, plan.spans, { complete: false })).toEqual([null]);
});
it("bounds long whitespace runs without changing fragment identity or internal whitespace", () => {
  const text = "A" + " \n".repeat(30_000) + "B"; expect(sourceTrim(text)).toBe(text);
  expect(splitChunkPlan(text).spans).toEqual([{ start: 0, end: 30000, overlapStart: 0, overlapEnd: 0 }, { start: 60000, end: 60002, overlapStart: 60000, overlapEnd: 30000 }]);
});
