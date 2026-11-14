import { expect, it } from "vitest";
import { ocrSourceEvidence, type TencentPage } from "./tencent-bundle.js";

const page = (layout: string): TencentPage => ({ page: 1, format: "table", figures: [], elements: [{ layout_xml: layout, table_info: { table_name: "Science", fields: [{ formatted_field_name: "Listening:_A_source_title" }] } }] });
it("uses exact native XML cells and worksheet identity for trusted OCR field checks", () => {
  expect(ocrSourceEvidence(page('<table><tr><td>Listening: A source title</td></tr><tr><td>Section: Part A &amp; B</td></tr></table>'))).toEqual({ text: "Listening: A source title\nSection: Part A & B", nativeTable: { title: "Science", headers: ["Listening:_A_source_title"] } });
});
it("keeps nested cell iteration order and excludes namespaced cells without discarding their parent text", () => {
  expect(ocrSourceEvidence(page('<table><td>A<table><td>B</td></table>C<x:td xmlns:x="urn:test">D</x:td></td><td><![CDATA[ E ]]></td></table>')).text).toBe("ABCD\nB\n E ");
});
it("uses original evidence lines when native XML is absent", () => {
  expect(ocrSourceEvidence({ page: 1, figures: [], elements: [{ text_info: { content: "First\r\nSecond\u0085Third" } }] })).toEqual({ text: "First\nSecond\nThird" });
});
it.each(['<!DOCTYPE table [<!ENTITY a "PRIVATE">]><table><td>&a;</td></table>', '<table><td>Unclosed', '<table>'.repeat(129) + '</table>'.repeat(129)])("rejects unsafe or malformed XML source evidence before model work", xml => {
  expect(() => ocrSourceEvidence(page(xml))).toThrow();
});
