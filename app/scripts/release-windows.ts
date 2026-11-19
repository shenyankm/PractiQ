import assert from "node:assert/strict";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { checksum } from "./release-data.ts";

const limit = 1024 * 1024 * 1024;
const entryLimit = 10000;
// Reject Windows path aliases, device names and alternate data streams before extracting.
function windowsEntry(name: string): boolean {
  return name.startsWith("PractiQ/") && name.split("/").every(part =>
    !/[<>:"\\|?*\x00-\x1f]|[. ]$|^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part));
}

export async function writeWindowsPackage(bundle: string, output: string): Promise<void> {
  const { writeZip } = await import(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href) as typeof import("../desktop/zip.js");
  const entries = readdirSync(bundle, { recursive: true, withFileTypes: true }).flatMap(entry => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) return [];
    const name = `PractiQ/${relative(bundle, path).split(sep).join("/")}`;
    assert.ok(entry.isFile() && windowsEntry(name), "Unexpected Windows package entry");
    return [{ path, name, size: lstatSync(path).size, sha256: checksum(path) }];
  });
  assert.ok(entries.length <= entryLimit && entries.reduce((bytes, entry) => bytes + entry.size, 0) <= limit);
  await writeZip(output, entries, limit);
}

export async function expandWindowsPackage(zipPath: string, destination: string): Promise<string> {
  const { BoundedZip } = await import(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href) as typeof import("../desktop/zip.js");
  const zip = await BoundedZip.open(zipPath, { archiveBytes: limit, expandedBytes: limit, entries: entryLimit });
  try {
    const names = [...zip.entries.keys()];
    assert.ok(names.every(windowsEntry) && new Set(names.map(name => name.toLowerCase())).size === names.length, "Unsafe Windows package entries");
    mkdirSync(destination);
    for (const name of names) {
      const file = join(destination, name);
      mkdirSync(dirname(file), { recursive: true }); await zip.copy(name, file, limit);
    }
    return join(destination, "PractiQ");
  } finally { zip.close(); }
}

export function checkWindowsExecutable(path: string): void {
  const fd = openSync(path, "r");
  try {
    const dos = Buffer.alloc(64), pe = Buffer.alloc(6);
    assert.equal(readSync(fd, dos, 0, dos.length, 0), dos.length);
    assert.equal(dos.toString("ascii", 0, 2), "MZ");
    assert.equal(readSync(fd, pe, 0, pe.length, dos.readUInt32LE(60)), pe.length);
    assert.equal(pe.toString("binary", 0, 4), "PE\0\0");
    assert.equal(pe.readUInt16LE(4), 0x8664, "Expected a Windows x64 executable");
  } finally { closeSync(fd); }
}
