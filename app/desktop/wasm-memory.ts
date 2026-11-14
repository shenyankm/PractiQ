import { AppError, invariant } from "./errors.js";

/** The upstream PDFium binary advertises 2 GiB; enforce a real Wasm memory maximum. */
export function boundWasmMemory(input: Uint8Array, maximumPages = 8192): Uint8Array {
  invariant(Buffer.from(input.subarray(0, 8)).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])), "PDF_ENGINE_INVALID", "Invalid PDF engine binary");
  let position = 8;
  const read = () => { let value = 0, shift = 0, byte: number; do { invariant(position < input.length && shift <= 28, "PDF_ENGINE_INVALID", "Invalid Wasm memory declaration"); byte = input[position++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return value; };
  const encode = (value: number) => { const bytes = []; do { const byte = value & 127; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value); return bytes; };
  while (position < input.length) {
    const start = position, id = input[position++], size = read(), end = position + size; invariant(end <= input.length, "PDF_ENGINE_INVALID", "Truncated PDF engine binary");
    if (id === 5) {
      invariant(read() === 1 && read() === 1, "PDF_ENGINE_INVALID", "Unsupported PDF engine memory layout"); const initial = read(), maximum = read();
      invariant(position === end && Number.isSafeInteger(maximumPages) && maximumPages >= initial && maximumPages <= maximum, "PDF_ENGINE_INVALID", "Invalid PDF engine memory bound");
      const memory = [1, 1, ...encode(initial), ...encode(maximumPages)]; return Buffer.concat([input.subarray(0, start), Buffer.from([5, ...encode(memory.length), ...memory]), input.subarray(end)]);
    }
    position = end;
  }
  throw new AppError("PDF_ENGINE_INVALID", "PDF engine has no declared memory");
}
