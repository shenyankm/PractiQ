import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { hash } from "./assets.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { readBounded, regularFileExists, syncDirectory, writeNewFile } from "./filesystem.js";
import { validateOfficeInput } from "./office-input.js";

export const SOURCE_LIMIT = 150 * 1024 * 1024, OFFICE_LIMIT = 25 * 1024 * 1024, ARTIFACT_LIMIT = 100 * 1024 * 1024;
export const SOURCE_FORMATS = {
  pdf: { sourceType: "pdf", mediaType: "application/pdf" }, txt: { sourceType: "text", mediaType: "text/plain" }, md: { sourceType: "markdown", mediaType: "text/markdown" }, png: { sourceType: "image", mediaType: "image/png" }, jpg: { sourceType: "image", mediaType: "image/jpeg" }, jpeg: { sourceType: "image", mediaType: "image/jpeg" },
  doc: { sourceType: "doc", mediaType: "application/msword" }, docx: { sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, ppt: { sourceType: "ppt", mediaType: "application/vnd.ms-powerpoint" }, pptx: { sourceType: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, xls: { sourceType: "xls", mediaType: "application/vnd.ms-excel" }, xlsx: { sourceType: "xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
} as const;
export function sourceFileName(value: unknown): asserts value is string { invariant(typeof value === "string" && [...value].length >= 1 && [...value].length <= 255 && !value.startsWith(".") && !/[\\/\p{Cc}]/u.test(value), "CLOUD_FILENAME_INVALID", "Invalid source filename"); }
export function sourceFormat(name: string) { sourceFileName(name); const extension = name.split(".").at(-1)!.toLowerCase(); invariant(Object.hasOwn(SOURCE_FORMATS, extension), "UNSUPPORTED_FILE", "Choose a supported source document"); return SOURCE_FORMATS[extension as keyof typeof SOURCE_FORMATS]; }
export const sourceLimit = (type: string) => ["doc", "docx", "ppt", "pptx", "xls", "xlsx"].includes(type) ? OFFICE_LIMIT : SOURCE_LIMIT;
export const sourceKey = (type: string, digest: string) => `practiq-agent/sources/${digest}/source.${type === "text" ? "txt" : type === "markdown" ? "md" : type}`;
const suffix = (media: string): string => ({ "image/png": "png", "image/jpeg": "jpg", "text/plain": "txt", "application/json": "json" })[media] ?? "bin";
const artifactMedia: string[] = [...new Set(["application/json", "application/zip", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", ...Object.values(SOURCE_FORMATS).map(format => format.mediaType)])];
export function validateSourceReference(value: unknown): asserts value is DocumentReference {
  validateContract("DocumentReference", value); const reference = value as DocumentReference; sourceFileName(reference.fileName);
  const format = sourceFormat(reference.fileName);
  invariant(format.sourceType === reference.sourceType && format.mediaType === reference.mediaType && reference.objectKey === sourceKey(reference.sourceType, reference.sha256) && reference.sizeBytes > 0 && reference.sizeBytes <= sourceLimit(reference.sourceType), "INVALID_REFERENCE", "Source reference differs from its filename, media type or managed storage key");
}

/** AI bytes have a separate namespace and never enter practice backups. */
export class AiStorage {
  readonly root: string;
  constructor(directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.root = join(directory, "ai-storage"); this.directory(this.root); }
  private directory(path: string, create = true): void {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    invariant(!existing || existing.isDirectory() && !existing.isSymbolicLink(), "INVALID_OBJECT_REFERENCE", "Storage directories cannot be symbolic links");
    if (!existing && create) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
  }
  private path(key: string, create = false): string {
    invariant(key.startsWith("practiq-agent/") && key.split("/").every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".."), "INVALID_OBJECT_REFERENCE", "Invalid managed object key");
    let parent = this.root; this.directory(parent, create);
    const parts = key.split("/"); for (const part of parts.slice(0, -1)) { parent = join(parent, part); this.directory(parent, create); }
    return join(parent, parts.at(-1)!);
  }
  private verified(reference: ArtifactReference, limit: number): Buffer {
    invariant(Number.isSafeInteger(reference.sizeBytes) && reference.sizeBytes >= 0 && reference.sizeBytes <= limit, "DOCUMENT_TOO_LARGE", "Stored object exceeds its limit");
    const bytes = readBounded(this.path(reference.objectKey), limit);
    invariant(bytes.length === reference.sizeBytes && hash(bytes) === reference.sha256, "DOCUMENT_CHECKSUM_MISMATCH", "Stored object size or checksum differs from its reference"); return bytes;
  }
  private async put(reference: ArtifactReference, bytes: Buffer, validate?: (path: string) => Promise<void>): Promise<void> {
    invariant(bytes.length === reference.sizeBytes && hash(bytes) === reference.sha256, "DOCUMENT_CHECKSUM_MISMATCH", "Object does not match its reference");
    const target = this.path(reference.objectKey, true), temporary = join(dirname(target), `.pending-${randomUUID()}`);
    try {
      writeNewFile(temporary, bytes); await validate?.(temporary);
      if (regularFileExists(target)) { this.verified(reference, bytes.length); return; }
      try { linkSync(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; this.verified(reference, bytes.length); }
      syncDirectory(dirname(target)); this.verified(reference, bytes.length);
    } finally { if (regularFileExists(temporary)) unlinkSync(temporary); }
  }
  async putSource(reference: DocumentReference, bytes: Buffer): Promise<void> { validateSourceReference(reference); await this.put(reference, bytes, path => validateOfficeInput(path, bytes, reference.sourceType)); }
  source(reference: DocumentReference): Buffer { validateSourceReference(reference); return this.verified(reference, sourceLimit(reference.sourceType)); }
  sourcePath(reference: DocumentReference, create = false): string { validateSourceReference(reference); return this.path(reference.objectKey, create); }
  async putArtifact(bytes: Buffer, sourceSha256: string, kind: string, index: number, mediaType: string): Promise<ArtifactReference> {
    invariant(/^[a-f0-9]{64}$/.test(sourceSha256) && /^[a-z][a-z0-9_-]{0,63}$/.test(kind) && Number.isSafeInteger(index) && index >= 0 && bytes.length <= ARTIFACT_LIMIT && artifactMedia.includes(mediaType), "INVALID_OBJECT_REFERENCE", "Invalid artifact identity or content size");
    const sha256 = hash(bytes), reference = { objectKey: `practiq-agent/artifacts/${sourceSha256}/${kind}/${index}-${sha256}.${suffix(mediaType)}`, sha256, mediaType, sizeBytes: bytes.length };
    await this.put(reference, bytes); return reference;
  }
  artifact(reference: ArtifactReference): Buffer {
    validateContract("ArtifactReference", reference); const match = /^practiq-agent\/artifacts\/[a-f0-9]{64}\/[a-z][a-z0-9_-]{0,63}\/(?:0|[1-9][0-9]*)-([a-f0-9]{64})\.([a-z0-9]+)$/.exec(reference.objectKey);
    invariant(match && match[1] === reference.sha256 && match[2] === suffix(reference.mediaType) && artifactMedia.includes(reference.mediaType), "INVALID_OBJECT_REFERENCE", "Invalid artifact reference"); return this.verified(reference, ARTIFACT_LIMIT);
  }
}
