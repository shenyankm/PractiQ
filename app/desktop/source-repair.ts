import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync, type BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import type { DesktopSourceRepairRequest, DesktopSourceRepairResult, DesktopSourceStatus, DocumentReference } from "../src/contracts.generated.js";
import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { transaction } from "./database.js";
import { parseJson } from "./document-contract.js";
import { DocumentTasks } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { fileDigest, readBounded, syncDirectory, writeNewFile } from "./filesystem.js";
import { executionJson, SqliteStore } from "./graph-store.js";
import { validateOfficeInput } from "./office-input.js";
import { modelSlots, tencentSlots } from "./provider-slots.js";
import { canonical } from "./questions.js";

type Original = { file: "original"; sizeBytes: number; sha256: string } | null;
interface Manifest { version: 1; threadId: string; requestId: string; requestDigest: string; document: DocumentReference; original: Original; completed: boolean }
interface RepairRecord { version: 1; threadId: string; expectedVersion: number; requestDigest: string; document: DocumentReference; quarantineId: string | null; result: DesktopSourceRepairResult | null }
const sameFile = (a: BigIntStats, b: BigIntStats) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

/** Explicit file maintenance; task/call/checkpoint records and provider state stay untouched. */
export class SourceRepairs {
  readonly namespace = ["source_repairs"];
  private readonly operations = new Map<string, { digest: string; done: Promise<DesktopSourceRepairResult | null> }>();
  busy(): boolean { return this.operations.size > 0; }
  async settle(): Promise<void> { await Promise.allSettled([...this.operations.values()].map(operation => operation.done)); }
  constructor(readonly tasks: DocumentTasks, readonly store: SqliteStore, private readonly running: () => boolean) {}
  private idle(requestId?: string): boolean { return [...this.operations.keys()].every(id => id === requestId) && !this.running() && !modelSlots.busy() && !tencentSlots.busy() && this.tasks.unfinished().length === 0; }
  private root(): void { const info = lstatSync(this.tasks.storage.root, { throwIfNoEntry: false }); invariant(info?.isDirectory() && !info.isSymbolicLink(), "SOURCE_REPAIR_ROOT_MISSING", "Source repair requires the existing storage directory"); }
  private inspect(document: DocumentReference): Pick<DesktopSourceStatus, "status" | "errorCode"> {
    this.root(); const path = this.tasks.storage.sourcePath(document), before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!before) return { status: "missing", errorCode: "OBJECT_NOT_FOUND" };
    invariant(before.isFile() && !before.isSymbolicLink(), "INVALID_OBJECT_REFERENCE", "Stored source must be a regular file");
    if (before.size !== BigInt(document.sizeBytes)) return { status: "corrupt", errorCode: "DOCUMENT_SIZE_MISMATCH" };
    const digest = fileDigest(path, document.sizeBytes); invariant(sameFile(before, lstatSync(path, { bigint: true })), "SOURCE_REPAIR_CHANGED", "Stored source changed while it was being checked");
    return digest.sha256 === document.sha256 ? { status: "verified", errorCode: null } : { status: "corrupt", errorCode: "DOCUMENT_CHECKSUM_MISMATCH" };
  }
  status(id: string): DesktopSourceStatus {
    const task = this.tasks.record(id), state = this.inspect(task.input.document);
    return { threadId: task.id, document: task.input.document, taskVersion: task.updatedAt, ...state, canRepair: state.status !== "verified" && this.idle() };
  }
  private owner(path: string): void {
    let current = path, info = lstatSync(current, { throwIfNoEntry: false });
    while (!info && current !== this.tasks.storage.root) { current = dirname(current); info = lstatSync(current, { throwIfNoEntry: false }); }
    invariant(info && process.geteuid && info.uid === process.geteuid(), "SOURCE_REPAIR_OWNER", "Run source repair as the original file owner");
  }
  private directory(id: string, create: boolean): string {
    invariant(uuid(id), "SOURCE_REPAIR_INVALID", "Invalid quarantine identity"); this.root(); let path = this.tasks.storage.root;
    for (const part of [".quarantine", "source-repair", id]) {
      path = join(path, part); const info = lstatSync(path, { throwIfNoEntry: false });
      invariant(!info || info.isDirectory() && !info.isSymbolicLink(), "INVALID_OBJECT_REFERENCE", "Quarantine directories cannot be symbolic links");
      if (!info && create) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
      this.owner(path);
    }
    return path;
  }
  private readRecord(requestId: string, digest: string, document: DocumentReference): RepairRecord | null {
    const value = this.store.read(this.namespace, requestId)?.value; if (!value) return null;
    invariant(Object.keys(value).length === 7 && ["version", "threadId", "expectedVersion", "requestDigest", "document", "quarantineId", "result"].every(key => Object.hasOwn(value, key)) && value.version === 1 && uuid(value.threadId) && Number.isSafeInteger(value.expectedVersion) && Number(value.expectedVersion) >= 0 && typeof value.requestDigest === "string" && /^[a-f0-9]{64}$/.test(value.requestDigest) && (value.quarantineId === null || uuid(value.quarantineId)), "SOURCE_REPAIR_INVALID", "Invalid saved source repair record");
    validateContract("DocumentReference", value.document);
    invariant(hash(canonical({ threadId: value.threadId, request: { requestId, expectedVersion: value.expectedVersion }, document: value.document })) === value.requestDigest, "SOURCE_REPAIR_INVALID", "Saved repair request fields changed");
    invariant(value.requestDigest === digest && canonical(value.document) === canonical(document), "REQUEST_CONFLICT", "This repair request belongs to another source or task version");
    if (value.result !== null) { validateContract("DesktopSourceRepairResult", value.result); const result = value.result as DesktopSourceRepairResult; invariant(result.requestId === requestId && result.threadId === value.threadId && result.quarantineId === value.quarantineId && result.status === (value.quarantineId ? "repaired" : "verified"), "SOURCE_REPAIR_INVALID", "Invalid saved source repair receipt"); }
    else invariant(value.quarantineId !== null, "SOURCE_REPAIR_INVALID", "Pending source repair has no preservation directory");
    return value as unknown as RepairRecord;
  }
  private readManifest(path: string, record: RepairRecord, requestId: string): Manifest | null {
    const file = join(path, "manifest.json"); if (!lstatSync(file, { throwIfNoEntry: false })) return null;
    const value = parseJson(readBounded(file, 1024 * 1024)) as Manifest;
    invariant(value && Object.keys(value).length === 7 && value.version === 1 && value.threadId === record.threadId && value.requestId === requestId && value.requestDigest === record.requestDigest && canonical(value.document) === canonical(record.document) && typeof value.completed === "boolean" && (value.original === null || value.original?.file === "original" && Object.keys(value.original).length === 3 && Number.isSafeInteger(value.original.sizeBytes) && value.original.sizeBytes >= 0 && /^[a-f0-9]{64}$/.test(value.original.sha256)), "SOURCE_REPAIR_INVALID", "Invalid source preservation manifest");
    if (value.original) { const original = fileDigest(join(path, "original"), value.original.sizeBytes); invariant(original.size === value.original.sizeBytes && original.sha256 === value.original.sha256, "SOURCE_REPAIR_INVALID", "Preserved source differs from its manifest"); }
    else invariant(!lstatSync(join(path, "original"), { throwIfNoEntry: false }), "SOURCE_REPAIR_INVALID", "Missing-source manifest has an unexpected original copy");
    return value;
  }
  private publish(path: string, bytes: Buffer): void {
    const temporary = join(dirname(path), `.pending-${randomUUID()}`); writeNewFile(temporary, bytes);
    renameSync(temporary, path); syncDirectory(dirname(path));
  }
  private preserve(source: string, directory: string): Original {
    const before = lstatSync(source, { bigint: true, throwIfNoEntry: false });
    if (!before) { invariant(!lstatSync(join(directory, "original"), { throwIfNoEntry: false }), "SOURCE_REPAIR_CHANGED", "Preserved source disappeared before repair"); return null; }
    invariant(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(Number.MAX_SAFE_INTEGER), "INVALID_OBJECT_REFERENCE", "Stored source must be a regular file");
    const retained = join(directory, "original");
    if (lstatSync(retained, { throwIfNoEntry: false })) {
      const saved = fileDigest(retained, Number(before.size)), current = fileDigest(source, Number(before.size));
      invariant(saved.size === current.size && saved.sha256 === current.sha256 && sameFile(before, lstatSync(source, { bigint: true })), "SOURCE_REPAIR_CHANGED", "Source differs from its existing preservation copy");
      return { file: "original", sizeBytes: saved.size, sha256: saved.sha256 };
    }
    const temporary = join(directory, `.pending-original-${randomUUID()}`), reader = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), digest = createHash("sha256"); let size = 0, writer: number | undefined;
    try {
      writer = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      invariant(sameFile(before, fstatSync(reader, { bigint: true })), "SOURCE_REPAIR_CHANGED", "Source changed before preservation"); const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const count = readSync(reader, buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - size), null); if (!count) break;
        size += count; invariant(size <= Number(before.size), "SOURCE_REPAIR_CHANGED", "Source grew during preservation"); digest.update(buffer.subarray(0, count));
        let written = 0; while (written < count) { const n = writeSync(writer, buffer, written, count - written); invariant(n > 0, "SOURCE_REPAIR_IO", "Preservation write did not advance"); written += n; }
      }
      invariant(size === Number(before.size) && sameFile(before, fstatSync(reader, { bigint: true })) && sameFile(before, lstatSync(source, { bigint: true })), "SOURCE_REPAIR_CHANGED", "Source changed during preservation"); fsyncSync(writer);
    } finally { closeSync(reader); if (writer !== undefined) closeSync(writer); }
    renameSync(temporary, retained); syncDirectory(directory); return { file: "original", sizeBytes: size, sha256: digest.digest("hex") };
  }
  async repair(id: string, input: unknown, replacement: string | null): Promise<DesktopSourceRepairResult | null> {
    validateContract("DesktopSourceRepairRequest", input); const request = structuredClone(input) as DesktopSourceRepairRequest; request.requestId = request.requestId.toLowerCase();
    const task = this.tasks.record(id), document = task.input.document, digest = hash(canonical({ threadId: task.id, request, document })), active = this.operations.get(request.requestId);
    if (active) { invariant(active.digest === digest, "REQUEST_CONFLICT", "This repair request is already running with another input"); return active.done; }
    const done = this.perform(task.id, request, document, digest, replacement).finally(() => this.operations.delete(request.requestId)); this.operations.set(request.requestId, { digest, done }); return done;
  }
  private async perform(id: string, request: DesktopSourceRepairRequest, document: DocumentReference, digest: string, replacement: string | null): Promise<DesktopSourceRepairResult | null> {
    const task = this.tasks.record(id), previous = this.readRecord(request.requestId, digest, document);
    if (previous?.result) { invariant(this.inspect(document).status === "verified", "SOURCE_REPAIR_CHANGED", "Source changed after the acknowledged repair"); return previous.result; }
    let bytes: Buffer | null = null;
    if (replacement !== null) {
      invariant(typeof replacement === "string" && replacement.length <= 8192, "SOURCE_REPAIR_INVALID", "Choose a native replacement file");
      bytes = readBounded(replacement, document.sizeBytes); invariant(bytes.length === document.sizeBytes && hash(bytes) === document.sha256, "SOURCE_REPLACEMENT_INVALID", "Replacement must match the original size and checksum");
      await validateOfficeInput(replacement, bytes, document.sourceType);
    }
    return transaction(this.tasks.db, () => {
      invariant(this.idle(request.requestId), "SOURCE_REPAIR_BUSY", "Stop all AI work before repairing a source"); this.root();
      const current = this.tasks.record(task.id), saved = this.readRecord(request.requestId, digest, document), state = this.inspect(document);
      if (saved?.result) { invariant(state.status === "verified", "SOURCE_REPAIR_CHANGED", "Source changed after the acknowledged repair"); return saved.result; }
      const path = this.tasks.storage.sourcePath(document); this.owner(this.tasks.storage.root); this.owner(path);
      let record = saved, manifest: Manifest | null = null, quarantine: string | null = null;
      if (record?.quarantineId) { quarantine = this.directory(record.quarantineId, false); manifest = this.readManifest(quarantine, record, request.requestId); }
      if (state.status !== "verified") {
        invariant(current.updatedAt === request.expectedVersion && canonical(current.input.document) === canonical(document), "STALE_CHECKPOINT", "Task changed before source repair");
        if (!bytes) return null;
        if (!record) {
          record = { version: 1, threadId: task.id, expectedVersion: request.expectedVersion, requestDigest: digest, document, quarantineId: randomUUID(), result: null };
          this.store.updateSync(this.namespace, request.requestId, value => { invariant(value === null, "REQUEST_CONFLICT", "Repair request already exists"); return { ...record! }; });
        }
        quarantine = this.directory(record.quarantineId!, true);
        const original = this.preserve(path, quarantine);
        if (manifest) invariant(canonical(manifest.original) === canonical(original) && !manifest.completed, "SOURCE_REPAIR_CHANGED", "Source differs from its incomplete repair record");
        manifest = { version: 1, threadId: task.id, requestId: request.requestId, requestDigest: digest, document, original, completed: false };
        this.publish(join(quarantine, "manifest.json"), Buffer.from(executionJson(manifest)));
        const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (original) { const actual = fileDigest(path, original.sizeBytes); invariant(actual.size === original.sizeBytes && actual.sha256 === original.sha256, "SOURCE_REPAIR_CHANGED", "Source changed before replacement"); }
        else invariant(!before, "SOURCE_REPAIR_CHANGED", "A source appeared after missing-file preservation");
        const target = this.tasks.storage.sourcePath(document, true);
        invariant(!before || sameFile(before, lstatSync(target, { bigint: true })), "SOURCE_REPAIR_CHANGED", "Source changed before replacement");
        this.publish(target, bytes); this.tasks.storage.source(document);
      } else if (record?.quarantineId) invariant(manifest, "SOURCE_REPAIR_INVALID", "Published source has no verified preservation manifest");
      if (manifest && quarantine) { manifest.completed = true; this.publish(join(quarantine, "manifest.json"), Buffer.from(executionJson(manifest))); }
      const result: DesktopSourceRepairResult = { threadId: task.id, requestId: request.requestId, status: record?.quarantineId ? "repaired" : "verified", quarantineId: record?.quarantineId ?? null };
      const completed: RepairRecord = { version: 1, threadId: task.id, expectedVersion: request.expectedVersion, requestDigest: digest, document, quarantineId: result.quarantineId, result };
      this.store.updateSync(this.namespace, request.requestId, () => ({ ...completed })); return result;
    });
  }
}
