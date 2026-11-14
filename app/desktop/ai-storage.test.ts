import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yazl from "yazl";
import type { DocumentReference } from "../src/contracts.generated.js";
import { AiStorage, OFFICE_LIMIT, SOURCE_FORMATS, SOURCE_LIMIT, sourceFormat, sourceKey, sourceLimit } from "./ai-storage.js";
import { SourceTickets } from "./source-tickets.js";
import { hash } from "./assets.js";
import { validateCompound } from "./office-input.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-ai-storage-")); directories.push(path); return path; }
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function reference(name: string, bytes: Buffer): DocumentReference { const format = sourceFormat(name), sha256 = hash(bytes); return { ...format, fileName: name, sha256, sizeBytes: bytes.length, objectKey: sourceKey(format.sourceType, sha256) }; }
async function ooxml(entries: Record<string, string>, folders: string[] = []): Promise<Buffer> {
  const zip = new yazl.ZipFile(), chunks: Buffer[] = []; for (const folder of folders) zip.addEmptyDirectory(folder); for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name); zip.end();
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk as Uint8Array)); return Buffer.concat(chunks);
}
function compound(names: string[]): Buffer {
  const bytes = Buffer.alloc(1536); bytes.set(Buffer.from("d0cf11e0a1b11ae1", "hex")); bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(0xfffe, 28); bytes.writeUInt16LE(9, 30); bytes.writeUInt32LE(1, 44); bytes.writeUInt32LE(0, 48); bytes.writeUInt32LE(0xfffffffe, 68);
  for (let offset = 76; offset < 512; offset += 4) bytes.writeUInt32LE(0xffffffff, offset); bytes.writeUInt32LE(1, 76);
  bytes[512 + 66] = 5; bytes.writeUInt32LE(1, 512 + 76);
  for (let index = 0; index < names.length; index++) {
    const offset = 512 + (index + 1) * 128, name = Buffer.from(names[index] + "\0", "utf16le"); bytes.set(name, offset); bytes.writeUInt16LE(name.length, offset + 64); bytes[offset + 66] = 2; bytes.writeUInt32LE(0xffffffff, offset + 68); bytes.writeUInt32LE(index + 1 < names.length ? index + 2 : 0xffffffff, offset + 72);
  }
  bytes.fill(0xff, 1024); bytes.writeUInt32LE(0xfffffffe, 1024); bytes.writeUInt32LE(0xfffffffd, 1028); return bytes;
}

it("selects opaque native tickets without copying source bytes or creating AI work", async () => {
  const path = directory(), source = join(path, "source.txt"), bytes = Buffer.from("原始题目\n答案：保持原文"); writeFileSync(source, bytes);
  const storage = new AiStorage(path), tickets = new SourceTickets(storage), picked = tickets.pick([source], "revision-1");
  expect(picked).toMatchObject([{ name: "source.txt", size: bytes.length, nativeTicket: expect.any(String) }]); expect(JSON.stringify(picked)).not.toContain(path); expect(readdirSync(storage.root)).toEqual([]);
  const saved = await tickets.upload(picked[0].nativeTicket!, "revision-1"); expect(saved).toEqual(reference("source.txt", bytes)); expect(storage.source(saved)).toEqual(bytes); expect(await tickets.upload(picked[0].nativeTicket!, "revision-1")).toEqual(saved);
  expect(readdirSync(path).sort()).toEqual(["ai-storage", "source.txt"]);
});

it("rejects changed, expired and settings-fenced source tickets before publication", async () => {
  const path = directory(), source = join(path, "source.txt"); writeFileSync(source, "original"); let now = 0; const storage = new AiStorage(path), tickets = new SourceTickets(storage, () => now), selected = tickets.pick([source], "one")[0];
  await expect(tickets.upload(selected.nativeTicket!, "two")).rejects.toMatchObject({ code: "CLOUD_FILE_RESELECT" });
  writeFileSync(source, "changed!"); await expect(tickets.upload(selected.nativeTicket!, "one")).rejects.toMatchObject({ code: "DOCUMENT_CHECKSUM_MISMATCH" });
  writeFileSync(source, "original"); now = 15 * 60 * 1000 + 1; await expect(tickets.upload(selected.nativeTicket!, "one")).rejects.toMatchObject({ code: "CLOUD_FILE_RESELECT" }); expect(readdirSync(storage.root)).toEqual([]);
});

