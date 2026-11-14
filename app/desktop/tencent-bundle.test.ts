import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ZipFile } from "yazl";
import sharp from "sharp";
import { BoundedZip } from "./zip.js";
import { elementBox, evidenceText, labelCropBox, TencentBundle, type TencentBundleOptions } from "./tencent-bundle.js";

const codecs = JSON.parse(readFileSync(new URL("../fixtures/tencent/zip-codecs.json", import.meta.url), "utf8")) as Record<string, string>;
async function archive(entries: [string, unknown][]): Promise<Buffer> {
  const zip = new ZipFile(); for (const [name, value] of entries) { if (name.endsWith("/")) zip.addEmptyDirectory(name); else zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), name, { compress: false }); }
  zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
function element(box: number[], text: unknown, figure = false): Record<string, unknown> {
  const [x0, y0, x1, y1] = box, polygon = Object.fromEntries([["left_top", x0, y0], ["right_top", x1, y0], ["left_bottom", x0, y1], ["right_bottom", x1, y1]].map(([key, x, y]) => [key, { x, y }])); return { polygon, ...(figure ? { figure_info: { text_info: { content: text } } } : { text_info: { content: text } }) };
}
const page = () => ({ width: 200, height: 160, elements: [{ type: 2, text_info: { content: "1. Question?\n$x^2$" } }, { ...element([40, 40, 160, 120], "3\n4\n5", true), index: 9 }] });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AwMDEwMDAwMDAwAkBgMB/DXemwAAAABJRU5ErkJggg==", "base64");
async function decode(entries: [string, unknown][], options: TencentBundleOptions = { pageCount: 1 }) { const bundle = await TencentBundle.open(await archive(entries), options); try { return bundle.pages; } finally { bundle.close(); } }

it.each(Object.entries(codecs))("retains original ZIP method %s for both XML evidence and verified subimages", async (_method, encoded) => {
  const bundle = await TencentBundle.open(Buffer.from(encoded, "base64"), { pageCount: 1 });
  try { expect(bundle.pages[0].figures).toEqual([{ elementIndex: 9, kind: "image", bbox: [0.1, 0.1, 0.4, 0.4], imageMember: "image.png" }]); const image = await bundle.image("image.png"); expect(image.mediaType).toBe("image/png"); expect((await sharp(image.bytes).metadata()).width).toBe(2); } finally { bundle.close(); }
});

it("retains the deprecated method-20 Zstandard ZIP identifier", async () => {
  const bytes = Buffer.from(codecs["93"], "base64"); let cursor = bytes.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (bytes.readUInt32LE(cursor) === 0x02014b50) { bytes.writeUInt16LE(20, cursor + 10); bytes.writeUInt16LE(20, bytes.readUInt32LE(cursor + 42) + 8); cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32); }
  const bundle = await TencentBundle.open(bytes, { pageCount: 1 }); try { expect((await bundle.image("image.png")).mediaType).toBe("image/png"); } finally { bundle.close(); }
});

it.each([12, 14, 93])("rejects damaged method-%s data and leaves the codec queue usable", async method => {
  const bytes = Buffer.from(codecs[String(method)], "base64"), bundle = await TencentBundle.open(bytes, { pageCount: 1 });
  const entry = bundle.archive.entries.get("image.png")!, offset = entry.relativeOffsetOfLocalHeader + 30 + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 26) + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 28); bundle.close(); if (method === 14) bytes[offset + 4] = 255; else bytes[offset] ^= 255;
  const damaged = await TencentBundle.open(bytes, { pageCount: 1 }); try { await expect(damaged.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); } finally { damaged.close(); }
  const next = await TencentBundle.open(Buffer.from(codecs[String(method)], "base64"), { pageCount: 1 }); try { expect((await next.image("image.png")).bytes.length).toBeGreaterThan(0); } finally { next.close(); }
});

