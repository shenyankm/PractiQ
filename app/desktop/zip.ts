import { constants, closeSync, createReadStream, createWriteStream, fstatSync, fsyncSync, linkSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, deflateRaw } from "node:zlib";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import { invariant } from "./errors.js";
import { regularFileExists, syncDirectory } from "./filesystem.js";
import { decodeZipCodec } from "./zip-codecs.js";

export interface ZipLimits { archiveBytes: number; expandedBytes: number; entries: number; allowDirectories?: boolean; extraCodecs?: boolean }
export function safeZipName(name: string): boolean { return Boolean(name) && !name.startsWith("/") && !/[\\\0]/.test(name) && name.split("/").every(part => part && part !== "." && part !== ".."); }
export class BoundedZip {
  readonly entries = new Map<string, yauzl.Entry>();
  private failure?: Error;
  private readonly streams = new Set<Readable>();
  private constructor(private readonly zip: yauzl.ZipFile, private readonly limits: ZipLimits) {
    zip.on("error", error => { this.failure = error; for (const stream of this.streams) stream.destroy(error); });
  }
  static async open(path: string, limits: ZipLimits): Promise<BoundedZip> {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let zip: yauzl.ZipFile;
    try {
      const stat = fstatSync(descriptor);
      invariant(stat.isFile(), "LOCAL_REGULAR_FILE_REQUIRED", "Archive must be a regular file");
      invariant(stat.size <= limits.archiveBytes, "LOCAL_ARCHIVE_TOO_LARGE", "ZIP exceeds its size limit");
      zip = await yauzl.fromFdPromise(descriptor, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    } catch (error) { closeSync(descriptor); throw error; }
    return BoundedZip.validate(zip, limits);
  }
  static async fromBytes(bytes: Uint8Array, limits: ZipLimits): Promise<BoundedZip> {
    invariant(bytes.byteLength <= limits.archiveBytes, "LOCAL_ARCHIVE_TOO_LARGE", "ZIP exceeds its size limit");
    return BoundedZip.validate(await yauzl.fromBufferPromise(Buffer.from(bytes), { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }), limits);
  }
  private static async validate(zip: yauzl.ZipFile, limits: ZipLimits): Promise<BoundedZip> {
    const result = new BoundedZip(zip, limits);
    try {
      invariant(Number.isSafeInteger(zip.entryCount) && zip.entryCount <= limits.entries, "LOCAL_BANK_ZIP_INVALID", "Too many ZIP entries");
      let total = 0;
      await new Promise<void>((resolve, reject) => {
        zip.once("end", resolve); zip.once("error", reject);
        zip.on("entry", (entry: yauzl.Entry) => {
          try {
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            const directory = entry.fileName.endsWith("/");
            invariant(safeZipName(directory ? entry.fileName.slice(0, -1) : entry.fileName) && !result.entries.has(entry.fileName) && (directory ? limits.allowDirectories && entry.uncompressedSize === 0 && (mode === 0 || mode === 0o040000) : mode === 0 || mode === 0o100000) && !entry.isEncrypted() && (entry.canDecodeFileData() || limits.extraCodecs && [12, 14, 20, 93].includes(entry.compressionMethod)), "LOCAL_BANK_ZIP_INVALID", "Unsafe, duplicate or encrypted ZIP entry");
            invariant(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && Number.isSafeInteger(entry.compressedSize) && entry.compressedSize >= 0, "LOCAL_BANK_ZIP_INVALID", "Invalid ZIP entry size");
            total += entry.uncompressedSize;
            invariant(Number.isSafeInteger(total) && total <= limits.expandedBytes, "LOCAL_BACKUP_EXPANDED_TOO_LARGE", "Expanded ZIP exceeds its size limit");
            result.entries.set(entry.fileName, entry); zip.readEntry();
          } catch (error) { reject(error); }
        });
        zip.readEntry();
      });
      return result;
    } catch (error) { result.close(); throw error; }
  }
  close(): void { for (const stream of this.streams) stream.destroy(); this.zip.close(); }
  private async *chunks(name: string, limit: number): AsyncGenerator<Buffer> {
    if (this.failure) throw this.failure;
    const entry = this.entries.get(name);
    invariant(entry, "LOCAL_BANK_ZIP_INVALID", "Missing ZIP entry");
    invariant(entry.uncompressedSize <= limit, "LOCAL_FILE_TOO_LARGE", "ZIP entry exceeds its size limit");
    if (!entry.canDecodeFileData()) {
      const bytes = await decodeZipCodec(async () => {
        const stream = await this.zip.openReadStreamPromise(entry, { decodeFileData: false }); this.streams.add(stream); const chunks: Buffer[] = []; let size = 0;
        try { for await (const chunk of stream) { size += chunk.length; invariant(size <= entry.compressedSize && size <= this.limits.archiveBytes, "LOCAL_ARCHIVE_TOO_LARGE", "Compressed ZIP entry exceeds its size limit"); chunks.push(Buffer.from(chunk)); } invariant(size === entry.compressedSize, "LOCAL_BANK_ZIP_INVALID", "Truncated compressed ZIP entry"); return Buffer.concat(chunks, size); }
        finally { this.streams.delete(stream); stream.destroy(); }
      }, entry.compressionMethod, entry.uncompressedSize);
      invariant(bytes.length === entry.uncompressedSize && crc32(bytes) === entry.crc32, "LOCAL_BACKUP_CHECKSUM_MISMATCH", "ZIP size or CRC checksum mismatch"); yield bytes; return;
    }
    const stream = await this.zip.openReadStreamPromise(entry); this.streams.add(stream);
    let size = 0, checksum = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length; invariant(size <= limit, "LOCAL_FILE_TOO_LARGE", "ZIP entry exceeds its size limit");
        checksum = crc32(chunk, checksum); yield chunk;
      }
      invariant(size === entry.uncompressedSize && checksum === entry.crc32, "LOCAL_BACKUP_CHECKSUM_MISMATCH", "ZIP size or CRC checksum mismatch");
    } finally { this.streams.delete(stream); stream.destroy(); }
  }
  async read(name: string, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []; for await (const chunk of this.chunks(name, limit)) chunks.push(chunk); return Buffer.concat(chunks);
  }
  /** Rewrite bounded members in one pass, retaining other compressed members and metadata. */
  async replace(replacements: ReadonlyMap<string, Buffer>, limit: number, signal?: AbortSignal): Promise<Buffer> {
    invariant(replacements.size > 0 && [...replacements].every(([name, data]) => this.entries.has(name) && !name.endsWith("/") && data.length <= this.limits.expandedBytes), "LOCAL_BANK_ZIP_INVALID", "Invalid replacement ZIP member");
    invariant(Number.isSafeInteger(limit) && limit >= 22 && limit <= 0xffffffff, "LOCAL_ARCHIVE_TOO_LARGE", "Invalid derived ZIP limit");
    invariant([...this.entries.values()].reduce((sum, entry) => sum + (replacements.get(entry.fileName)?.length ?? entry.uncompressedSize), 0) <= this.limits.expandedBytes, "LOCAL_BACKUP_EXPANDED_TOO_LARGE", "Derived ZIP exceeds its expanded size limit");
    const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
    for (const entry of this.entries.values()) {
      signal?.throwIfAborted(); await this.read(entry.fileName, this.limits.expandedBytes); signal?.throwIfAborted();
      const data = replacements.get(entry.fileName), changed = data !== undefined, fileName = entry.fileNameRaw, comment = entry.fileCommentRaw, extra = Buffer.concat(entry.extraFields.filter(field => field.id !== 1).map(field => { const header = Buffer.alloc(4); header.writeUInt16LE(field.id); header.writeUInt16LE(field.data.length, 2); return Buffer.concat([header, field.data]); }));
      let compressed: Buffer;
      if (changed) compressed = await new Promise<Buffer>((resolve, reject) => deflateRaw(data, (error, output) => error ? reject(error) : resolve(output)));
      else {
        const stream = await this.zip.openReadStreamPromise(entry, { decodeFileData: false }); this.streams.add(stream); const chunks: Buffer[] = []; let size = 0;
        try { for await (const chunk of stream) { signal?.throwIfAborted(); size += chunk.length; invariant(size <= entry.compressedSize && size <= this.limits.archiveBytes, "LOCAL_BANK_ZIP_INVALID", "Invalid compressed ZIP size"); chunks.push(Buffer.from(chunk)); } invariant(size === entry.compressedSize, "LOCAL_BANK_ZIP_INVALID", "Truncated compressed ZIP member"); compressed = Buffer.concat(chunks, size); }
        finally { this.streams.delete(stream); stream.destroy(); }
      }
      signal?.throwIfAborted();
      const flags = entry.generalPurposeBitFlag & ~(8 | (changed ? 6 : 0)), method = changed ? 8 : entry.compressionMethod, size = changed ? data.length : entry.uncompressedSize, checksum = changed ? crc32(data) : entry.crc32, version = changed ? 20 : entry.versionNeededToExtract;
      invariant(fileName.length <= 65535 && extra.length <= 65535 && comment.length <= 65535 && offset + 30 + fileName.length + extra.length + compressed.length <= limit, "LOCAL_ARCHIVE_TOO_LARGE", "Derived ZIP exceeds its size limit");
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(version, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(entry.lastModFileTime, 10); local.writeUInt16LE(entry.lastModFileDate, 12); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(fileName.length, 26); local.writeUInt16LE(extra.length, 28);
      const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(entry.versionMadeBy, 4); local.copy(record, 6, 4, 26); record.writeUInt16LE(fileName.length, 28); record.writeUInt16LE(extra.length, 30); record.writeUInt16LE(comment.length, 32); record.writeUInt16LE(entry.internalFileAttributes, 36); record.writeUInt32LE(entry.externalFileAttributes >>> 0, 38); record.writeUInt32LE(offset, 42);
      locals.push(local, fileName, extra, compressed); central.push(record, fileName, extra, comment); offset += local.length + fileName.length + extra.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); invariant(this.entries.size <= 65535 && offset + directory.length + end.length <= limit, "LOCAL_ARCHIVE_TOO_LARGE", "Derived ZIP exceeds its size limit"); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(this.entries.size, 8); end.writeUInt16LE(this.entries.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...locals, directory, end]);
  }
  async copy(name: string, destination: string, limit: number): Promise<void> {
    const descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let success = false;
    try { for await (const chunk of this.chunks(name, limit)) writeFileSync(descriptor, chunk); fsyncSync(descriptor); success = true; }
    finally { closeSync(descriptor); if (!success) unlinkSync(destination); }
  }
}

