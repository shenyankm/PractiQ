import { setTimeout as sleep } from "node:timers/promises";
import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import type { AiSnapshot } from "./ai-settings.js";
import { guardDocumentCall } from "./document-execution.js";
import { AppError, invariant } from "./errors.js";
import { canonical } from "./questions.js";
import { FILE_TYPES, TencentClient, type TencentSource } from "./tencent.js";
import { TencentBundle, type TencentBundleLimits } from "./tencent-bundle.js";

export interface TencentResultOptions { sourceType: TencentSource; pageCount: number; limits?: Partial<TencentBundleLimits> }

/** Explicit graph work only: cached bytes and known jobs never authorize a second submission. */
export class TencentResults {
  constructor(readonly client: TencentClient, readonly storage: AiStorage) {}
  async open(taskId: string, key: string, reference: DocumentReference | ArtifactReference, config: AiSnapshot, options: TencentResultOptions, signal?: AbortSignal): Promise<{ bundle: TencentBundle; record: Record<string, unknown> }> {
    signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted();
    invariant(/^[A-Za-z0-9:_-]{1,128}$/.test(key) && Object.hasOwn(FILE_TYPES, options.sourceType) && Number.isSafeInteger(options.pageCount) && options.pageCount > 0 && options.pageCount <= 300, "TENCENT_RESULT_INVALID", "Invalid Tencent source plan");
    const parent = String(this.client.database.db.prepare("SELECT source_digest FROM ai_tasks WHERE id=?").get(taskId)?.source_digest ?? "");
    invariant(/^[a-f0-9]{64}$/.test(parent), "TENCENT_JOB_CONFLICT", "Tencent work requires its original document task");
    const bytes = "sourceType" in reference ? this.storage.source(reference) : this.storage.artifact(reference), resultType = ["text", "markdown"].includes(options.sourceType) ? 2 : 9;
    const source = { sha256: reference.sha256, type: options.sourceType, bytes, mediaType: reference.mediaType, estimatedPages: options.pageCount, ...(["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(options.sourceType) ? { maxPages: options.pageCount } : {}) };
    invariant(!("sourceType" in reference) || options.sourceType === reference.sourceType && reference.sha256 === parent, "TENCENT_JOB_CONFLICT", "Tencent source differs from its document task");
    invariant("sourceType" in reference || reference.objectKey.startsWith(`practiq-agent/artifacts/${parent}/`), "TENCENT_JOB_CONFLICT", "Tencent source artifact belongs to another document");
    let record = this.client.job(taskId, key);
    if (Object.keys(record).length) invariant(record.sourceSha256 === reference.sha256 && record.resultType === resultType, "TENCENT_JOB_CONFLICT", "Tencent task belongs to another source or output type");
    const patch = (value: Record<string, unknown>, expected: Record<string, unknown> = {}) => this.client.updateJob(taskId, key, { sourceSha256: reference.sha256, resultType, ...(record.taskId ? { taskId: record.taskId } : {}), ...value }, expected);
    if (!record.resultRef || record.resultValidationError) {
      if (!record.taskId) {
        await this.client.submit(taskId, key, source, config, signal);
        record = this.client.job(taskId, key);
      } else if (this.client.database.receipt(taskId, `tencent:${key}`)) {
        // Repair/check an acknowledgement gap without sending an existing receipt again.
        await this.client.submit(taskId, key, source, config, signal);
      }
      for (;;) {
        signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted();
        const status = await this.client.query(taskId, key, config, signal);
        if (status.status === "Success") {
          const raw = await this.client.download(status.resultUrl, signal, config);
          signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted();
          const resultRef = await this.storage.putArtifact(raw, parent, "tencent-result", 0, "application/zip");
          record = patch({ resultRef, resultValidated: false, resultValidationError: null }); break;
        }
        invariant(status.status !== "Failed" && status.status !== "Unknown", status.status === "Failed" ? "TENCENT_JOB_FAILED" : "TENCENT_JOB_UNKNOWN", "Tencent job did not succeed; the original task ID is retained");
        for (let count = 0; count < 3; count++) { await sleep(1000, undefined, { signal }); signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted(); }
      }
    }
    const resultRef = record.resultRef as ArtifactReference;
    invariant(resultRef?.mediaType === "application/zip" && typeof resultRef.objectKey === "string" && resultRef.objectKey.startsWith(`practiq-agent/artifacts/${parent}/tencent-result/`), "TENCENT_RESULT_INVALID", "Tencent result belongs to another document or artifact kind");
    // Integrity failure is local damage, not permission to replace evidence or redownload automatically.
    const raw = this.storage.artifact(resultRef); let bundle: TencentBundle | undefined;
    try {
      bundle = await TencentBundle.open(raw, { pageCount: options.pageCount, resultType, allowEmpty: record.successPageCount === 0 && Number(record.failedPageCount ?? 0) > 0, limits: options.limits, signal });
      const members = bundle.pages.flatMap(page => page.figures.flatMap(figure => figure.imageMember ? [figure.imageMember] : [])), sizes = new Map<string, number>(); let totalBytes = 0;
      for (const member of members) {
        if (!sizes.has(member)) sizes.set(member, (await bundle.image(member)).bytes.length);
        totalBytes += sizes.get(member)!; invariant(totalBytes <= bundle.limits.visionMaxBytes, "TENCENT_RESULT_TOO_LARGE", "Tencent subimages exceed the shared visual byte limit");
      }
      signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted();
      record = patch({ resultValidated: true, resultValidationError: null }, { resultRef });
      if (record.staging) { await this.client.cleanupSource(taskId, key, config, signal); record = this.client.job(taskId, key); }
      return { bundle, record };
    } catch (error) {
      bundle?.close();
      if (!signal?.aborted && error instanceof AppError && (["TENCENT_RESULT_INVALID", "TENCENT_RESULT_TOO_LARGE", "DOCUMENT_PROCESSING_FAILED"].includes(error.code) || error.code.startsWith("IMAGE_"))) {
        const previous = this.client.job(taskId, key).invalidResultRefs ?? [];
        invariant(Array.isArray(previous) && previous.length <= 1000, "TENCENT_RESULT_INVALID", "Invalid Tencent result history");
        patch({ resultValidated: false, resultValidationError: error.code, invalidResultRefs: previous.some(value => canonical(value) === canonical(resultRef)) ? previous : [...previous, resultRef] }, { resultRef });
      }
      throw error;
    }
  }
}
