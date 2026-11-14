import { RpcWorker } from "./rpc-worker.js";
import type { AiSnapshot } from "./ai-settings.js";
import type { StructuredInput } from "./model.js";
import type { TencentSource } from "./tencent.js";
import { AppError } from "./errors.js";
import type { PreparedGrade } from "./grading.js";
import type { DesktopDocumentBankSelection, DesktopDocumentRequest, DesktopSourceRepairRequest } from "../src/contracts.generated.js";
import type { DocumentConfiguration } from "./document-tasks.js";

export type AiWorkerRequest = { type: "status" }
  | { type: "pick_sources"; paths: string[]; revision: string }
  | { type: "upload_source"; ticket: string; revision: string }
  | { type: "document"; request: DesktopDocumentRequest; config: DocumentConfiguration }
  | { type: "repair_source"; threadId: string; value: DesktopSourceRepairRequest; path: string | null }
  | { type: "export_bank_zip"; value: DesktopDocumentBankSelection; config: DocumentConfiguration; path: string }
  | { type: "create_task"; sourceDigest: string; maxCalls: number }
  | { type: "structured"; taskId: string; key: string; input: StructuredInput; config: AiSnapshot }
  | { type: "grade"; prepared: PreparedGrade; config: AiSnapshot }
  | { type: "tencent_submit"; taskId: string; key: string; source: { sha256: string; type: TencentSource; bytes: Uint8Array }; config: AiSnapshot }
  | { type: "tencent_query"; taskId: string; key: string; config: AiSnapshot };
export class AiClient extends RpcWorker {
  constructor(directory: string) { super(new URL("./ai-worker.js", import.meta.url), directory, "AI_RUNTIME_UNAVAILABLE", "AI worker is unavailable; restart the app"); }
  async call<T>(request: AiWorkerRequest): Promise<T> { const reply = await this.request(request); if (!reply.ok) throw new AppError(reply.error.code, reply.error.message, reply.error.params); return reply.value as T; }
}