it("bounds native selections and evicts old tickets without losing stored originals", async () => {
  const path = directory(), source = join(path, "source.md"); writeFileSync(source, "Original"); const storage = new AiStorage(path), tickets = new SourceTickets(storage), first = tickets.pick([source], "one")[0], saved = await tickets.upload(first.nativeTicket!, "one");
  for (let index = 0; index < 5; index++) tickets.pick(Array(10).fill(source), "one");
  await expect(tickets.upload(first.nativeTicket!, "one")).rejects.toMatchObject({ code: "CLOUD_FILE_RESELECT" }); expect(storage.source(saved)).toEqual(Buffer.from("Original"));
  expect(() => tickets.pick(Array(11).fill(source), "one")).toThrow(); const previous = tickets.pick([source], "one")[0]; tickets.pick([source], "two"); await expect(tickets.upload(previous.nativeTicket!, "one")).rejects.toThrow();
});

it("keeps upload references strict and validates hashes before writing", async () => {
  const storage = new AiStorage(directory()), bytes = Buffer.from("original"), source = reference("source.txt", bytes);
  for (const changed of [{ ...source, sha256: "a".repeat(64) }, { ...source, objectKey: "../../secret" }, { ...source, mediaType: "image/png" }, { ...source, fileName: "source.csv" }, { ...source, sizeBytes: SOURCE_LIMIT + 1 }, { ...source, path: "/private/secret" }]) await expect(storage.putSource(changed, bytes)).rejects.toThrow();
  expect(readdirSync(storage.root)).toEqual([]); await expect(storage.putSource(source, Buffer.from("modified"))).rejects.toMatchObject({ code: "DOCUMENT_CHECKSUM_MISMATCH" });
});

it("preserves existing corrupt bytes instead of overwriting a content-addressed source", async () => {
  const storage = new AiStorage(directory()), bytes = Buffer.from("original"), source = reference("source.txt", bytes); await storage.putSource(source, bytes);
  const path = join(storage.root, source.objectKey); writeFileSync(path, "modified"); expect(() => storage.source(source)).toThrow(); await expect(storage.putSource(source, bytes)).rejects.toThrow(); expect(readFileSync(path)).toEqual(Buffer.from("modified"));
  expect(readdirSync(join(storage.root, "practiq-agent", "sources", source.sha256))).toEqual(["source.txt"]);
});

it("confines immutable artifacts and leaves missing passive reads unchanged", async () => {
  const storage = new AiStorage(directory()), source = "a".repeat(64), bytes = Buffer.from('{"value":"source"}'), sha256 = hash(bytes), key = `practiq-agent/artifacts/${source}/result/0-${sha256}.json`;
  expect(() => storage.artifact({ objectKey: key, sha256, sizeBytes: bytes.length, mediaType: "application/json" })).toThrow(); expect(readdirSync(storage.root)).toEqual([]);
  const saved = await storage.putArtifact(bytes, source, "result", 0, "application/json"); expect(saved.objectKey).toBe(key); expect(storage.artifact(saved)).toEqual(bytes);
  for (const changed of [{ ...saved, objectKey: `../${key}` }, { ...saved, sha256: "b".repeat(64) }, { ...saved, mediaType: "image/png" }, { ...saved, sizeBytes: bytes.length - 1 }]) expect(() => storage.artifact(changed)).toThrow();
  await expect(storage.putArtifact(bytes, source, "../result", 0, "application/json")).rejects.toThrow(); await expect(storage.putArtifact(bytes, source, "result", 0, "text/html")).rejects.toThrow();
});