it("keeps rare codecs opt-in for provider bundles and rejects malformed codec declarations", async () => {
  for (const method of [12, 14, 93]) {
    await expect(BoundedZip.fromBytes(Buffer.from(codecs[String(method)], "base64"), { archiveBytes: 100000, expandedBytes: 100000, entries: 10 })).rejects.toThrow();
    const bytes = Buffer.from(codecs["0"], "base64"); bytes.writeUInt16LE(method, 8); bytes.writeUInt16LE(method, bytes.indexOf(Buffer.from("PK\x01\x02", "binary")) + 10);
    await expect(TencentBundle.open(bytes, { pageCount: 1 })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
  }
});

it.each([12, 14, 93])("bounds method-%s output independently of the compressed stream", async method => {
  const bytes = Buffer.from(codecs[String(method)], "base64"), parsed = await TencentBundle.open(bytes, { pageCount: 1 }), entry = parsed.archive.entries.get("image.png")!; parsed.close();
  let cursor = bytes.indexOf(Buffer.from("PK\x01\x02", "binary"));
  while (bytes.subarray(cursor + 46, cursor + 46 + bytes.readUInt16LE(cursor + 28)).toString() !== "image.png") cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  bytes.writeUInt32LE(1, cursor + 24); bytes.writeUInt32LE(1, entry.relativeOffsetOfLocalHeader + 22);
  const bundle = await TencentBundle.open(bytes, { pageCount: 1 }); try { await expect(bundle.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); } finally { bundle.close(); }
});

it("rejects oversized LZMA dictionary requests before decoder allocation", async () => {
  const bytes = Buffer.from(codecs["14"], "base64"), parsed = await TencentBundle.open(bytes, { pageCount: 1 }), entry = parsed.archive.entries.get("image.png")!; parsed.close();
  const start = entry.relativeOffsetOfLocalHeader + 30 + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 26) + bytes.readUInt16LE(entry.relativeOffsetOfLocalHeader + 28); bytes.writeUInt32LE(256 * 1024 * 1024, start + 5);
  const bundle = await TencentBundle.open(bytes, { pageCount: 1 }); try { await expect(bundle.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); } finally { bundle.close(); }
});

it("validates every directory entry before reading any XML or image member", async () => {
  const bytes = await archive([["safevalue", "unused"], ["x_ocr_page0.json", page()]]), read = vi.spyOn(BoundedZip.prototype, "read");
  try { const damaged = Buffer.from(bytes.toString("binary").replaceAll("safevalue", "../escape"), "binary"); await expect(TencentBundle.open(damaged, { pageCount: 1 })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); expect(read).not.toHaveBeenCalled(); } finally { read.mockRestore(); }
});

