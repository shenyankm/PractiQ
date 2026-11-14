import { ASSET_LIMIT } from "./assets.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { list, object, text } from "./question-contract.js";
import { canonical } from "./questions.js";
import { safeZipName } from "./zip.js";

export const BANK_RESOURCE_LIMIT = 256 * 1024 * 1024, BANK_RESOURCE_COUNT_LIMIT = 2000;
export function resourceReferences(root: unknown): Map<string, Record<string, unknown>> {
  const result = object(object(root).result ?? root), references = new Map<string, Record<string, unknown>>();
  const values = [...list(result, "visualElements").flatMap(value => [object(value).imageRef, object(value).sourceRef]), ...list(result, "questions").map(value => object(value).audioRef)];
  for (const value of values) if (value != null) {
    const reference = object(value), key = text(reference, "objectKey"), name = `resources/${key}`;
    invariant(safeZipName(key), "LOCAL_BANK_ZIP_INVALID", "Unsafe resource path");
    invariant(!references.has(name) || canonical(references.get(name)) === canonical(reference), "LOCAL_BANK_ZIP_INVALID", "Conflicting resource references");
    references.set(name, reference);
  }
  return references;
}
export function bankResourcePlan(root: unknown): Map<string, Record<string, unknown>> {
  const references = resourceReferences(root); let total = 0;
  invariant(references.size <= BANK_RESOURCE_COUNT_LIMIT, "BANK_EXPORT_TOO_LARGE", "Bank has too many resources");
  for (const reference of references.values()) {
    validateContract("ArtifactReference", reference);
    invariant(["image/png", "image/jpeg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav"].includes(text(reference, "mediaType")), "BANK_EXPORT_INVALID", "Unsupported bank resource media type");
    invariant(Number(reference.sizeBytes) > 0 && Number(reference.sizeBytes) <= ASSET_LIMIT, "BANK_EXPORT_TOO_LARGE", "Bank resource exceeds its size limit");
    total += Number(reference.sizeBytes); invariant(total <= BANK_RESOURCE_LIMIT, "BANK_EXPORT_TOO_LARGE", "Bank resources exceed their total size limit");
  }
  return references;
}
