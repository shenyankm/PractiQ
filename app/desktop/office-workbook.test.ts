import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SaxesParser } from "saxes";
import { visibleWorkbook } from "./office-workbook.js";
import { BoundedZip } from "./zip.js";
import { hash } from "./assets.js";
import { xmlSource } from "./tencent-bundle.js";

interface Node { name: string; attributes: Record<string, string>; children: (string | Node)[] }
function xmlTree(bytes: Buffer) {
  const stack: Node[] = [], parser = new SaxesParser({ xmlns: true }); let root: Node;
  parser.on("opentag", tag => { const node: Node = { name: `{${tag.uri}}${tag.local}`, attributes: Object.fromEntries(Object.values(tag.attributes).filter(attribute => attribute.uri !== "http://www.w3.org/2000/xmlns/").map(attribute => [`{${attribute.uri}}${attribute.local}`, attribute.value]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), children: [] }; if (stack.length) stack.at(-1)!.children.push(node); else root = node; stack.push(node); });
  const text = (value: string) => { const node = stack.at(-1); if (!node) return; if (typeof node.children.at(-1) === "string") node.children[node.children.length - 1] += value; else node.children.push(value); }; parser.on("text", text); parser.on("cdata", text); parser.on("closetag", () => { stack.pop(); }); parser.write(xmlSource(bytes)).close(); return root!;
}
const cases = JSON.parse(readFileSync(new URL("../fixtures/office/workbook-parity.json", import.meta.url), "utf8")) as { name: string; payload: string; maxSheets: number; error?: string; expected: { sheets: string[]; unchanged: boolean; tree: Node; members: Record<string, { sha256: string; method: number }> } }[];
it.each(cases)("retains historical workbook visibility and content: $name", async sample => {
  const source = Buffer.from(sample.payload, "base64"), before = Buffer.from(source), operation = () => visibleWorkbook(source, sample.maxSheets, new AbortController().signal);
  if (sample.error) { await expect(operation()).rejects.toMatchObject({ code: sample.error }); return; }
  const result = await operation(); expect(result.sheets).toEqual(sample.expected.sheets); expect(result.bytes.equals(source)).toBe(sample.expected.unchanged); expect(source).toEqual(before);
  const policy = { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true }, archive = await BoundedZip.fromBytes(result.bytes, policy), originalArchive = await BoundedZip.fromBytes(source, policy);
  try { expect(xmlTree(await archive.read("xl/workbook.xml", 2 * 1024 * 1024))).toEqual(sample.expected.tree); expect([...archive.entries.keys()].filter(name => name !== "xl/workbook.xml")).toEqual(Object.keys(sample.expected.members)); for (const [name, original] of Object.entries(sample.expected.members)) { expect(hash(await archive.read(name, 100 * 1024 * 1024))).toBe(original.sha256); const before = originalArchive.entries.get(name)!, after = archive.entries.get(name)!; expect(after.compressionMethod).toBe(original.method); expect(after).toMatchObject({ lastModFileDate: before.lastModFileDate, lastModFileTime: before.lastModFileTime, externalFileAttributes: before.externalFileAttributes, internalFileAttributes: before.internalFileAttributes, fileCommentRaw: before.fileCommentRaw }); const raw = (bytes: Buffer, offset: number, size: number) => { const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28); return bytes.subarray(start, start + size); }; expect(raw(result.bytes, after.relativeOffsetOfLocalHeader, after.compressedSize)).toEqual(raw(source, before.relativeOffsetOfLocalHeader, before.compressedSize)); } } finally { archive.close(); originalArchive.close(); }
  expect(await visibleWorkbook(result.bytes, sample.maxSheets, new AbortController().signal)).toEqual(result);
});
it("checks corrupt sibling CRCs before producing a workbook snapshot", async () => {
  const sample = cases.find(sample => sample.name === "codec-xl/worksheets/sheet1.xml-0")!, source = Buffer.from(sample.payload, "base64"), archive = await BoundedZip.fromBytes(source, { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
  const entry = archive.entries.get("xl/worksheets/sheet1.xml")!, start = entry.relativeOffsetOfLocalHeader; archive.close(); source[start + 30 + source.readUInt16LE(start + 26) + source.readUInt16LE(start + 28)] ^= 1;
  await expect(visibleWorkbook(source, 100, new AbortController().signal)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" });
});
it("rejects excessive metadata depth and honours cancellation", async () => {
  const source = Buffer.from(cases[0].payload, "base64"), cancelled = new AbortController(); cancelled.abort(new Error("stopped")); await expect(visibleWorkbook(source, 100, cancelled.signal)).rejects.toThrow("stopped");
  const archive = await BoundedZip.fromBytes(source, { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
  try { const deep = await archive.replace(new Map([["xl/workbook.xml", Buffer.from("<workbook>" + "<node>".repeat(128) + "</node>".repeat(128) + "</workbook>")]]), 25 * 1024 * 1024); await expect(visibleWorkbook(deep, 100, new AbortController().signal)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" }); } finally { archive.close(); }
});