it.each(["duplicate", "encrypted", "symlink", "colon", "expanded", "entries"])("rejects unsafe %s metadata before decoding", async damage => {
  const bytes = await archive(damage === "duplicate" ? [["same", "a"], ["same", "b"]] : damage === "entries" ? Array.from({ length: 2001 }, (_, index): [string, string] => [`unused-${index}`, ""]) : [["abcdef", "unused"], ["x_ocr_page0.json", page()]]), directory = bytes.indexOf(Buffer.from("PK\x01\x02", "binary"));
  if (damage === "encrypted") bytes.writeUInt16LE(bytes.readUInt16LE(directory + 8) | 1, directory + 8);
  if (damage === "symlink") bytes.writeUInt32LE((0o120777 << 16) >>> 0, directory + 38);
  if (damage === "expanded") bytes.writeUInt32LE(151 * 1024 * 1024, directory + 24);
  const input = damage === "colon" ? Buffer.from(bytes.toString("binary").replaceAll("abcdef", "C:evil"), "binary") : bytes;
  await expect(TencentBundle.open(input, { pageCount: 1 })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
});

it("keeps page reading order, nested formula/table evidence, stable figure IDs and original bounds", async () => {
  const value = page(), before = structuredClone(value), pages = await decode([["x_ocr_page1.json", value], ["x_ocr_page0.json", { ...value, elements: [] }]], { pageCount: 2 });
  expect(pages.map(page => page.page)).toEqual([0, 1]); expect(pages[1].elements).toEqual(value.elements); expect(pages[1].figures[0]).toMatchObject({ elementIndex: 9, bbox: [.2, .25, .8, .75], imageMember: null }); expect(pages[1].figures[0]).not.toHaveProperty("cropBbox"); expect(value).toEqual(before);
  expect(evidenceText({ ignored: [null, 42], table: [{ formula: "$x^2$" }, "literal\ntext"] })).toBe("$x^2$\n\nliteral\ntext");
});

it.each(["missing", "cross_page", "unlinked", "invalid", "duplicate"])("rejects %s XML figure associations without guessing", async damage => {
  const value = page(); (value.elements[1] as Record<string, unknown>).figure_info = { path: damage === "invalid" ? null : "image.png" };
  const tag = `<image id="p-18" page-numbers="${damage === "cross_page" ? 1 : 0}" src="image.png"/>`, xml = `<root>${damage === "unlinked" ? "" : tag}${damage === "duplicate" ? tag : ""}</root>`;
  await expect(decode([["x_ocr_page0.json", value], ["x_xml_full.xml", xml], ...(damage === "missing" ? [] : [["image.png", png] as [string, unknown]])], { pageCount: 2 })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
});

it("links global XML image IDs to page-local JSON IDs only through an explicit same-page path", async () => {
  const value = page(); (value.elements[1] as Record<string, unknown>).figure_info = { path: "image.png" };
  const result = await decode([["x_ocr_page0.json", value], ["x_xml_full.xml", '<root><image id="p-18" page-numbers="0" src="image.png"/></root>'], ["image.png", png]]);
  expect(result[0].figures[0]).toMatchObject({ elementIndex: 9, imageMember: "image.png", bbox: [.2, .25, .8, .75] });
});

it.each(["<root>", '<!DOCTYPE root [<!ENTITY x "value">]><root>&x;</root>', '<!DOCTYPE root SYSTEM "file:///private/value"><root/>', '<root><image id="bad" page-numbers="0" src="image.png"/></root>'])("rejects malformed or entity-bearing XML: %s", async xml => {
  await expect(decode([["x_ocr_page0.json", page()], ["x_xml_full.xml", xml], ["image.png", png]])).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
});

it.each(["width", "elements", "bounds", "duplicate", "page", "json", "text-limit"])("rejects invalid OCR %s evidence", async damage => {
  const value = page() as unknown as Record<string, unknown>; if (damage === "width") value.width = true; if (damage === "elements") value.elements = [null]; if (damage === "bounds") (value.elements as Record<string, unknown>[])[1].polygon = {}; if (damage === "duplicate") (value.elements as unknown[]).push(structuredClone((value.elements as unknown[])[1]));
  const entries: [string, unknown][] = [[damage === "page" ? "x_ocr_page1.json" : "x_ocr_page0.json", damage === "json" ? "{" : value]];
  await expect(decode(entries, { pageCount: 1, ...(damage === "text-limit" ? { limits: { maxTotalInputChars: 1 } } : {}) })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
});

it("retains the synthetic native table fixture with blank cells, leading zeroes and merged XML layout", async () => {
  const table = JSON.parse(readFileSync(new URL("../fixtures/tencent/tencent-xlsx.json", import.meta.url), "utf8")), xml = readFileSync(new URL("../fixtures/tencent/tencent-xlsx.xml", import.meta.url));
  const pages = await decode([["x_ocr_page0.json", table], ["x_xml_full.xml", xml]]), element = pages[0].elements[0]; expect(pages[0].format).toBe("table"); expect(element.table_info).toEqual(table); expect(element.layout_xml).toContain('colspan="3"'); expect(element.layout_xml).toContain("OUTSIDE_PRINT_AREA"); expect(table.rows[2].cells[0]).toEqual({ row_idx: 2 });
  await expect(decode([["x_ocr_page0.json", table], ["x_xml_full.xml", xml]], { pageCount: 1, limits: { maxTotalInputChars: 1 } })).rejects.toThrow();
});

it.each(["utf8", "utf16le", "latin1"] as const)("retains declared %s XML layout text", async encoding => {
  const name = encoding === "utf8" ? "UTF-8" : encoding === "utf16le" ? "UTF-16" : "ISO-8859-1", xml = Buffer.from(`<?xml version="1.0" encoding="${name}"?><root><table><caption>A</caption><tr><td>café</td></tr></table></root>`, encoding);
  const result = await decode([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["x_xml_full.xml", xml]]); expect(result[0].elements[0].layout_xml).toContain("<td>café</td>");
});

it("retains coordinate-free native table images and does not resolve ambiguous captions", async () => {
  const names = [" A & B\n", "duplicate", "missing", "", "first", "second", null, 1], entries: [string, unknown][] = names.map((caption, index) => [`x_ocr_page${index}.json`, { table_name: "fallback", caption, fields: [], rows: [] }]);
  const xml = '<root><image id="p-9" page-numbers="0" src="image.png"/><table><caption> A <b>&amp;</b> B </caption><tr><td>unique</td></tr></table><table><caption>duplicate</caption></table><table><caption> duplicate </caption></table><table/><table><caption> </caption></table><table><caption>first</caption><caption>second</caption></table></root>';
  const pages = await decode([...entries, ["x_xml_full.xml", xml], ["image.png", png]], { pageCount: names.length });
  expect(pages.map(page => Boolean(page.elements[0].layout_xml))).toEqual([true, false, false, true, true, false, false, false]); expect(pages[0].figures).toEqual([{ elementIndex: 9, kind: "image", bbox: null, imageMember: "image.png" }]);
});

it.each([{ fields: "bad" }, { rows: [{}] }, { rows: [{ cells: [null] }] }])("rejects malformed native table collections: %j", async change => {
  await expect(decode([["x_ocr_page0.json", { table_name: "Synthetic", fields: [], rows: [], ...change }]])).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" });
});

it("preserves Markdown exactly as inert text, including non-BMP characters, with explicit empty-result handling", async () => {
  const text = '题目😀\n\n<script>inert evidence</script>\n'; expect((await decode([["x_md_full.md", Buffer.from("\ufeff" + text)]], { pageCount: 1, resultType: 2 }))[0].elements[0].text_info).toEqual({ content: text });
  expect(await decode([["x_md_full.md", "😀"]], { pageCount: 1, resultType: 2, limits: { maxTotalInputChars: 1 } })).toHaveLength(1);
  expect(await decode([], { pageCount: 1, resultType: 2, allowEmpty: true })).toEqual([]); expect(await decode([["x_md_full.md", " "]], { pageCount: 1, resultType: 2, allowEmpty: true })).toEqual([]);
});

it.each([["x_md_full.md", " "], ["unrelated.md", "text"], ["x_md_full.md", Buffer.from([255])]])("rejects unusable Markdown evidence: %s", async (name, value) => { await expect(decode([[name as string, value]], { pageCount: 1, resultType: 2 })).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); });

it("does not accept multiple Markdown members or exceed the shared text limit", async () => {
  await expect(decode([["x_md_full.md", "one"], ["y_md_full.md", "two"]], { pageCount: 1, resultType: 2 })).rejects.toThrow(); await expect(decode([["x_md_full.md", "12345"]], { pageCount: 1, resultType: 2, limits: { maxTotalInputChars: 4 } })).rejects.toThrow();
});

it("rejects pixel/byte limits and CRC damage during subimage reads", async () => {
  const original = Buffer.from(codecs["0"], "base64"), bundle = await TencentBundle.open(original, { pageCount: 1 }), image = await bundle.image("image.png"), entry = bundle.archive.entries.get("image.png")!; bundle.close();
  const cases: [Partial<TencentBundleOptions>, string][] = [[{ limits: { visionMaxBytes: image.bytes.length - 1 } }, "TENCENT_RESULT_TOO_LARGE"], [{ limits: { maxVisionPagePixels: 1 } }, "TENCENT_RESULT_INVALID"]];
  for (const [options, code] of cases) { if (code === "TENCENT_RESULT_INVALID") { await expect(TencentBundle.open(original, { pageCount: 1, ...options })).rejects.toMatchObject({ code }); continue; } const value = await TencentBundle.open(original, { pageCount: 1, ...options }); try { await expect(value.image("image.png")).rejects.toMatchObject({ code }); } finally { value.close(); } }
  const damaged = Buffer.from(original), start = entry.relativeOffsetOfLocalHeader + 30 + damaged.readUInt16LE(entry.relativeOffsetOfLocalHeader + 26) + damaged.readUInt16LE(entry.relativeOffsetOfLocalHeader + 28); damaged[start] ^= 1;
  const value = await TencentBundle.open(damaged, { pageCount: 1 }); try { await expect(value.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); } finally { value.close(); }
  const native = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "Native", fields: [], rows: [] }], ["image.png", image.bytes]]), { pageCount: 1, limits: { maxVisionPagePixels: 1 } });
  try { await expect(native.image("image.png")).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" }); } finally { native.close(); }
});

