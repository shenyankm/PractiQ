import { accountHeaders, accountStorageScope, sessionExpired, storageKey } from "./accountClient";
import type { ArtifactReference, DocumentCorrections, DocumentCorrectionSave, DocumentReference, DocumentSourceType, DocumentTaskControl, DocumentTaskCreate, DocumentTaskDetail, DocumentTaskHead, DocumentTaskList, DocumentTaskReceipt, DocumentTaskReparse, DocumentTaskReview, DocumentReparseSelection, DocumentAnswerMatches, DocumentAnswerProposal, DocumentAnswerSource, DocumentUploadResponse, ImportCapabilities, ImportSettingsSnapshot } from "./contracts.generated";
import { validPages, validReparseSelection } from "./importSelection";
import { IMPORT_SOURCE_TYPES } from "./contracts.generated";

import { nativeBridge, serviceFetch, type SourceFile } from "./transport";
export type { SourceFile } from "./transport";

export type SourceType = Exclude<DocumentSourceType, "csv">;
export type Capabilities = ImportCapabilities;
export type UploadDocument = DocumentReference;
export type TaskList = DocumentTaskList;
export type Receipt = DocumentTaskReceipt;
export type Action = DocumentTaskDetail["allowedActions"][number];
export type UploadStage = "hashing" | "uploading" | "starting";
export type ReparseIntent = DocumentTaskReparse & { threadId: string };
const MIB = 1024 * 1024;
const IMPORT_INTENTS = "practiq-import-intents-v1";
const REPARSE_INTENTS = "practiq-reparse-intents-v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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
export function fileFormat(file: SourceFile) {
  const format = formats[file.name.trim().split(".").at(-1)?.toLowerCase() || ""];
  if (!format || file.name.length > 255) throw new ApiError("请选择支持的文档格式，文件名最多 255 个字符。", "UNSUPPORTED_FILE");
  return format;
}
export function validateFiles(files: SourceFile[], capabilities: Capabilities) {
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
async function readChunks(response: Response, maximum: number, signal?: AbortSignal) {
  if (Number(response.headers.get("content-length")) > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maximum) throw new ApiError("响应超过浏览器大小限制。", "RESPONSE_TOO_LARGE");
    return [bytes];
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
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
  return chunks;
}

export async function readBytes(response: Response, maximum: number, signal?: AbortSignal) {
  const chunks = await readChunks(response, maximum, signal);
  if (!response.body) return chunks[0];
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
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
  constructor(readonly administrative = false) {}
  readonly storageScope = accountStorageScope();
  private readonly native = nativeBridge();
  private readonly session = new AbortController();
  private readonly intents = new Map<string, string>();
  get active() { return !this.session.signal.aborted && this.storageScope === accountStorageScope() && this.native === nativeBridge(); }
  disconnect() { this.session.abort(); this.intents.clear(); }
  private async request<T>(path: string, init: RequestInit, read: (response: Response, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (!path.startsWith("/api/") || path.startsWith("//")) throw new ApiError("服务返回了无效地址。", "INVALID_URL");
    const headers = new Headers(init.headers);
    accountHeaders(headers);
    if (this.administrative && (path.startsWith('/api/document-tasks') || path.startsWith('/api/artifacts/') || path === '/api/import-settings')) path = path.replace('/api/', '/api/admin/');
    const signals = [this.session.signal];
    if (signal) signals.push(signal);
    const pathname = path.split("?")[0].replace("/api/admin/", "/api/");
    const upload = pathname === "/api/uploads" || pathname === "/api/uploads/content";
    // Upload transport and POST artifact reads do not create tasks.
    const mutation = !!init.method && !["GET", "HEAD"].includes(init.method) && !upload && pathname !== "/api/artifacts/read";
    const uploadRetry = "文件上传未确认，请检查连接后手动重试上传。";
    const timeout = path.includes("/export?") ? 600_000 : init.method && !["GET", "HEAD"].includes(init.method) ? 125_000 : 30_000;
    return withDeadline(timeout, signals, async requestSignal => {
      let response: Response;
      try {
        response = await (this.native ? this.native.fetch.bind(this.native) : serviceFetch)(path, { ...init, headers, cache: "no-store", credentials: "same-origin", redirect: "error", signal: requestSignal });
      } catch {
        if (!this.active || signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        throw new ApiError(upload ? uploadRetry : mutation ? "连接中断，操作结果尚未确认。请先查询原任务，再决定是否重试。" : "无法连接服务。请检查服务状态，再手动重试读取。", "NETWORK_ERROR");
      }
      try {
        if (!response.ok) {
          if (response.status === 401) sessionExpired();
          let code = `HTTP_${response.status}`;
          try {
            const body = JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * 1024, requestSignal))) as { detail?: { code?: string } };
            if (body.detail?.code && /^[A-Z0-9_]{1,64}$/.test(body.detail.code)) code = body.detail.code;
          } catch { /* Error bodies may be empty, text, or validation arrays. */ }
          const known: Record<string, string> = {
            USER_QUOTA_EXCEEDED: '每日调用额度已用尽，请等待新加坡时间次日零点或联系管理员调整额度，然后手动继续。',
            FREE_PAGE_QUOTA_EXCEEDED: '剩余免费页数不足。新账户默认共有 50 页免费额度，不按日恢复；请联系管理员调整额度。',
            USER_TASK_LIMIT: '进行中的任务已达到个人上限，请等待任务停止或完成后再手动提交。',
            ACCOUNT_DISABLED: '账户已停用，请联系管理员。',

            DOCUMENT_TOO_LARGE: "文件超过服务限制，请选择较小的文件。",
            UNSUPPORTED_FILE: "服务不支持此文件格式，请更换文件。",
            OFFICE_NOT_FOUND: "服务尚未配置 Office 转换，请联系服务提供方或改用 PDF。",
            OFFICE_NOT_CONFIGURED: "服务尚未配置 Office 转换，请联系服务提供方或改用 PDF。本次提交未创建任务，可以修正配置后手动重新提交。",
            TENCENT_NOT_CONFIGURED: "服务尚未配置腾讯文档解析，请联系服务提供方。本次提交未创建任务，可以修正配置后手动重新提交。",
            STALE_RUN: "任务状态已更新，请刷新任务详情后再操作。",
            SOURCE_SELECTION_INVALID: "所选页码或来源单元不可用，请核对原文件和任务检查点。",
            ANSWER_SOURCE_UNAVAILABLE: "请选择已完成且以答案卷用途导入的任务；来源可能尚未完成或已过期。",
            ANSWER_SOURCE_STALE: "答案卷检查点已变化，请重新读取匹配建议。",
            ANSWER_REPLACEMENT_REQUIRED: "题目已有参考答案，请明确确认替换后再保存。",
            ANSWER_MATCH_INVALID: "答案与所选来源或题型不一致，请核对，或改为人工编辑。",
            CORRECTION_CONFLICT: "其他窗口已保存修订，请重新读取后核对，草稿仍保留。",
            CORRECTION_INVALID: "修改与题组或答案引用冲突，请核对选项、作答方式和所属材料。",
            CORRECTION_PROTECTED_FIELD: "来源证据、资源和题组关联不可修改。",
            CORRECTION_NOT_READY: "任务尚未完成或结果已变化，请刷新后再校对。",
            CORRECTION_HISTORY_LIMIT: "此检查点的修订记录已达上限，请下载修订版后继续在练习应用中编辑。",
            SERVICE_READ_ONLY: "服务当前只读，无法保存修改。",
            STALE_CHECKPOINT: "任务检查点已变化，请刷新后重新核对。",
            TASK_BUSY: "任务正在处理，请等待并刷新状态。",
          };
          const exportRecovery: Record<string, string> = pathname.endsWith("/export") ? {
            BANK_EXPORT_TOO_LARGE: "题库超过 ZIP、题目或资源数量限制。请拆分原文后分别解析和导出；重复下载不能解决超限。",
            BANK_EXPORT_INVALID: "题库内容或资源不符合导入要求。请检查解析结果，修复资源或重新解析原文后再导出。",
            OBJECT_NOT_FOUND: "原文件或资源已丢失。请恢复服务端原文件或资源，或重新解析原文后再导出；重复下载不能修复资源。",
            DOCUMENT_SIZE_MISMATCH: "原文件或资源大小校验失败。请恢复服务端原文件或资源，或重新解析原文后再导出。",
            DOCUMENT_CHECKSUM_MISMATCH: "原文件或资源校验失败。请恢复服务端原文件或资源，或重新解析原文后再导出。",
            STALE_CHECKPOINT: "任务在导出前或导出期间已变化。请刷新任务详情和检查点预览，核对结果后再下载。",
            BANK_EXPORT_NOT_READY: "当前没有可导出的已完成题目。请刷新任务详情，按任务状态等待处理完成或处理失败单元。",
            TEMPORARY_BUSY: "服务端临时存储空间或并发容量正忙。请稍后手动重试下载，无需重新解析原文。",
          } : {};
          const message = response.status === 401 || response.status === 403 ? "服务拒绝了请求，请检查服务或反向代理的访问配置。"
            : exportRecovery[code] ?? known[code] ?? (response.status === 429 ? "请求过于频繁，请稍后再操作。"
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
    if (settings && ((settings.deduplicateQuestions !== undefined && typeof settings.deduplicateQuestions !== "boolean") || (settings.generateAnswers !== undefined && typeof settings.generateAnswers !== "boolean"))) throw new ApiError("导入设置响应无效，请重新读取。", "INVALID_RESPONSE");
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
  answerMatches(task: DocumentTaskDetail, answerTaskId: string) {
    return this.json<DocumentAnswerMatches>(`/api/document-tasks/${encodeURIComponent(task.threadId)}/answer-matches?${new URLSearchParams({ checkpoint_id: task.checkpointId!, answer_task_id: answerTaskId })}`);
  }
  answerProposal(task: DocumentTaskDetail, questionIndex: number, source: DocumentAnswerSource) {
    const query = new URLSearchParams({ checkpoint_id: task.checkpointId!, question_index: String(questionIndex), answer_task_id: source.taskId, answer_checkpoint_id: source.checkpointId, answer_question_index: String(source.questionIndex), replace_existing: String(!!source.replaceExisting) });
    return this.json<DocumentAnswerProposal>(`/api/document-tasks/${encodeURIComponent(task.threadId)}/answer-proposal?${query}`);
  }
  corrections(id: string) { return this.json<DocumentCorrections>(`/api/document-tasks/${encodeURIComponent(id)}/corrections`); }
  async saveCorrection(id: string, value: DocumentCorrectionSave) {
    const saved = await this.json<DocumentCorrections>(`/api/document-tasks/${encodeURIComponent(id)}/corrections`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    if (saved.checkpointId !== value.checkpointId || !Array.isArray(saved.edits) || !saved.edits.some(edit => edit.requestId === value.requestId && edit.questionIndex === value.questionIndex)) throw new ApiError("修订回执未确认，请重新读取已保存修订。", "INVALID_RESPONSE");
    return saved;
  }
  head(id: string, signal?: AbortSignal) { return this.json<DocumentTaskHead>(`/api/document-tasks/${encodeURIComponent(id)}/head`, undefined, signal); }
  preview(id: string, signal?: AbortSignal, includeResult = true) { return this.json<DocumentTaskReview>(`/api/document-tasks/${encodeURIComponent(id)}/preview${includeResult ? "" : "?include_result=false"}`, undefined, signal); }
  pendingImports(): DocumentTaskCreate[] {
    try {
      const raw = localStorage.getItem(storageKey(IMPORT_INTENTS, this.storageScope));
      if (!raw) return [];
      if (raw.length > 1024 * 1024) throw new Error();
      const records: DocumentTaskCreate[] = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > 50 || !records.every(record => {
        const document = record?.document;
        return record && Object.keys(record).every(key => ["requestId", "document", "graphId", "failurePolicy", "deduplicateQuestions", "generateAnswers", "pages", "documentRole"].includes(key))
          && uuid.test(record.requestId) && record.graphId === "document_parser" && record.failurePolicy === "return_partial"
          && (record.deduplicateQuestions === undefined || typeof record.deduplicateQuestions === "boolean")
          && (record.generateAnswers === undefined || typeof record.generateAnswers === "boolean")
          && validPages(record.pages) && (record.documentRole === undefined || ["questions", "answers"].includes(record.documentRole))
          && document && Object.keys(document).length === 6
          && typeof document.fileName === "string" && document.fileName.length > 0 && document.fileName.length <= 255
          && typeof document.sha256 === "string" && /^[a-f0-9]{64}$/.test(document.sha256)
          && Number.isSafeInteger(document.sizeBytes) && document.sizeBytes > 0
          && Object.values(formats).some(format => format.sourceType === document.sourceType && format.mediaType === document.mediaType)
          && document.objectKey === `practiq-agent/sources/${document.sha256}/source.${document.sourceType === "text" ? "txt" : document.sourceType === "markdown" ? "md" : document.sourceType}`;
      }) || new Set(records.map(record => record.requestId)).size !== records.length) throw new Error();
      return records;
    } catch {
      throw new ApiError("无法读取本机的原提交恢复记录。请先核对导入记录并检查浏览器存储，勿重复提交。", "RECOVERY_STORAGE_UNAVAILABLE");
    }
  }
  private saveImports(records: DocumentTaskCreate[]) {
    try {
      if (records.length > 50 || JSON.stringify(records).length > 1024 * 1024) throw new Error();
      if (records.length) localStorage.setItem(storageKey(IMPORT_INTENTS, this.storageScope), JSON.stringify(records));
      else localStorage.removeItem(storageKey(IMPORT_INTENTS, this.storageScope));
    } catch {
      throw new ApiError("无法保存原提交恢复记录。请检查浏览器存储并核对导入记录，勿重复提交。", "RECOVERY_STORAGE_UNAVAILABLE");
    }
  }
  async retryImport(requestId: string) {
    const request = this.pendingImports().find(record => record.requestId === requestId);
    if (!request) throw new ApiError("原提交恢复记录不存在，请先核对导入记录。", "ACTION_UNAVAILABLE");
    const receipt = await this.receipt("/api/document-tasks", request);
    this.saveImports(this.pendingImports().filter(record => record.requestId !== requestId));
    return receipt;
  }
  forgetImport(requestId: string) { this.saveImports(this.pendingImports().filter(record => record.requestId !== requestId)); }
  async start(file: SourceFile, capabilities: Capabilities, requestId: string, onStage: (stage: UploadStage, requestId?: string) => void, deduplicateQuestions = false, generateAnswers = false, pages?: number[] | null, documentRole: "questions" | "answers" = "questions") {
    validateFiles([file], capabilities);
    const format = fileFormat(file);
    if (!validPages(pages) || pages && ["text", "markdown"].includes(format.sourceType)) throw new ApiError("TXT/Markdown 不使用页码；其他文件请选择有效页面。", "SOURCE_SELECTION_INVALID");
    if (documentRole === "answers" && generateAnswers) throw new ApiError("答案卷仅提取已有答案，请关闭自动生成。", "ANSWER_MATCH_INVALID");
    if (capabilities.parserConfigured === false) throw new ApiError("服务端尚未配置腾讯文档解析。", "TENCENT_NOT_CONFIGURED");
    if (!capabilities.modelConfigured) throw new ApiError("服务端尚未配置模型。", "MODEL_NOT_CONFIGURED");
    onStage("hashing");
    let document: DocumentReference;
    let metadata: Omit<DocumentReference, "objectKey">;
    if (!this.active) throw new DOMException("Disconnected", "AbortError");
    if (file.nativeTicket && this.native) {
      onStage("uploading");
      document = await this.native.upload(file.nativeTicket);
      metadata = { ...format, fileName: file.name.trim(), sizeBytes: file.size, sha256: document.sha256 };
      if (document.fileName !== metadata.fileName || document.sizeBytes !== metadata.sizeBytes || document.sourceType !== format.sourceType || document.mediaType !== format.mediaType) throw new ApiError("上传后的文件引用不匹配。", "INVALID_REFERENCE");
    } else {
    const bytes = await file.arrayBuffer!();
    if (bytes.byteLength !== file.size) throw new ApiError("文件内容与声明大小不一致。", "DOCUMENT_SIZE_MISMATCH");
    metadata = { ...format, fileName: file.name.trim(), sizeBytes: file.size, sha256: await sha256(bytes) };
    onStage("uploading");
    const prepared = await this.post<DocumentUploadResponse>("/api/uploads", metadata);
    document = prepared.document;
    const suffix = format.sourceType === "text" ? "txt" : format.sourceType === "markdown" ? "md" : format.sourceType;
    if (document.sha256 !== metadata.sha256 || document.sizeBytes !== metadata.sizeBytes || document.mediaType !== metadata.mediaType || document.sourceType !== metadata.sourceType || document.fileName !== metadata.fileName || document.objectKey !== `practiq-agent/sources/${metadata.sha256}/source.${suffix}`) throw new ApiError("服务返回的文件引用不匹配。", "INVALID_REFERENCE");
    if (prepared.upload) {
      const url = new URL(prepared.upload.url, location.origin);
      const keys = Object.keys(metadata) as (keyof typeof metadata)[];
      if (prepared.upload.method !== "PUT" || url.origin !== location.origin || url.pathname !== "/api/uploads/content" || url.hash || Array.from(url.searchParams).length !== keys.length || !keys.every(key => url.searchParams.get(key) === String(metadata[key]))) throw new ApiError("服务返回的上传地址不匹配。", "INVALID_URL");
      const uploaded = await this.json<UploadDocument>(url.pathname + url.search, { method: "PUT", headers: { "Content-Type": metadata.mediaType }, body: bytes });
      if (Object.keys(document).some(key => uploaded[key as keyof UploadDocument] !== document[key as keyof UploadDocument])) throw new ApiError("上传后的文件引用不匹配。", "INVALID_REFERENCE");
    }
    }
    const pending = this.pendingImports();
    const original = pending.find(record => record.document.sha256 === document.sha256 && record.document.sourceType === document.sourceType);
    if (original && (JSON.stringify(original.pages ?? null) !== JSON.stringify(pages ?? null) || (original.documentRole ?? "questions") !== documentRole)) throw new ApiError("此文件有未确认的原提交，请先使用原请求恢复后再更改范围或用途。", "RECOVERY_PENDING");
    requestId = original?.requestId ?? requestId;
    if (!original) {
      const request: DocumentTaskCreate = { requestId, document: { ...metadata, objectKey: document.objectKey }, graphId: "document_parser", failurePolicy: "return_partial", ...(deduplicateQuestions ? { deduplicateQuestions: true } : {}), ...(generateAnswers ? { generateAnswers: true } : {}), ...(pages ? { pages } : {}), ...(documentRole === "answers" ? { documentRole } : {}) };
      this.saveImports([...pending, request]);
    }
    onStage("starting", requestId);
    return this.retryImport(requestId);
  }
  async control(task: DocumentTaskDetail, action: Action) {
    const running = action === "pause" || action === "interrupt";
    if (!task.allowedActions.includes(action) || (running ? !task.runId : !task.checkpointId)) throw new ApiError("此检查点暂不允许该操作，请刷新任务。", "ACTION_UNAVAILABLE");
    if (!running && (!task.modelConfigured || !task.resumeCompatible)) throw new ApiError("服务模型未配置或检查点不兼容，无法继续。", "MODEL_NOT_CONFIGURED");
    const target = running ? task.runId : task.checkpointId;
    return this.intent(`control:${task.threadId}:${action}:${target}`, requestId => { const request: DocumentTaskControl = { requestId, action, runId: running ? task.runId : null, checkpointId: running ? null : task.checkpointId, units: [] }; return this.receipt(`/api/document-tasks/${encodeURIComponent(task.threadId)}/control`, request); });
  }
  pendingReparses(): ReparseIntent[] {
    try {
      const raw = localStorage.getItem(storageKey(REPARSE_INTENTS, this.storageScope));
      if (raw === null) return [];
      if (raw.length > 4 * 1024 * 1024) throw new Error();
      const records: ReparseIntent[] = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > 50 || !records.every(record => record && Object.keys(record).every(k => ["requestId", "threadId", "selection"].includes(k)) && validReparseSelection(record.selection)
        && typeof record.requestId === "string" && uuid.test(record.requestId)
        && typeof record.threadId === "string" && uuid.test(record.threadId))
        || new Set(records.map(record => record.requestId.toLowerCase())).size !== records.length
        || new Set(records.map(record => record.threadId.toLowerCase())).size !== records.length) throw new Error();
      return records;
    } catch {
      throw new ApiError("无法读取本机的重新解析恢复记录。请先核对导入记录并检查浏览器存储，勿重复提交。", "RECOVERY_STORAGE_UNAVAILABLE");
    }
  }
  private saveReparses(records: ReparseIntent[]) {
    try {
      if (records.length > 50 || JSON.stringify(records).length > 4 * 1024 * 1024) throw new Error();
      if (records.length) localStorage.setItem(storageKey(REPARSE_INTENTS, this.storageScope), JSON.stringify(records));
      else localStorage.removeItem(storageKey(REPARSE_INTENTS, this.storageScope));
    } catch {
      throw new ApiError("无法保存重新解析恢复记录。请检查浏览器存储并核对导入记录，勿重复提交。", "RECOVERY_STORAGE_UNAVAILABLE");
    }
  }
  async retryReparse(requestId: string) {
    const request = this.pendingReparses().find(record => record.requestId === requestId);
    if (!request) throw new ApiError("重新解析恢复记录不存在，请先核对导入记录。", "ACTION_UNAVAILABLE");
    const receipt = await this.receipt(`/api/document-tasks/${encodeURIComponent(request.threadId)}/reparse`, { requestId: request.requestId, ...(request.selection ? { selection: request.selection } : {}) });
    this.saveReparses(this.pendingReparses().filter(record => record.requestId !== requestId));
    return receipt;
  }
  forgetReparse(requestId: string) { this.saveReparses(this.pendingReparses().filter(record => record.requestId !== requestId)); }
  async reparse(id: string, selection?: DocumentReparseSelection) {
    if (!this.active) throw new DOMException("请求已取消", "AbortError");
    if (!uuid.test(id)) throw new ApiError("任务引用无效。", "INVALID_REFERENCE");
    const pending = this.pendingReparses();
    const original = pending.find(record => record.threadId.toLowerCase() === id.toLowerCase());
    if (!validReparseSelection(selection)) throw new ApiError("请选择有效来源单元。", "SOURCE_SELECTION_INVALID");
    if (original && JSON.stringify(original.selection ?? null) !== JSON.stringify(selection ?? null)) throw new ApiError("此任务有未确认的重新解析，请先沿用原请求恢复。", "RECOVERY_PENDING");
    const requestId = original?.requestId ?? crypto.randomUUID();
    if (!original) this.saveReparses([...pending, { threadId: id, requestId, ...(selection ? { selection } : {}) }]);
    return this.retryReparse(requestId);
  }
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
  async exportBank(task: DocumentTaskDetail, revisionId?: string, questionIndexes?: number[]) {
    if ((!task.canExportCompleted && (task.state !== "COMPLETED" || !task.result)) || !task.checkpointId) throw new ApiError("任务结果尚不可导出。", "BANK_EXPORT_NOT_READY");
    const query = new URLSearchParams({ checkpoint_id: task.checkpointId, scope: task.state === "COMPLETED" ? "full" : "completed" });
    if (revisionId) query.set("revision_id", revisionId);
    if (questionIndexes) {
      if (!questionIndexes.length || questionIndexes.length > 2000 || questionIndexes.some(v => !Number.isSafeInteger(v) || v < 0 || !task.result || v >= task.result.questions.length)) throw new ApiError("请选择当前结果中的题目。", "SOURCE_SELECTION_INVALID");
      for (const index of questionIndexes) query.append("question_index", String(index));
    }
    if (!this.active) throw new DOMException("Disconnected", "AbortError");
    if (this.native) {
      const saved = await this.native.download(`/api/document-tasks/${encodeURIComponent(task.threadId)}/export?${query}`, `practiq-bank-${task.threadId}.zip`);
      if (!saved) throw new ApiError("已取消保存题库。", "DOWNLOAD_CANCELLED");
      return { blob: null, name: `practiq-bank-${task.threadId}.zip` };
    }
    return this.request(`/api/document-tasks/${encodeURIComponent(task.threadId)}/export?${query}`, {}, async (response, signal) => {
      if (response.headers.get("content-type")?.split(";")[0] !== "application/zip") throw new ApiError("服务未返回题库 ZIP。", "INVALID_RESPONSE");
      return { blob: new Blob(await readChunks(response, MAX_BANK_ZIP_BYTES, signal), { type: "application/zip" }), name: `practiq-bank-${revisionId ? "revised-" : ""}${task.threadId.replace(/[^a-zA-Z0-9-]/g, "")}.zip` };
    });
  }
}

export async function downloadBlob(blob: Blob | null, name: string) {
  if (!blob) return;
  const native = nativeBridge();
  if (native) { const saved = await native.save(new Uint8Array(await blob.arrayBuffer()), name); if (!saved) throw new ApiError("已取消保存文件。", "DOWNLOAD_CANCELLED"); return; }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  // Retain the URL through the browser's download handoff, then release it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
