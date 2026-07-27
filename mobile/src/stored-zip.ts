import {
  assertSafeArchivePath,
  finishBackupCrc32,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_FILES,
  updateBackupCrc32,
} from './backup';

export interface StoredZipInput {
  name: string;
  size: number;
  chunks: () => AsyncIterable<Uint8Array>;
}

export interface StoredZipReader {
  size: number;
  read: (offset: number, length: number) => Uint8Array;
}

export interface StoredZipEntry {
  crc: number;
  dataOffset: number;
  localOffset: number;
  name: string;
  size: number;
}

interface CentralEntry {
  crc: number;
  date: number;
  name: Uint8Array;
  offset: number;
  size: number;
  time: number;
}

const ZIP_FLAGS = 0x0808; // UTF-8 names and a trailing data descriptor.
const COPY_CHUNK_BYTES = 256 * 1024;
const MAX_EOCD_BYTES = 65_557;

const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function exactRead(reader: StoredZipReader, offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(length) || length < 0 ||
    offset + length > reader.size
  ) throw new Error('备份压缩包结构损坏');
  const bytes = reader.read(offset, length);
  if (bytes.byteLength !== length) throw new Error('备份压缩包读取不完整');
  return bytes;
}

function record(size: number, fill: (view: DataView) => void) {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
}

function zipDate(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

export async function writeStoredZip(
  entries: readonly StoredZipInput[],
  writeChunk: (bytes: Uint8Array) => Promise<void>,
) {
  if (entries.length > 0xffff) throw new Error('备份压缩包文件过多');
  const centralEntries: CentralEntry[] = [];
  const encoder = new TextEncoder();
  let offset = 0;
  const write = async (bytes: Uint8Array) => {
    if (offset + bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
      throw new Error('完整备份超过 130 MB 文件上限');
    }
    await writeChunk(bytes);
    offset += bytes.byteLength;
  };

  for (const entry of entries) {
    assertSafeArchivePath(entry.name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff) {
      throw new Error('备份文件大小无效');
    }
    const name = encoder.encode(entry.name);
    if (!name.byteLength || name.byteLength > 0xffff) throw new Error('备份文件名无效');
    const { date, time } = zipDate(new Date());
    const localOffset = offset;
    await write(record(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, ZIP_FLAGS, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, time, true);
      view.setUint16(12, date, true);
      view.setUint16(26, name.byteLength, true);
    }));
    await write(name);

    let actualSize = 0;
    let crcState = -1;
    let bytesSinceYield = 0;
    for await (const chunk of entry.chunks()) {
      if (actualSize + chunk.byteLength > entry.size) {
        throw new Error('备份源文件在导出期间发生变化');
      }
      actualSize += chunk.byteLength;
      crcState = updateBackupCrc32(crcState, chunk);
      await write(chunk);
      bytesSinceYield += chunk.byteLength;
      if (bytesSinceYield >= COPY_CHUNK_BYTES) {
        bytesSinceYield = 0;
        await yieldToEvents();
      }
    }
    if (actualSize !== entry.size) throw new Error('备份源文件在导出期间发生变化');
    const crc = finishBackupCrc32(crcState);
    await write(record(16, (view) => {
      view.setUint32(0, 0x08074b50, true);
      view.setUint32(4, crc >>> 0, true);
      view.setUint32(8, actualSize, true);
      view.setUint32(12, actualSize, true);
    }));
    centralEntries.push({ crc, date, name, offset: localOffset, size: actualSize, time });
  }

  const centralOffset = offset;
  for (const entry of centralEntries) {
    await write(record(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 0x0314, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, ZIP_FLAGS, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc >>> 0, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.name.byteLength, true);
      view.setUint32(42, entry.offset, true);
    }));
    await write(entry.name);
  }
  const centralSize = offset - centralOffset;
  await write(record(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, centralEntries.length, true);
    view.setUint16(10, centralEntries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
  }));
  return offset;
}

