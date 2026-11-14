import { SaxesParser } from "saxes";
import { invariant } from "./errors.js";
import type { StoredOcrPage } from "./ocr-inputs.js";
import { ocrSourceEvidence } from "./tencent-bundle.js";
import { SOURCE_WHITESPACE, sourceTrim } from "./source-text.js";

/** Rectangular native rows preserve column ownership; merged cells use conservative page evidence. */
export function ocrAnswerText(page: StoredOcrPage): string {
  if ("failed" in page) return "";
  const layouts = page.elements.flatMap(element => typeof element.layout_xml === "string" && element.layout_xml ? [element.layout_xml] : []);
  if (page.format === "table" && layouts.length === 1) {
    const rows: string[][] = [], rowStack: { index: number; depth: number }[] = [], cells: { values: [number, number][]; depth: number }[] = []; let depth = 0, merged = false;
    invariant(Buffer.byteLength(layouts[0]) <= 8 * 1024 * 1024, "TENCENT_RESULT_INVALID", "Native XML exceeds its limit");
    const parser = new SaxesParser({ xmlns: true }); parser.on("error", error => { throw error; }); parser.on("doctype", () => { throw new Error("XML document types are forbidden"); });
    parser.on("opentag", tag => {
      invariant(++depth <= 128, "TENCENT_RESULT_INVALID", "Native XML depth exceeds its limit");
      if (tag.local === "tr" && !tag.uri) { rowStack.push({ index: rows.length, depth }); rows.push([]); }
      if (tag.local === "td" && !tag.uri) {
        merged ||= ["rowspan", "colspan"].some(name => (tag.attributes[name]?.value ?? "1") !== "1");
        cells.push({ depth, values: rowStack.map(row => { const index = rows[row.index].length; rows[row.index].push(""); return [row.index, index]; }) });
      }
    });
    const append = (text: string) => { for (const cell of cells) for (const [row, index] of cell.values) rows[row][index] += text; }; parser.on("text", append); parser.on("cdata", append);
    parser.on("closetag", () => { if (cells.at(-1)?.depth === depth) cells.pop(); if (rowStack.at(-1)?.depth === depth) rowStack.pop(); depth--; }); parser.write(layouts[0]).close();
    if (rows.length && !merged) return rows.map(row => row.map(cell => sourceTrim(cell).replace(new RegExp(`${SOURCE_WHITESPACE}+`, "gu"), " ")).join("\t")).join("\n");
  }
  return ocrSourceEvidence(page).text;
}
