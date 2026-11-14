import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { hash } from "./assets.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { canonical } from "./questions.js";
import { TENCENT_BASE64_LIMIT } from "./tencent.js";
import { jsonSize, type TencentPage } from "./tencent-bundle.js";
import { TencentResults } from "./tencent-results.js";
import { ChunkInputs } from "./chunk-inputs.js";
import { RasterDocuments } from "./raster-documents.js";
import { OfficeDocuments, officeSource } from "./office-documents.js";

export interface TextInputLimits { inputBytes: number; maxParts: number; maxChars: number }
const defaults: TextInputLimits = { inputBytes: TENCENT_BASE64_LIMIT, maxParts: 300, maxChars: 2_000_000 };
export interface TextPart { reference: ArtifactReference | DocumentReference; byteStart: number; byteEnd: number }
interface TextPlan { version: 1; taskId: string; source: DocumentReference; policy: TextInputLimits; parts: TextPart[] }
export interface RecognizedText {
  version: 1; source: DocumentReference; textRef: ArtifactReference | null; ocrPageRefs: ArtifactReference[];
  inputParts: TextPart[]; warnings: string[]; truncated: boolean; chunkManifest: ArtifactReference | null;
}
function utf8(payload: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(payload); }
  catch { throw new AppError("DOCUMENT_ENCODING_INVALID", "Text and Markdown sources must be UTF-8"); }
}

/** Preserve exact UTF-8 bytes, preferring the last complete newline within each bound. */
export function splitText(payload: Buffer, limit: number, maxParts: number): Buffer[] {
  invariant(Number.isSafeInteger(limit) && limit > 0 && Number.isSafeInteger(maxParts) && maxParts > 0 && maxParts <= 300, "TENCENT_SOURCE_TOO_LARGE", "Invalid text split limits");
  utf8(payload); const parts: Buffer[] = []; let start = 0;
  while (start < payload.length) {
    let end = Math.min(start + limit, payload.length);
    if (end < payload.length) {
      while ((payload[end] & 0xc0) === 0x80) end--;
      const newline = payload.lastIndexOf(10, end - 1); if (newline >= start && newline < end) end = newline + 1;
    }
    invariant(end > start && parts.length < maxParts, "TENCENT_SOURCE_TOO_LARGE", "Text cannot be split within the character or part limit");
    parts.push(Buffer.from(payload.subarray(start, end))); start = end;
  } return parts;
}

