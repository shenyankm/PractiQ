import type { ArtifactReference, DocumentReference, DocumentSourceType, DocumentTaskControl, DocumentTaskCreate, DocumentTaskDetail, DocumentTaskHead, DocumentTaskList, DocumentTaskReceipt, DocumentTaskReparse, DocumentTaskReview, DocumentUploadResponse, ImportCapabilities, ImportSettingsSnapshot } from "./contracts.generated";
import { IMPORT_SOURCE_TYPES } from "./contracts.generated";

export type SourceType = Exclude<DocumentSourceType, "csv">;
export type Capabilities = ImportCapabilities;
export type UploadDocument = DocumentReference;
export type TaskList = DocumentTaskList;
export type Receipt = DocumentTaskReceipt;
export type Action = DocumentTaskDetail["allowedActions"][number];
export type UploadStage = "hashing" | "uploading" | "starting";
const MIB = 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_BANK_ZIP_BYTES = 300 * MIB;
const formats: Record<string, { sourceType: SourceType; mediaType: string }> = {
  pdf: { sourceType: "pdf", mediaType: "application/pdf" },
  txt: { sourceType: "text", mediaType: "text/plain" },
  md: { sourceType: "markdown", mediaType: "text/markdown" },
  png: { sourceType: "image", mediaType: "image/png" },
  jpg: { sourceType: "image", mediaType: "image/jpeg" },
  jpeg: { sourceType: "image", mediaType: "image/jpeg" },
  doc: { sourceType: "doc", mediaType: "application/msword" },
  docx: { sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ppt: { sourceType: "ppt", mediaType: "application/vnd.ms-powerpoint" },
  pptx: { sourceType: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xls: { sourceType: "xls", mediaType: "application/vnd.ms-excel" },
  xlsx: { sourceType: "xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
};

export class ApiError extends Error {
  constructor(message: string, public readonly code = "CLIENT_ERROR", public readonly status = 0) { super(message); }
}
export const isOffice = (source: SourceType) => ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(source);
export const sourceLimit = (capabilities: Capabilities, source?: SourceType) => source && isOffice(source) ? Math.min(capabilities.sourceMaxBytes, capabilities.officeSourceMaxBytes ?? capabilities.sourceMaxBytes) : capabilities.sourceMaxBytes;
export function fileFormat(file: File) {
  const format = formats[file.name.split(".").at(-1)?.toLowerCase() || ""];
  if (!format || file.name.length > 255) throw new ApiError("请选择支持的文档格式，文件名最多 255 个字符。", "UNSUPPORTED_FILE");
  return format;
}
export function validateFiles(files: File[], capabilities: Capabilities) {
  if (!files.length || files.length > MAX_FILES) throw new ApiError("一次请选择 1–10 个文件。", "FILE_COUNT_LIMIT");
  for (const file of files) {
    const format = fileFormat(file);
    if (!capabilities.sourceTypes.includes(format.sourceType)) throw new ApiError(`服务暂不支持 ${file.name} 的格式。`, "UNSUPPORTED_FILE");
    if (!file.size || file.size > sourceLimit(capabilities, format.sourceType)) throw new ApiError(`${file.name} 为空或超过单文件大小限制。`, "DOCUMENT_TOO_LARGE");
  }
}
export async function sha256(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}
export async function readBytes(response: Response, maximum: number, signal?: AbortSignal) {
  if (Number(response.headers.get("content-length")) > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.length;
      if (length > maximum) { await reader.cancel(); throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function withDeadline<T>(milliseconds: number, signals: AbortSignal[], perform: (signal: AbortSignal) => Promise<T>, timeoutMessage = "请求超时。请检查任务状态；操作结果可能尚未确认，请勿重复提交。") {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  const signal = AbortSignal.any([...signals, deadline.signal]);
  try {
    const value = await perform(signal);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (signals.some(item => item.aborted)) throw new DOMException("请求已取消", "AbortError");
    if (deadline.signal.aborted) throw new ApiError(timeoutMessage, "REQUEST_TIMEOUT");
    throw error;
  } finally { clearTimeout(timer); }
}

/** Same-origin personal-service client. Its lifetime ends on disconnect; mutations are never retried here. */
export class Client {
  private readonly session = new AbortController();
  private readonly intents = new Map<string, string>();
  constructor(private readonly token: string) {
    if (!token.trim() || /[\r\n]/.test(token)) throw new ApiError("请输入有效的服务访问令牌。", "INVALID_SERVICE_TOKEN");
  }
  get active() { return !this.session.signal.aborted; }
  disconnect() { this.session.abort(); this.intents.clear(); }
  private async request<T>(path: string, init: RequestInit, read: (response: Response, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (!path.startsWith("/api/") || path.startsWith("//")) throw new ApiError("服务返回了无效地址。", "INVALID_URL");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    const signals = [this.session.signal];
    if (signal) signals.push(signal);
    const pathname = path.split("?")[0];
    const upload = pathname === "/api/uploads" || pathname === "/api/uploads/content";
    // Upload transport and POST artifact reads do not create tasks.
    const mutation = !!init.method && !["GET", "HEAD"].includes(init.method) && !upload && pathname !== "/api/artifacts/read";
    const uploadRetry = "文件上传未确认，请检查连接后手动重试上传。";
    const timeout = path.includes("/export?") ? 600_000 : init.method && !["GET", "HEAD"].includes(init.method) ? 125_000 : 30_000;
    return withDeadline(timeout, signals, async requestSignal => {
      let response: Response;
      try {
        response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "omit", redirect: "error", signal: requestSignal });
      } catch {
        if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        throw new ApiError(upload ? uploadRetry : mutation ? "连接中断，操作结果尚未确认。请先查询原任务，再决定是否重试。" : "无法连接服务。请检查服务状态，再手动重试读取。", "NETWORK_ERROR");
      }
      try {
        if (!response.ok) {
          let code = `HTTP_${response.status}`;
          try {
            const body = JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * 1024, requestSignal))) as { detail?: { code?: string } };
            if (body.detail?.code && /^[A-Z0-9_]{1,64}$/.test(body.detail.code)) code = body.detail.code;
          } catch { /* Error bodies may be empty, text, or validation arrays. */ }
          const known: Record<string, string> = {
            DOCUMENT_TOO_LARGE: "文件超过服务限制，请选择较小的文件。",
            UNSUPPORTED_FILE: "服务不支持此文件格式，请更换文件。",
            OFFICE_NOT_FOUND: "服务尚未配置 Office 转换，请联系服务提供方或改用 PDF。",
            OFFICE_NOT_CONFIGURED: "服务尚未配置 Office 转换，请联系服务提供方或改用 PDF。本次提交未创建任务，可以修正配置后手动重新提交。",
            TENCENT_NOT_CONFIGURED: "服务尚未配置腾讯文档解析，请联系服务提供方。本次提交未创建任务，可以修正配置后手动重新提交。",
            STALE_RUN: "任务状态已更新，请刷新任务详情后再操作。",
            TASK_BUSY: "任务正在处理，请等待并刷新状态。",
          };
          const message = response.status === 401 || response.status === 403 ? "服务访问令牌无效，请检查 AI_SERVICE_TOKEN。"
            : known[code] ?? (response.status === 429 ? "请求过于频繁，请稍后再操作。"
            : upload ? uploadRetry
            : !mutation ? "读取失败，请稍后重试读取。"
            : response.status >= 500 || response.status === 408 ? "操作结果尚未确认，请先查询原任务；不要重复提交。"
            : "服务未接受此操作，请检查输入并刷新相关状态后再操作。");
          throw new ApiError(`${message}（${code}）`, code, response.status);
        }
        return await read(response, requestSignal);
      } finally {
        void response.body?.cancel().catch(() => {});
      }
    }, upload ? "文件上传超时，请检查连接后手动重试上传。" : mutation ? undefined : "读取请求超时，请稍后重试读取。");
  }
  private async json<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
    return this.request(path, init ?? {}, async (response, requestSignal) => {
      try { return JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * MIB, requestSignal))) as T; }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError("服务响应格式无效。", "INVALID_RESPONSE"); }
    }, signal);
  }
  private post<T>(path: string, body: unknown) {
    return this.json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  private checkedSettings(value: ImportSettingsSnapshot) {
    const settings = value?.settings;
    if (!value || typeof value.revision !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.revision) || !settings || !Number.isInteger(settings.tencentConcurrency) || settings.tencentConcurrency! < 1 || settings.tencentConcurrency! > 5 || !Number.isInteger(settings.readRetryCount) || settings.readRetryCount! < 0 || settings.readRetryCount! > 5 || !Number.isFinite(settings.retryBaseSeconds) || settings.retryBaseSeconds! < 0.5 || settings.retryBaseSeconds! > 10) throw new ApiError("导入设置响应无效，请重新读取。", "INVALID_RESPONSE");
    return value;
  }
  async importSettings(signal?: AbortSignal) { return this.checkedSettings(await this.json<ImportSettingsSnapshot>("/api/import-settings", undefined, signal)); }
  async saveImportSettings(value: ImportSettingsSnapshot) {
    this.checkedSettings(value);
    const saved = this.checkedSettings(await this.json<ImportSettingsSnapshot>("/api/import-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }));
    if (saved.revision === value.revision || Object.keys(value.settings).some(key => saved.settings[key as keyof typeof saved.settings] !== value.settings[key as keyof typeof value.settings])) throw new ApiError("保存结果尚未确认，请重新读取设置后核对。", "INVALID_RESPONSE");
    return saved;
  }
  private async receipt(path: string, body: { requestId: string }) {
    const receipt = await this.post<Receipt>(path, body);
    if (!receipt || receipt.requestId !== body.requestId || receipt.accepted !== true || ![receipt.threadId, receipt.runId].every(id => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) throw new ApiError("任务操作回执无效，结果尚未确认。请先查询任务。", "INVALID_RESPONSE");
    return receipt;
  }
  private async intent<T>(key: string, perform: (requestId: string) => Promise<T>) {
    const requestId = this.intents.get(key) || crypto.randomUUID();
    this.intents.set(key, requestId);
    const receipt = await perform(requestId);
    this.intents.delete(key);
    return receipt;
  }
  async capabilities(signal?: AbortSignal) {
    const value = await this.json<Capabilities>("/api/import-capabilities", undefined, signal);
    if (!Number.isSafeInteger(value.sourceMaxBytes) || value.sourceMaxBytes <= 0 || !Array.isArray(value.sourceTypes) || !value.sourceTypes.every(type => IMPORT_SOURCE_TYPES.some(supported => supported === type)) || !Array.isArray(value.officeModes) || !value.officeModes.every(mode => ["pdf", "text"].includes(mode)) || typeof value.officeAvailable !== "boolean" || typeof value.modelConfigured !== "boolean") throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
    if (value.officeSourceMaxBytes != null && (!Number.isSafeInteger(value.officeSourceMaxBytes) || value.officeSourceMaxBytes <= 0 || value.officeSourceMaxBytes > value.sourceMaxBytes)) throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
    if (value.parserInputMaxBytes != null && (!Number.isSafeInteger(value.parserInputMaxBytes) || value.parserInputMaxBytes < 4 || value.parserInputMaxBytes > 150 * MIB)) throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
    if (value.modelBudget != null && (![value.modelBudget.limit, value.modelBudget.unitCalls, value.modelBudget.contextUnitCalls].every(Number.isSafeInteger) || value.modelBudget.limit < 0 || value.modelBudget.unitCalls <= 0 || value.modelBudget.contextUnitCalls <= 0)) throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
    return value;
  }
  list(offset: number, filter = "", signal?: AbortSignal, cursor?: string) {
    const query = new URLSearchParams({ limit: "20", offset: String(cursor ? 0 : offset) });
    if (cursor) query.set("cursor", cursor);
    if (filter) query.set("state_filter", filter);
    return this.json<TaskList>(`/api/document-tasks?${query}`, undefined, signal);
  }
  detail(id: string, signal?: AbortSignal) { return this.json<DocumentTaskDetail>(`/api/document-tasks/${encodeURIComponent(id)}`, undefined, signal); }
  head(id: string, signal?: AbortSignal) { return this.json<DocumentTaskHead>(`/api/document-tasks/${encodeURIComponent(id)}/head`, undefined, signal); }
  preview(id: string, signal?: AbortSignal) { return this.json<DocumentTaskReview>(`/api/document-tasks/${encodeURIComponent(id)}/preview`, undefined, signal); }
  async start(file: File, capabilities: Capabilities, requestId: string, onStage: (stage: UploadStage, requestId?: string) => void, deduplicateQuestions = false) {
    validateFiles([file], capabilities);
    const format = fileFormat(file);
    if (capabilities.parserConfigured === false) throw new ApiError("服务端尚未配置腾讯文档解析。", "TENCENT_NOT_CONFIGURED");
    if (!capabilities.modelConfigured) throw new ApiError("服务端尚未配置模型。", "MODEL_NOT_CONFIGURED");
    onStage("hashing");
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new ApiError("文件内容与声明大小不一致。", "DOCUMENT_SIZE_MISMATCH");
    const metadata = { ...format, fileName: file.name, sizeBytes: file.size, sha256: await sha256(bytes) };
    onStage("uploading");
    const prepared = await this.post<DocumentUploadResponse>("/api/uploads", metadata);
    const document = prepared.document;
    const suffix = format.sourceType === "text" ? "txt" : format.sourceType === "markdown" ? "md" : format.sourceType;
    if (document.sha256 !== metadata.sha256 || document.sizeBytes !== metadata.sizeBytes || document.mediaType !== metadata.mediaType || document.sourceType !== metadata.sourceType || document.fileName !== metadata.fileName || document.objectKey !== `practiq-agent/sources/${metadata.sha256}/source.${suffix}`) throw new ApiError("服务返回的文件引用不匹配。", "INVALID_REFERENCE");
    if (prepared.upload) {
      const url = new URL(prepared.upload.url, location.origin);
      const keys = Object.keys(metadata) as (keyof typeof metadata)[];
      if (prepared.upload.method !== "PUT" || url.origin !== location.origin || url.pathname !== "/api/uploads/content" || url.hash || Array.from(url.searchParams).length !== keys.length || !keys.every(key => url.searchParams.get(key) === String(metadata[key]))) throw new ApiError("服务返回的上传地址不匹配。", "INVALID_URL");
      const uploaded = await this.json<UploadDocument>(url.pathname + url.search, { method: "PUT", headers: { "Content-Type": metadata.mediaType }, body: bytes });
      if (Object.keys(document).some(key => uploaded[key as keyof UploadDocument] !== document[key as keyof UploadDocument])) throw new ApiError("上传后的文件引用不匹配。", "INVALID_REFERENCE");
    }
    const key = `start:${JSON.stringify(metadata)}:${deduplicateQuestions}`;
    requestId = this.intents.get(key) || requestId;
    this.intents.set(key, requestId);
    onStage("starting", requestId);
    const request: DocumentTaskCreate = { requestId, document, graphId: "document_parser", failurePolicy: "return_partial", ...(deduplicateQuestions ? { deduplicateQuestions: true } : {}) };
    const receipt = await this.receipt("/api/document-tasks", request);
    this.intents.delete(key);
    return receipt;
  }
  async control(task: DocumentTaskDetail, action: Action) {
    const running = action === "pause" || action === "interrupt";
    if (!task.allowedActions.includes(action) || (running ? !task.runId : !task.checkpointId)) throw new ApiError("此检查点暂不允许该操作，请刷新任务。", "ACTION_UNAVAILABLE");
    if (["resume", "retry_failed"].includes(action) && (!task.modelConfigured || !task.resumeCompatible)) throw new ApiError("服务模型未配置或检查点不兼容，无法继续。", "MODEL_NOT_CONFIGURED");
    const target = running ? task.runId : task.checkpointId;
    return this.intent(`control:${task.threadId}:${action}:${target}`, requestId => { const request: DocumentTaskControl = { requestId, action, runId: running ? task.runId : null, checkpointId: running ? null : task.checkpointId, units: [] }; return this.receipt(`/api/document-tasks/${encodeURIComponent(task.threadId)}/control`, request); });
  }
  reparse(id: string) { return this.intent(`reparse:${id}`, requestId => { const request: DocumentTaskReparse = { requestId }; return this.receipt(`/api/document-tasks/${encodeURIComponent(id)}/reparse`, request); }); }
  async delete(id: string) {
    const receipt = await this.json<{ deleted: boolean }>(`/api/document-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!receipt || receipt.deleted !== true) throw new ApiError("删除回执无效，结果尚未确认。请先查询任务。", "INVALID_RESPONSE");
    return receipt;
  }
  private async artifact(reference: ArtifactReference, threadId: string, limit: number, signal?: AbortSignal) {
    if (!/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes <= 0 || reference.sizeBytes > limit) throw new ApiError("来源引用无效。", "INVALID_REFERENCE");
    return this.request(`/api/artifacts/read?thread_id=${encodeURIComponent(threadId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reference) }, async (response, signal) => {
      const bytes = await readBytes(response, reference.sizeBytes, signal);
      if (bytes.length !== reference.sizeBytes || response.headers.get("content-type")?.split(";")[0] !== reference.mediaType || await sha256(bytes.buffer) !== reference.sha256) throw new ApiError("来源文件校验失败。", "ARTIFACT_CHECKSUM_MISMATCH");
      return new Blob([bytes], { type: reference.mediaType });
    }, signal);
  }
  image(reference: ArtifactReference, threadId: string, signal?: AbortSignal) {
    if (!["image/png", "image/jpeg"].includes(reference.mediaType)) return Promise.reject(new ApiError("图片引用无效。", "INVALID_REFERENCE"));
    return this.artifact(reference, threadId, 50 * MIB, signal);
  }
  evidence(reference: ArtifactReference, threadId: string, signal?: AbortSignal) {
    if (!["application/json", "text/plain", "text/markdown"].includes(reference.mediaType)) return Promise.reject(new ApiError("来源证据类型无效。", "INVALID_REFERENCE"));
    return this.artifact(reference, threadId, 25 * MIB, signal);
  }
  source(reference: DocumentReference, threadId: string) {
    if (!Object.values(formats).some(format => format.sourceType === reference.sourceType && format.mediaType === reference.mediaType) && !(reference.sourceType === "csv" && reference.mediaType === "text/csv") && !(reference.sourceType === "markdown" && reference.mediaType === "text/plain")) return Promise.reject(new ApiError("原文件类型无效。", "INVALID_REFERENCE"));
    const { objectKey, sha256, sizeBytes, mediaType } = reference;
    return this.artifact({ objectKey, sha256, sizeBytes, mediaType }, threadId, 50 * MIB);
  }
  async exportBank(task: DocumentTaskDetail) {
    if ((!task.canExportCompleted && (task.state !== "COMPLETED" || !task.result)) || !task.checkpointId) throw new ApiError("任务结果尚不可导出。", "BANK_EXPORT_NOT_READY");
    const query = new URLSearchParams({ checkpoint_id: task.checkpointId, scope: task.state === "COMPLETED" ? "full" : "completed" });
    return this.request(`/api/document-tasks/${encodeURIComponent(task.threadId)}/export?${query}`, {}, async (response, signal) => {
      if (response.headers.get("content-type")?.split(";")[0] !== "application/zip") throw new ApiError("服务未返回题库 ZIP。", "INVALID_RESPONSE");
      return { blob: new Blob([await readBytes(response, MAX_BANK_ZIP_BYTES, signal)], { type: "application/zip" }), name: `practiq-bank-${task.threadId.replace(/[^a-zA-Z0-9-]/g, "")}.zip` };
    });
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  // Retain the URL through the browser's download handoff, then release it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
