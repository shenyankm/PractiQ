import { Worker } from "node:worker_threads";
import { invariant } from "./errors.js";
import type { ImageInputs, ImageInputLimits } from "./image-inputs.js";
import { runPreparation } from "./preparation.js";
import { MAX_CROPS, MAX_CROP_BYTES } from "./vision-crops.js";
import { playbackAddress } from "../../shared/listening.js";
import type { ListeningLink } from "./listening-web.js";
import { validateContract } from "./contracts.js";

const helper = (input: Record<string, unknown>, source: () => Uint8Array) => {
  const bytes = Uint8Array.from(source()); invariant(bytes.length > 0 && bytes.length <= 150 * 1024 * 1024, "IMAGE_FORMAT_UNSUPPORTED", "Invalid image source size");
  return new Worker(new URL(import.meta.url.endsWith(".ts") ? "../.build/electron/app/desktop/preparation-worker.js" : "./preparation-worker.js", import.meta.url), { workerData: { ...input, bytes }, transferList: [bytes.buffer], env: {}, execArgv: [], trackUnmanagedFds: true, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
};
export function prepareImage(source: () => Uint8Array, signal: AbortSignal, limits: ImageInputLimits): Promise<ImageInputs> {
  return runPreparation(signal, 120000, { failed: "IMAGE_FORMAT_UNSUPPORTED", timeout: "IMAGE_PROCESSING_TIMEOUT" }, () => helper({ type: "image", limits }, source), value => {
    const result = value as ImageInputs; invariant(result && Object.keys(result).length === 3 && Number.isSafeInteger(result.width) && Number.isSafeInteger(result.height) && result.width > 0 && result.height > 0 && result.width <= 16384 && result.height <= 16384 && result.width * result.height <= 25_000_000 && Array.isArray(result.parts) && result.parts.length > 0 && result.parts.length <= limits.maxParts, "IMAGE_FORMAT_UNSUPPORTED", "Invalid image preparation result"); let total = 0, area = 0;
    const parts = result.parts.map(part => { const box = part?.bounds; invariant(part && Object.keys(part).length === 3 && part.bytes instanceof Uint8Array && part.bytes.length > 0 && (total += part.bytes.length) <= limits.maxBytes && part.bytes.length <= limits.inputBytes && ["image/png", "image/jpeg"].includes(part.mediaType) && Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[0] >= 0 && box[1] >= 0 && box[2] <= result.width && box[3] <= result.height && box[2] > box[0] && box[3] > box[1], "IMAGE_FORMAT_UNSUPPORTED", "Invalid image part or bounds"); area += (box[2] - box[0]) * (box[3] - box[1]); return { ...part, bytes: Buffer.from(part.bytes) }; });
    invariant(area === result.width * result.height, "IMAGE_FORMAT_UNSUPPORTED", "Image parts omit source pixels"); return { width: result.width, height: result.height, parts };
  });
}
export function prepareCrops(source: () => Uint8Array, boxes: number[][], kinds: (string | null)[], signal?: AbortSignal): Promise<{ bytes: Buffer | null; rejected: boolean }[]> {
  invariant(boxes.length === kinds.length && boxes.length <= MAX_CROPS, "CROP_FAILED", "Crop batch exceeds its limit");
  return runPreparation(signal, 120000, { failed: "CROP_FAILED", timeout: "CROP_FAILED" }, () => helper({ type: "crops", boxes, kinds }, source), value => {
    invariant(Array.isArray(value) && value.length === boxes.length, "CROP_FAILED", "Invalid crop preparation result"); let total = 0;
    return value.map(item => { invariant(item && Object.keys(item).length === 2 && typeof item.rejected === "boolean" && (item.bytes === null || item.bytes instanceof Uint8Array && item.bytes.length > 0 && item.bytes.length <= MAX_CROP_BYTES && (total += item.bytes.length) <= MAX_CROPS * MAX_CROP_BYTES) && (!item.rejected || item.bytes === null), "CROP_FAILED", "Invalid crop bytes or rejection"); return { bytes: item.bytes === null ? null : Buffer.from(item.bytes), rejected: item.rejected }; });
  });
}
export function prepareListeningQr(source: () => Uint8Array, signal?: AbortSignal): Promise<ListeningLink[]> {
  return runPreparation(signal, 15000, { failed: "LOCAL_AUDIO_QR_INVALID", timeout: "LOCAL_AUDIO_QR_INVALID" }, () => helper({ type: "listening-qr" }, () => {
    const bytes = source(); invariant(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024, "LOCAL_AUDIO_QR_INVALID", "Invalid QR image size"); return bytes;
  }), value => {
    invariant(Array.isArray(value) && value.length > 0 && value.length <= 50, "LOCAL_AUDIO_QR_INVALID", "Invalid QR address list");
    for (const link of value) { validateContract("DesktopListeningLink", link); invariant(playbackAddress(link.url) === link.url, "LOCAL_AUDIO_QR_INVALID", "Invalid QR address"); }
    return value;
  });
}
