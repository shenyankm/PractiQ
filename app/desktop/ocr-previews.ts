import type { StructuredInput } from "./model.js";
import { AiStorage } from "./ai-storage.js";
import type { StoredOcrPage } from "./ocr-inputs.js";
import { validateImage } from "./media.js";

import { MAX_CROPS, MAX_CROP_BYTES } from "./vision-crops.js";
import { prepareCrops } from "./image-preparation.js";
export { MAX_CROPS as MAX_OCR_PREVIEWS, MAX_CROP_BYTES as MAX_OCR_PREVIEW_BYTES } from "./vision-crops.js";
/** Preview compression never changes the immutable source or its authoritative bounds. */
export async function ocrPreviews(storage: AiStorage, page: StoredOcrPage, signal?: AbortSignal): Promise<NonNullable<StructuredInput["images"]>> {
  signal?.throwIfAborted();
  if ("failed" in page) return [];
  const previews: NonNullable<StructuredInput["images"]> = [];
  for (const figure of page.figures.slice(0, MAX_CROPS)) {
    signal?.throwIfAborted();
    if (!figure.imageRef) continue;
    let bytes = storage.artifact(figure.imageRef), mediaType = figure.imageRef.mediaType as "image/png" | "image/jpeg"; await validateImage(bytes, mediaType);
    if (bytes.length > MAX_CROP_BYTES) {
      const crop = (await prepareCrops(() => bytes, [[0, 0, 1, 1]], [null], signal))[0].bytes;
      if (!crop) continue; bytes = crop; mediaType = "image/jpeg";
    }
    signal?.throwIfAborted();
    if (bytes.length) previews.push({ bytes, mediaType, label: `Fixed Tencent PRIMARY figure elementIndex=${figure.elementIndex}. Use this crop only to classify and describe that figure. Question starts and text come from OCR. Do not invent coordinates, questions or associations; unassociated document figures keep questionIndexes=[].` });
  }
  return previews;
}
