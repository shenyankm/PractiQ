import { parentPort, workerData } from "node:worker_threads";
import { constants, zstdDecompressSync } from "node:zlib";
import bzip from "seek-bzip";
import lzma from "lzma-purejs";

try {
  const { method, expected } = workerData as { method: number; expected: number; compressed: Uint8Array }, input = Buffer.from(workerData.compressed);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > 150 * 1024 * 1024 || input.length > 100 * 1024 * 1024) throw new Error();
  let output: Buffer;
  if (method === 20 || method === 93) output = zstdDecompressSync(input, { maxOutputLength: Math.max(1, expected), params: { [constants.ZSTD_d_windowLogMax]: 27 } });
  else {
    output = Buffer.allocUnsafeSlow(expected); let written = 0;
    const stream = { writeByte(value: number) { if (written >= expected) throw new Error(); output[written++] = value; } };
    if (method === 12) bzip.decode(input, stream);
    else if (method === 14) {
      if (input.length < 9 || input.readUInt16LE(2) !== 5 || input.readUInt32LE(5) > 128 * 1024 * 1024) throw new Error();
      let offset = 9; const reader = { readByte() { if (offset >= input.length) throw new Error(); return input[offset++]; } };
      if (!lzma.decompress(input.subarray(4, 9), reader, stream, expected)) throw new Error();
    } else throw new Error();
    if (written !== expected) throw new Error();
  }
  if (output.length !== expected) throw new Error(); const result = Uint8Array.from(output); parentPort!.postMessage(result, [result.buffer]);
} catch { parentPort!.postMessage(null); }
