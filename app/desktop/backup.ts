import { backup, DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { PracticeStore } from "./store.js";
import { Assets, ASSET_LIMIT, hash } from "./assets.js";
import { BACKUP_ARCHIVE_LIMIT, BACKUP_LIMIT, BACKUP_MANIFEST_LIMIT, validateBackupAudio, validateBackupContents } from "./backup-validation.js";
import { openPracticeDatabase, validatePracticeDatabase } from "./database.js";
import { parseJson } from "./document-contract.js";
import { AppError, invariant } from "./errors.js";
import { fileDigest, readBounded, regularFileExists, syncDirectory, syncFile, writeNewFile } from "./filesystem.js";
import { emptyLearningData, Learning, validateLearningData, type LearningData } from "./learning.js";
import { LegacySettings, validateLegacyConfig, type LegacyConfig } from "./legacy-settings.js";
import { mediaDuration } from "./media.js";
import { object } from "./question-contract.js";
import { BoundedZip, writeZip, type ZipSource } from "./zip.js";

interface Resource { sha256: string; mediaType: string; sizeBytes: number; file: string }
interface Candidate { directory: string; path: string; resources: Resource[]; settings: LegacyConfig | null; learning: LearningData }
const mediaTypes = ["image/png", "image/jpeg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/wav"];
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), "LOCAL_BACKUP_VERSION_UNSUPPORTED", "Unsupported backup fields"); return object(value);
}
function resource(value: unknown): Resource {
  const row = fields(value, ["sha256", "mediaType", "sizeBytes", "file"]);
  invariant(typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && row.file === `assets/${row.sha256}` && typeof row.mediaType === "string" && mediaTypes.includes(row.mediaType) && Number.isSafeInteger(row.sizeBytes) && Number(row.sizeBytes) >= 0 && Number(row.sizeBytes) <= ASSET_LIMIT, "LOCAL_IMAGE_MANIFEST_INVALID", "Invalid backup resource metadata");
  return row as unknown as Resource;
}
function resources(db: DatabaseSync): Resource[] {
  return db.prepare("SELECT hash AS sha256,media AS mediaType,size AS sizeBytes,path AS file FROM assets ORDER BY hash").all().map(resource);
}
function settingsBackup(value: unknown): LegacyConfig | null {
  const settings = fields(value, ["version", "config"]); invariant(settings.version === 1 && Object.hasOwn(settings, "config"), "LOCAL_BACKUP_VERSION_UNSUPPORTED", "Unsupported grading settings backup"); return validateLegacyConfig(settings.config);
}
function isWithin(directory: string, path: string): boolean { const result = relative(directory, path); return result === "" || !result.startsWith("../") && !isAbsolute(result); }

