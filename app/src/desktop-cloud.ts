import { ApiError } from "../../shared/cloud/api";
import type { NativeBridge, SourceFile } from "../../shared/cloud/transport";
import type { DesktopAiSettingsView, DesktopDocumentReply, DocumentReference } from "./contracts.generated";
import { errorMessage } from "./api";
import { invoke } from "./transport";
import { t } from "../../shared/cloud/i18n";

export const DESKTOP_AI_ORIGIN = "practiq://embedded-ai";
export async function desktopAiRequest<T>(request: Record<string, unknown>): Promise<T> {
  try { return await invoke<T>("request", { request }); }
  catch (cause) {
    const code = (cause as { code?: string })?.code ?? "AI_RUNTIME_UNAVAILABLE";
    const status = ["CORRECTION_CONFLICT", "CORRECTION_NOT_READY", "STALE_CHECKPOINT", "ANSWER_SOURCE_UNAVAILABLE", "ANSWER_SOURCE_STALE", "ANSWER_REPLACEMENT_REQUIRED", "REQUEST_CONFLICT", "TASK_EXPIRED"].includes(code) ? 409 : ["CORRECTION_INVALID", "CORRECTION_PROTECTED_FIELD", "ANSWER_MATCH_INVALID", "SOURCE_SELECTION_INVALID"].includes(code) ? 422 : ["CORRECTION_HISTORY_LIMIT", "REQUEST_TOO_LARGE"].includes(code) ? 413 : 0;
    throw new ApiError(errorMessage(cause, false), code, status);
  }
}
export function desktopCloudBridge(settings: DesktopAiSettingsView): NativeBridge {
  const bridge: NativeBridge = {
    origin: DESKTOP_AI_ORIGIN, revision: settings.revision,
    confirm: async message => window.confirm(message),
    fetch: async () => { throw new ApiError(t("此操作尚未完成迁移。"), "ACTION_UNAVAILABLE"); },
    async documents(request) {
      const reply = await desktopAiRequest<DesktopDocumentReply>({ type: "document_request", request });
      if (!reply || reply.type !== request.type) throw new ApiError(t("任务响应无效，请重新读取。"), "INVALID_RESPONSE");
      if (reply.type === "import_settings" || reply.type === "save_import_settings") bridge.revision = reply.value.revision;
      return reply;
    },
    pickSources: () => desktopAiRequest<SourceFile[]>({ type: "pick_document_sources" }),
    upload: ticket => desktopAiRequest<DocumentReference>({ type: "upload_document_source", ticket }),
    download: async () => { throw new ApiError(t("此操作尚未完成迁移。"), "ACTION_UNAVAILABLE"); },
    save: (bytes, name) => desktopAiRequest<boolean>({ type: "save_document_bytes", bytes: new Uint8Array(bytes).buffer, name }),
  };
  return bridge;
}
