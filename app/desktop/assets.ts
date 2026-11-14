import { constants, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { invariant } from "./errors.js";
import { list, object, text } from "./question-contract.js";
import { transaction } from "./database.js";

import { readBounded, syncDirectory } from "./filesystem.js";
export { readBounded, syncDirectory } from "./filesystem.js";

export const ASSET_LIMIT = 25 * 1024 * 1024;
export const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export class Assets {
  constructor(readonly directory: string, readonly db: DatabaseSync) {}
  path(digest: string): string {
    invariant(/^[a-f0-9]{64}$/.test(digest), "LOCAL_ASSET_HASH_INVALID", "Invalid resource hash");
    const root = join(this.directory, "assets");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    invariant(!lstatSync(root).isSymbolicLink(), "LOCAL_ASSET_DIRECTORY_LINK", "Resource directory cannot be a symbolic link");
    return join(root, digest);
  }
  read(digest: string, size: number): Buffer {
    invariant(Number.isSafeInteger(size) && size >= 0 && size <= ASSET_LIMIT, "LOCAL_ASSET_MISSING", "Invalid resource size");
    const bytes = readBounded(this.path(digest), ASSET_LIMIT);
    invariant(bytes.length === size && hash(bytes) === digest, "LOCAL_ASSET_MISSING", "Resource size or checksum mismatch");
    return bytes;
  }
  write(digest: string, bytes: Uint8Array): void {
    invariant(bytes.byteLength <= ASSET_LIMIT && hash(bytes) === digest, "LOCAL_ASSET_CHECKSUM_MISMATCH", "Resource checksum mismatch");
    const target = this.path(digest), root = join(this.directory, "assets");
    if (existsSync(target)) { this.read(digest, bytes.byteLength); return; }
    const temporary = join(root, `.pending-${randomUUID()}`);
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); }
    catch (error) { closeSync(descriptor); unlinkSync(temporary); throw error; }
    closeSync(descriptor);
    try {
      try { linkSync(temporary, target); }
      catch (error) { if (object(error).code !== "EEXIST") throw error; this.read(digest, bytes.byteLength); }
    } finally { unlinkSync(temporary); }
    syncDirectory(root);
    this.read(digest, bytes.byteLength);
  }
  bytes(digest: string): { media: string; bytes: Buffer } | null {
    invariant(/^[a-f0-9]{64}$/.test(digest), "LOCAL_ASSET_HASH_INVALID", "Invalid resource hash");
    const row = this.db.prepare("SELECT media,size,path FROM assets WHERE hash=?").get(digest);
    if (!row) return null;
    invariant(row.path === `assets/${digest}` && ["image/png", "image/jpeg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav"].includes(String(row.media)), "LOCAL_ASSET_MISSING", "Invalid resource metadata");
    return { media: String(row.media), bytes: this.read(digest, Number(row.size)) };
  }
  collect(): void {
    const live = transaction(this.db, () => {
      this.db.exec("DELETE FROM visuals WHERE document_level=0 AND NOT EXISTS(SELECT 1 FROM question_visuals WHERE visual_id=visuals.id)");
      const used = new Set<string>();
      for (const row of this.db.prepare("WITH refs(visual) AS (SELECT content FROM visuals UNION ALL SELECT value FROM session_documents,json_each(session_documents.content,'$.visuals')) SELECT json_extract(visual,'$.imageRef.sha256') AS image,json_extract(visual,'$.sourceRef.sha256') AS source FROM refs").all()) {
        if (typeof row.image === "string") used.add(row.image); if (typeof row.source === "string") used.add(row.source);
      }
      if (this.db.prepare("SELECT EXISTS(SELECT 1 FROM assets WHERE media NOT IN ('image/png','image/jpeg')) AS present").get()!.present) {
        for (const row of this.db.prepare("SELECT json_extract(audio_ref,'$.sha256') AS hash FROM listening_questions UNION SELECT json_extract(value,'$.question.audioRef.sha256') FROM session_documents,json_each(session_documents.content,'$.questions')").all()) if (typeof row.hash === "string") used.add(row.hash);
      }
      for (const row of this.db.prepare("SELECT hash FROM assets").all()) if (!used.has(String(row.hash))) this.db.prepare("DELETE FROM assets WHERE hash=?").run(row.hash);
      return used;
    });
    const root = join(this.directory, "assets");
    if (!existsSync(root)) return;
    invariant(!lstatSync(root).isSymbolicLink(), "LOCAL_ASSET_DIRECTORY_LINK", "Resource directory cannot be a symbolic link");
    for (const name of readdirSync(root)) if (/^[a-f0-9]{64}$/.test(name) && !live.has(name)) unlinkSync(join(root, name));
    syncDirectory(root);
  }
  markMissing(rows: Record<string, unknown>[]): void {
    const references = (row: unknown) => [...list(row, "visuals").map(visual => object(visual).imageRef), object(object(row).question).audioRef].filter(ref => ref !== null && typeof ref === "object");
    const hashes = new Set(rows.flatMap(row => references(row).map(ref => text(ref, "sha256"))));
    const missing = new Set<string>();
    for (const digest of hashes) {
      try { if (!this.bytes(digest)) missing.add(digest); }
      catch { missing.add(digest); }
    }
    for (const row of rows) row.missingAssets = row.missingAssets === true || references(row).some(ref => missing.has(text(ref, "sha256")));
  }
}
