import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import { canonical } from "./questions.js";
import { AppError, invariant } from "./errors.js";
import { responseBytes, type HttpFetch } from "./ai-http.js";
import { parseAiJson } from "./ai-json.js";
import { object, text } from "./question-contract.js";
import { guardDocumentCall } from "./document-execution.js";
import { tencentSlots } from "./provider-slots.js";
import { sourceUrl, stagingObject, TencentStaging, validateStaging } from "./tencent-staging.js";
import { CostBudget, costSettings, pageEstimate } from "./cost-budget.js";

export const TENCENT_HOST = "ocr.tencentcloudapi.com";
export const TENCENT_RESULT_LIMIT = 100 * 1024 * 1024;
export const TENCENT_BASE64_LIMIT = 8 * 1024 * 1024;
export const FILE_TYPES = { pdf: 1, doc: 2, docx: 2, ppt: 3, pptx: 3, xls: 4, xlsx: 4, markdown: 5, text: 6, image: 7 };
export type TencentSource = keyof typeof FILE_TYPES;
const SOURCE_MIME: Record<TencentSource, string> = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", markdown: "text/markdown", text: "text/plain", image: "image/png" };
export const tencentInputLimit = (type: TencentSource, cos: boolean): number => Math.min((["text", "markdown", "xls", "xlsx"].includes(type) ? 10 : type === "image" ? 30 : 150) * 1024 * 1024, cos ? 150 * 1024 * 1024 : TENCENT_BASE64_LIMIT);
type Credentials = Pick<AiSnapshot["secrets"], "tencentSecretId" | "tencentSecretKey">;
export function tencentHeaders(action: string, payload: string, credentials: Credentials, timestamp: number): Record<string, string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10), signed = "content-type;host;x-tc-action", scope = `${date}/ocr/tc3_request`;
  const request = `POST\n/\n\ncontent-type:application/json\nhost:${TENCENT_HOST}\nx-tc-action:${action.toLowerCase()}\n\n${signed}\n${hash(payload)}`;
  let key: Buffer = Buffer.from(`TC3${credentials.tencentSecretKey}`);
  for (const part of [date, "ocr", "tc3_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(request)}`).digest("hex");
  return { "Content-Type": "application/json", "Accept-Encoding": "identity", Host: TENCENT_HOST, "X-TC-Action": action, "X-TC-Version": "2018-11-19", "X-TC-Timestamp": String(timestamp), Authorization: `TC3-HMAC-SHA256 Credential=${credentials.tencentSecretId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
const diagnostic = (value: unknown, code = false): string | null => typeof value === "string" && (code ? /^[A-Za-z0-9_.]{1,128}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(value) ? value : null;
class Rejected extends AppError {
  constructor(readonly providerCode: string, readonly requestId: string | null) { super("TENCENT_REQUEST_REJECTED", "Tencent rejected the request", { providerCode, requestId }); }
}
class ReadFailure extends AppError {
  constructor(code: string, readonly retryable: boolean) { super(code, "Tencent response is unavailable or invalid"); }
}
const transientStatus = (status: number) => [408, 429, 500, 502, 503, 504].includes(status);
async function read<T>(config: AiSnapshot | undefined, signal: AbortSignal | undefined, perform: () => Promise<T>): Promise<T> {
  const retries = config?.preferences.import.readRetryCount ?? 0, base = config?.preferences.import.retryBaseSeconds ?? 1;
  for (let attempt = 0; ; attempt++) {
    signal = guardDocumentCall(undefined, signal, config); signal?.throwIfAborted();
    try { return await perform(); }
    catch (error) {
      signal?.throwIfAborted();
      const retryable = error instanceof ReadFailure && error.retryable || error instanceof Rejected && ["RequestLimitExceeded", "InternalError"].includes(error.providerCode.split(".")[0]);
      if (!retryable || attempt >= retries) throw error;
      let remaining = base * 1000 * 2 ** attempt * (0.8 + Math.random() * 0.4);
      while (remaining > 0) { const interval = Math.min(1000, remaining); await sleep(interval, undefined, { signal }); remaining -= interval; guardDocumentCall(undefined, signal, config); }
    }
  }
}
export function tencentResultUrl(value: unknown): string {
  invariant(typeof value === "string" && value.length <= 16384 && !/\p{Cc}/u.test(value), "TENCENT_RESULT_INVALID", "Invalid Tencent result reference");
  const url = new URL(value);
  invariant(url.protocol === "https:" && !url.username && !url.password && !url.hash && !value.includes("#") && (!url.port || url.port === "443") && /^[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/.test(url.hostname), "TENCENT_RESULT_INVALID", "Tencent result URL is outside allowed storage hosts"); return url.href;
}

export class TencentClient {
  private costs?: CostBudget;
  bindCosts(costs: CostBudget): void { invariant(!this.costs || this.costs === costs, "COST_STORE_REQUIRED", "Recognition cost admission must retain its original Store"); this.costs = costs; }
  private readonly staging: TencentStaging;
  constructor(readonly database: AiDatabase, private readonly http: HttpFetch = fetch) { this.staging = new TencentStaging(http); }
  private async request(action: string, data: unknown, config: AiSnapshot, signal?: AbortSignal): Promise<Record<string, unknown>> {
    invariant(config.secrets.tencentSecretId && config.secrets.tencentSecretKey, "TENCENT_NOT_CONFIGURED", "Configure Tencent credentials in Settings");
    const payload = JSON.stringify(data), timeout = AbortSignal.timeout(60000), abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.http(`https://${TENCENT_HOST}/`, { method: "POST", body: payload, headers: tencentHeaders(action, payload, config.secrets, Math.floor(Date.now() / 1000)), redirect: "error", signal: abort });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ReadFailure("TENCENT_API_UNAVAILABLE", transientStatus(response.status)); }
      const bytes = await responseBytes(response, 65536); let body: Record<string, unknown>;
      try { body = object(parseAiJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
      catch { throw new ReadFailure("TENCENT_API_UNAVAILABLE", false); }
      invariant(body.Response !== null && typeof body.Response === "object" && !Array.isArray(body.Response), "TENCENT_API_UNAVAILABLE", "Tencent response is unavailable or invalid");
      const result = object(body.Response);
      if (result.Error != null) throw new Rejected(diagnostic(object(result.Error).Code, true) ?? "Unknown", diagnostic(result.RequestId));
      return result;
    } catch (error) { signal?.throwIfAborted(); if (error instanceof Rejected || error instanceof ReadFailure) throw error; throw new ReadFailure("TENCENT_API_UNAVAILABLE", !(error instanceof AppError)); }
  }
  job(taskId: string, key: string): Record<string, unknown> { return object(object(object(this.database.state(taskId)).tencentJobs)[key]); }
  updateJob(taskId: string, key: string, patch: Record<string, unknown>, expected: Record<string, unknown> = {}): Record<string, unknown> {
    let record: Record<string, unknown> = {};
    this.database.updateState(taskId, state => {
      const value = object(state), jobs = object(value.tencentJobs), previous = object(jobs[key]);
      invariant(Object.entries(expected).every(([field, value]) => canonical(previous[field]) === canonical(value)), "TENCENT_JOB_CONFLICT", "Tencent job changed before publishing the read result");
      for (const field of ["sourceSha256", "taskId"]) invariant(previous[field] == null || patch[field] == null || previous[field] === patch[field], "TENCENT_JOB_CONFLICT", "Tencent job identity changed during a read");
      record = { ...previous, ...patch }; return { ...value, tencentJobs: { ...jobs, [key]: record } };
    }); return record;
  }
  async submit(taskId: string, key: string, source: { sha256: string; type: TencentSource; bytes: Uint8Array; maxPages?: number; estimatedPages?: number; mediaType?: string }, config: AiSnapshot, signal?: AbortSignal): Promise<string> {
    signal = guardDocumentCall(taskId, signal, config);
    return tencentSlots.run(Math.min(5, config.preferences.import.tencentConcurrency), signal, () => this.performSubmit(taskId, key, source, config, signal));
  }
  private async performSubmit(taskId: string, key: string, source: { sha256: string; type: TencentSource; bytes: Uint8Array; maxPages?: number; estimatedPages?: number; mediaType?: string }, config: AiSnapshot, signal?: AbortSignal): Promise<string> {
    signal = guardDocumentCall(taskId, signal, config);
    invariant(Object.hasOwn(FILE_TYPES, source.type) && source.bytes.length > 0 && source.bytes.length <= tencentInputLimit(source.type, config.preferences.tencentCos.enabled) && hash(source.bytes) === source.sha256, "TENCENT_SOURCE_TOO_LARGE", "Split and verify the source before Tencent submission");
    invariant(config.secrets.tencentSecretId && config.secrets.tencentSecretKey, "TENCENT_NOT_CONFIGURED", "Configure Tencent credentials in Settings");
    invariant(source.maxPages === undefined || Number.isSafeInteger(source.maxPages) && source.maxPages > 0 && source.maxPages <= 300 && ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(source.type), "TENCENT_SOURCE_TOO_LARGE", "Invalid Office recognition page limit");
    const jobs = object(object(this.database.state(taskId)).tencentJobs), previous = object(jobs[key]), callKey = `tencent:${key}`, resultType = ["text", "markdown"].includes(source.type) ? 2 : 9;
    const cos = config.preferences.tencentCos;
    if (Object.keys(previous).length) {
      invariant(Boolean(previous.staging) === cos.enabled, "TENCENT_COS_CONFLICT", "The original transport cannot change during recovery");
      if (previous.staging) validateStaging(previous.staging, config, taskId, key, source.sha256);
    }
    const target = { inputDigest: hash(canonical({ sourceSha256: source.sha256, type: source.type, resultType, ...(source.maxPages === undefined ? {} : { maxPages: source.maxPages }), ...(cos.enabled ? { transport: { mode: "cos", bucket: cos.bucket, region: cos.region } } : {}) })), endpoint: `https://${TENCENT_HOST}`, model: "multimodal-doc-parse", promptVersion: "2018-11-19-v1" };
    const receipt = this.database.receipt(taskId, callKey);
    if (receipt) {
      invariant(receipt.inputDigest === target.inputDigest && previous.sourceSha256 === source.sha256, "TENCENT_JOB_CONFLICT", "Tencent task belongs to another source");
      if (receipt.status === "failed") await this.cleanupJob(taskId, key, config, signal);
      invariant(receipt.status === "succeeded" && diagnostic(object(receipt.result).taskId), receipt.status === "failed" ? "TENCENT_REQUEST_REJECTED" : "TENCENT_SUBMISSION_UNKNOWN", "The saved submission cannot be replayed; inspect its outcome before explicitly parsing again");
      const id = String(object(receipt.result).taskId); invariant(previous.taskId == null || previous.taskId === id, "TENCENT_JOB_CONFLICT", "Tencent job identity differs from its durable receipt"); if (!previous.taskId) this.updateJob(taskId, key, { sourceSha256: source.sha256, resultType, taskId: id, status: "Created" }); return id;
    }
    invariant(!Object.hasOwn(jobs, key) || previous.status === "STAGING" && cos.enabled && previous.sourceSha256 === source.sha256 && previous.resultType === resultType, "TENCENT_SUBMISSION_UNKNOWN", "An existing submission intent has no durable outcome; it cannot be automatically sent again");
    invariant(Object.hasOwn(jobs, key) || Object.keys(object(object(this.database.state(taskId)).tencentJobs)).length < 300, "TENCENT_SOURCE_TOO_LARGE", "Tencent source plan exceeds its job limit");
    signal?.throwIfAborted();
    let transport: { FileUrl: string } | { FileBase64: string };
    if (cos.enabled) {
      const staging = previous.staging ? validateStaging(previous.staging, config, taskId, key, source.sha256) : stagingObject(config, taskId, key, source.sha256);
      invariant(!staging.deleted, "TENCENT_COS_CONFLICT", "Deleted staging cannot authorize a new submission");
      this.updateJob(taskId, key, { sourceSha256: source.sha256, resultType, staging, status: "STAGING" });
      await this.staging.upload(staging, source.bytes, source.mediaType ?? SOURCE_MIME[source.type], config, signal);
      signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted(); transport = { FileUrl: sourceUrl(staging, config) };
    } else transport = { FileBase64: Buffer.from(source.bytes).toString("base64") };
    const cost = this.costs ? this.costs.policy(config.preferences.cost, true) : costSettings(config.preferences.cost);
    if (cost.enabled) {
      invariant(this.costs, "COST_STORE_REQUIRED", "Enabled cost limits require their durable Store");
      this.costs.reserve(cost, `task:${taskId}`, callKey, pageEstimate(source.estimatedPages ?? source.maxPages ?? 300, cost), "tencent", hash(canonical(target)));
    }
    invariant(!this.database.receipt(taskId, callKey), "TENCENT_SUBMISSION_UNKNOWN", "A concurrent submission already has a durable receipt");
    this.updateJob(taskId, key, { sourceSha256: source.sha256, resultType, status: "SUBMITTING" }, cos.enabled ? { status: "STAGING" } : {}); this.database.claim(taskId, callKey, target);
    try {
      const result = await this.request("SubmitMultimodalDocParseJob", { FileType: FILE_TYPES[source.type], ResultType: resultType, EnableSubImg: resultType === 9, TaskType: 0, ...(["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(source.type) ? { FileEndPageNumber: source.maxPages ?? 300 } : {}), ...transport }, config, signal);
      const id = diagnostic(result.TaskId); invariant(id, "TENCENT_SUBMISSION_UNKNOWN", "Tencent returned no valid task ID; submission outcome is unknown");
      const record = { taskId: id, requestId: diagnostic(result.RequestId) };
      this.database.finish(taskId, callKey, "succeeded", record, null); this.updateJob(taskId, key, { ...record, sourceSha256: source.sha256, resultType, status: "Created" }); return id;
    } catch (error) {
      if (error instanceof Rejected) { this.database.finish(taskId, callKey, "failed", { providerCode: error.providerCode, requestId: error.requestId }, null); this.updateJob(taskId, key, { sourceSha256: source.sha256, resultType, status: "REJECTED", requestId: error.requestId, errorCode: error.providerCode }); await this.cleanupJob(taskId, key, config, signal); throw error; }
      throw new AppError("TENCENT_SUBMISSION_UNKNOWN", "Tencent submission outcome is unknown; it will not be automatically sent again");
    }
  }
  async cleanupSource(taskId: string, key: string, config: AiSnapshot, signal?: AbortSignal): Promise<void> {
    signal = guardDocumentCall(taskId, signal, config);
    return tencentSlots.run(Math.min(5, config.preferences.import.tencentConcurrency), signal, () => this.cleanupJob(taskId, key, config, signal));
  }
  private async cleanupJob(taskId: string, key: string, config: AiSnapshot, signal?: AbortSignal): Promise<void> {
    const record = this.job(taskId, key); if (!record.staging) return;
    const staging = validateStaging(record.staging, config, taskId, key, String(record.sourceSha256)); if (staging.deleted) return;
    invariant(record.resultValidated === true || ["REJECTED", "Failed"].includes(String(record.status)), "TENCENT_COS_CONFLICT", "Uncertain or unvalidated recognition must retain its staged input");
    signal = guardDocumentCall(taskId, signal, config); signal?.throwIfAborted();
    try { await this.staging.delete(staging, config, signal); }
    catch (error) { this.updateJob(taskId, key, { staging: { ...staging, cleanupError: "TENCENT_COS_CLEANUP_FAILED" } }, { staging }); throw error; }
    this.updateJob(taskId, key, { staging: { ...staging, deleted: true, cleanupError: undefined } }, { staging });
  }
  async query(taskId: string, key: string, config: AiSnapshot, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal = guardDocumentCall(taskId, signal, config);
    return tencentSlots.run(Math.min(5, config.preferences.import.tencentConcurrency), signal, () => this.performQuery(taskId, key, config, signal));
  }
  private async performQuery(taskId: string, key: string, config: AiSnapshot, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal = guardDocumentCall(taskId, signal, config);
    const record = object(object(object(this.database.state(taskId)).tencentJobs)[key]), id = diagnostic(record.taskId);
    invariant(id, "TENCENT_SUBMISSION_UNKNOWN", "No acknowledged Tencent task is available for polling");
    let result: Record<string, unknown>;
    try { result = await read(config, signal, () => this.request("DescribeMultimodalDocParseJob", { TaskId: id }, config, signal)); }
    catch (error) {
      if (error instanceof Rejected) { this.updateJob(taskId, key, { sourceSha256: record.sourceSha256, taskId: id, queryRequestId: error.requestId, errorCode: error.providerCode }); throw new AppError("TENCENT_QUERY_REJECTED", "Tencent query was rejected; the original task ID is retained", { requestId: error.requestId, providerCode: error.providerCode }); }
      throw error;
    }
    invariant(["Created", "Processing", "Success", "Failed", "Unknown"].includes(text(result, "Status")), "TENCENT_RESULT_INVALID", "Invalid Tencent task status");
    const failedPages = result.FailedPages ?? [];
    invariant(Array.isArray(failedPages) && failedPages.length <= 300 && failedPages.every(value => value !== null && typeof value === "object" && !Array.isArray(value)) && [result.SuccessPageNum, result.FailPageNum].every(value => value == null || Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 300), "TENCENT_RESULT_INVALID", "Invalid Tencent page counts or failure metadata");
    const resultUrl = result.Status === "Success" ? tencentResultUrl(result.ResultUrl) : undefined;
    const saved = this.updateJob(taskId, key, { sourceSha256: record.sourceSha256, taskId: id, status: result.Status, queryRequestId: diagnostic(result.RequestId), errorCode: diagnostic(result.ErrorCode, true), statusUpdatedAt: new Date().toISOString(), successPageCount: result.SuccessPageNum ?? record.successPageCount ?? null, failedPageCount: result.FailPageNum ?? record.failedPageCount ?? null, ...(result.Status === "Success" ? { failedPages: failedPages.map(page => ({ ...(Number.isSafeInteger(page.PageNum) && Number(page.PageNum) >= 1 && Number(page.PageNum) <= 300 ? { PageNum: page.PageNum } : {}), ...(diagnostic(page.ErrorCode, true) ? { ErrorCode: diagnostic(page.ErrorCode, true) } : {}) })) } : {}) });
    if (result.Status === "Failed") await this.cleanupJob(taskId, key, config, signal);
    // Signed result URLs exist only in this response; callers must persist verified artifact references.
    return { ...saved, ...(resultUrl ? { resultUrl, failedPages, successPageNum: result.SuccessPageNum ?? null, failPageNum: result.FailPageNum ?? null } : {}) };
  }
  async download(url: unknown, signal?: AbortSignal, config?: AiSnapshot): Promise<Buffer> {
    signal = guardDocumentCall(undefined, signal, config);
    const target = tencentResultUrl(url);
    return read(config, signal, async () => {
      const timeout = AbortSignal.timeout(120000);
      try {
        const response = await this.http(target, { method: "GET", headers: { "Accept-Encoding": "identity" }, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ReadFailure("TENCENT_RESULT_UNAVAILABLE", transientStatus(response.status)); }
        return await responseBytes(response, TENCENT_RESULT_LIMIT);
      } catch (error) { signal?.throwIfAborted(); if (error instanceof ReadFailure) throw error; throw new ReadFailure("TENCENT_RESULT_UNAVAILABLE", !(error instanceof AppError)); }
    });
  }
}