export type ZipSource = { name: string; data: Uint8Array } | { name: string; path: string; size: number; sha256: string };
export async function writeZip(destination: string, entries: ZipSource[], limit: number, overwrite = false, beforePublish?: () => void): Promise<void> {
  const parent = realpathSync(dirname(destination)), target = join(parent, basename(destination)), temporary = join(parent, `.practiq-${randomUUID()}.tmp`);
  invariant(!regularFileExists(target) || overwrite, "LOCAL_DESTINATION_EXISTS", "Choose a new filename; the destination already exists");
  const zip = new yazl.ZipFile(), output = zip.outputStream as Readable;
  zip.on("error", error => output.destroy(error));
  let size = 0;
  const names = new Set<string>();
  try {
    const writing = pipeline(output, new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length; try { invariant(size <= limit, "LOCAL_ARCHIVE_TOO_LARGE", "ZIP exceeds its size limit"); callback(null, chunk); } catch (error) { callback(error as Error); }
    } }), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    // Observe asynchronous stream errors while the synchronous entry list is prepared.
    void writing.catch(() => {});
    try {
      for (const entry of entries) {
        invariant(safeZipName(entry.name) && !names.has(entry.name), "LOCAL_BANK_ZIP_INVALID", "Unsafe or duplicate ZIP entry"); names.add(entry.name);
        if ("data" in entry) { zip.addBuffer(Buffer.from(entry.data), entry.name, { mode: 0o100600 }); continue; }
        zip.addReadStreamLazy(entry.name, { size: entry.size, mode: 0o100600 }, callback => {
          let fd: number | undefined;
          try {
            fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = fstatSync(fd); invariant(stat.isFile() && stat.size === entry.size, "LOCAL_ASSET_MISSING", "Resource changed before export");
            const digest = createHash("sha256"), source = createReadStream(entry.path, { fd, autoClose: true }); fd = undefined;
            const verifier = new Transform({ transform(chunk: Buffer, _encoding, callback) { digest.update(chunk); callback(null, chunk); }, flush(callback) {
              try { invariant(digest.digest("hex") === entry.sha256, "LOCAL_ASSET_MISSING", "Resource checksum changed during export"); callback(); } catch (error) { callback(error as Error); }
            } });
            source.on("error", error => verifier.destroy(error));
            verifier.on("error", error => { source.destroy(); output.destroy(error); });
            verifier.on("close", () => source.destroy()); callback(null, source.pipe(verifier));
          } catch (error) { if (fd !== undefined) closeSync(fd); callback(error, Readable.from([])); }
        });
      }
      zip.end();
    } catch (error) { output.destroy(error as Error); await writing.catch(() => {}); throw error; }
    await writing;
    const descriptor = openSync(temporary, constants.O_RDWR | constants.O_NOFOLLOW);
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    beforePublish?.();
    if (overwrite) { regularFileExists(target); renameSync(temporary, target); }
    else { linkSync(temporary, target); unlinkSync(temporary); }
    syncDirectory(parent);
  } catch (error) {
    output.destroy();
    try { unlinkSync(temporary); } catch { /* Publication may already have completed. */ }
    throw error;
  }
}
