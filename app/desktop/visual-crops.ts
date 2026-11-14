import type { ArtifactReference, UnitFailure, VisualElement } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { validateContract } from "./contracts.js";
import type { CropResult } from "./ocr-assembly.js";
import { SourceText } from "./source-text.js";
import { MAX_CROPS } from "./vision-crops.js";
import { prepareCrops } from "./image-preparation.js";

/** A provider subimage never certifies expanded bounds; retain full-page evidence independently. */
export async function cropVisuals(storage: AiStorage, sourceSha: string, input: VisualElement[], pages: Map<number, ArtifactReference>, sourceType: string, signal?: AbortSignal): Promise<CropResult> {
  signal?.throwIfAborted(); pages = new Map([...pages].filter(([, reference]) => ["image/png", "image/jpeg"].includes(reference.mediaType))); const visuals = structuredClone(input).slice(0, 1000); let truncated = input.length > 1000;
  for (const visual of visuals) { validateContract("VisualElement", visual); if (visual.page != null && pages.has(visual.page)) visual.sourceRef = pages.get(visual.page)!; if (visual.cropBbox != null) visual.imageRef = null; }
  const candidates = visuals.flatMap((visual, index) => visual.page != null && visual.bbox != null && visual.imageRef == null ? [{ index, page: visual.page, bbox: visual.cropBbox ?? visual.bbox }] : []), selected = candidates.slice(0, MAX_CROPS); truncated ||= candidates.length > MAX_CROPS;
  const byPage = new Map<number, typeof selected>(); for (const item of selected) byPage.set(item.page, [...byPage.get(item.page) ?? [], item]);
  const failures: UnitFailure[] = [];
  for (const [page, items] of byPage) {
    signal?.throwIfAborted(); const reference = pages.get(page), crops = reference ? await prepareCrops(() => storage.artifact(reference), items.map(item => item.bbox), items.map(item => visuals[item.index].kind ?? null), signal) : items.map(() => ({ bytes: null, rejected: false }));
    for (const [index, crop] of crops.entries()) {
      signal?.throwIfAborted(); const item = items[index], visual = visuals[item.index];
      if (crop.bytes) { visual.imageRef = await storage.putArtifact(crop.bytes, sourceSha, `crop-${page}`, item.index, "image/jpeg"); if (sourceType === "pdf") { const description = new SourceText("[page crop] " + visual.description); visual.description = description.slice(0, Math.min(description.length, 20000)); } }
      else failures.push({ stage: "visual_crop", index: item.index, code: crop.rejected ? "CROP_UNVERIFIED" : "CROP_FAILED", retryable: false });
    }
  }
  return { visuals, failures, truncated, limit: MAX_CROPS };
}
