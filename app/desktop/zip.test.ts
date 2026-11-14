import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedZip, writeZip } from "./zip.js";
import { hash } from "./assets.js";
import * as yazl from "yazl";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-zip-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const limits = { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, entries: 2002 };

it("reads existing portable bank packages with bounded and verified entries", async () => {
  const zip = await BoundedZip.open(new URL("../fixtures/all-types.zip", import.meta.url).pathname, { ...limits, archiveBytes: 300 * 1024 * 1024, expandedBytes: 288 * 1024 * 1024 + 65536 });
  try { expect(zip.entries.has("manifest.json")).toBe(true); expect(JSON.parse((await zip.read("manifest.json", 65536)).toString()).format).toBe("practiq-question-bank"); expect((await zip.read("questions.json", limits.expandedBytes)).length).toBeGreaterThan(0); }
  finally { zip.close(); }
});

it("round-trips streamed files and rejects changed source checksums before replacing an existing export", async () => {
  const path = directory(), target = join(path, "bank.zip"), resource = join(path, "resource"), bytes = Buffer.from("immutable"); writeFileSync(resource, bytes);
  await writeZip(target, [{ name: "manifest.json", data: Buffer.from("{}") }, { name: "resources/one", path: resource, size: bytes.length, sha256: hash(bytes) }], limits.archiveBytes);
  const zip = await BoundedZip.open(target, limits);
  try { expect(await zip.read("resources/one", 100)).toEqual(bytes); for (const entry of zip.entries.values()) expect(entry.externalFileAttributes >>> 16 & 0o777).toBe(0o600); const copied = join(path, "copy"); await zip.copy("resources/one", copied, 100); expect(readFileSync(copied)).toEqual(bytes); }
  finally { zip.close(); }
  const original = readFileSync(target);
  await expect(writeZip(join(path, "bad.zip"), [{ name: "resources/one", path: resource, size: bytes.length, sha256: "a".repeat(64) }], limits.archiveBytes)).rejects.toThrow("checksum changed");
  await expect(writeZip(target, [{ name: "replacement", data: Buffer.from("changed") }], limits.archiveBytes)).rejects.toThrow("already exists");
  expect(readFileSync(target)).toEqual(original);
});

it("verifies CRC32 rather than accepting corrupted central-directory checksums", async () => {
  const path = directory(), target = join(path, "crc.zip"); await writeZip(target, [{ name: "one", data: Buffer.from("one") }], limits.archiveBytes);
  const bytes = readFileSync(target), central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); expect(central).toBeGreaterThan(0);
  bytes.writeUInt32LE((bytes.readUInt32LE(central + 16) + 1) >>> 0, central + 16); writeFileSync(target, bytes);
  const zip = await BoundedZip.open(target, limits);
  try { await expect(zip.read("one", 100)).rejects.toThrow("CRC checksum mismatch"); } finally { zip.close(); }
});

it.each(["duplicate", "symlink", "directory", "expanded"])("rejects %s ZIP entries before extracting files", async kind => {
  const path = directory(), target = join(path, "bad.zip"), zip = new yazl.ZipFile(), writing = pipeline(zip.outputStream, createWriteStream(target));
  if (kind === "duplicate") { zip.addBuffer(Buffer.from("1"), "one"); zip.addBuffer(Buffer.from("2"), "one"); }
  if (kind === "symlink") zip.addBuffer(Buffer.from("/private"), "one", { mode: 0o120777 });
  if (kind === "directory") zip.addEmptyDirectory("folder");
  if (kind === "expanded") zip.addBuffer(Buffer.alloc(2048), "one");
  zip.end(); await writing;
  await expect(BoundedZip.open(target, { ...limits, expandedBytes: kind === "expanded" ? 1024 : limits.expandedBytes })).rejects.toThrow();
});

it("checks the publication fence after streaming and cleans its temporary file on rejection", async () => {
  const path = directory(), target = join(path, "fenced.zip"); let guarded = false;
  await expect(writeZip(target, [{ name: "one", data: Buffer.from("saved") }], limits.archiveBytes, false, () => { guarded = true; throw Error("stale checkpoint"); })).rejects.toThrow("stale checkpoint");
  expect(guarded).toBe(true); expect((await import("node:fs")).readdirSync(path)).toEqual([]);
});

it("rejects named pipes before archive or lazy resource reads can block", async () => {
  const path = directory(), fifo = join(path, "pipe"); execFileSync("mkfifo", [fifo]);
  await expect(BoundedZip.open(fifo, limits)).rejects.toThrow("regular file"); await expect(writeZip(join(path, "bad.zip"), [{ name: "one", path: fifo, size: 0, sha256: hash(Buffer.alloc(0)) }], limits.archiveBytes)).rejects.toThrow();
});

it.each(["before", "after"])("retains atomic ZIP publication through SIGKILL %s publication", async phase => {
  const path = directory(), target = join(path, "killed.zip"), source = `import {writeZip} from ${JSON.stringify(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href)}; const data=JSON.parse(process.argv[1]); await writeZip(data.target,[{name:'saved',data:Buffer.from('complete')}],1048576,false,()=>{if(data.phase==='before')process.kill(process.pid,'SIGKILL')}); process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify({ target, phase })], { timeout: 15000, encoding: "utf8" }); expect(child.signal, child.stderr).toBe("SIGKILL");
  if (phase === "before") expect((await import("node:fs")).existsSync(target)).toBe(false);
  else { const zip = await BoundedZip.open(target, limits); try { expect((await zip.read("saved", 100)).toString()).toBe("complete"); } finally { zip.close(); } }
});