it("keeps crop repair conservative and leaves fixed figure bounds unchanged", () => {
  const figure = element([40, 40, 160, 120], "3\n4\n5", true), label = element([75, 113, 90, 125], "3"), before = structuredClone([figure, label]); expect(labelCropBox(figure, [figure, label], 200, 160)).toEqual([.2, .25, .8, 125 / 160]); expect(elementBox(figure, 200, 160)).toEqual([.2, .25, .8, .75]); expect([figure, label]).toEqual(before);
  for (const defect of ["unidentified", "detached", "ambiguous", "answer", "large", "invalid", "non_text", "unknown_bounds", "dense"]) {
    const source = structuredClone(figure), labels = [source, structuredClone(label)];
    if (defect === "unidentified") source.figure_info = { text_info: { content: "5" } }; if (defect === "detached") labels[1] = element([75, 122, 90, 130], "3"); if (defect === "ambiguous") labels.push(element([95, 113, 110, 125], "3")); if (defect === "answer") labels.push(element([45, 121, 70, 125], "Answer: 42")); if (defect === "large") labels[1] = element([75, 113, 190, 159], "3"); if (defect === "invalid") labels[1].polygon = {}; if (defect === "non_text") labels[1].text_info = { content: 3 }; if (defect === "unknown_bounds") labels.push({ text_info: { content: "Answer: 42" }, polygon: {} }); if (defect === "dense") labels.push(...Array.from({ length: 1000 }, () => ({})));
    expect(labelCropBox(source, labels, 200, 160), defect).toBeNull();
  }
});

