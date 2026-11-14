import type { DesktopBankZipReceipt, DesktopDocumentReply, DesktopDocumentRequest, DesktopSourceRepairResult, DocumentReference } from "../src/contracts.generated.js";
import { AiClient } from "./ai-client.js";
import { AiSettings } from "./ai-settings.js";
import { validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import { DatabaseClient } from "./client.js";
import { importDocumentBank } from "./document-bank-import.js";

/** Only explicit execution receives credentials; an acknowledged create can be recovered keylessly. */
export async function documentAction(input: unknown, settings: AiSettings, client: () => AiClient, database?: DatabaseClient, pickSource?: (document: DocumentReference) => Promise<string | null>, saveBank?: (name: string) => Promise<string | null>): Promise<DesktopDocumentReply> {
  validateContract("DesktopDocumentRequest", input); const request = input as DesktopDocumentRequest, view = await settings.view(), starts = request.type === "create" || request.type === "reparse" || request.type === "control" && ["resume", "retry_failed"].includes(request.value.action);
  if (request.type === "export_bank_zip") {
    invariant(saveBank, "ACTION_UNAVAILABLE", "Bank ZIP export requires a native save dialog");
    const worker = client(), head = await worker.call<DesktopDocumentReply>({ type: "document", request: { type: "head", revision: view.revision, threadId: request.value.threadId }, config: view }); validateContract("DesktopDocumentReply", head);
    invariant(head.type === "head" && head.value.threadId === request.value.threadId.toLowerCase() && head.value.checkpointId === request.value.checkpointId, "STALE_CHECKPOINT", "The reviewed checkpoint changed before ZIP export");
    invariant(!["EXPIRED", "PENDING", "RUNNING", "PAUSING"].includes(head.value.state) && (head.value.state === "COMPLETED" || request.value.scope === "completed"), "BANK_EXPORT_NOT_READY", "This checkpoint has no exportable saved result");
    const path = await saveBank(`practiq-bank-${request.value.revisionId ? "revised-" : ""}${request.value.threadId.toLowerCase()}.zip`);
    const value = path === null ? { threadId: request.value.threadId.toLowerCase(), checkpointId: request.value.checkpointId, saved: false } : await worker.call<DesktopBankZipReceipt>({ type: "export_bank_zip", value: request.value, config: view, path });
    const reply = { type: "export_bank_zip" as const, value }; validateContract("DesktopDocumentReply", reply);
    invariant(value.threadId === request.value.threadId.toLowerCase() && value.checkpointId === request.value.checkpointId, "LOCAL_RESPONSE_INVALID", "Bank ZIP receipt belongs to another task checkpoint"); return reply;
  }
  if (request.type === "repair_source") {
    const worker = client(), repair = (path: string | null) => worker.call<DesktopSourceRepairResult | null>({ type: "repair_source", threadId: request.threadId, value: request.value, path });
    let value = await repair(null);
    if (!value) {
      invariant(pickSource, "ACTION_UNAVAILABLE", "Source repair requires a native file picker");
      const status = await worker.call<DesktopDocumentReply>({ type: "document", request: { type: "source_status", revision: view.revision, threadId: request.threadId }, config: view }); validateContract("DesktopDocumentReply", status);
      invariant(status.type === "source_status" && status.value.threadId === request.threadId, "LOCAL_RESPONSE_INVALID", "Source status belongs to another task");
      const path = await pickSource(status.value.document);
      value = path === null ? { threadId: request.threadId, requestId: request.value.requestId, status: "cancelled", quarantineId: null } : await repair(path);
    }
    invariant(value && value.threadId === request.threadId && value.requestId === request.value.requestId, "LOCAL_RESPONSE_INVALID", "Source repair receipt belongs to another request");
    const reply = { type: "repair_source" as const, value }; validateContract("DesktopDocumentReply", reply); return reply;
  }
  if (request.type === "import_bank") { invariant(database, "LOCAL_DATABASE_UNAVAILABLE", "Practice database is unavailable"); return { type: "import_bank", value: await importDocumentBank(request, view, client(), database) }; }
  if (request.type === "save_import_settings") {
    invariant(request.revision === view.revision && request.value.revision === view.revision, "IMPORT_SETTINGS_CONFLICT", "AI settings changed; reload before saving");
    const saved = await settings.save({ revision: view.revision, preferences: { ...view.preferences, import: request.value.settings } });
    const reply = { type: request.type, value: { revision: saved.revision, settings: saved.preferences.import } }; validateContract("DesktopDocumentReply", reply); return reply;
  }
  if (starts) invariant(request.revision === view.revision, "LOCAL_SETTINGS_CHANGED", "AI settings changed; inspect the original task before starting more work");
  const call = async (config: Awaited<ReturnType<AiSettings["view"]>> | Awaited<ReturnType<AiSettings["snapshot"]>>) => {
    const reply = await client().call<DesktopDocumentReply>({ type: "document", request, config }); validateContract("DesktopDocumentReply", reply); invariant(reply.type === request.type, "LOCAL_RESPONSE_INVALID", "Document reply belongs to another operation"); return reply;
  };
  if (!starts) return call(view);
  if (request.type === "create" || request.type === "reparse") {
    try { return await call(view); }
    catch (error) { if (!(error instanceof AppError && error.code === "MODEL_NOT_CONFIGURED")) throw error; }
  }
  const snapshot = await settings.snapshot(); invariant(snapshot.revision === request.revision, "LOCAL_SETTINGS_CHANGED", "AI settings changed before document execution");
  const reply = await call(snapshot); invariant((await settings.view()).revision === snapshot.revision, "LOCAL_SETTINGS_CHANGED", "AI settings changed during admission; inspect the original task before retrying"); return reply;
}