export class Backups {
  constructor(readonly store: PracticeStore) {}
  private get settings() { return new LegacySettings(this.store.directory); }
  private async snapshot(path: string, portable: boolean): Promise<void> {
    await backup(this.store.db, path);
    if (portable) {
      const db = new DatabaseSync(path);
      try { db.exec("PRAGMA trusted_schema=OFF; DELETE FROM grade_requests WHERE response IS NULL"); }
      finally { db.close(); }
    }
    syncFile(path);
  }
  async export(destination: string): Promise<{ path: string }> {
    const parent = realpathSync(dirname(destination)), target = join(parent, basename(destination)), root = realpathSync(this.store.directory);
    invariant(!isWithin(root, target) || isWithin(join(root, "recoveries"), target), "LOCAL_BACKUP_OVERWRITE", "Export outside application data files");
    regularFileExists(target);
    const directory = mkdtempSync(join(root, ".practiq-backup-")), path = join(directory, "practiq.sqlite");
    try {
      await this.snapshot(path, true);
      const db = new DatabaseSync(path, { readOnly: true });
      let entries: Resource[], learning: LearningData;
      try { db.exec("PRAGMA trusted_schema=OFF"); validateBackupContents(db, new Assets(root, db)); entries = resources(db); learning = new Learning(root, db).backup(); }
      finally { db.close(); }
      const database = fileDigest(path, BACKUP_LIMIT), active = this.settings.read(); invariant(!active.pending, "LOCAL_DATABASE_RESTART", "Database restoration is pending");
      const manifest = { format: "practiq-backup", version: 4, schemaVersion: 11, createdAt: Date.now(), database: { file: "practiq.sqlite", sha256: database.sha256, sizeBytes: database.size }, assets: entries,
        ...(active.active ? { serviceSettings: { version: 1, config: active.active } } : {}), ...(Object.keys(learning.notes).length ? { learningData: learning } : {}) };
      const raw = Buffer.from(JSON.stringify(manifest)); invariant(raw.length <= BACKUP_MANIFEST_LIMIT, "LOCAL_MANIFEST_TOO_LARGE", "Backup manifest exceeds size limit");
      const files: ZipSource[] = [{ name: "manifest.json", data: raw }, { name: "practiq.sqlite", path, size: database.size, sha256: database.sha256 }];
      let total = database.size; const durations = new Map<string, number>();
      for (const ref of entries) {
        const bytes = this.store.assets.read(ref.sha256, ref.sizeBytes), duration = await mediaDuration(bytes, ref.mediaType); if (duration !== null) durations.set(ref.sha256, duration);
        total += bytes.length; invariant(total <= BACKUP_LIMIT, "LOCAL_BACKUP_TOO_LARGE", "Backup payload exceeds 512 MiB");
        files.push({ name: ref.file, path: this.store.assets.path(ref.sha256), size: ref.sizeBytes, sha256: ref.sha256 });
      }
      const validation = new DatabaseSync(path, { readOnly: true });
      try { validation.exec("PRAGMA trusted_schema=OFF"); validateBackupAudio(validation, durations); } finally { validation.close(); }
      await writeZip(target, files, BACKUP_ARCHIVE_LIMIT, true); return { path: destination };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  private async stage(source: string): Promise<Candidate> {
    const zip = await BoundedZip.open(source, { archiveBytes: BACKUP_ARCHIVE_LIMIT, expandedBytes: BACKUP_LIMIT + BACKUP_MANIFEST_LIMIT, entries: 100000 });
    let directory: string | undefined;
    try {
      const value = parseJson(await zip.read("manifest.json", BACKUP_MANIFEST_LIMIT));
      invariant(object(value).format !== "practiq-question-bank", "LOCAL_USE_BANK_IMPORT", "Use question-bank import for this package");
      const manifest = fields(value, ["format", "version", "schemaVersion", "createdAt", "database", "assets", "serviceSettings", "learningData"]);
      invariant(manifest.format === "practiq-backup" && manifest.version === 4 && manifest.schemaVersion === 11, "LOCAL_BACKUP_VERSION_UNSUPPORTED", "Only version-4 schema-11 backups are supported");
      const database = fields(manifest.database, ["file", "sha256", "sizeBytes"]);
      invariant(database.file === "practiq.sqlite" && typeof database.sha256 === "string" && /^[a-f0-9]{64}$/.test(database.sha256) && Number.isSafeInteger(database.sizeBytes) && Number(database.sizeBytes) > 0 && Number(database.sizeBytes) <= BACKUP_LIMIT, "LOCAL_BACKUP_CHECKSUM_MISMATCH", "Invalid backup database metadata");
      invariant(Array.isArray(manifest.assets), "LOCAL_IMAGE_MANIFEST_MISSING", "Backup resource manifest is missing");
      const entries = manifest.assets.map(resource), allowed = new Set(["manifest.json", "practiq.sqlite", ...entries.map(ref => ref.file)]);
      invariant(allowed.size === entries.length + 2 && allowed.size === zip.entries.size && [...zip.entries.keys()].every(name => allowed.has(name)), "LOCAL_BACKUP_UNDECLARED_FILE", "Duplicate, missing or undeclared backup entries");
      invariant([...zip.entries].reduce((sum, [name, entry]) => sum + (name === "manifest.json" ? 0 : entry.uncompressedSize), 0) <= BACKUP_LIMIT, "LOCAL_BACKUP_EXPANDED_TOO_LARGE", "Backup payload exceeds 512 MiB");
      const config = Object.hasOwn(manifest, "serviceSettings") ? settingsBackup(manifest.serviceSettings) : null;
      const learning = Object.hasOwn(manifest, "learningData") ? structuredClone(validateLearningData(manifest.learningData)) : emptyLearningData();
      learning.lastBackupAt = null; delete learning.removedNoteChanges;
      directory = mkdtempSync(join(this.store.directory, ".practiq-restore-")); const path = join(directory, "practiq.sqlite");
      await zip.copy("practiq.sqlite", path, BACKUP_LIMIT);
      const digest = fileDigest(path, BACKUP_LIMIT); invariant(digest.size === database.sizeBytes && digest.sha256 === database.sha256, "LOCAL_BACKUP_CHECKSUM_MISMATCH", "Backup database checksum mismatch");
      const schema = new DatabaseSync(path, { readOnly: true });
      try { schema.exec("PRAGMA trusted_schema=OFF"); validatePracticeDatabase(schema); } finally { schema.close(); }
      const db = openPracticeDatabase(directory), assets = new Assets(directory, db), durations = new Map<string, number>();
      try {
        for (const ref of entries) {
          const bytes = await zip.read(ref.file, ASSET_LIMIT);
          invariant(bytes.length === ref.sizeBytes && hash(bytes) === ref.sha256, "LOCAL_BACKUP_CHECKSUM_MISMATCH", "Backup resource checksum mismatch");
          const duration = await mediaDuration(bytes, ref.mediaType); if (duration !== null) durations.set(ref.sha256, duration);
          assets.write(ref.sha256, bytes);
        }
        const actual = resources(db), byHash = new Map(entries.map(ref => [ref.sha256, ref]));
        invariant(actual.length === entries.length && actual.every(ref => { const expected = byHash.get(ref.sha256); return expected && expected.file === ref.file && expected.mediaType === ref.mediaType && expected.sizeBytes === ref.sizeBytes; }), "LOCAL_BACKUP_IMAGE_MANIFEST", "Resource manifest does not match database records");
        validateBackupContents(db, assets); validateBackupAudio(db, durations);
        for (const id of Object.keys(learning.notes)) invariant(db.prepare("SELECT 1 FROM questions WHERE id=?").get(id), "LOCAL_BACKUP_RELATIONS", "Backup note refers to an unknown question");
      } finally { db.close(); }
      syncFile(path);
      return { directory, path, resources: entries, settings: config, learning };
    } catch (error) { if (directory) rmSync(directory, { recursive: true, force: true }); throw error; }
    finally { zip.close(); }
  }
  private async preserveDamaged(destination: string, replacements: Resource[]): Promise<void> {
    const parent = dirname(destination), temporary = mkdtempSync(join(parent, ".pending-")), path = join(temporary, "practiq.sqlite"), assetDir = join(temporary, "assets");
    try {
      await this.snapshot(path, false); mkdirSync(assetDir, { mode: 0o700 });
      const db = new DatabaseSync(path, { readOnly: true }); let indexed: Resource[];
      try { db.exec("PRAGMA trusted_schema=OFF"); indexed = resources(db); } finally { db.close(); }
      const indexedByHash = new Map(indexed.map(ref => [ref.sha256, ref])), all = new Map([...indexed, ...replacements.filter(ref => !indexedByHash.has(ref.sha256))].map(ref => [ref.sha256, ref]));
      const database = fileDigest(path, BACKUP_LIMIT), inventory: Record<string, unknown>[] = []; let total = database.size;
      for (const ref of all.values()) {
        const record: Record<string, unknown> = { sha256: ref.sha256, mediaType: ref.mediaType, sizeBytes: ref.sizeBytes, indexed: indexedByHash.has(ref.sha256), ...(indexedByHash.has(ref.sha256) ? { originalFile: ref.file } : {}) };
        const source = this.store.assets.path(ref.sha256);
        if (!regularFileExists(source)) { record.status = "missing"; inventory.push(record); continue; }
        const bytes = readBounded(source, ASSET_LIMIT), actual = hash(bytes); total += bytes.length; invariant(total <= BACKUP_LIMIT, "LOCAL_BACKUP_TOO_LARGE", "Recovery payload exceeds 512 MiB");
        let status = "valid";
        if (actual !== ref.sha256 || bytes.length !== ref.sizeBytes) status = "damaged";
        else try { await mediaDuration(bytes, ref.mediaType); } catch { status = "invalidFormat"; }
        writeNewFile(join(assetDir, ref.sha256), bytes); Object.assign(record, { file: ref.file, status, actualSha256: actual, actualSizeBytes: bytes.length }); inventory.push(record);
      }
      const active = this.settings.read(), raw = Buffer.from(JSON.stringify({ format: "practiq-recovery", version: 1, schemaVersion: 11, database: { file: "practiq.sqlite", sha256: database.sha256, sizeBytes: database.size }, assets: inventory, learningData: this.store.learning.data(), ...(active.active ? { serviceSettings: { version: 1, config: active.active } } : {}) }));
      invariant(raw.length <= BACKUP_MANIFEST_LIMIT, "LOCAL_MANIFEST_TOO_LARGE", "Recovery manifest exceeds size limit");
      writeNewFile(join(temporary, "inventory.json"), raw); syncDirectory(assetDir); syncDirectory(temporary);
      renameSync(temporary, destination); syncDirectory(parent); syncDirectory(this.store.directory);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  async restore(source: string, repair: boolean): Promise<{ recoveryPath: string }> {
    const candidate = await this.stage(source), root = this.store.directory, settings = this.settings;
    let recoveryPath = "", suspended = false;
    try {
      const recoveries = join(root, "recoveries"); mkdirSync(recoveries, { recursive: true, mode: 0o700 });
      invariant(lstatSync(recoveries).isDirectory() && !lstatSync(recoveries).isSymbolicLink(), "LOCAL_BACKUP_PATH_INVALID", "Recovery directory must not be a link");
      recoveryPath = join(recoveries, `before-restore-${Date.now()}-${randomUUID()}${repair ? "" : ".zip"}`);
      if (repair) await this.preserveDamaged(recoveryPath, candidate.resources);
      else await this.export(recoveryPath);
      const staging = new Assets(candidate.directory, this.store.db);
      for (const ref of candidate.resources) {
        const bytes = staging.read(ref.sha256, ref.sizeBytes);
        if (!repair) this.store.assets.write(ref.sha256, bytes);
        else {
          try { this.store.assets.read(ref.sha256, ref.sizeBytes); continue; } catch { /* Explicit repair has already preserved the original bytes. */ }
          const target = this.store.assets.path(ref.sha256), temporary = join(dirname(target), `.repair-${randomUUID()}`); regularFileExists(target);
          try { writeNewFile(temporary, bytes); renameSync(temporary, target); syncDirectory(dirname(target)); } finally { rmSync(temporary, { force: true }); }
        }
      }
      const previous = join(candidate.directory, "previous.sqlite"); await this.snapshot(previous, false);
      settings.prepare(candidate.settings, fileDigest(candidate.path, BACKUP_LIMIT).sha256, { previous: this.store.learning.data(), next: candidate.learning });
      this.store.suspend(); suspended = true;
      try {
        regularFileExists(join(root, "practiq.sqlite")); renameSync(candidate.path, join(root, "practiq.sqlite")); syncDirectory(root);
        const db = new DatabaseSync(join(root, "practiq.sqlite"), { readOnly: true });
        try { settings.finish(true, db); } finally { db.close(); }
      } catch (error) {
        try {
          renameSync(previous, join(root, "practiq.sqlite")); syncDirectory(root);
          const db = new DatabaseSync(join(root, "practiq.sqlite"), { readOnly: true });
          try { settings.finish(false, db); } finally { db.close(); }
        } catch { throw new AppError("LOCAL_RESTORE_ROLLBACK_FAILED", "Restore recovery is required; restart the application", { path: recoveryPath }); }
        this.store.reopen(); suspended = false; throw error;
      }
      this.store.reopen(); suspended = false;
      try { this.store.assets.collect(); } catch { console.warn("Resource cleanup deferred after restore"); }
      return { recoveryPath };
    } catch (error) {
      try { if (settings.read().pending && !suspended) { this.store.suspend(); suspended = true; } } catch { if (!suspended) { this.store.suspend(); suspended = true; } }
      if (repair && recoveryPath) throw new AppError("LOCAL_RESTORE_RECOVERY_FAILED", "Recovery did not finish; original evidence is preserved", { path: recoveryPath, cause: error instanceof AppError ? error.code : "OPERATION_FAILED" });
      throw error;
    } finally { if (!suspended) rmSync(candidate.directory, { recursive: true, force: true }); }
  }
}
