import { Worker } from "node:worker_threads";
import { AppError, invariant } from "./errors.js";

let pending: Promise<unknown> = Promise.resolve();
/** Rare provider codecs share one bounded worker; normal stored/deflate streams use the existing ZIP reader. */
export function decodeZipCodec(read: () => Promise<Buffer>, method: number, expected: number): Promise<Buffer> {
  const operation = pending.then(async () => {
    invariant([12, 14, 20, 93].includes(method) && Number.isSafeInteger(expected) && expected >= 0 && expected <= 150 * 1024 * 1024, "LOCAL_BANK_ZIP_INVALID", "Unsupported compressed ZIP entry");
    const compressed = Uint8Array.from(await read()), worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "../.build/electron/app/desktop/zip-codec-worker.js" : "./zip-codec-worker.js", import.meta.url), { workerData: { compressed, method, expected }, transferList: [compressed.buffer], env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        timer = setTimeout(() => reject(new AppError("LOCAL_BANK_ZIP_INVALID", "ZIP codec exceeded its execution limit")), 5000); timer.unref();
        worker.once("message", value => { if (value instanceof Uint8Array && value.byteLength === expected) resolve(Buffer.from(value.buffer, value.byteOffset, value.byteLength)); else reject(new AppError("LOCAL_BANK_ZIP_INVALID", "Compressed ZIP member is invalid")); });
        worker.once("error", () => reject(new AppError("LOCAL_BANK_ZIP_INVALID", "ZIP codec exceeded its resource limit or failed")));
        worker.once("exit", code => { if (code !== 0) reject(new AppError("LOCAL_BANK_ZIP_INVALID", "ZIP codec stopped before completing")); });
      });
    } finally { clearTimeout(timer); await worker.terminate(); }
  });
  pending = operation.catch(() => {}); return operation;
}
