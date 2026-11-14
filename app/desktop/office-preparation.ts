import { Worker } from "node:worker_threads";
import { invariant } from "./errors.js";
import { runPreparation } from "./preparation.js";

export interface OfficeVisibility { bytes: Buffer; sheets: string[]; slides: string[]; unchanged: boolean }
export async function officePreparation(read: () => Buffer, type: string, maxParts: number, signal: AbortSignal): Promise<OfficeVisibility> {
  signal.throwIfAborted(); invariant(["xlsx", "pptx", "ppt"].includes(type) && Number.isSafeInteger(maxParts) && maxParts > 0 && maxParts <= 300, "OFFICE_INPUT_INVALID", "Invalid Office visibility input"); let original: Buffer;
  return runPreparation(signal, 180000, { failed: "OFFICE_INPUT_INVALID", timeout: "OFFICE_TIMEOUT" }, () => {
    original = read(); invariant(original.length > 0 && original.length <= 25 * 1024 * 1024, "OFFICE_OUTPUT_LIMIT", "Office source exceeds the shared limit"); const bytes = Uint8Array.from(original);
    return new Worker(new URL(import.meta.url.endsWith(".ts") ? "../.build/electron/app/desktop/preparation-worker.js" : "./preparation-worker.js", import.meta.url), { workerData: { type: "office", bytes, sourceType: type, maxParts }, transferList: [bytes.buffer], env: {}, execArgv: [], trackUnmanagedFds: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
  }, value => {
    const result = value as OfficeVisibility; invariant(result && Object.keys(result).length === 3 && result.bytes instanceof Uint8Array && result.bytes.length > 0 && result.bytes.length <= 25 * 1024 * 1024 && [result.sheets, result.slides].every(items => Array.isArray(items) && items.length <= maxParts && items.every(item => typeof item === "string" && item.length <= 2048)), "OFFICE_INPUT_INVALID", "Invalid Office preparation result");
    const bytes = Buffer.from(result.bytes); return { bytes, sheets: result.sheets, slides: result.slides, unchanged: bytes.equals(original) };
  });
}
