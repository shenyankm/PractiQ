import { join } from "node:path";
import type { ArtifactReference, DesktopDocumentBankSelection, DocumentBankImport } from "../src/contracts.generated.js";
import { BANK_ZIP_LIMIT, bankExportDestination, verifyResource } from "./bank-packages.js";
import { bankResourcePlan } from "./bank-references.js";
import { MAX_JSON_BYTES } from "./document-contract.js";
import { DOCUMENT_TTL_MS } from "./document-execution.js";
import type { DocumentTasks } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { validateSegment } from "./media.js";
import { canonical } from "./questions.js";
import { writeZip, type ZipSource } from "./zip.js";

/** Publish only verified saved content; never import a bank or execute a document stage. */
export async function exportDocumentBank(tasks: DocumentTasks, selection: DesktopDocumentBankSelection, snapshot: DocumentBankImport, version: number, destination: string): Promise<void> {
  const target = bankExportDestination(tasks.directory, destination), record = tasks.record(selection.threadId);
  const guard = () => {
    const current = tasks.record(record.id);
    invariant(Date.now() < current.createdAt + DOCUMENT_TTL_MS, "TASK_EXPIRED", "Task expired before ZIP publication");
    invariant(current.updatedAt === version && current.checkpointId === selection.checkpointId, "STALE_CHECKPOINT", "Task changed while its bank ZIP was being exported");
    tasks.storage.source(current.input.document);
  };
  guard();
  const json = Buffer.from(canonical({ status: snapshot.status, result: snapshot.result, processing: snapshot.processing })), manifest = Buffer.from(canonical({ format: "practiq-question-bank", version: 2, bank: { title: snapshot.title, description: "" } }));
  invariant(json.length <= MAX_JSON_BYTES && manifest.length <= 65536, "BANK_EXPORT_TOO_LARGE", "Bank ZIP metadata exceeds its size limit");
  const entries: ZipSource[] = [{ name: "manifest.json", data: manifest }, { name: "questions.json", data: json }];
  for (const [name, declared] of [...bankResourcePlan(snapshot)].sort(([left], [right]) => left.localeCompare(right))) {
    const reference = declared as unknown as ArtifactReference, bytes = tasks.readArtifact(record.id, reference), duration = await verifyResource(declared, bytes);
    if (duration !== null) for (const question of snapshot.result.questions) if (question.audioRef?.sha256 === reference.sha256) validateSegment(question, duration);
    entries.push({ name, path: join(tasks.storage.root, reference.objectKey), size: reference.sizeBytes, sha256: reference.sha256 });
  }
  await writeZip(target, entries, BANK_ZIP_LIMIT, false, guard);
}
