import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { PDFiumModule } from "@hyzyla/pdfium";
import sharp from "sharp";
import { hash } from "./assets.js";
import { AppError, invariant } from "./errors.js";
import { mountPdfFonts, type PdfFilesystem, type PdfFont } from "./pdf-fonts.js";
import { boundWasmMemory } from "./wasm-memory.js";

interface Input { bytes: Uint8Array; fonts: PdfFont[]; wasmSha256: string; maxPages: number; maxPixels: number; maxBytes: number }
const port = parentPort!, input = workerData as Input;
globalThis.fetch = async () => { throw new Error("PDF rendering cannot access the network"); };
async function run() {
  const wasm = readFileSync(new URL("./resources/pdfium.wasm", import.meta.url)); invariant(hash(wasm) === input.wasmSha256, "PDF_ENGINE_CHANGED", "PDF engine binary changed");
  const options = { wasmBinary: boundWasmMemory(wasm), print: () => {}, printErr: () => {} };
  const module = await PDFiumModule(options), sdk = module as unknown as Omit<typeof module, "_FPDF_InitLibraryWithConfig"> & { _FPDF_InitLibraryWithConfig(pointer: number): void; FS: PdfFilesystem }, pointers: number[] = [];
  const closeFonts = mountPdfFonts(sdk.FS, input.fonts); let document = 0, initialized = false;
  const allocate = (size: number) => { const pointer = sdk.wasmExports.malloc(size); invariant(pointer > 0, "PDF_MEMORY_LIMIT", "PDF engine memory limit reached"); pointers.push(pointer); return pointer; };
  try {
    const path = allocate(8), paths = allocate(8), config = allocate(24); sdk.HEAPU8.set(Buffer.from("/fonts\0"), path); sdk.HEAP32.set([path, 0], paths >> 2); sdk.HEAP32.set([2, paths, 0, 0, 0, 0], config >> 2);
    sdk._FPDF_InitLibraryWithConfig(config); initialized = true;
    const source = allocate(input.bytes.length); sdk.HEAPU8.set(input.bytes, source); document = sdk._FPDF_LoadMemDocument(source, input.bytes.length, 0); invariant(document, "PDF_PROCESSING_FAILED", "PDF cannot be opened or requires a password");
    const count = sdk._FPDF_GetPageCount(document); invariant(count > 0 && count <= input.maxPages, "PDF_PAGE_LIMIT_EXCEEDED", "PDF exceeds the page limit");
    const dimensions = [];
    for (let index = 0; index < count; index++) { const page = sdk._FPDF_LoadPage(document, index); invariant(page, "PDF_PROCESSING_FAILED", "PDF page cannot be opened"); try { const width = Math.ceil(sdk._FPDF_GetPageWidth(page) * 200 / 72), height = Math.ceil(sdk._FPDF_GetPageHeight(page) * 200 / 72); invariant(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= input.maxPixels, "IMAGE_TOO_LARGE", "PDF page exceeds the dimension or pixel limit"); dimensions.push({ width, height }); } finally { sdk._FPDF_ClosePage(page); } }
    let images: Buffer[] = [];
    for (const compressionLevel of [3, 6]) {
      images = []; let total = 0, overflow = false;
      for (let index = 0; index < count; index++) {
        const { width, height } = dimensions[index], page = sdk._FPDF_LoadPage(document, index), pixels = sdk.wasmExports.malloc(width * height * 4); let bitmap = 0;
        try { invariant(page && pixels, "PDF_MEMORY_LIMIT", "PDF engine memory limit reached"); bitmap = sdk._FPDFBitmap_CreateEx(width, height, 4, pixels, width * 4); invariant(bitmap, "PDF_MEMORY_LIMIT", "PDF bitmap allocation failed"); sdk._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff); sdk._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 17);
          const bytes = await sharp(sdk.HEAPU8.slice(pixels, pixels + width * height * 4), { raw: { width, height, channels: 4 } }).removeAlpha().png({ compressionLevel }).toBuffer(); total += bytes.length; if (bytes.length > 25 * 1024 * 1024 || total > input.maxBytes) { overflow = true; break; } images.push(bytes);
        } finally { if (bitmap) sdk._FPDFBitmap_Destroy(bitmap); if (pixels) sdk.wasmExports.free(pixels); if (page) sdk._FPDF_ClosePage(page); }
      }
      if (!overflow) { port.postMessage({ images, dimensions }); return; }
    }
    throw new AppError("IMAGE_TOO_LARGE", "Rendered PDF pages exceed the asset or visual byte limit");
  } finally { if (document) sdk._FPDF_CloseDocument(document); if (initialized) sdk._FPDF_DestroyLibrary(); closeFonts(); for (const pointer of pointers.reverse()) sdk.wasmExports.free(pointer); }
}
run().catch(error => { port.postMessage({ error: error instanceof AppError ? error.code : "PDF_PROCESSING_FAILED" }); });