/** These are real prepare/recognize graph stages; structuring still uses independent model units. */
export class TextDocuments {
  readonly limits: TextInputLimits;
  constructor(readonly storage: AiStorage, readonly results: TencentResults, limits: Partial<TextInputLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    invariant(Object.keys(this.limits).length === 3 && Number.isSafeInteger(this.limits.inputBytes) && this.limits.inputBytes >= 4 && this.limits.inputBytes <= TENCENT_BASE64_LIMIT && Number.isSafeInteger(this.limits.maxParts) && this.limits.maxParts >= 1 && this.limits.maxParts <= 300 && Number.isSafeInteger(this.limits.maxChars) && this.limits.maxChars > 0 && this.limits.maxChars <= defaults.maxChars, "TENCENT_SOURCE_TOO_LARGE", "Invalid text preparation limits");
  }
  private source(context: DocumentStageContext): { reference: DocumentReference; bytes: Buffer; text: string } {
    context.execution.guard(); const reference = context.task.input.document;
    invariant(["text", "markdown"].includes(reference.sourceType), "DOCUMENT_SOURCE_TYPE_MISMATCH", "Text stages only accept UTF-8 text or Markdown");
    invariant(reference.sizeBytes <= this.limits.maxChars * 4 + 3, "TENCENT_SOURCE_TOO_LARGE", "Text exceeds the shared document character limit");
    const bytes = this.storage.source(reference), text = utf8(bytes);
    invariant(!/^[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(text), "DOCUMENT_PROCESSING_FAILED", "Document contains no text");
    let chars = 0; for (const _char of text) chars++;
    invariant(chars <= this.limits.maxChars, "TENCENT_SOURCE_TOO_LARGE", "Text exceeds the shared document character limit"); return { reference, bytes, text };
  }
  private verify(input: unknown, context: DocumentStageContext, source: { reference: DocumentReference; bytes: Buffer }): TextPlan {
    const plan = input as TextPlan;
    invariant(plan !== null && typeof plan === "object" && Object.keys(plan).length === 5 && ["version", "taskId", "source", "policy", "parts"].every(key => Object.hasOwn(plan, key)) && plan.version === 1 && plan.taskId === context.task.id && canonical(plan.source) === canonical(source.reference) && canonical(plan.policy) === canonical(this.limits) && Array.isArray(plan.parts) && plan.parts.length > 0 && plan.parts.length <= this.limits.maxParts, "TENCENT_INPUTS_INVALID", "Saved text preparation belongs to another source or execution policy");
    const split = source.bytes.length > this.limits.inputBytes, expected = split ? splitText(source.bytes, this.limits.inputBytes, this.limits.maxParts) : [source.bytes];
    invariant(plan.parts.length === expected.length, "TENCENT_INPUTS_INVALID", "Saved text preparation omitted or added source parts"); let start = 0;
    plan.parts.forEach((part, index) => {
      invariant(part !== null && typeof part === "object" && Object.keys(part).length === 3 && ["reference", "byteStart", "byteEnd"].every(key => Object.hasOwn(part, key)) && part.byteStart === start && part.byteEnd === start + expected[index].length, "TENCENT_INPUTS_INVALID", "Saved text source ranges differ from the original");
      if (split) {
        invariant(part.reference?.mediaType === source.reference.mediaType && part.reference.sha256 === hash(expected[index]) && typeof part.reference.objectKey === "string" && part.reference.objectKey.startsWith(`practiq-agent/artifacts/${source.reference.sha256}/ocr-input/${index}-`), "TENCENT_INPUTS_INVALID", "Saved text part differs from its source range"); this.storage.artifact(part.reference);
      } else invariant(canonical(part.reference) === canonical(source.reference), "TENCENT_INPUTS_INVALID", "Unsplit text must retain its immutable original reference");
      start = part.byteEnd;
    }); return plan;
  }
  async prepare(context: DocumentStageContext): Promise<DocumentStageOutput> {
    if (officeSource(context.task.input.document.sourceType)) return new OfficeDocuments(this.storage, this.results, this.limits).prepare(context);
    if (["pdf", "image"].includes(context.task.input.document.sourceType)) return new RasterDocuments(this.storage, this.results, this.limits).prepare(context);
    const source = this.source(context), namespace = ["document_tasks", context.task.id, "tencent_inputs"], previous = await context.store.get(namespace, "source");
    let manifest: ArtifactReference, plan: TextPlan;
    if (previous) {
      const saved = previous.value;
      invariant(Object.keys(saved).length === 1 && Object.hasOwn(saved, "manifest"), "TENCENT_INPUTS_INVALID", "Saved text input receipt is invalid"); manifest = saved.manifest as ArtifactReference;
      invariant(manifest?.mediaType === "application/json" && typeof manifest.objectKey === "string" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${source.reference.sha256}/tencent-inputs/`), "TENCENT_INPUTS_INVALID", "Saved text manifest belongs to another source"); plan = this.verify(parseJson(this.storage.artifact(manifest)), context, source);
    } else {
      // Finish the complete bounded plan before writes or any provider work.
      const chunks = source.bytes.length > this.limits.inputBytes ? splitText(source.bytes, this.limits.inputBytes, this.limits.maxParts) : [source.bytes], parts: TextPart[] = []; let start = 0;
      for (const [index, bytes] of chunks.entries()) {
        context.execution.guard(); const reference = chunks.length === 1 && bytes.length === source.bytes.length ? source.reference : await this.storage.putArtifact(bytes, source.reference.sha256, "ocr-input", index, source.reference.mediaType);
        parts.push({ reference, byteStart: start, byteEnd: start + bytes.length }); start += bytes.length;
      }
      plan = { version: 1, taskId: context.task.id, source: source.reference, policy: { ...this.limits }, parts }; this.verify(plan, context, source);
      manifest = await this.storage.putArtifact(Buffer.from(executionJson(plan)), source.reference.sha256, "tencent-inputs", 0, "application/json"); context.execution.guard();
      await context.store.update(namespace, "source", previous => { invariant(previous === null || canonical(previous) === canonical({ manifest }), "TENCENT_INPUTS_INVALID", "Text preparation changed before its receipt committed"); return { manifest }; });
    }
    return { manifest, artifacts: [manifest, ...plan.parts.flatMap(part => part.reference.objectKey === source.reference.objectKey ? [] : [part.reference])] };
  }
  async recognize(context: DocumentStageContext): Promise<DocumentStageOutput> {
    if (officeSource(context.task.input.document.sourceType)) return new OfficeDocuments(this.storage, this.results, this.limits).recognize(context);
    if (["pdf", "image"].includes(context.task.input.document.sourceType)) return new RasterDocuments(this.storage, this.results, this.limits).recognize(context);
    const source = this.source(context), manifest = context.task.outputs.prepare?.manifest;
    invariant(manifest?.mediaType === "application/json" && typeof manifest.objectKey === "string" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${source.reference.sha256}/tencent-inputs/`), "TENCENT_INPUTS_INVALID", "Text recognition requires its completed source plan");
    const plan = this.verify(parseJson(this.storage.artifact(manifest)), context, source), controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
    const completed: { pages: TencentPage[]; record: Record<string, unknown> }[] = new Array(plan.parts.length), work = plan.parts.entries(); let firstError: unknown, stopped = false;
    const worker = async () => {
      try {
        for (const [index, part] of work) {
          if (stopped) return; context.execution.guard(); signal.throwIfAborted();
          const output = await this.results.open(context.task.id, `source-0-${index}`, part.reference, context.config, { sourceType: source.reference.sourceType as "text" | "markdown", pageCount: this.limits.maxParts, limits: { maxTotalInputChars: this.limits.maxChars } }, signal);
          try { completed[index] = { pages: structuredClone(output.bundle.pages), record: output.record }; } finally { output.bundle.close(); }
        }
      } catch (error) { if (!stopped) firstError = error; stopped = true; controller.abort(); }
    };
    await Promise.all(Array.from({ length: Math.min(plan.parts.length, context.config.preferences.import.tencentConcurrency) }, worker)); if (stopped) throw firstError;
    context.execution.guard(); const pages: (TencentPage | { page: number; failed: true })[] = [], archives: ArtifactReference[] = [], warnings: string[] = []; let truncated = false, chars = 0;
    for (const output of completed) {
      const count = Math.max(Number(output.record.successPageCount ?? 0) + Number(output.record.failedPageCount ?? 0), Math.max(...output.pages.map(page => page.page + 1), 0));
      invariant(pages.length + count <= this.limits.maxParts, "PDF_PAGE_LIMIT_EXCEEDED", "Tencent text recognition exceeds its page limit"); archives.push(output.record.resultRef as ArtifactReference);
      for (const page of output.pages) { chars += jsonSize(page, true); invariant(chars <= this.limits.maxChars, "TENCENT_RESULT_TOO_LARGE", "OCR evidence exceeds the shared document character limit"); }
      const byPage = new Map(output.pages.map(page => [page.page, page]));
      for (let index = 0; index < count; index++) { const page = byPage.get(index); pages.push(page ? { ...page, page: pages.length } : { failed: true, page: pages.length }); }
      truncated ||= Number(output.record.failedPageCount ?? 0) > 0 || output.pages.length !== count;
    }
    if (truncated) warnings.push("Tencent parsing contains failed or missing pages; retain human review.");
    const inputParts = plan.parts[0].reference.objectKey === source.reference.objectKey ? [] : plan.parts;
    if (inputParts.length) warnings.push("Oversized source was split into ordered Tencent inputs; review content across part boundaries.");
    const contents = pages.flatMap(page => "elements" in page ? page.elements.map(element => element.text_info !== null && typeof element.text_info === "object" ? (element.text_info as Record<string, unknown>).content : undefined) : [undefined]);
    const exact = !truncated && contents.length > 0 && contents.every(value => typeof value === "string") && !pages.some(page => "figures" in page && page.figures.length) && contents.join("") === source.text;
    const textRef = exact ? await this.storage.putArtifact(Buffer.from(source.text), source.reference.sha256, "text", 0, "text/plain") : null, ocrPageRefs: ArtifactReference[] = [];
    for (const [index, page] of pages.entries()) { context.execution.guard(); ocrPageRefs.push(await this.storage.putArtifact(Buffer.from(executionJson(page)), source.reference.sha256, "ocr-page", index, "application/json")); }
    if (!exact) { if (!truncated) warnings.push("Tencent text differs from the original; original-text source proofs are unavailable. Retain human review."); warnings.push("Full-page images are unavailable; review the original document and retained OCR evidence."); }
    const chunks = textRef ? await new ChunkInputs(this.storage).prepare(context, textRef, { complete: !truncated }) : null;
    const value: RecognizedText = { version: 1, source: source.reference, textRef, ocrPageRefs, inputParts, warnings, truncated, chunkManifest: chunks?.manifest ?? null }, result = await this.storage.putArtifact(Buffer.from(executionJson(value)), source.reference.sha256, "recognized-text", 0, "application/json");
    context.execution.guard(); return { manifest: result, artifacts: [result, ...archives, ...ocrPageRefs, ...(textRef ? [textRef] : []), ...(chunks?.artifacts ?? [])] };
  }
}
