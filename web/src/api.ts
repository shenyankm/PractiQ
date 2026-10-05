import type { ArtifactReference, DocumentReference, DocumentSourceType, DocumentTaskControl, DocumentTaskCreate, DocumentTaskDetail, DocumentTaskHead, DocumentTaskList, DocumentTaskReceipt, DocumentTaskReparse, DocumentTaskReview, DocumentUploadResponse, ImportCapabilities, OfficeMode } from "./contracts.generated";

export type SourceType = DocumentSourceType;
export type { OfficeMode } from "./contracts.generated";
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
  csv: { sourceType: "csv", mediaType: "text/csv" },
  png: { sourceType: "image", mediaType: "image/png" },
  jpg: { sourceType: "image", mediaType: "image/jpeg" },
  jpeg: { sourceType: "image", mediaType: "image/jpeg" },
  doc: { sourceType: "doc", mediaType: "application/msword" },
  docx: { sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { sourceType: "xls", mediaType: "application/vnd.ms-excel" },
  xlsx: { sourceType: "xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
};

export class ApiError extends Error {
  constructor(message: string, public readonly code = "CLIENT_ERROR", public readonly status = 0) { super(message); }
}
export const isOffice = (source: SourceType) => ["doc", "docx", "xls", "xlsx"].includes(source);
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
async function readBytes(response: Response, maximum: number) {
  if (Number(response.headers.get("content-length")) > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Same-origin Bearer client. Its lifetime ends on disconnect; mutations are never retried here. */
export class Client {
  private readonly session = new AbortController();
  private readonly intents = new Map<string, string>();
  constructor(private readonly token: string) {
    if (!token.trim() || /[\r\n]/.test(token)) throw new ApiError("请输入有效的服务 Token。", "INVALID_TOKEN");
  }
  get active() { return !this.session.signal.aborted; }
  disconnect() { this.session.abort(); this.intents.clear(); }
  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (!path.startsWith("/api/") || path.startsWith("//")) throw new ApiError("服务返回了无效地址。", "INVALID_URL");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "omit", redirect: "error", signal: signal ? AbortSignal.any([signal, this.session.signal]) : this.session.signal });
    } catch {
      if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      throw new ApiError("无法连接服务。请检查服务状态，再手动重试。", "NETWORK_ERROR");
    }
    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      try {
        const body = JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * 1024))) as { detail?: { code?: string } };
        if (body.detail?.code && /^[A-Z0-9_]{1,64}$/.test(body.detail.code)) code = body.detail.code;
      } catch { /* Error bodies may be empty, text, or validation arrays. */ }
      const message = response.status === 401 || response.status === 403 ? "服务 Token 无效或没有访问权限。" : "服务未完成此操作，请检查任务状态后重试。";
      throw new ApiError(`${message}（${code}）`, code, response.status);
    }
    return response;
  }
  private async json<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, init, signal);
    try { return JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * MIB))) as T; }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError("服务响应格式无效。", "INVALID_RESPONSE"); }
  }
  private post<T>(path: string, body: unknown) {
    return this.json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
    if (!Number.isSafeInteger(value.sourceMaxBytes) || value.sourceMaxBytes <= 0 || !Array.isArray(value.sourceTypes) || !value.sourceTypes.every(type => ["pdf", "text", "csv", "image", "doc", "docx", "xls", "xlsx"].includes(type)) || !Array.isArray(value.officeModes) || !value.officeModes.every(mode => ["pdf", "text"].includes(mode)) || typeof value.officeAvailable !== "boolean" || typeof value.modelConfigured !== "boolean") throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
    if (value.officeSourceMaxBytes != null && (!Number.isSafeInteger(value.officeSourceMaxBytes) || value.officeSourceMaxBytes <= 0 || value.officeSourceMaxBytes > value.sourceMaxBytes)) throw new ApiError("服务能力响应无效。", "INVALID_RESPONSE");
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
  async start(file: File, capabilities: Capabilities, requestId: string, officeMode: OfficeMode, onStage: (stage: UploadStage) => void) {
    validateFiles([file], capabilities);
    const format = fileFormat(file);
    if (isOffice(format.sourceType) && (!capabilities.officeAvailable || !capabilities.officeModes.includes(officeMode))) throw new ApiError("服务端 Office 转换暂不可用。", "OFFICE_UNAVAILABLE");
    if (!capabilities.modelConfigured) throw new ApiError("服务端尚未配置模型。", "MODEL_NOT_CONFIGURED");
    onStage("hashing");
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new ApiError("文件内容与声明大小不一致。", "DOCUMENT_SIZE_MISMATCH");
    const metadata = { ...format, fileName: file.name, sizeBytes: file.size, sha256: await sha256(bytes) };
    onStage("uploading");
    const prepared = await this.post<DocumentUploadResponse>("/api/uploads", metadata);
    const document = prepared.document;
    const suffix = format.sourceType === "text" ? "txt" : format.sourceType;
    if (document.sha256 !== metadata.sha256 || document.sizeBytes !== metadata.sizeBytes || document.mediaType !== metadata.mediaType || document.sourceType !== metadata.sourceType || document.fileName !== metadata.fileName || document.objectKey !== `practiq-agent/sources/${metadata.sha256}/source.${suffix}`) throw new ApiError("服务返回的文件引用不匹配。", "INVALID_REFERENCE");
    if (prepared.upload) {
      const url = new URL(prepared.upload.url, location.origin);
      const keys = Object.keys(metadata) as (keyof typeof metadata)[];
      if (prepared.upload.method !== "PUT" || url.origin !== location.origin || url.pathname !== "/api/uploads/content" || url.hash || Array.from(url.searchParams).length !== keys.length || !keys.every(key => url.searchParams.get(key) === String(metadata[key]))) throw new ApiError("服务返回的上传地址不匹配。", "INVALID_URL");
      const uploaded = await this.json<UploadDocument>(url.pathname + url.search, { method: "PUT", headers: { "Content-Type": metadata.mediaType }, body: bytes });
      if (JSON.stringify(uploaded) !== JSON.stringify(document)) {
        if (Object.keys(document).some(key => uploaded[key as keyof UploadDocument] !== document[key as keyof UploadDocument])) throw new ApiError("上传后的文件引用不匹配。", "INVALID_REFERENCE");
      }
    }
    onStage("starting");
    const request: DocumentTaskCreate = { requestId, document, graphId: "document_parser", failurePolicy: "return_partial", ...(isOffice(format.sourceType) ? { officeMode } : {}) };
    return this.post<Receipt>("/api/document-tasks", request);
  }
  async control(task: DocumentTaskDetail, action: Action) {
    const running = action === "pause" || action === "interrupt";
    if (!task.allowedActions.includes(action) || (running ? !task.runId : !task.checkpointId)) throw new ApiError("此检查点暂不允许该操作，请刷新任务。", "ACTION_UNAVAILABLE");
    if (["resume", "retry_failed"].includes(action) && (!task.modelConfigured || !task.resumeCompatible)) throw new ApiError("服务模型未配置或检查点不兼容，无法继续。", "MODEL_NOT_CONFIGURED");
    const target = running ? task.runId : task.checkpointId;
    return this.intent(`control:${task.threadId}:${action}:${target}`, requestId => { const request: DocumentTaskControl = { requestId, action, runId: running ? task.runId : null, checkpointId: running ? null : task.checkpointId, units: [] }; return this.post<Receipt>(`/api/document-tasks/${encodeURIComponent(task.threadId)}/control`, request); });
  }
  reparse(id: string) { return this.intent(`reparse:${id}`, requestId => { const request: DocumentTaskReparse = { requestId }; return this.post<Receipt>(`/api/document-tasks/${encodeURIComponent(id)}/reparse`, request); }); }
  delete(id: string) { return this.json<{ deleted: boolean }>(`/api/document-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  async image(reference: ArtifactReference) {
    if (!["image/png", "image/jpeg"].includes(reference.mediaType) || !/^[a-f0-9]{64}$/.test(reference.sha256) || reference.sizeBytes <= 0 || reference.sizeBytes > 50 * MIB) throw new ApiError("图片引用无效。", "INVALID_REFERENCE");
    const response = await this.request("/api/artifacts/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reference) });
    const bytes = await readBytes(response, reference.sizeBytes);
    if (bytes.length !== reference.sizeBytes || response.headers.get("content-type")?.split(";")[0] !== reference.mediaType || await sha256(bytes.buffer) !== reference.sha256) throw new ApiError("图片校验失败。", "ARTIFACT_CHECKSUM_MISMATCH");
    return new Blob([bytes], { type: reference.mediaType });
  }
  async exportBank(task: DocumentTaskDetail) {
    if (task.state !== "COMPLETED" || !task.result || !task.checkpointId) throw new ApiError("任务结果尚不可导出。", "BANK_EXPORT_NOT_READY");
    const query = new URLSearchParams({ checkpoint_id: task.checkpointId });
    const response = await this.request(`/api/document-tasks/${encodeURIComponent(task.threadId)}/export?${query}`);
    if (response.headers.get("content-type")?.split(";")[0] !== "application/zip") throw new ApiError("服务未返回题库 ZIP。", "INVALID_RESPONSE");
    return { blob: new Blob([await readBytes(response, MAX_BANK_ZIP_BYTES)], { type: "application/zip" }), name: `practiq-bank-${task.threadId.replace(/[^a-zA-Z0-9-]/g, "")}.zip` };
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  // Retain the URL through the browser's download handoff, then release it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
