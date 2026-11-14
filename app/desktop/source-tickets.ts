import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DocumentReference } from "../src/contracts.generated.js";
import type { SourceFile } from "../../shared/cloud/transport.js";
import { AiStorage, OFFICE_LIMIT, sourceFormat, sourceKey, sourceLimit } from "./ai-storage.js";
import { hash } from "./assets.js";
import { AppError, invariant } from "./errors.js";
import { fileDigest, readBounded } from "./filesystem.js";

interface SourceTicket { path: string; revision: string; selectedAt: number; reference: DocumentReference }
export class SourceTickets {
  private readonly tickets = new Map<string, SourceTicket>();
  constructor(readonly storage: AiStorage, private readonly now: () => number = () => performance.now()) {}
  pick(paths: string[], revision: string): SourceFile[] {
    invariant(Array.isArray(paths) && paths.length <= 10 && paths.every(path => typeof path === "string") && revision.length > 0 && revision.length <= 128, "FILE_COUNT_LIMIT", "Choose at most ten native files");
    const selectedAt = this.now(), additions = paths.map(path => {
      const name = basename(path).trim(), format = sourceFormat(name), limit = sourceLimit(format.sourceType); let digest: ReturnType<typeof fileDigest>;
      try { digest = fileDigest(path, limit); }
      catch (error) { if (limit === OFFICE_LIMIT && error instanceof AppError && error.code === "LOCAL_FILE_TOO_LARGE") throw new AppError("OFFICE_EXPORT_PDF_REQUIRED", "Office input exceeds the size limit; export it as a PDF and import the PDF"); throw error; }
      invariant(digest.size > 0, "DOCUMENT_TOO_LARGE", "The selected source is empty");
      const reference = { ...format, fileName: name, sizeBytes: digest.size, sha256: digest.sha256, objectKey: sourceKey(format.sourceType, digest.sha256) };
      return { ticket: randomUUID(), path, revision, selectedAt, reference };
    });
    for (const [ticket, record] of this.tickets) if (record.revision !== revision || selectedAt - record.selectedAt > 15 * 60 * 1000) this.tickets.delete(ticket);
    while (this.tickets.size + additions.length > 50) this.tickets.delete(this.tickets.keys().next().value!);
    for (const record of additions) this.tickets.set(record.ticket, record);
    return additions.map(record => ({ name: record.reference.fileName!, size: record.reference.sizeBytes, nativeTicket: record.ticket }));
  }
  async upload(ticket: string, revision: string): Promise<DocumentReference> {
    const source = this.tickets.get(ticket);
    invariant(source && source.revision === revision && this.now() - source.selectedAt <= 15 * 60 * 1000, "CLOUD_FILE_RESELECT", "Select the source file again");
    const bytes = readBounded(source.path, sourceLimit(source.reference.sourceType));
    invariant(bytes.length === source.reference.sizeBytes && hash(bytes) === source.reference.sha256, "DOCUMENT_CHECKSUM_MISMATCH", "The selected source changed; select it again");
    await this.storage.putSource(source.reference, bytes);
    invariant(this.tickets.get(ticket) === source && this.now() - source.selectedAt <= 15 * 60 * 1000, "CLOUD_FILE_RESELECT", "Select the source file again");
    return structuredClone(source.reference);
  }
}