it.each(["multi-frame", "default-frame"])("retains the source extractor's %s image rejection", async name => {
  const bundle = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["image.png", readFileSync(new URL(`../fixtures/tencent/${name}.png`, import.meta.url))]]), { pageCount: 1 });
  try { await expect(bundle.image("image.png")).rejects.toMatchObject({ code: "IMAGE_MULTIFRAME_UNSUPPORTED" }); } finally { bundle.close(); }
});

it("preserves inert PNG trailing padding while checking inner chunk checksums", async () => {
  const source = await TencentBundle.open(Buffer.from(codecs["0"], "base64"), { pageCount: 1 }); let image: Buffer; try { image = (await source.image("image.png")).bytes; } finally { source.close(); }
  const padded = Buffer.concat([image!, Buffer.alloc(32768)]), valid = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["image.png", padded]]), { pageCount: 1 });
  try { expect((await valid.image("image.png")).bytes).toEqual(padded); } finally { valid.close(); }
  const damaged = Buffer.from(image!); damaged[29] ^= 1; const invalid = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["image.png", damaged]]), { pageCount: 1 });
  try { await expect(invalid.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); } finally { invalid.close(); }
});

it("rejects unsupported image signatures before invoking a metadata decoder", async () => {
  const bundle = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["image.png", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>']]), { pageCount: 1 }), metadata = vi.spyOn(sharp.prototype, "metadata");
  try { await expect(bundle.image("image.png")).rejects.toMatchObject({ code: "TENCENT_RESULT_INVALID" }); expect(metadata).not.toHaveBeenCalled(); } finally { metadata.mockRestore(); bundle.close(); }
});

it.each([["image.jpg", true], ["multi-picture.mpo", false]] as const)("validates actual JPEG/MPO content: %s", async (name, supported) => {
  const bytes = readFileSync(new URL(`../fixtures/tencent/${name}`, import.meta.url)), bundle = await TencentBundle.open(await archive([["x_ocr_page0.json", { table_name: "A", fields: [], rows: [] }], ["image.png", bytes]]), { pageCount: 1 });
  try { if (supported) { const result = await bundle.image("image.png"); expect(result.mediaType).toBe("image/jpeg"); expect(result.bytes).toEqual(bytes); } else await expect(bundle.image("image.png")).rejects.toMatchObject({ code: "IMAGE_MULTIFRAME_UNSUPPORTED" }); } finally { bundle.close(); }
});

it("honors cancellation before publishing an empty provider bundle", async () => { const signal = AbortSignal.abort(new Error("stopped")); await expect(TencentBundle.open(await archive([]), { pageCount: 0, allowEmpty: true, signal })).rejects.toThrow("stopped"); });
