import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import type { DocumentStageContext } from "./document-runtime.js";
import { invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import type { StoredOcrPage } from "./ocr-inputs.js";
import { jsonSize } from "./tencent-bundle.js";
import { TencentResults } from "./tencent-results.js";
import type { TencentSource } from "./tencent.js";
import type { TextInputLimits } from "./text-documents.js";

export interface PageSubmission { reference: ArtifactReference | DocumentReference; sourceType: TencentSource; count: number | null }
/** A source-specific preparation owns admission; this shared stage retains native evidence and order. */
export async function recognizePages(storage: AiStorage, results: TencentResults, context: DocumentStageContext, submissions: PageSubmission[], limits: TextInputLimits) {
  invariant(submissions.length > 0 && submissions.length <= limits.maxParts && submissions.every(submission => submission.count === null || Number.isSafeInteger(submission.count) && submission.count > 0) && submissions.reduce((sum, submission) => sum + (submission.count ?? 1), 0) <= limits.maxParts, "TENCENT_INPUTS_INVALID", "Invalid recognition page inventory");
  const source = context.task.input.document, visualLimit = 50 * 1024 * 1024, completed: { pages: StoredOcrPage[]; artifacts: ArtifactReference[]; truncated: boolean; imageBytes: number }[] = new Array(submissions.length), work = submissions.entries(), controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]); let stopped = false, firstError: unknown;
  const worker = async () => {
    try { for (const [index, submission] of work) {
      if (stopped) return; context.execution.guard(); signal.throwIfAborted(); const output = await results.open(context.task.id, `source-0-${index}`, submission.reference, context.config, { sourceType: submission.sourceType, pageCount: submission.count ?? limits.maxParts, limits: { maxTotalInputChars: limits.maxChars } }, signal);
      try {
        const pages: StoredOcrPage[] = [], artifacts: ArtifactReference[] = [output.record.resultRef as ArtifactReference]; let imageBytes = 0;
        const reported = Number(output.record.successPageCount ?? 0) + Number(output.record.failedPageCount ?? 0), count = submission.count ?? Math.max(reported, ...output.bundle.pages.map(page => page.page + 1), 0);
        invariant(count > 0 && count <= limits.maxParts && reported <= count, "TENCENT_RESULT_INVALID", "Tencent page count differs from its source or page limit");
        for (let page = 0; page < count; page++) {
          const original = output.bundle.pages.find(item => item.page === page); if (!original) { pages.push({ page, failed: true }); continue; }
          const figures = [];
          for (const [position, figure] of original.figures.entries()) {
            signal.throwIfAborted(); const image = figure.imageMember ? await output.bundle.image(figure.imageMember) : null;
            if (image) { imageBytes += image.bytes.length; invariant(imageBytes <= visualLimit, "TENCENT_RESULT_TOO_LARGE", "Tencent subimages exceed the shared visual byte limit"); const imageRef = await storage.putArtifact(image.bytes, source.sha256, "tencent-image", index * 300_000 + page * 1000 + position, image.mediaType); artifacts.push(imageRef); figures.push({ ...figure, imageRef }); } else figures.push({ ...figure });
          }
          pages.push({ ...original, figures });
        }
        completed[index] = { pages, artifacts, imageBytes, truncated: Number(output.record.failedPageCount ?? 0) > 0 || pages.some(page => "failed" in page) };
      } finally { output.bundle.close(); }
    } } catch (error) { if (!stopped) firstError = error; stopped = true; controller.abort(); }
  };
  await Promise.all(Array.from({ length: Math.min(submissions.length, context.config.preferences.import.tencentConcurrency) }, worker)); if (stopped) throw firstError;
  const ocrPageRefs: ArtifactReference[] = [], artifacts: ArtifactReference[] = [], pages: StoredOcrPage[] = []; let chars = 0, imageBytes = 0, truncated = false;
  for (const output of completed) { truncated ||= output.truncated; imageBytes += output.imageBytes; invariant(imageBytes <= visualLimit, "TENCENT_RESULT_TOO_LARGE", "Tencent subimages exceed the shared visual byte limit"); invariant(pages.length + output.pages.length <= limits.maxParts, "PDF_PAGE_LIMIT_EXCEEDED", "Document exceeds its page limit"); artifacts.push(...output.artifacts); for (const page of output.pages) { context.execution.guard(); const value = { ...page, page: pages.length }; chars += jsonSize(value, true); invariant(chars <= limits.maxChars, "TENCENT_RESULT_TOO_LARGE", "OCR evidence exceeds its document character limit"); pages.push(value); ocrPageRefs.push(await storage.putArtifact(Buffer.from(executionJson(value)), source.sha256, "ocr-page", ocrPageRefs.length, "application/json")); } }
  return { pages, ocrPageRefs, artifacts: [...artifacts, ...ocrPageRefs], truncated };
}
