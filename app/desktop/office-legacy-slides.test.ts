import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { hash } from "./assets.js";
import { visibleLegacySlides } from "./office-legacy-slides.js";

const samples = JSON.parse(readFileSync(new URL("../fixtures/office/legacy-slides-parity.json", import.meta.url), "utf8")).cases as { file: string; sha256: string; visibleSha256: string; changedOffsets: number[]; before: { slides: { hidden: boolean }[] } }[];
it.each(samples)("matches independently read Apache POI visibility without changing any other byte: $file", sample => {
  const bytes = readFileSync(new URL(`../fixtures/office/${sample.file}`, import.meta.url)), before = Buffer.from(bytes), result = visibleLegacySlides(bytes, 300, new AbortController().signal);
  expect(hash(bytes)).toBe(sample.sha256); expect(hash(result.bytes)).toBe(sample.visibleSha256); expect(bytes).toEqual(before); expect(result.slides).toHaveLength(sample.before.slides.length);
  const changed = [...bytes.keys()].filter(index => bytes[index] !== result.bytes[index]); expect(changed).toEqual(sample.changedOffsets); for (const index of changed) expect(result.bytes[index]).toBe(bytes[index] & ~4);
  expect(visibleLegacySlides(result.bytes, 300, new AbortController().signal)).toEqual(result);
});
const record = (type: number, payload: Buffer, version = 0, instance = 0) => { const header = Buffer.alloc(8); header.writeUInt16LE(version | instance << 4); header.writeUInt16LE(type, 2); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload]); };
function documentFixture(history = false) {
  const parts: Buffer[] = [], positions: number[] = [], append = (part: Buffer) => { const offset = parts.reduce((sum, value) => sum + value.length, 0); parts.push(part); positions.push(offset); return offset; };
  const persist = (id: number) => { const bytes = Buffer.alloc(20); bytes.writeUInt32LE(id); bytes.writeUInt32LE(254 + id, 12); return record(0x03f3, bytes); }, info = (hidden: boolean) => { const bytes = Buffer.alloc(16); bytes.writeUInt16LE(0x1111 | Number(hidden) * 4, 10); return record(0x03f9, bytes); };
  const doc = append(record(0x03e8, record(0x0ff0, Buffer.concat([persist(2), persist(3)]), 15), 15)), first = append(record(0x03ee, info(true), 15)), second = append(record(0x03ee, info(false), 15));
  const directory = (values: number[], start = 1) => { const bytes = Buffer.alloc(4 + values.length * 4); bytes.writeUInt32LE(start | values.length << 20); values.forEach((value, index) => bytes.writeUInt32LE(value, 4 + index * 4)); return record(0x1772, bytes); }, edit = (directory: number, previous: number) => { const bytes = Buffer.alloc(28); bytes.writeUInt32LE(previous, 8); bytes.writeUInt32LE(directory, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(5, 20); return record(0x0ff5, bytes); };
  const oldDirectory = append(directory([doc, first, second])), oldEdit = append(edit(oldDirectory, 0)); let lastEdit = oldEdit;
  if (history) { const updated = append(record(0x03ee, info(false), 15)), latestDirectory = append(directory([updated], 2)); lastEdit = append(edit(latestDirectory, oldEdit)); }
  const current = Buffer.alloc(20); current.writeUInt32LE(20); current.writeUInt32LE(0xe391c05f, 4); current.writeUInt32LE(lastEdit, 8); current.writeUInt16LE(0x03f4, 14); current[16] = 3;
  return { document: Buffer.concat(parts), current: record(0x0ff6, current), positions, lastEdit, oldDirectory, first, second };
}
/** Small CFB fixture writer; its contents deliberately contain only metadata, never parsed questions. */
function compound(document: Buffer, current: Buffer, size = 512) {
  const blocks: Buffer[] = [Buffer.alloc(size)], miniBlocks: Buffer[] = [], miniTable: number[] = [], streams: { start: number; length: number; position: (offset: number) => number }[] = [], chains: number[][] = [];
  const allocate = (bytes: Buffer) => { const ids: number[] = []; for (let offset = 0; offset < bytes.length; offset += size) { ids.push(blocks.length); const block = Buffer.alloc(size); bytes.copy(block, 0, offset, offset + size); blocks.push(block); } chains.push(ids); return ids; };
  const values = [document, current, Buffer.from("UNRELATED WITNESS")];
  for (const value of values) {
    if (value.length >= 4096) { const ids = allocate(value); streams.push({ start: ids[0], length: value.length, position: offset => (ids[Math.floor(offset / size)] + 1) * size + offset % size }); }
    else { const start = miniBlocks.length; for (let offset = 0; offset < value.length; offset += 64) { const block = Buffer.alloc(64); value.copy(block, 0, offset, offset + 64); miniBlocks.push(block); miniTable.push(offset + 64 < value.length ? miniBlocks.length : 0xfffffffe); } streams.push({ start, length: value.length, position: offset => offset }); }
  }
  const mini = allocate(Buffer.concat(miniBlocks)), miniBytes = Buffer.alloc(Math.ceil(miniTable.length * 4 / size) * size, 0xff); miniTable.forEach((value, index) => miniBytes.writeUInt32LE(value, index * 4)); const miniFat = allocate(miniBytes);
  values.forEach((value, index) => { if (value.length < 4096) { const start = streams[index].start; streams[index].position = offset => { const relative = start * 64 + offset; return (mini[Math.floor(relative / size)] + 1) * size + relative % size; }; } });
  const directory = blocks[0], names = ["Root Entry", "PowerPoint Document", "Current User", "Witness"];
  names.forEach((name, index) => { const entry = directory.subarray(index * 128, index * 128 + 128), raw = Buffer.from(name + "\0", "utf16le"); raw.copy(entry); entry.writeUInt16LE(raw.length, 64); entry[66] = index ? 2 : 5; entry[67] = 1; entry.writeUInt32LE(0xffffffff, 68); entry.writeUInt32LE(index && index < 3 ? index + 1 : 0xffffffff, 72); entry.writeUInt32LE(index ? 0xffffffff : 1, 76); entry.writeUInt32LE(index ? streams[index - 1].start : mini[0], 116); entry.writeBigUInt64LE(BigInt(index ? streams[index - 1].length : miniBlocks.length * 64), 120); });
  const fatId = blocks.length, fat = Buffer.alloc(size, 0xff); fat.writeUInt32LE(0xfffffffe, 0); for (const ids of chains) ids.forEach((id, index) => fat.writeUInt32LE(ids[index + 1] ?? 0xfffffffe, id * 4)); fat.writeUInt32LE(0xfffffffd, fatId * 4); blocks.push(fat);
  const header = Buffer.alloc(size); Buffer.from("d0cf11e0a1b11ae1", "hex").copy(header); header.writeUInt16LE(size === 512 ? 3 : 4, 26); header.writeUInt16LE(0xfffe, 28); header.writeUInt16LE(size === 512 ? 9 : 12, 30); header.writeUInt16LE(6, 32); header.writeUInt32LE(size === 512 ? 0 : 1, 40); header.writeUInt32LE(1, 44); header.writeUInt32LE(0, 48); header.writeUInt32LE(4096, 56); header.writeUInt32LE(miniFat[0], 60); header.writeUInt32LE(miniFat.length, 64); header.writeUInt32LE(0xfffffffe, 68); for (let offset = 76; offset < 512; offset += 4) header.writeUInt32LE(0xffffffff, offset); header.writeUInt32LE(fatId, 76);
  return { bytes: Buffer.concat([header, ...blocks]), streams, fatOffset: (fatId + 1) * size, miniFatOffset: (miniFat[0] + 1) * size, rootOffset: size, size };
}
it.each([512, 4096])("resolves latest edit metadata and keeps obsolete hidden saves untouched with %s-byte sectors", size => {
  const source = documentFixture(true), file = compound(source.document, source.current, size), result = visibleLegacySlides(file.bytes, 2, new AbortController().signal); expect(result.bytes).toEqual(file.bytes); expect(result.slides).toEqual(["slide:256:persist:2", "slide:257:persist:3"]);
});
it.each([512, 4096])("changes only a live hidden bit in mini streams with %s-byte sectors", size => {
  const source = documentFixture(), file = compound(source.document, source.current, size), result = visibleLegacySlides(file.bytes, 2, new AbortController().signal), position = file.streams[0].position(source.first + 8 + 18), expected = Buffer.from(file.bytes); expected[position] &= ~4; expect(result.bytes).toEqual(expected);
});
it.each(["encrypted", "fat-cycle", "mini-cycle", "alias", "system-alias", "too-large", "edit-cycle", "persist-offset", "truncated-record", "duplicate-slide", "invalid-atom"])("refuses damaged binary allocations or slide metadata: %s", kind => {
  const source = documentFixture(true);
  if (kind === "encrypted") source.current.writeUInt32LE(0xf3d1c4df, 12);
  if (kind === "edit-cycle") source.document.writeUInt32LE(source.lastEdit, source.lastEdit + 16);
  if (kind === "persist-offset") source.document.writeUInt32LE(1, source.oldDirectory + 12);
  if (kind === "truncated-record") source.document.writeUInt32LE(0xffffffff, source.first + 4);
  if (kind === "duplicate-slide") source.document.writeUInt32LE(256, 8 + 8 + 28 + 20);
  if (kind === "invalid-atom") source.document.writeUInt32LE(15, source.second + 8 + 4);
  const file = compound(source.document, source.current), bytes = file.bytes;
  if (kind === "fat-cycle") bytes.writeUInt32LE(0, file.fatOffset);
  if (kind === "mini-cycle") bytes.writeUInt32LE(file.streams[0].start, file.miniFatOffset + file.streams[0].start * 4);
  if (kind === "alias") bytes.writeUInt32LE(file.streams[0].start, file.rootOffset + 3 * 128 + 116);
  if (kind === "system-alias") { bytes.writeUInt32LE(0, file.rootOffset + 116); }
  if (kind === "too-large") bytes.writeBigUInt64LE(BigInt(bytes.length + 1), file.rootOffset + 128 + 120);
  expect(() => visibleLegacySlides(bytes, 300, new AbortController().signal)).toThrow();
});
it("enforces active slide limits, keeps the original on refusal and honors cancellation", () => {
  const source = readFileSync(new URL("../fixtures/office/hidden-slides.ppt", import.meta.url)), before = Buffer.from(source); expect(() => visibleLegacySlides(source, 1, new AbortController().signal)).toThrow(); expect(source).toEqual(before); const stop = new AbortController(); stop.abort(new Error("stopped")); expect(() => visibleLegacySlides(source, 300, stop.signal)).toThrow("stopped");
});