it("rejects symlink source files and storage ancestors without touching external files", async () => {
  const path = directory(), outside = directory(), source = join(outside, "source.txt"), linked = join(path, "linked.txt"); writeFileSync(source, "private"); symlinkSync(source, linked);
  const storage = new AiStorage(path); expect(() => new SourceTickets(storage).pick([linked], "one")).toThrow();
  symlinkSync(outside, join(storage.root, "practiq-agent")); await expect(storage.putSource(reference("source.txt", Buffer.from("source")), Buffer.from("source"))).rejects.toThrow(); expect(readdirSync(outside)).toEqual(["source.txt"]);
  const second = directory(); symlinkSync(outside, join(second, "ai-storage")); expect(() => new AiStorage(second)).toThrow();
});

it("retains all allowed formats, rejects new CSV sources, and preserves source-type byte limits", () => {
  for (const extension of Object.keys(SOURCE_FORMATS)) expect(sourceFormat(`source.${extension.toUpperCase()}`)).toEqual(SOURCE_FORMATS[extension as keyof typeof SOURCE_FORMATS]);
  for (const name of ["source.csv", "../secret.txt", ".env", "x\ny.txt", "file.txt\0", "文".repeat(256) + ".txt"]) expect(() => sourceFormat(name)).toThrow();
  expect(sourceLimit("text")).toBe(SOURCE_LIMIT); expect(sourceLimit("xlsx")).toBe(OFFICE_LIMIT);
});

it.each(["docx", "pptx", "xlsx"])("validates %s family and accepts safe directory entries", async type => {
  const storage = new AiStorage(directory()), folder = type === "docx" ? "word" : type === "pptx" ? "ppt" : "xl", required = type === "docx" ? "document" : type === "pptx" ? "presentation" : "workbook", bytes = await ooxml({ "[Content_Types].xml": "<Types/>", [`${folder}/${required}.xml`]: "<root/>" }, [folder]);
  const source = reference(`source.${type}`, bytes); await storage.putSource(source, bytes); expect(storage.source(source)).toEqual(bytes);
  const wrong = reference(`source.${type === "docx" ? "xlsx" : "docx"}`, bytes); await expect(storage.putSource(wrong, bytes)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" });
});

it("rejects OOXML macros and malformed containers before publishing source data", async () => {
  const storage = new AiStorage(directory());
  for (const bytes of [Buffer.from("not a container"), await ooxml({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<document/>", "word/VbaProject.bin": "macro" }), await ooxml({ "[Content_Types].xml": "<Types/>" })]) {
    const source = reference("source.docx", bytes); await expect(storage.putSource(source, bytes)).rejects.toMatchObject({ code: "OFFICE_INPUT_INVALID" });
    expect(readdirSync(join(storage.root, "practiq-agent", "sources", source.sha256))).toEqual([]);
  }
});

it.each([["doc", ["WordDocument", "0Table"]], ["ppt", ["PowerPoint Document", "Current User"]], ["xls", ["Workbook"]]] as const)("validates legacy %s root streams without recognizing embedded content", async (type, names) => {
  const storage = new AiStorage(directory()), bytes = compound([...names]), source = reference(`source.${type}`, bytes); await storage.putSource(source, bytes); expect(storage.source(source)).toEqual(bytes);
  for (const family of ["writer", "impress", "calc"] as const) if (family !== ({ doc: "writer", ppt: "impress", xls: "calc" })[type]) expect(() => validateCompound(bytes, family)).toThrow();
});

it("rejects encrypted, cyclic and malformed compound directories", () => {
  const valid = compound(["WordDocument", "0Table"]); expect(() => validateCompound(valid, "writer")).not.toThrow();
  const cycle = Buffer.from(valid); cycle.writeUInt32LE(0, 1024);
  const invalidSector = Buffer.from(valid); invalidSector.writeUInt32LE(500, 48);
  const invalidName = Buffer.from(valid); invalidName.writeUInt16LE(99, 512 + 128 + 64);
  const invalidEncoding = compound(["\uFEFFWordDocument", "0Table"]);
  for (const bytes of [valid.subarray(0, 511), cycle, invalidSector, invalidName, invalidEncoding, compound(["WordDocument", "0Table", "EncryptedPackage"])]) expect(() => validateCompound(bytes, "writer")).toThrow();
});
