import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sourcePresencePlan, splitChunkPlan, type ChunkSourceOptions, type ChunkSpan, type SourcePresenceHint } from "./source-chunks.js";
import { SourceText, sourceLines, sourceTrim, sourceWithoutWhitespace } from "./source-text.js";

type Presence = (Record<string, SourcePresenceHint> | null)[];
const corpus = JSON.parse(readFileSync(new URL("../fixtures/tencent/source-chunks.json", import.meta.url), "utf8")) as { cases: { name: string; text: string; target: number; options: { source_type?: string; tabular_rows_safe?: boolean; complete?: boolean }; expected?: { spans: ChunkSpan[]; header: string | null; nodeCounts: (number | null)[]; presence: Presence }; error?: string; extraSpans?: ChunkSpan[]; extraPresence?: Presence }[] };
it.each(corpus.cases)("matches historical source planning and presence: $name", input => {
  const options: ChunkSourceOptions = { sourceType: input.options.source_type, tabularRowsSafe: input.options.tabular_rows_safe, complete: input.options.complete }, perform = () => splitChunkPlan(input.text, input.target, options);
  if (input.error) { expect(perform).toThrow(); try { perform(); } catch (error) { expect(error).toMatchObject({ code: input.error }); } return; }
  const plan = perform(); expect(plan).toEqual({ spans: input.expected!.spans, header: input.expected!.header, nodeCounts: input.expected!.nodeCounts }); expect(sourcePresencePlan(input.text, plan.spans, options)).toEqual(input.expected!.presence);
  if (input.extraSpans) expect(sourcePresencePlan(input.text, input.extraSpans, options)).toEqual(input.extraPresence);
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
