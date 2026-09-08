import { ApiClientError, isRetryableWriteError } from "../api/client";
import { newWriteKey } from "../api/write-attempts";
import type { createApi } from "../api/modules";

export interface TransferFile {
  path: string;
  name: string;
  digest: string;
  size: number;
}
interface Transfer {
  scope: number;
  file: TransferFile;
  createdAt: number;
  blocked?: boolean;
}
export interface ImportTransfer extends Transfer {
  bankId: number;
  jobId?: number;
  stage: "create" | "upload" | "parse";
  keys: { create: string; upload: string; parse: string };
}
export interface MediaTransfer extends Transfer {
  questionId: number;
  mediaId?: number;
  stage: "upload" | "link";
  keys: { upload: string; link: string };
}
type Api = ReturnType<typeof createApi>;

// Only already-started import/media operations: no page data, answers or general drafts.
export class PendingTransfers {
  private revision = 0;
  private readonly imports = new Map<number, ImportTransfer>();
  private readonly media = new Map<number, MediaTransfer>();
  constructor(
    private readonly forget: (keys: string[]) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}
  scope(): number {
    return this.revision;
  }
  check(scope: number): void {
    if (scope !== this.revision)
      throw new ApiClientError(0, "STALE_RESPONSE", "账号或访问权限已变化");
  }
  importFor(scope: number, bankId?: number): ImportTransfer | undefined {
    if (scope !== this.revision) return undefined;
    const values = [...this.imports.values()];
    return bankId ? this.imports.get(bankId) : values[values.length - 1];
  }
  mediaFor(scope: number, questionId: number): MediaTransfer | undefined {
    if (scope !== this.revision) return undefined;
    return this.media.get(questionId);
  }
  beginImport(
    scope: number,
    bankId: number,
    file: TransferFile,
  ): ImportTransfer {
    this.check(scope);
    const existing = this.imports.get(bankId);
    if (existing) {
      this.sameFile(existing.file, file);
      return existing;
    }
    const value: ImportTransfer = {
      scope,
      bankId,
      file: { ...file },
      createdAt: this.now(),
      stage: "create",
      keys: {
        create: newWriteKey(),
        upload: newWriteKey(),
        parse: newWriteKey(),
      },
    };
    this.imports.set(bankId, value);
    return value;
  }
  beginMedia(
    scope: number,
    questionId: number,
    file: TransferFile,
  ): MediaTransfer {
    this.check(scope);
    const existing = this.media.get(questionId);
    if (existing) {
      this.sameFile(existing.file, file);
      return existing;
    }
    const value: MediaTransfer = {
      scope,
      questionId,
      file: { ...file },
      createdAt: this.now(),
      stage: "upload",
      keys: { upload: newWriteKey(), link: newWriteKey() },
    };
    this.media.set(questionId, value);
    return value;
  }
  endImport(value: ImportTransfer): void {
    if (this.imports.get(value.bankId) === value) {
      this.imports.delete(value.bankId);
      this.forget(Object.values(value.keys));
    }
  }
  endMedia(value: MediaTransfer): void {
    if (this.media.get(value.questionId) === value) {
      this.media.delete(value.questionId);
      this.forget(Object.values(value.keys));
    }
  }
  clear(): void {
    this.revision += 1;
    for (const value of this.imports.values()) this.endImport(value);
    for (const value of this.media.values()) this.endMedia(value);
  }
  private sameFile(original: TransferFile, selected: TransferFile): void {
    if (
      original.path !== selected.path ||
      original.name !== selected.name ||
      original.digest !== selected.digest ||
      original.size !== selected.size
    )
      throw new Error(
        "已有未完成操作，不能用新文件直接重放。请先明确放弃本地恢复；这不会取消或删除服务端任务。",
      );
  }
  private current(value: ImportTransfer | MediaTransfer): void {
    this.check(value.scope);
    if (
      "bankId" in value
        ? this.imports.get(value.bankId) !== value
        : this.media.get(value.questionId) !== value
    )
      throw new ApiClientError(
        0,
        "STALE_RESPONSE",
        "本地恢复已结束，不会继续后续操作",
      );
    if (value.blocked || this.now() - value.createdAt >= 24 * 60 * 60_000)
      throw new Error(
        "原操作已被拒绝或超过重试窗口，请核对服务端状态后明确放弃本地恢复；不会自动新建或取消任务。",
      );
  }
  async runImport(
    api: Api,
    value: ImportTransfer,
    verifyFile: (file: TransferFile) => Promise<void>,
  ): Promise<number> {
    try {
      this.current(value);
      await api.banks.get(value.bankId);
      this.current(value);
      if (!value.jobId) {
        await verifyFile(value.file);
        this.current(value);
        const job = await api.imports.create(
          {
            bankId: value.bankId,
            fileName: value.file.name,
            sourceType:
              value.file.name.split(".").pop()?.toLowerCase() || "unknown",
            requestPayload: {},
          },
          value.keys.create,
        );
        this.current(value);
        value.jobId = job.id;
        value.stage = "upload";
      }
      const job = await api.imports.get(value.jobId);
      this.current(value);
      if (job.bank_id !== value.bankId)
        throw new Error("导入目标已变化，请核对任务");
      if (job.status !== "queued") {
        this.endImport(value);
        return value.jobId;
      }
      if (Number(job.source_size_bytes) > 0) value.stage = "parse";
      if (value.stage === "upload") {
        await verifyFile(value.file);
        this.current(value);
        await api.imports.upload(
          value.jobId,
          value.file.path,
          value.keys.upload,
        );
        this.current(value);
        value.stage = "parse";
      }
      await api.imports.action(
        value.jobId,
        "parse",
        { persistQuestions: true },
        value.keys.parse,
      );
      this.current(value);
      this.endImport(value);
      return value.jobId;
    } catch (error) {
      if (!isRetryableWriteError(error)) {
        if (value.jobId) value.blocked = true;
        else this.endImport(value);
      }
      throw error;
    }
  }
  async runMedia(
    api: Api,
    value: MediaTransfer,
    verifyFile: (file: TransferFile) => Promise<void>,
  ): Promise<void> {
    try {
      this.current(value);
      await api.questions.management(value.questionId);
      this.current(value);
      if (!value.mediaId) {
        await verifyFile(value.file);
        this.current(value);
        const media = await api.media.upload(
          value.file.path,
          value.keys.upload,
        );
        this.current(value);
        value.mediaId = media.id;
        value.stage = "link";
      }
      const media = await api.media.get(value.mediaId);
      this.current(value);
      await api.media.linkQuestion(
        value.questionId,
        value.mediaId,
        media.mime_type.startsWith("image/") ? "image" : "attachment",
        1,
        value.keys.link,
      );
      this.current(value);
      this.endMedia(value);
    } catch (error) {
      if (!isRetryableWriteError(error)) {
        if (value.mediaId) value.blocked = true;
        else this.endMedia(value);
      }
      throw error;
    }
  }
}
