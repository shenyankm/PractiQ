import sharp from "sharp";
import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import type { PixelBounds } from "./image-inputs.js";
import { prepareImage } from "./image-preparation.js";
import { pdfEngineIdentity, renderPdf } from "./pdf-render.js";
import { canonical } from "./questions.js";
import { recognizePages } from "./recognized-pages.js";
import { TencentResults } from "./tencent-results.js";
import type { RecognizedText, TextInputLimits } from "./text-documents.js";
import { PAGE_SELECTION_WARNING, sourceIndexes } from "./source-selection.js";

export interface RasterPart { reference: ArtifactReference; sourcePage: number; pixelBounds: PixelBounds; originalPageRef: ArtifactReference }
interface RasterPlan { version: 1; taskId: string; source: DocumentReference; policy: TextInputLimits; engine: unknown; pages: { reference: ArtifactReference; width: number; height: number }[]; parts: RasterPart[] }
export type RecognizedRaster = Omit<RecognizedText, "version" | "inputParts"> & { version: 2; inputParts: RasterPart[]; pageRefs: ArtifactReference[]; prepareManifest: ArtifactReference };
const visualLimit = 50 * 1024 * 1024;
const engine = (type: string) => type === "pdf" ? { kind: "pdfium", ...pdfEngineIdentity() } : { kind: "sharp", versions: sharp.versions };
export class RasterDocuments {
  constructor(readonly storage: AiStorage, readonly results: TencentResults, readonly limits: TextInputLimits) {}
  private verify(value: unknown, context: DocumentStageContext): RasterPlan {
    const plan = value as RasterPlan, source = context.task.input.document, prefix = `practiq-agent/artifacts/${source.sha256}/`;
    invariant(plan && Object.keys(plan).length === 7 && ["version", "taskId", "source", "policy", "engine", "pages", "parts"].every(key => Object.hasOwn(plan, key)) && plan.version === 1 && plan.taskId === context.task.id && canonical(plan.source) === canonical(source) && canonical(plan.policy) === canonical(this.limits) && canonical(plan.engine) === canonical(engine(source.sourceType)) && Array.isArray(plan.pages) && plan.pages.length > 0 && plan.pages.length <= this.limits.maxParts && Array.isArray(plan.parts) && plan.parts.length <= this.limits.maxParts, "TENCENT_INPUTS_INVALID", "Raster preparation belongs to another source, engine or policy");
    let total = 0;
    for (const [index, page] of plan.pages.entries()) {
      invariant(page && Object.keys(page).length === 3 && Number.isSafeInteger(page.width) && Number.isSafeInteger(page.height) && page.width > 0 && page.height > 0 && page.width <= 16384 && page.height <= 16384 && page.width * page.height <= 25_000_000 && page.reference?.objectKey.startsWith(`${prefix}source-page/${index}-`) && ["image/png", "image/jpeg"].includes(page.reference.mediaType), "TENCENT_INPUTS_INVALID", "Invalid immutable source page");
      total += this.storage.artifact(page.reference).length; invariant(total <= visualLimit, "TENCENT_SOURCE_TOO_LARGE", "Source pages exceed the shared visual byte limit");
    }
    if (source.sourceType === "image") invariant(plan.pages.length === 1 && plan.pages[0].reference.sha256 === source.sha256 && plan.pages[0].reference.mediaType === source.mediaType, "TENCENT_INPUTS_INVALID", "Image page must retain the immutable original bytes");
    const split = source.sizeBytes > this.limits.inputBytes; invariant(Boolean(plan.parts.length) === split, "TENCENT_INPUTS_INVALID", "Raster split policy changed"); total = 0;
    for (const [index, part] of plan.parts.entries()) {
      const page = plan.pages[part?.sourcePage], box = part?.pixelBounds;
      invariant(part && Object.keys(part).length === 4 && Number.isSafeInteger(part.sourcePage) && page && canonical(part.originalPageRef) === canonical(page.reference) && part.reference?.objectKey.startsWith(`${prefix}ocr-input/${index}-`) && part.reference.mediaType === "image/png" && part.reference.sizeBytes > 0 && part.reference.sizeBytes <= this.limits.inputBytes && Array.isArray(box) && box.length === 4 && box.every(Number.isSafeInteger) && box[0] >= 0 && box[1] >= 0 && box[0] < box[2] && box[1] < box[3] && box[2] <= page.width && box[3] <= page.height && (!index || part.sourcePage >= plan.parts[index - 1].sourcePage), "TENCENT_INPUTS_INVALID", "Invalid ordered raster input or source bounds");
      total += this.storage.artifact(part.reference).length; invariant(total <= visualLimit, "TENCENT_SOURCE_TOO_LARGE", "Raster inputs exceed the shared visual byte limit");
      for (const previous of plan.parts.slice(0, index)) if (previous.sourcePage === part.sourcePage) invariant(Math.max(box[0], previous.pixelBounds[0]) >= Math.min(box[2], previous.pixelBounds[2]) || Math.max(box[1], previous.pixelBounds[1]) >= Math.min(box[3], previous.pixelBounds[3]), "TENCENT_INPUTS_INVALID", "Raster source ranges overlap");
    }
    if (split) for (const [index, page] of plan.pages.entries()) invariant(plan.parts.filter(part => part.sourcePage === index).reduce((area, part) => area + (part.pixelBounds[2] - part.pixelBounds[0]) * (part.pixelBounds[3] - part.pixelBounds[1]), 0) === page.width * page.height, "TENCENT_INPUTS_INVALID", "Raster source ranges omit pixels");
    return plan;
  }
  async prepare(context: DocumentStageContext): Promise<DocumentStageOutput> {
    context.execution.guard(); const source = context.task.input.document;
    invariant(["pdf", "image"].includes(source.sourceType), "DOCUMENT_SOURCE_TYPE_MISMATCH", "Raster stages require a PDF or image"); const namespace = ["document_tasks", context.task.id, "tencent_inputs"], saved = await context.store.get(namespace, "source");
    let plan: RasterPlan, manifest: ArtifactReference;
    if (saved) {
      this.storage.source(source);
      invariant(Object.keys(saved.value).length === 1, "TENCENT_INPUTS_INVALID", "Invalid raster preparation receipt"); manifest = saved.value.manifest as ArtifactReference;
      invariant(manifest?.mediaType === "application/json" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${source.sha256}/tencent-inputs/`), "TENCENT_INPUTS_INVALID", "Invalid raster preparation reference"); plan = this.verify(parseJson(this.storage.artifact(manifest)), context);
    } else {
      const rendered = source.sourceType === "pdf" ? await renderPdf(() => this.storage.source(source), context.signal) : null;
      const raw = rendered ? rendered.images.map(bytes => () => bytes) : [() => { const bytes = this.storage.source(source); invariant((bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" : "image/jpeg") === source.mediaType, "IMAGE_FORMAT_UNSUPPORTED", "Image source differs from its declared media type"); return bytes; }], prepared = [];
      let total = 0, remainingParts = this.limits.maxParts, tileBytes = 0;
      for (const [index, image] of raw.entries()) { context.execution.guard(); const length = rendered ? rendered.images[index].length : source.sizeBytes; total += length; invariant(total <= visualLimit, "TENCENT_SOURCE_TOO_LARGE", "Source pages exceed the shared visual byte limit"); const result = await prepareImage(image, context.signal, { inputBytes: source.sizeBytes > this.limits.inputBytes ? this.limits.inputBytes : Math.max(this.limits.inputBytes, length), maxParts: remainingParts, maxBytes: visualLimit - tileBytes }); prepared.push(result); remainingParts -= result.parts.length; tileBytes += result.parts.reduce((sum, part) => sum + part.bytes.length, 0); }
      const pages: RasterPlan["pages"] = [], parts: RasterPart[] = [];
      for (const [index, result] of prepared.entries()) { context.execution.guard(); const reference = await this.storage.putArtifact(raw[index](), source.sha256, "source-page", index, source.sourceType === "image" ? source.mediaType : "image/png"); pages.push({ reference, width: result.width, height: result.height }); }
      if (source.sizeBytes > this.limits.inputBytes) for (const [sourcePage, result] of prepared.entries()) for (const part of result.parts) { context.execution.guard(); const reference = await this.storage.putArtifact(part.bytes, source.sha256, "ocr-input", parts.length, part.mediaType); parts.push({ reference, sourcePage, pixelBounds: part.bounds, originalPageRef: pages[sourcePage].reference }); }
      plan = { version: 1, taskId: context.task.id, source, policy: { ...this.limits }, engine: rendered ? { kind: "pdfium", ...rendered.engine } : engine(source.sourceType), pages, parts }; this.verify(plan, context);
      manifest = await this.storage.putArtifact(Buffer.from(executionJson(plan)), source.sha256, "tencent-inputs", 0, "application/json"); context.execution.guard(); await context.store.update(namespace, "source", previous => { invariant(previous === null || canonical(previous) === canonical({ manifest }), "TENCENT_INPUTS_INVALID", "Raster preparation changed before its receipt committed"); return { manifest }; });
    }
    sourceIndexes(context.task, "vision_parse", plan.parts.length || plan.pages.length, plan.parts);
    return { manifest, artifacts: [manifest, ...plan.pages.map(page => page.reference), ...plan.parts.map(part => part.reference)] };
  }
  async recognize(context: DocumentStageContext): Promise<DocumentStageOutput> {
    context.execution.guard(); const source = context.task.input.document, stage = context.task.outputs.prepare, manifest = stage?.manifest;
    invariant(manifest && stage.artifacts.some(reference => canonical(reference) === canonical(manifest)), "TENCENT_INPUTS_INVALID", "Raster recognition requires its completed preparation"); this.storage.source(source);
    const saved = await context.store.get(["document_tasks", context.task.id, "tencent_inputs"], "source"); invariant(saved && canonical(saved.value) === canonical({ manifest }), "TENCENT_INPUTS_INVALID", "Raster preparation differs from its durable receipt");
    const plan = this.verify(parseJson(this.storage.artifact(manifest)), context), submissions = plan.parts.length ? plan.parts.map(part => ({ reference: part.reference as ArtifactReference | DocumentReference, sourceType: "image" as const, count: 1 })) : [{ reference: source, sourceType: source.sourceType as "pdf" | "image", count: plan.pages.length }];
    for (const reference of [...plan.pages.map(page => page.reference), ...plan.parts.map(part => part.reference)]) invariant(stage.artifacts.some(owned => canonical(owned) === canonical(reference)), "TENCENT_INPUTS_INVALID", "Raster input is not owned by the preparation stage");
    const { ocrPageRefs, artifacts, truncated } = await recognizePages(this.storage, this.results, context, submissions, this.limits);
    const warnings = [...(plan.parts.length ? ["Oversized source was split into ordered Tencent inputs; review content across part boundaries."] : []), ...(truncated ? ["Tencent parsing contains failed or missing pages; retain human review."] : [])], pageRefs = plan.parts.length ? plan.parts.map(part => part.reference) : plan.pages.map(page => page.reference);
    if (context.task.input.pages) warnings.push(PAGE_SELECTION_WARNING);
    const recognized: RecognizedRaster = { version: 2, source, textRef: null, ocrPageRefs, inputParts: plan.parts, warnings, truncated, chunkManifest: null, pageRefs, prepareManifest: manifest }, result = await this.storage.putArtifact(Buffer.from(executionJson(recognized)), source.sha256, "recognized-text", 0, "application/json"); context.execution.guard();
    return { manifest: result, artifacts: [result, ...stage.artifacts, ...artifacts] };
  }
}
