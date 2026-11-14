import { AppError, invariant } from "./errors.js";
import { validateCompound } from "./office-input.js";

const END = 0xfffffffe;
interface Stream { bytes: Buffer; position: (index: number) => number }
/** Read allocation metadata only; shared/cyclic sectors cannot authorize an in-place byte patch. */
function streams(data: Buffer, signal: AbortSignal) {
  const valid = (value: unknown) => invariant(value, "OFFICE_INPUT_INVALID", "Invalid PowerPoint compound allocation");
  const { version, size, sectors, fat, directory, roots, systemSectors } = validateCompound(data, "impress"), used = new Set(systemSectors), usedMini = new Set<number>();
  valid(used.size === systemSectors.length && data.readUInt16LE(32) === 6 && data.readUInt32LE(56) === 4096);
  const length = (entry: Buffer) => { const value = version === 3 ? BigInt(entry.readUInt32LE(120)) : entry.readBigUInt64LE(120); valid(value <= BigInt(data.length)); return Number(value); };
  const chain = (start: number, bytes: number, unit: number, table: Buffer, count: number, claimed: Set<number>, physical: (id: number) => number): Stream => {
    const chunks: Buffer[] = [], positions: number[] = []; let id = start;
    for (let index = 0; index < Math.ceil(bytes / unit); index++) {
      signal.throwIfAborted(); valid(id < count && id < table.length / 4 && !claimed.has(id)); claimed.add(id); const offset = physical(id); valid(offset >= 0 && offset + unit <= data.length); positions.push(offset); chunks.push(data.subarray(offset, offset + unit)); id = table.readUInt32LE(id * 4);
    }
    valid(bytes === 0 || id === END); const payload = Buffer.concat(chunks).subarray(0, bytes);
    return { bytes: payload, position: (index: number) => { valid(Number.isSafeInteger(index) && index >= 0 && index < payload.length); return positions[Math.floor(index / unit)] + index % unit; } };
  };
  const regular = (start: number, bytes: number) => chain(start, bytes, size, fat, sectors, used, id => (id + 1) * size);
  const miniFatCount = data.readUInt32LE(64); valid(miniFatCount <= sectors); const miniFat = regular(data.readUInt32LE(60), miniFatCount * size).bytes, root = directory.subarray(0, 128), mini = regular(root.readUInt32LE(116), length(root)), result = new Map<number, Stream>();
  for (let offset = 128; offset < directory.length; offset += 128) {
    const entry = directory.subarray(offset, offset + 128); if (entry[66] !== 2) continue; const bytes = length(entry), start = entry.readUInt32LE(116);
    result.set(offset / 128, bytes < 4096 ? chain(start, bytes, 64, miniFat, Math.floor(mini.bytes.length / 64), usedMini, id => mini.position(id * 64)) : regular(start, bytes));
  }
  const get = (name: string) => { const stream = result.get(roots.get(name)!); valid(stream); return stream!; };
  return { document: get("powerpoint document"), current: get("current user") };
}
interface RecordHeader { start: number; end: number; version: number; instance: number; type: number; length: number }

