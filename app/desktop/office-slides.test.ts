import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { visibleSlides } from "./office-slides.js";
import { BoundedZip } from "./zip.js";

const original = readFileSync(new URL("../fixtures/office/hidden-slides.pptx", import.meta.url)), policy = { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true }, slide = "ppt/slides/slide2.xml", controller = () => new AbortController();
afterEach(() => vi.restoreAllMocks());
async function fixture(changes: Record<string, string | null>) {
  const source = await BoundedZip.fromBytes(original, policy), zip = new ZipFile();
  try { for (const name of new Set([...source.entries.keys(), ...Object.keys(changes)])) { const value = changes[name]; if (value !== null) zip.addBuffer(value === undefined ? await source.read(name, policy.expandedBytes) : Buffer.from(value), name); } } finally { source.close(); }
  zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
async function member(bytes: Buffer, name: string) { const archive = await BoundedZip.fromBytes(bytes, policy); try { return (await archive.read(name, policy.expandedBytes)).toString(); } finally { archive.close(); } }
const raw = (bytes: Buffer, offset: number, size: number) => { const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28); return bytes.subarray(start, start + size); };

it.each(["false", "0", "fal&#115;e", " 0 "])("changes only declared slide visibility (%s) and preserves all content and sibling bytes", async value => {
  const first = "ppt/slides/slide1.xml", firstXml = (await member(original, first)).replace("<p:sld ", `<p:sld show='${value}' `), bytes = await fixture({ [first]: firstXml }), before = Buffer.from(bytes), result = await visibleSlides(bytes, 300, controller().signal);
  expect(result.slides).toEqual([first, slide]); expect(bytes).toEqual(before);
  const source = await BoundedZip.fromBytes(bytes, policy), target = await BoundedZip.fromBytes(result.bytes, policy);
  try {
    expect([...target.entries.keys()]).toEqual([...source.entries.keys()]);
    for (const [name, entry] of source.entries) {
      const data = await source.read(name, policy.expandedBytes), output = await target.read(name, policy.expandedBytes);
      expect(output).toEqual(name === first ? Buffer.from(firstXml.replace(`show='${value}'`, "show='true'")) : name === slide ? Buffer.from(data.toString().replace('show="false"', 'show="true"')) : data);
      if (name === first || name === slide) continue;
      const after = target.entries.get(name)!; expect(after).toMatchObject({ compressionMethod: entry.compressionMethod, lastModFileTime: entry.lastModFileTime, lastModFileDate: entry.lastModFileDate, externalFileAttributes: entry.externalFileAttributes, internalFileAttributes: entry.internalFileAttributes, fileCommentRaw: entry.fileCommentRaw });
      expect(raw(result.bytes, after.relativeOffsetOfLocalHeader, after.compressedSize)).toEqual(raw(bytes, entry.relativeOffsetOfLocalHeader, entry.compressedSize));
    }
  } finally { source.close(); target.close(); }
  expect(await visibleSlides(result.bytes, 300, controller().signal)).toEqual(result);
});
it("keeps already-visible files byte-identical and ignores foreign or nested show attributes", async () => {
  const xml = (await member(original, slide)).replace('show="false"', 'xmlns:x="urn:foreign" x:show="false"').replace("</p:sld>", '<p:extLst><x:sld xmlns:x="urn:foreign" show="false"/></p:extLst></p:sld>'), bytes = await fixture({ [slide]: xml });
  expect((await visibleSlides(bytes, 300, controller().signal)).bytes).toEqual(bytes);
});
it("retains declaration order and resolves local absolute and escaped part URIs", async () => {
  const presentation = (await member(original, "ppt/presentation.xml")).replace('<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rIdHidden"/>', '<p:sldId id="257" r:id="rIdHidden"/><p:sldId id="256" r:id="rId1"/>'), rels = (await member(original, "ppt/_rels/presentation.xml.rels")).replace('Target="slides/slide2.xml"', 'Target="/ppt/slides/%73lide2.xml"');
  const result = await visibleSlides(await fixture({ "ppt/presentation.xml": presentation, "ppt/_rels/presentation.xml.rels": rels }), 300, controller().signal); expect(result.slides).toEqual([slide, "ppt/slides/slide1.xml"]);
});
it("accepts strict OOXML namespaces without changing visible content", async () => {
  const replacements: Record<string, string> = {};
  for (const name of ["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/slides/slide1.xml", slide]) replacements[name] = (await member(original, name)).replaceAll("http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main").replaceAll("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships").replaceAll("http://schemas.openxmlformats.org/package/2006/relationships", "http://purl.oclc.org/ooxml/package/relationships");
  const result = await visibleSlides(await fixture(replacements), 300, controller().signal); expect(await member(result.bytes, slide)).toBe(replacements[slide].replace('show="false"', 'show="true"'));
});
it("normalizes only the encoding declaration and visibility in a UTF-16 slide", async () => {
  const source = await BoundedZip.fromBytes(original, policy); let bytes: Buffer;
  try { const text = (await member(original, slide)).replace('encoding="UTF-8"', 'encoding="UTF-16"'); bytes = await source.replace(new Map([[slide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])]]), policy.archiveBytes); } finally { source.close(); }
  const result = await visibleSlides(bytes, 300, controller().signal); expect(await member(result.bytes, slide)).toContain('encoding="utf-8"'); expect(await member(result.bytes, slide)).toContain('show="true"'); expect(await member(result.bytes, slide)).toContain("原卷问题与答案");
});
it.each(["doctype", "depth", "namespace", "malformed", "visibility", "missing", "duplicate-id", "duplicate-part", "external", "escape", "fragment", "macro"])("refuses unsafe or ambiguous presentation metadata: %s", async kind => {
  const presentation = await member(original, "ppt/presentation.xml"), rels = await member(original, "ppt/_rels/presentation.xml.rels"), xml = await member(original, slide), changes: Record<string, string | null> = {};
  if (kind === "doctype") changes[slide] = xml.replace("?><", '?><!DOCTYPE sld [<!ENTITY bomb "forbidden">]><');
  if (kind === "depth") changes[slide] = xml.replace("</p:sld>", "<p:x>".repeat(128) + "</p:x>".repeat(128) + "</p:sld>");
  if (kind === "namespace") changes[slide] = xml.replace("http://schemas.openxmlformats.org/presentationml/2006/main", "urn:wrong");
  if (kind === "malformed") changes[slide] = xml.slice(0, -10);
  if (kind === "visibility") changes[slide] = xml.replace('show="false"', 'show="maybe"');
  if (kind === "missing") changes[slide] = null;
  if (kind === "duplicate-id") changes["ppt/presentation.xml"] = presentation.replace('id="257"', 'id="256"');
  if (kind === "duplicate-part") changes["ppt/_rels/presentation.xml.rels"] = rels.replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"');
  if (kind === "external") changes["ppt/_rels/presentation.xml.rels"] = rels.replace('Target="slides/slide2.xml"', 'TargetMode="External" Target="https://example.invalid/slide.xml"');
  if (kind === "escape") changes["ppt/_rels/presentation.xml.rels"] = rels.replace('Target="slides/slide2.xml"', 'Target="../../outside.xml"');
  if (kind === "fragment") changes["ppt/_rels/presentation.xml.rels"] = rels.replace('Target="slides/slide2.xml"', 'Target="slides/slide2.xml#fragment"');
  if (kind === "macro") changes["ppt/vbaProject.bin"] = "macro";
  await expect(visibleSlides(await fixture(changes), 300, controller().signal)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" });
});
it("checks the declared slide ceiling, cancellation and corrupt sibling CRCs before publication", async () => {
  await expect(visibleSlides(original, 1, controller().signal)).rejects.toMatchObject({ code: "OFFICE_OUTPUT_LIMIT" });
  const cancelled = controller(); cancelled.abort(new Error("stopped")); await expect(visibleSlides(original, 300, cancelled.signal)).rejects.toThrow("stopped");
  const bytes = Buffer.from(original), archive = await BoundedZip.fromBytes(bytes, policy);
  try { const entry = archive.entries.get("[Content_Types].xml")!, position = entry.relativeOffsetOfLocalHeader + 30 + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 26) + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 28); bytes[position + Math.floor(entry.compressedSize / 2)] ^= 0x01; } finally { archive.close(); }
  await expect(visibleSlides(bytes, 300, controller().signal)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" });
});
it("bounds multi-member replacement and refuses unknown members without changing the source", async () => {
  const archive = await BoundedZip.fromBytes(original, policy), before = Buffer.from(original);
  try { await expect(archive.replace(new Map([["missing", Buffer.from("x")]]), policy.archiveBytes)).rejects.toMatchObject({ code: "LOCAL_BANK_ZIP_INVALID" }); await expect(archive.replace(new Map([[slide, Buffer.alloc(1000)]]), 22)).rejects.toMatchObject({ code: "LOCAL_ARCHIVE_TOO_LARGE" }); expect(original).toEqual(before); } finally { archive.close(); }
});
