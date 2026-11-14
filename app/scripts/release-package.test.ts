import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditPackage, optionalOtherPlatform, runtimeDependencies } from "./package-audit.ts";
import { checkMachO } from "./release-macho.ts";

function fixture(action: (directory: string) => void) { const directory = realpathSync(mkdtempSync(join(tmpdir(), "practiq-native-release-"))); try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); } }
function thin(cpu = 0x0100000c, subtype = 0, order = "little") { const bytes = Buffer.alloc(40), fields = [0xfeedfacf, cpu, subtype, 2, 1, 8, 0, 0, 0x80000028, 8]; fields.forEach((value, index) => order === "little" ? bytes.writeUInt32LE(value, index * 4) : bytes.writeUInt32BE(value, index * 4)); return bytes; }
function fat(wide: boolean, little: boolean) {
  const width = wide ? 32 : 20, offset = 8 + 2 * width, bytes = Buffer.alloc(offset + 80), integer = (value: number, at: number, length = 4) => { if (length === 8) { if (little) bytes.writeBigUInt64LE(BigInt(value), at); else bytes.writeBigUInt64BE(BigInt(value), at); } else if (little) bytes.writeUInt32LE(value, at); else bytes.writeUInt32BE(value, at); };
  integer(wide ? 0xcafebabf : 0xcafebabe, 0); integer(2, 4);
  for (let index = 0; index < 2; index++) { const start = 8 + index * width, cpu = index ? 0x0100000c : 0x01000007, field = wide ? 8 : 4; integer(cpu, start); integer(0, start + 4); integer(offset + index * 40, start + 8, field); integer(40, start + 8 + field, field); thin(cpu).copy(bytes, offset + index * 40); }
  return bytes;
}

test("native architecture checks accept thin and bounded universal executables in either byte order", () => fixture(directory => {
  const path = join(directory, "PractiQ"); writeFileSync(path, thin(), { mode: 0o700 }); checkMachO(path, "arm64"); assert.throws(() => checkMachO(path, "x64"));
  writeFileSync(path, thin(0x01000007, 0, "big")); checkMachO(path, "x64");
  for (const wide of [false, true]) for (const little of [false, true]) { writeFileSync(path, fat(wide, little)); checkMachO(path, "arm64"); checkMachO(path, "x64"); }
}));

for (const fault of ["script", "truncated", "header", "filetype", "commands", "alignment", "count", "label", "subtype", "duplicate", "overlap", "range", "table", "reserved", "unsafeInteger", "permission", "symlink"])
  test(`native architecture checks reject ${fault}`, () => fixture(directory => {
    const path = join(directory, "PractiQ"); let bytes = fault === "script" ? Buffer.from("#!/bin/sh\nexit 0\n") : fault === "truncated" ? thin().subarray(0, 12) : ["header", "filetype", "commands", "permission", "symlink"].includes(fault) ? thin() : fat(true, false);
    if (fault === "header") bytes.writeUInt32BE(0, 0);
    if (fault === "filetype") bytes.writeUInt32LE(6, 12);
    if (fault === "commands") bytes.writeUInt32LE(4096, 20);
    if (fault === "count") bytes.writeUInt32BE(65, 4);
    if (fault === "alignment") bytes.writeUInt32BE(64, 32);
    if (fault === "label") bytes.writeUInt32BE(0x0100000c, 8);
    if (fault === "subtype") bytes.writeUInt32BE(2, 12);
    if (fault === "duplicate") bytes.writeUInt32BE(0x01000007, 40);
    if (fault === "overlap") { bytes.writeBigUInt64BE(104n, 48); thin().copy(bytes, 104); }
    if (fault === "range") bytes.writeBigUInt64BE(10000n, 16);
    if (fault === "table") bytes = bytes.subarray(0, 50);
    if (fault === "reserved") bytes.writeUInt32BE(1, 36);
    if (fault === "unsafeInteger") bytes.writeBigUInt64BE(2n ** 63n, 16);
    writeFileSync(path, bytes, { mode: 0o700 }); if (fault === "permission") chmodSync(path, 0o600);
    if (fault === "symlink") { const alias = join(directory, "link"); symlinkSync(path, alias); assert.throws(() => checkMachO(alias, "arm64")); } else assert.throws(() => checkMachO(path, "arm64"));
  }));

test("package auditing rejects legacy engines, environment files and escaping links anywhere", () => fixture(directory => {
  const bundle = join(directory, "PractiQ.app"); mkdirSync(bundle); writeFileSync(join(bundle, "valid"), "valid"); assert.equal(auditPackage(bundle), 1);
  for (const name of ["python", "python3.14", "libpython3.14.dylib", "python314.dll", "PYTHON-LICENSE.txt", "soffice", "LibreOffice.app", "postgres", "rabbitmq-server", "base_library.zip", "practiq-ai.exe", ".env", ".env.local", "legacy.py", "legacy.pyc", "legacy.rs"]) {
    const path = join(bundle, name); writeFileSync(path, "forbidden"); assert.throws(() => auditPackage(bundle), name); rmSync(path);
  }
  const link = join(bundle, "link"); symlinkSync("valid", link); assert.equal(auditPackage(bundle), 1); rmSync(link); symlinkSync(join(bundle, "valid"), link); assert.throws(() => auditPackage(bundle)); rmSync(link); symlinkSync("../external", link); writeFileSync(join(directory, "external"), "external"); assert.throws(() => auditPackage(bundle));
}));

test("runtime dependency selection follows shared imports and includes detached worker modules", () => fixture(directory => {
  const desktop = join(directory, ".build/electron/app/desktop"), shared = join(directory, ".build/electron/shared"); mkdirSync(desktop, { recursive: true }); mkdirSync(shared);
  writeFileSync(join(desktop, "main.js"), 'import "node:fs"; import "electron"; import "../../shared/runtime.js"; const name="unused-package";');
  writeFileSync(join(desktop, "worker.js"), 'export {something} from "@scope/worker/subpath"; import("worker-runtime");');
  writeFileSync(join(desktop, "build.js"), 'import "development-only";'); writeFileSync(join(shared, "runtime.js"), 'const dep=require("common-runtime");');
  const dependencies = { "@scope/worker": "1.0.0", "worker-runtime": "2.0.0", "common-runtime": "3.0.0", "unused-package": "4.0.0" };
  assert.deepEqual(runtimeDependencies(directory, { dependencies }), { "@scope/worker": "1.0.0", "common-runtime": "3.0.0", "worker-runtime": "2.0.0" });
  assert.throws(() => runtimeDependencies(directory, { dependencies: {} })); writeFileSync(join(desktop, "worker.js"), 'import "../../../../../outside.js";'); assert.throws(() => runtimeDependencies(directory, { dependencies }));
}));

test("only optional dependencies for another OS or architecture may be absent", () => {
  for (const target of [{ optional: true, os: ["linux"] }, { optional: true, cpu: ["x64"] }, { optional: true, os: ["!darwin"] }, { optional: true, cpu: ["!arm64"] }]) assert.equal(optionalOtherPlatform(target, "arm64"), true);
  for (const target of [{ optional: true }, { optional: true, os: ["darwin"], cpu: ["arm64"] }, { optional: false, os: ["linux"] }, { optional: true, os: ["any"] }, { optional: true, cpu: ["!x64"] }]) assert.equal(optionalOtherPlatform(target, "arm64"), false);
  assert.throws(() => optionalOtherPlatform({ optional: true, os: "linux" }, "arm64")); assert.throws(() => optionalOtherPlatform({ optional: true, cpu: [1] }, "arm64"));
});