export function readStoredZip(reader: StoredZipReader) {
  if (!Number.isSafeInteger(reader.size) || reader.size < 22 || reader.size > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new Error('备份压缩包大小无效');
  }
  const tailLength = Math.min(reader.size, MAX_EOCD_BYTES);
  const tailOffset = reader.size - tailLength;
  const tail = exactRead(reader, tailOffset, tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocdOffset = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (
      tailView.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + tailView.getUint16(offset + 20, true) === tail.byteLength
    ) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('备份压缩包结构损坏');
  if (
    tailView.getUint16(eocdOffset + 4, true) !== 0 ||
    tailView.getUint16(eocdOffset + 6, true) !== 0
  ) throw new Error('不支持分卷备份压缩包');
  const entryCount = tailView.getUint16(eocdOffset + 10, true);
  if (
    entryCount !== tailView.getUint16(eocdOffset + 8, true) ||
    entryCount > MAX_BACKUP_FILES + 2
  ) throw new Error('备份压缩包文件过多');
  const centralSize = tailView.getUint32(eocdOffset + 12, true);
  const centralOffset = tailView.getUint32(eocdOffset + 16, true);
  const absoluteEocdOffset = tailOffset + eocdOffset;
  if (centralOffset + centralSize !== absoluteEocdOffset) throw new Error('备份压缩包目录损坏');

  const central = exactRead(reader, centralOffset, centralSize);
  const centralView = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = new Map<string, StoredZipEntry>();
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.byteLength || centralView.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('备份压缩包目录损坏');
    }
    const flags = centralView.getUint16(cursor + 8, true);
    const compression = centralView.getUint16(cursor + 10, true);
    const crc = centralView.getUint32(cursor + 16, true) | 0;
    const compressedSize = centralView.getUint32(cursor + 20, true);
    const size = centralView.getUint32(cursor + 24, true);
    const nameLength = centralView.getUint16(cursor + 28, true);
    const extraLength = centralView.getUint16(cursor + 30, true);
    const commentLength = centralView.getUint16(cursor + 32, true);
    const disk = centralView.getUint16(cursor + 34, true);
    const localOffset = centralView.getUint32(cursor + 42, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (
      cursor + recordLength > central.byteLength ||
      flags & 1 ||
      compression !== 0 ||
      compressedSize !== size ||
      disk !== 0
    ) throw new Error('备份压缩包必须使用未加密的 STORE 格式');
    let name: string;
    try {
      name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error('备份压缩包文件名编码无效');
    }
    assertSafeArchivePath(name);
    if (entries.has(name)) throw new Error('备份压缩包包含重复文件');

    const local = exactRead(reader, localOffset, 30);
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
    if (
      localView.getUint32(0, true) !== 0x04034b50 ||
      localView.getUint16(8, true) !== 0 ||
      localView.getUint16(6, true) & 1
    ) throw new Error('备份压缩包文件头损坏');
    const localNameLength = localView.getUint16(26, true);
    const localExtraLength = localView.getUint16(28, true);
    const localName = exactRead(reader, localOffset + 30, localNameLength);
    try {
      if (decoder.decode(localName) !== name) throw new Error();
    } catch {
      throw new Error('备份压缩包文件头与目录不一致');
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + size > centralOffset) throw new Error('备份压缩包文件范围无效');
    entries.set(name, { crc, dataOffset, localOffset, name, size });
    cursor += recordLength;
  }
  if (cursor !== central.byteLength) throw new Error('备份压缩包目录包含额外数据');

  const ordered = [...entries.values()].sort((left, right) => left.localOffset - right.localOffset);
  if (ordered[0]?.localOffset !== 0) throw new Error('备份压缩包包含未知前缀');
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].dataOffset + ordered[index - 1].size > ordered[index].localOffset) {
      throw new Error('备份压缩包文件范围重叠');
    }
  }
  return entries;
}

export function readStoredZipEntry(reader: StoredZipReader, entry: StoredZipEntry) {
  const bytes = exactRead(reader, entry.dataOffset, entry.size);
  if (finishBackupCrc32(updateBackupCrc32(-1, bytes)) !== entry.crc) {
    throw new Error('备份压缩包 CRC 完整性校验失败');
  }
  return bytes;
}

export async function copyStoredZipEntry(
  reader: StoredZipReader,
  entry: StoredZipEntry,
  writeChunk: (bytes: Uint8Array) => Promise<void>,
) {
  let crcState = -1;
  for (let offset = 0; offset < entry.size; offset += COPY_CHUNK_BYTES) {
    const chunk = exactRead(reader, entry.dataOffset + offset, Math.min(COPY_CHUNK_BYTES, entry.size - offset));
    crcState = updateBackupCrc32(crcState, chunk);
    await writeChunk(chunk);
    await yieldToEvents();
  }
  if (finishBackupCrc32(crcState) !== entry.crc) {
    throw new Error('备份压缩包 CRC 完整性校验失败');
  }
}
