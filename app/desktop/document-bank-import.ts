import type { ArtifactReference, DesktopBankImportReceipt, DesktopDocumentRequest, DocumentBankImport, DocumentTaskHead } from "../src/contracts.generated.js";
import type { AiSettingsView } from "./ai-settings.js";
import { AiClient } from "./ai-client.js";
import { DatabaseClient } from "./client.js";
import { bankResourcePlan } from "./bank-references.js";
import { validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import { canonical } from "./questions.js";
import { hash } from "./assets.js";

export async function importDocumentBank(request: Extract<DesktopDocumentRequest, { type: "import_bank" }>, config: AiSettingsView, ai: AiClient, database: DatabaseClient): Promise<DesktopBankImportReceipt> {
  const selection = request.value;
  const read = async (request: DesktopDocumentRequest) => {
    const reply = await ai.call<{ type: string; value: unknown }>({ type: "document", request, config }); validateContract("DesktopDocumentReply", reply); invariant(reply.type === request.type, "LOCAL_RESPONSE_INVALID", "Document reply belongs to another operation"); return reply.value;
  };
  const head = { type: "head" as const, revision: config.revision, threadId: selection.threadId }, before = await read(head) as DocumentTaskHead;
  invariant(before.checkpointId === selection.checkpointId, "STALE_CHECKPOINT", "The reviewed checkpoint changed before import");
  const value = await read({ type: "bank", revision: config.revision, value: selection }) as DocumentBankImport, resources: { reference: ArtifactReference; bytes: Uint8Array }[] = [];
  for (const declared of bankResourcePlan(value).values()) {
    const reference = declared as unknown as ArtifactReference, artifact = await read({ type: "artifact", revision: config.revision, threadId: selection.threadId, reference }) as { reference: ArtifactReference; bytes: string };
    invariant(canonical(artifact.reference) === canonical(reference) && artifact.bytes.length === Math.ceil(reference.sizeBytes / 3) * 4, "DOCUMENT_CHECKSUM_MISMATCH", "Bank resource transport changed");
    const bytes = Buffer.from(artifact.bytes, "base64"); invariant(bytes.toString("base64") === artifact.bytes && bytes.length === reference.sizeBytes && hash(bytes) === reference.sha256, "DOCUMENT_CHECKSUM_MISMATCH", "Bank resource encoding or checksum changed");
    // Do not send unrelated main-process memory from a pooled Buffer backing store.
    resources.push({ reference, bytes: Uint8Array.from(bytes) });
  }
  const after = await read(head) as DocumentTaskHead;
  invariant(before.checkpointId === after.checkpointId && before.state === after.state && before.updatedAt === after.updatedAt, "STALE_CHECKPOINT", "Task changed while its bank resources were being read");
  const receipt = await database.request({ type: "_import_document_bank", value, resources, selection });
  if (!receipt.ok) throw new AppError(receipt.error.code, receipt.error.message, receipt.error.params);
  validateContract("DesktopBankImportReceipt", receipt.value); return receipt.value as DesktopBankImportReceipt;
}
