import { AppError, invariant } from "./errors.js";
import { BoundedZip } from "./zip.js";

/** Identify root CFB streams only; embedded documents cannot change the declared family. */
export function validateCompound(data: Buffer, family: "writer" | "impress" | "calc") {
  const valid = (condition: unknown) => invariant(condition, "OFFICE_INPUT_INVALID", "Invalid Office compound container");
  try {
    valid(data.length >= 512 && data.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1");
    const version = data.readUInt16LE(26), order = data.readUInt16LE(28), shift = data.readUInt16LE(30);
    valid((version === 3 && shift === 9 || version === 4 && shift === 12) && order === 0xfffe);
    const size = 2 ** shift, sectors = data.length / size - 1; valid(Number.isInteger(sectors) && sectors >= 1);
    const sector = (index: number): Buffer => { valid(Number.isSafeInteger(index) && index >= 0 && index < sectors); return data.subarray((index + 1) * size, (index + 2) * size); };
    const fatCount = data.readUInt32LE(44), difatCount = data.readUInt32LE(72); let directoryStart = data.readUInt32LE(48), difatStart = data.readUInt32LE(68);
    valid(fatCount > 0 && fatCount <= sectors && difatCount <= sectors);
    const fatSectors: number[] = []; for (let offset = 76; offset < 512; offset += 4) { const value = data.readUInt32LE(offset); if (value !== 0xffffffff) fatSectors.push(value); }
    const seen = new Set<number>();
    for (let index = 0; index < difatCount; index++) {
      valid(!seen.has(difatStart)); seen.add(difatStart); const chunk = sector(difatStart);
      for (let offset = 0; offset < size - 4; offset += 4) { const value = chunk.readUInt32LE(offset); if (value !== 0xffffffff) fatSectors.push(value); }
      valid(fatSectors.length <= fatCount); difatStart = chunk.readUInt32LE(size - 4);
    }
    valid(fatSectors.length === fatCount && new Set(fatSectors).size === fatCount);
    const systemSectors = [...fatSectors, ...seen], fat = Buffer.concat(fatSectors.map(sector)), directories: Buffer[] = []; seen.clear();
    while (directoryStart !== 0xfffffffe) { valid(!seen.has(directoryStart) && directoryStart < fat.length / 4); seen.add(directoryStart); directories.push(sector(directoryStart)); directoryStart = fat.readUInt32LE(directoryStart * 4); }
    systemSectors.push(...seen); const directory = Buffer.concat(directories); valid(directory.length >= 128 && directory[66] === 5);
    const pending = [directory.readUInt32LE(76)], names = new Map<string, number>(), roots = new Map<string, number>(); seen.clear();
    while (pending.length) {
      const index = pending.pop()!; if (index === 0xffffffff) continue;
      valid(!seen.has(index) && index < directory.length / 128); seen.add(index);
      const entry = directory.subarray(index * 128, (index + 1) * 128), length = entry.readUInt16LE(64), kind = entry[66];
      valid(length >= 2 && length <= 64 && length % 2 === 0 && entry.readUInt16LE(length - 2) === 0 && [1, 2].includes(kind));
      const name = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(entry.subarray(0, length - 2)).toLowerCase(); valid(name && !name.includes("\0") && !names.has(name));
      names.set(name, kind); roots.set(name, index); pending.push(entry.readUInt32LE(68), entry.readUInt32LE(72));
    }
    const stream = (name: string) => names.get(name) === 2;
    valid((family === "writer" ? stream("worddocument") && (stream("0table") || stream("1table")) : family === "impress" ? stream("powerpoint document") && stream("current user") : stream("workbook") || stream("book")) && !stream("encryptioninfo") && !stream("encryptedpackage"));
    return { version, size, sectors, fat, directory, roots, systemSectors };
  } catch { throw new AppError("OFFICE_INPUT_INVALID", "Office container does not match its declared source type"); }
}
export async function validateOfficeInput(path: string, bytes: Buffer, type: string): Promise<void> {
  if (!["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(type)) return;
  const family = type.startsWith("doc") ? "writer" : type.startsWith("ppt") ? "impress" : "calc";
  if (["doc", "ppt", "xls"].includes(type)) { validateCompound(bytes, family); return; }
  let archive: BoundedZip | undefined;
  try {
    archive = await BoundedZip.open(path, { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
    const required = family === "writer" ? "word/document.xml" : family === "impress" ? "ppt/presentation.xml" : "xl/workbook.xml";
    invariant(archive.entries.has(required) && archive.entries.has("[Content_Types].xml") && ![...archive.entries.keys()].some(name => name.toLowerCase().endsWith("vbaproject.bin")), "OFFICE_INPUT_INVALID", "Office container is encrypted, contains macros or has the wrong document family");
  } catch { throw new AppError("OFFICE_INPUT_INVALID", "Office container does not match its declared source type"); }
  finally { archive?.close(); }
}
