import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function checkMachO(path: string, architecture: string): void {
  assert.ok(["arm64", "x64"].includes(architecture));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor); assert.ok(stat.isFile() && stat.mode & 0o111, "Native executable requires execute permission");
    const read = (offset: number, size: number) => { assert.ok(Number.isSafeInteger(offset) && size >= 0 && size <= 2048 && offset + size <= stat.size, "Mach-O range is outside its executable"); const buffer = Buffer.alloc(size); assert.equal(readSync(descriptor, buffer, 0, size, offset), size, "Truncated Mach-O header"); return buffer; };
    const thin = (offset: number, size: number) => {
      assert.ok(size >= 28); const header = read(offset, Math.min(size, 32)), magic = header.readUInt32BE(0), wide = [0xcffaedfe, 0xfeedfacf].includes(magic), little = [0xcffaedfe, 0xcefaedfe].includes(magic);
      assert.ok([0xcffaedfe, 0xfeedfacf, 0xcefaedfe, 0xfeedface].includes(magic), "Expected a native Mach-O executable"); const length = wide ? 32 : 28; assert.ok(header.length >= length);
      const integer = (position: number) => little ? header.readUInt32LE(position) : header.readUInt32BE(position), cpu = integer(4), subtype = integer(8), commands = integer(16), bytes = integer(20);
      assert.ok(integer(12) === 2 && Boolean(cpu & 0x01000000) === wide && bytes <= size - length && commands * 8 <= bytes && bytes % (wide ? 8 : 4) === 0 && (cpu !== 0x0100000c || little), "Invalid or unbounded Mach-O executable header"); return [cpu, subtype];
    };
    const header = read(0, 8), magic = header.readUInt32BE(0), fat = [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic); let cpus: number[];
    if (!fat) cpus = [thin(0, stat.size)[0]];
    else {
      const little = [0xbebafeca, 0xbfbafeca].includes(magic), wide = [0xcafebabf, 0xbfbafeca].includes(magic), width = wide ? 32 : 20, count = little ? header.readUInt32LE(4) : header.readUInt32BE(4), end = 8 + count * width;
      assert.ok(count >= 1 && count <= 64 && end <= stat.size, "Invalid or truncated universal Mach-O table"); const table = read(8, count * width), identities = new Set<string>(), ranges: [number, number][] = []; cpus = [];
      const integer = (offset: number, bytes = 4) => { const value = bytes === 8 ? (little ? table.readBigUInt64LE(offset) : table.readBigUInt64BE(offset)) : BigInt(little ? table.readUInt32LE(offset) : table.readUInt32BE(offset)); assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER), "Unbounded universal Mach-O integer"); return Number(value); };
      for (let index = 0; index < count; index++) {
        const start = index * width, cpu = integer(start), subtype = integer(start + 4), field = wide ? 8 : 4, offset = integer(start + 8, field), size = integer(start + 8 + field, field), alignment = integer(start + 8 + field * 2), key = `${cpu}:${subtype}`;
        assert.ok(!identities.has(key) && offset >= end && size >= 28 && size <= stat.size - offset && alignment <= 63 && BigInt(offset) % (1n << BigInt(alignment)) === 0n && (!wide || integer(start + 28) === 0), "Duplicated or unbounded universal Mach-O member");
        assert.deepEqual(thin(offset, size), [cpu, subtype], "Universal Mach-O CPU label differs from its member"); identities.add(key); cpus.push(cpu); ranges.push([offset, offset + size]);
      }
      ranges.sort((a, b) => a[0] - b[0]); for (let index = 1; index < ranges.length; index++) assert.ok(ranges[index][0] >= ranges[index - 1][1], "Universal Mach-O members overlap");
    }
    assert.ok(cpus.includes(architecture === "arm64" ? 0x0100000c : 0x01000007), "Native executable architecture differs from the candidate");
  } finally { closeSync(descriptor); }
}
