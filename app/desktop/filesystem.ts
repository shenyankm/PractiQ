import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { invariant } from "./errors.js";
import { createHash } from "node:crypto";

export function regularFileExists(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  invariant(stat.isFile() && !stat.isSymbolicLink(), "LOCAL_REGULAR_FILE_REQUIRED", "Expected a regular file");
  return true;
}

export function fileDigest(path: string, limit: number): { size: number; sha256: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), digest = createHash("sha256");
  try {
    const stat = fstatSync(descriptor);
    invariant(stat.isFile(), "LOCAL_REGULAR_FILE_REQUIRED", "Expected a regular file");
    invariant(stat.size <= limit, "LOCAL_FILE_TOO_LARGE", "File exceeds its size limit");
    const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0;
    for (;;) { const count = readSync(descriptor, buffer, 0, buffer.length, null); if (!count) break; size += count; invariant(size <= limit, "LOCAL_FILE_TOO_LARGE", "File exceeds its size limit"); digest.update(buffer.subarray(0, count)); }
    return { size, sha256: digest.digest("hex") };
  } finally { closeSync(descriptor); }
}

export function readBounded(path: string, limit: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    invariant(stat.isFile(), "LOCAL_REGULAR_FILE_REQUIRED", "Choose a regular file");
    invariant(stat.size <= limit, "LOCAL_FILE_TOO_LARGE", "File exceeds its size limit");
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) return Buffer.concat(chunks, total);
      total += count;
      invariant(total <= limit, "LOCAL_FILE_TOO_LARGE", "File exceeds its size limit");
      chunks.push(chunk.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
}
export function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
export function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { invariant(fstatSync(descriptor).isFile(), "LOCAL_REGULAR_FILE_REQUIRED", "Expected a regular file"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
export function writeNewFile(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
