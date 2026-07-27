import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import { MAX_BACKUP_ARCHIVE_BYTES } from './backup';
import {
  copyStoredZipEntry,
  readStoredZip,
  readStoredZipEntry,
  writeStoredZip,
  type StoredZipInput,
} from './stored-zip';

function input(name: string, parts: string[]): StoredZipInput {
  const chunks = parts.map((part) => new TextEncoder().encode(part));
  return {
    name,
    size: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    chunks: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

test('streaming STORE archives round-trip through the existing restore parser', async () => {
  const written: Uint8Array[] = [];
  const size = await writeStoredZip([
    input('manifest.json', ['{"format":"practiq-', 'backup"}']),
    input('database.sqlite', ['SQLite format 3\0', 'data']),
    input('files/media/0-题图.png', ['PNG', ' bytes']),
    input('files/imports/empty.txt', []),
  ], async (chunk) => {
    written.push(chunk.slice());
  });
  const archive = Buffer.concat(written.map((chunk) => Buffer.from(chunk)));
  assert.equal(size, archive.byteLength);

  const zip = await JSZip.loadAsync(archive, { checkCRC32: true, createFolders: false });
  assert.deepEqual(Object.keys(zip.files), [
    'manifest.json',
    'database.sqlite',
    'files/media/0-题图.png',
    'files/imports/empty.txt',
  ]);
  assert.equal(await zip.file('manifest.json')?.async('string'), '{"format":"practiq-backup"}');
  assert.equal(await zip.file('database.sqlite')?.async('string'), 'SQLite format 3\0data');
  assert.equal(await zip.file('files/media/0-题图.png')?.async('string'), 'PNG bytes');
  assert.equal((await zip.file('files/imports/empty.txt')?.async('uint8array'))?.byteLength, 0);

  const reader = {
    size: archive.byteLength,
    read: (offset: number, length: number) => new Uint8Array(archive.subarray(offset, offset + length)),
  };
  const entries = readStoredZip(reader);
  assert.equal(
    new TextDecoder().decode(readStoredZipEntry(reader, entries.get('manifest.json')!)),
    '{"format":"practiq-backup"}',
  );
  const copied: Uint8Array[] = [];
  await copyStoredZipEntry(reader, entries.get('files/media/0-题图.png')!, async (chunk) => {
    copied.push(chunk);
  });
  assert.equal(new TextDecoder().decode(Buffer.concat(copied)), 'PNG bytes');

  const corrupted = Uint8Array.from(archive);
  const mediaEntry = entries.get('files/media/0-题图.png')!;
  corrupted[mediaEntry.dataOffset] ^= 0xff;
  const corruptedReader = {
    size: corrupted.byteLength,
    read: (offset: number, length: number) => corrupted.slice(offset, offset + length),
  };
  assert.throws(
    () => readStoredZipEntry(corruptedReader, readStoredZip(corruptedReader).get(mediaEntry.name)!),
    /CRC/,
  );
});

test('streaming STORE archives reject changing sources and unsafe paths', async () => {
  await assert.rejects(
    writeStoredZip([{
      ...input('database.sqlite', ['too long']),
      size: 2,
    }], async () => undefined),
    /发生变化/,
  );
  await assert.rejects(
    writeStoredZip([input('../database.sqlite', ['data'])], async () => undefined),
    /不安全的文件路径/,
  );
});

test('restore parser remains compatible with legacy JSZip STORE backups', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', '{"legacy":true}');
  zip.file('database.sqlite', 'SQLite format 3\0legacy');
  zip.file('files/media/0-题图.png', 'image', { createFolders: false });
  const archive = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  const reader = {
    size: archive.byteLength,
    read: (offset: number, length: number) => archive.slice(offset, offset + length),
  };

  const entries = readStoredZip(reader);
  assert.deepEqual([...entries.keys()], [
    'manifest.json',
    'database.sqlite',
    'files/media/0-题图.png',
  ]);
  assert.equal(
    new TextDecoder().decode(readStoredZipEntry(reader, entries.get('database.sqlite')!)),
    'SQLite format 3\0legacy',
  );
});

test('restore parser rejects compressed ZIP bombs and oversized archives before extraction', async () => {
  const zip = new JSZip();
  zip.file('database.sqlite', 'x'.repeat(100_000));
  const compressed = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const reader = {
    size: compressed.byteLength,
    read: (offset: number, length: number) => compressed.slice(offset, offset + length),
  };

  assert.throws(() => readStoredZip(reader), /STORE/);
  assert.throws(
    () => readStoredZip({
      size: MAX_BACKUP_ARCHIVE_BYTES + 1,
      read: () => new Uint8Array(),
    }),
    /大小无效/,
  );
});