/** Resolve live slide metadata through the latest edit; never rewrite obsolete saves or content. */
export function visibleLegacySlides(source: Buffer, maxSlides: number, signal: AbortSignal): { bytes: Buffer; slides: string[] } {
  signal.throwIfAborted(); invariant(source.length <= 25 * 1024 * 1024 && Number.isSafeInteger(maxSlides) && maxSlides > 0 && maxSlides <= 300, "OFFICE_OUTPUT_LIMIT", "Invalid PowerPoint source or slide limit");
  try {
    const { document, current } = streams(source, signal), data = document.bytes, top = new Map<number, RecordHeader>(); let count = 0;
    const valid = (value: unknown) => invariant(value, "OFFICE_INPUT_INVALID", "Invalid PowerPoint slide metadata");
    const header = (bytes: Buffer, start: number, end: number): RecordHeader => { valid(start >= 0 && start + 8 <= end); const value = bytes.readUInt16LE(start), length = bytes.readUInt32LE(start + 4); valid(length <= end - start - 8); return { start, end: start + 8 + length, version: value & 15, instance: value >>> 4, type: bytes.readUInt16LE(start + 2), length }; };
    const records = function* (start: number, end: number) { for (let offset = start; offset < end;) { signal.throwIfAborted(); invariant(++count <= 100000, "OFFICE_OUTPUT_LIMIT", "PowerPoint record limit exceeded"); const record = header(data, offset, end); yield record; offset = record.end; } };
    for (const record of records(0, data.length)) top.set(record.start, record);
    const currentHeader = header(current.bytes, 0, current.bytes.length); valid(currentHeader.type === 0x0ff6 && currentHeader.version === 0 && currentHeader.instance === 0 && currentHeader.length >= 20 && current.bytes.readUInt32LE(8) === 20 && current.bytes.readUInt32LE(12) === 0xe391c05f);
    let editOffset = current.bytes.readUInt32LE(16), documentId: number | undefined; const edits = new Set<number>(), persisted = new Map<number, number>();
    for (;;) {
      signal.throwIfAborted(); valid(!edits.has(editOffset)); edits.add(editOffset); const edit = top.get(editOffset); valid(edit && edit.type === 0x0ff5 && edit.version === 0 && edit.instance === 0 && edit.length === 28);
      documentId ??= data.readUInt32LE(editOffset + 24); const directoryOffset = data.readUInt32LE(editOffset + 20), directory = top.get(directoryOffset); valid(directory && [0x1771, 0x1772].includes(directory.type) && directory.version === 0 && directory.instance === 0); const local = new Set<number>();
      for (let offset = directory!.start + 8; offset < directory!.end;) {
        valid(offset + 4 <= directory!.end); const value = data.readUInt32LE(offset), id = value & 0xfffff, entries = value >>> 20; offset += 4; valid(id > 0 && entries > 0 && id + entries <= 0x100000 && entries <= (directory!.end - offset) / 4);
        for (let index = 0; index < entries; index++, offset += 4) { const key = id + index, location = data.readUInt32LE(offset); valid(!local.has(key) && top.has(location)); local.add(key); if (!persisted.has(key)) persisted.set(key, location); }
      }
      const previous = data.readUInt32LE(editOffset + 16); if (!previous) break; valid(previous < editOffset); editOffset = previous;
    }
    const documentOffset = persisted.get(documentId!), container = top.get(documentOffset!); valid(container && container.type === 0x03e8 && container.version === 15);
    const lists = [...records(container!.start + 8, container!.end)].filter(record => record.type === 0x0ff0 && record.instance === 0); valid(lists.length === 1 && lists[0].version === 15);
    const slides: string[] = [], ids = new Set<number>(), references = new Set<number>(), patches: number[] = [];
    for (const item of records(lists[0].start + 8, lists[0].end)) {
      if (item.type !== 0x03f3) continue; valid(item.version === 0 && item.instance === 0 && item.length === 20); const reference = data.readUInt32LE(item.start + 8), id = data.readUInt32LE(item.start + 20), slide = top.get(persisted.get(reference)!);
      valid(id >= 256 && id < 2147483648 && !ids.has(id) && !references.has(reference) && slide && slide.type === 0x03ee && slide.version === 15); invariant(slides.length < maxSlides, "OFFICE_OUTPUT_LIMIT", "PowerPoint exceeds the slide limit"); ids.add(id); references.add(reference); slides.push(`slide:${id}:persist:${reference}`);
      const flags = [...records(slide!.start + 8, slide!.end)].filter(record => record.type === 0x03f9); valid(flags.length <= 1);
      for (const info of flags) { valid(info.version === 0 && info.instance === 0 && info.length === 16); const offset = info.start + 18; if (data[offset] & 4) patches.push(document.position(offset)); }
    }
    valid(slides.length > 0); if (!patches.length) return { bytes: source, slides }; const bytes = Buffer.from(source); for (const position of patches) bytes[position] &= ~4; return { bytes, slides };
  } catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof AppError && ["OFFICE_INPUT_INVALID", "OFFICE_OUTPUT_LIMIT"].includes(error.code)) throw error; throw new AppError("OFFICE_INPUT_INVALID", "PowerPoint visibility metadata did not validate"); }
}
