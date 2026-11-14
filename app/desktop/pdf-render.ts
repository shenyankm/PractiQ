import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { invariant } from "./errors.js";
import { runPreparation } from "./preparation.js";
import { pdfFonts } from "./pdf-fonts.js";

export interface PdfRenderLimits { maxPages: number; maxPixels: number; maxBytes: number; timeoutMs: number }
export const PDF_RENDER_LIMITS: PdfRenderLimits = { maxPages: 300, maxPixels: 25_000_000, maxBytes: 50 * 1024 * 1024, timeoutMs: 120_000 };
export interface RenderedPdf { images: Buffer[]; dimensions: { width: number; height: number }[]; engine: { version: 1; packageVersion: string; wasmSha256: string; fontsSha256: string; policy: PdfRenderLimits } }
const resources = new URL(import.meta.url.endsWith(".ts") ? "../.build/electron/app/desktop/" : "./", import.meta.url);
export function pdfEngineIdentity(limits: PdfRenderLimits = PDF_RENDER_LIMITS): RenderedPdf["engine"] {
  const metadata = JSON.parse(readFileSync(new URL("resources/pdfium-engine.json", resources), "utf8"));
  invariant(metadata.version === 1 && Object.keys(metadata).length === 3 && typeof metadata.packageVersion === "string" && /^[a-f0-9]{64}$/.test(metadata.wasmSha256), "PDF_ENGINE_INVALID", "Invalid PDF engine identity");
  return { ...metadata, fontsSha256: pdfFonts().digest, policy: { ...limits } };
}

/** Serialize expensive preparation; a cancelled worker must exit before the next enters. */
export async function renderPdf(bytes: Uint8Array | (() => Uint8Array), signal: AbortSignal, limits: PdfRenderLimits = PDF_RENDER_LIMITS): Promise<RenderedPdf> {
  signal.throwIfAborted();
  invariant(typeof bytes === "function" || bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 150 * 1024 * 1024, "DOCUMENT_PROCESSING_FAILED", "Invalid PDF source size");
  invariant(Object.keys(limits).length === 4 && Object.entries(PDF_RENDER_LIMITS).every(([key, maximum]) => Number.isSafeInteger(limits[key as keyof PdfRenderLimits]) && limits[key as keyof PdfRenderLimits] > 0 && limits[key as keyof PdfRenderLimits] <= maximum), "PDF_ENGINE_INVALID", "Invalid PDF rendering limits");
  let engine: RenderedPdf["engine"];
  return runPreparation(signal, limits.timeoutMs, { failed: "PDF_PROCESSING_FAILED", timeout: "PDF_PROCESSING_TIMEOUT" }, () => {
    const metadata = JSON.parse(readFileSync(new URL("resources/pdfium-engine.json", resources), "utf8"));
    invariant(metadata.version === 1 && Object.keys(metadata).length === 3 && typeof metadata.packageVersion === "string" && /^[a-f0-9]{64}$/.test(metadata.wasmSha256), "PDF_ENGINE_INVALID", "Invalid PDF engine identity");
    const input = typeof bytes === "function" ? bytes() : bytes; invariant(input instanceof Uint8Array && input.length > 0 && input.length <= 150 * 1024 * 1024, "DOCUMENT_PROCESSING_FAILED", "Invalid PDF source size");
    const fonts = pdfFonts(), source = Uint8Array.from(input); engine = { ...metadata, fontsSha256: fonts.digest, policy: { ...limits } };
    return new Worker(new URL("pdf-worker.js", resources), { workerData: { bytes: source, fonts: fonts.fonts, ...metadata, ...limits }, transferList: [source.buffer], execArgv: [], env: {}, trackUnmanagedFds: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  }, value => {
    const result = value as { images?: Uint8Array[]; dimensions?: RenderedPdf["dimensions"] };
    invariant(result && Array.isArray(result.images) && Array.isArray(result.dimensions) && result.images.length > 0 && result.images.length <= limits.maxPages && result.images.length === result.dimensions.length, "PDF_PROCESSING_FAILED", "Invalid PDF worker result");
    let total = 0;
    result.images.forEach((image, index) => { const size = result.dimensions![index]; invariant(image instanceof Uint8Array && image.length > 0 && image.length <= 25 * 1024 * 1024 && (total += image.length) <= limits.maxBytes && size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width > 0 && size.height > 0 && size.width <= 16384 && size.height <= 16384 && size.width * size.height <= limits.maxPixels, "PDF_PROCESSING_FAILED", "Invalid PDF worker image"); });
    signal.throwIfAborted(); return { images: result.images.map(image => Buffer.from(image)), dimensions: result.dimensions, engine };
  });
}
