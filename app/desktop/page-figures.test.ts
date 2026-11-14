import { expect, it } from "vitest";
import { tableContentKey, tableMarkdown, validatePageFigure } from "./page-figures.js";

const table = (tableRows: string[][] = [["Name", "Value"], ["x", "1"]]) => ({ kind: "table", description: "Source table", bbox: [0, 0, 1, 1], tableRows });
it("normalizes fixed source coordinates and ignores unknown model fields without mutating input", () => {
  const input = { kind: "image", bbox: ["0", false, "1_0e-2", true], description: "Source figure", untrusted: "discard" }, before = structuredClone(input);
  expect(validatePageFigure(input)).toMatchObject({ bbox: [0, 0, .1, 1], questionIndexes: [], description: "Source figure" }); expect(validatePageFigure(input)).not.toHaveProperty("untrusted"); expect(input).toEqual(before);
});
it.each([null, [], {}, { kind: "image", tableRows: [["x"], ["y"]] }, { kind: "image", bbox: [0, 0, 0, 1] }, { kind: "image", bbox: [-.1, 0, 1, 1] }, { kind: "image", bbox: [0, 0, Infinity, 1] }, table([Array(101).fill("x"), Array(101).fill("y")]), table([["x"], ["y".repeat(90001)]])])("rejects malformed or unbounded source figures: %#", input => expect(() => validatePageFigure(input)).toThrow());
it.each(["Answer", "参考答案", "Analysis", "Scoring rubric"])("protects a source table headed %s from answer leakage", heading => expect(validatePageFigure(table([[heading], ["1. A"]])).role).toBe("answer"));
it("also protects explicit analysis roles and extracted answer headings", () => {
  expect(validatePageFigure({ kind: "image", description: "Source", bbox: null, role: "explanation" }).role).toBe("answer"); expect(validatePageFigure({ kind: "table", description: "Source", bbox: null, extractedText: "# Answers\n1. A" }).role).toBe("answer");
});
it.each([[[]], [["h"]], [["h", "j"], ["v"]]].map(rows => ({ rows })))("keeps irregular table text as reviewable source rather than inventing cells: %#", ({ rows }) => {
  const figure = validatePageFigure(table(rows)); expect(figure.tableRows).toBeNull(); expect(figure.extractedText).toBe(rows.map(row => row.join("\t")).join("\n"));
});
it("escapes literal markup and pipes while retaining inline source math", () => {
  const figure = validatePageFigure(table([["<tag>", "a|b"], ["$x+1$", "[link]&"]]));
  expect(tableMarkdown(figure)).toBe("| &#60;tag&#62; | a\\|b |\n| --- | --- |\n| $x+1$ | &#91;link&#93;&#38; |");
  expect(tableMarkdown({ tableRows: null })).toBeNull();
});
it("compares equivalent cell contents without erasing literal text or accepting malformed tables", () => {
  expect(tableContentKey("| A | b\\|c |\n| :--- | ---: |\n| &lt;x&gt; | 01 |")).toBe(tableContentKey("A|b\\|c\n---|---\n<x>|01"));
  expect(tableContentKey("| A |\n| --- |\n| 01 |")).not.toBe(tableContentKey("| A |\n| --- |\n| 1 |"));
  expect(tableContentKey("  plain text  ")).toBe("text:plain text"); expect(tableContentKey("a|b\n---\nc|d")).toBe("text:a|b\n---\nc|d");
});
