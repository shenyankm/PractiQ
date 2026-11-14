import { parentPort, workerData } from "node:worker_threads";
import { AppError, invariant } from "./errors.js";
import { visibleWorkbook } from "./office-workbook.js";
import { visibleSlides } from "./office-slides.js";
import { visibleLegacySlides } from "./office-legacy-slides.js";
import { imageInputs } from "./image-inputs.js";
import { checkedCropFigures } from "./vision-crops.js";
import { qrListeningLinks } from "./listening-qr.js";

globalThis.fetch = async () => { throw new Error("Document preparation cannot access the network"); };
async function run() {
  invariant(workerData && workerData.bytes instanceof Uint8Array, "DOCUMENT_PROCESSING_FAILED", "Invalid preparation request"); const source = Buffer.from(workerData.bytes), signal = new AbortController().signal;
  if (workerData.type === "image") return imageInputs(source, signal, workerData.limits);
  if (workerData.type === "crops") return checkedCropFigures(source, workerData.boxes, workerData.kinds, signal);
  if (workerData.type === "listening-qr") return qrListeningLinks(source);
  invariant(workerData.type === "office", "OFFICE_INPUT_INVALID", "Invalid visibility preparation request");
  if (workerData.sourceType === "xlsx") return { ...await visibleWorkbook(source, workerData.maxParts, signal), slides: [] };
  if (workerData.sourceType === "pptx") return { ...await visibleSlides(source, workerData.maxParts, signal), sheets: [] };
  if (workerData.sourceType === "ppt") return { ...visibleLegacySlides(source, workerData.maxParts, signal), sheets: [] };
  throw new AppError("OFFICE_INPUT_INVALID", "Unsupported visibility metadata");
}
void run().then(value => parentPort!.postMessage(value)).catch(error => parentPort!.postMessage({ error: error instanceof AppError ? error.code : "DOCUMENT_PROCESSING_FAILED" }));
