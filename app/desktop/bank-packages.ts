import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Question, DesktopDocumentBankSelection } from "../src/contracts.generated.js";
import type { QuestionRow } from "../src/api.js";
import { Assets, ASSET_LIMIT, hash } from "./assets.js";
import { copyContext, putContext, remapDiagnostics, remapQuestion, writeDiagnostics } from "./bank-context.js";
import { openPracticeDatabase, transaction } from "./database.js";
import { readDiagnostics } from "./diagnostics.js";
import { importDiagnostics, MAX_JSON_BYTES, parseJson, validateDocument } from "./document-contract.js";
import { invariant } from "./errors.js";
import { mediaDuration, validateSegment } from "./media.js";
import { composite, list, object, text, validateQuestion } from "./question-contract.js";
import { canonical, freeze, QuestionIndex, readQuestions, writeQuestion } from "./questions.js";
import { BoundedZip, writeZip, type ZipSource } from "./zip.js";
import { bankResourcePlan, resourceReferences } from "./bank-references.js";
import { validateContract } from "./contracts.js";
export { resourceReferences } from "./bank-references.js";

export const BANK_ZIP_LIMIT = 300 * 1024 * 1024;
const RESOURCE_LIMIT = 256 * 1024 * 1024, MANIFEST_LIMIT = 65536, ENTRY_LIMIT = 2002;
const resultOf = (root: unknown) => object(object(root).result ?? root);
interface Pending { ticket: string; root: Record<string, unknown>; title: string; description: string; assets: Map<string, { media: string; bytes: Buffer }>; missing: string[] }

export function bankExportDestination(directory: string, destination: string): string {
  const target = join(realpathSync(dirname(destination)), basename(destination)), path = relative(realpathSync(directory), target);
  invariant(path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path), "LOCAL_EXPORT_DESTINATION_INVALID", "Export outside the application data directory"); return target;
}

export async function verifyResource(reference: Record<string, unknown>, bytes: Buffer): Promise<number | null> {
  invariant(bytes.length <= ASSET_LIMIT && bytes.length === reference.sizeBytes && hash(bytes) === reference.sha256, "LOCAL_BANK_ZIP_INVALID", "Invalid resource size or checksum");
  return mediaDuration(bytes, text(reference, "mediaType"));
}

function treeSignature(rows: QuestionRow[]): string {
  const ids = new Map(rows.map((row, i) => [row.id, `q${i}`])), document = freeze(rows);
  document.questions = rows.map(row => remapQuestion(row.question, ids));
  for (const key of ["groups", "visuals"]) {
    document[key] = list(document, key).map(value => {
      const item = object(value); delete item.id;
      item.questionIds = list(item, "questionIds").map((id, i) => { const mapped = ids.get(String(id)); invariant(mapped, "LOCAL_QUESTION_INDEX_INVALID", "Missing group reference", { key: `${key}.questionIds`, i }); return mapped; }).sort();
      return item;
    }).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  }
  return hash(canonical(document));
}

export class BankPackages {
  private pending?: Pending;
  constructor(readonly db: DatabaseSync, readonly assets: Assets) {}
  asset(digest: string) { return this.pending?.assets.get(digest) ?? this.assets.bytes(digest); }
  async addExample(path = fileURLToPath(new URL("./resources/all-types.zip", import.meta.url))) {
    const p = object(await this.previewZip(path)); return this.import(String(p.ticket), null, String(p.title));
  }
  merge(banks: string[], title: string, locale: string): { bankId: string; count: number } {
    title = title.trim();
    invariant(banks.length >= 2 && banks.length <= 1000 && new Set(banks).size === banks.length && title && [...title].length <= 15, "LOCAL_MERGE_SELECTION_INVALID", "Choose distinct banks and a valid name");
    return transaction(this.db, () => {
      banks.forEach(bank => this.assertBank(bank));
      const order = new Map(banks.map((bank, index) => [bank, index])), rows = readQuestions(this.db, this.assets, banks).sort((a, b) => order.get(a.bankId)! - order.get(b.bankId)!);
      const bankId = randomUUID(), ids = new Map(rows.map(row => [row.id, randomUUID()]));
      this.db.prepare("INSERT INTO banks VALUES(?,?,?,?)").run(bankId, title, locale === "en" ? "Merged copy" : locale === "zh-TW" ? "合併副本" : "合并副本", Date.now());
      rows.forEach((row, index) => writeQuestion(this.db, remapQuestion(row.question, ids) as unknown as Question, bankId, null, index, row.favorite, false));
      copyContext(this.db, bankId, banks, rows, ids);
      return { bankId, count: rows.filter(row => !composite(row.question)).length };
    });
  }
  stage(input: unknown, title: string, description = ""): Pending {
    const root = validateDocument(input);
    return { ticket: randomUUID(), root, title, description, assets: new Map(), missing: [...resourceReferences(root).values()].map(ref => text(ref, "objectKey")) };
  }
  preview(input: unknown, title: string): unknown { this.pending = this.stage(input, title); return this.previewValue(); }
  async importDocument(input: unknown, resources: unknown[], selection: DesktopDocumentBankSelection): Promise<{ bankId: string; count: number }> {
    validateContract("DocumentBankImport", input); validateContract("DesktopDocumentBankSelection", selection);
    const value = object(input), title = [...text(value, "title").trim()].slice(0, 15).join("").trimEnd(), pending = this.stage(value, title), plan = bankResourcePlan(pending.root);
    invariant(resources.length === plan.size, "BANK_EXPORT_INVALID", "Bank resources do not match their declared inventory");
    const seen = new Set<string>();
    for (const item of resources) {
      const resource = object(item), reference = object(resource.reference), key = `resources/${text(reference, "objectKey")}`, declared = plan.get(key);
      invariant(Object.keys(resource).sort().join() === "bytes,reference" && declared && canonical(reference) === canonical(declared) && !seen.has(key) && resource.bytes instanceof Uint8Array && resource.bytes.byteLength === reference.sizeBytes && resource.bytes.byteLength <= ASSET_LIMIT, "BANK_EXPORT_INVALID", "Bank resource is missing, duplicated or undeclared");
      const bytes = Buffer.from(resource.bytes), duration = await verifyResource(reference, bytes); seen.add(key);
      if (duration !== null) for (const question of list(resultOf(pending.root), "questions")) if (text(object(question).audioRef, "sha256") === reference.sha256) validateSegment(question, duration);
      const digest = text(reference, "sha256"), previous = pending.assets.get(digest);
      invariant(!previous || previous.media === reference.mediaType, "BANK_EXPORT_INVALID", "Bank resource aliases have conflicting media types");
      pending.assets.set(digest, { media: text(reference, "mediaType"), bytes });
    }
    pending.missing = [];
    const result = this.importPending(pending, null, title, new Set(), { threadId: selection.threadId.toLowerCase(), checkpointId: selection.checkpointId });
    return { bankId: result.bankId, count: result.count };
  }
  private previewValue(): unknown {
    const p = this.pending; invariant(p, "LOCAL_IMPORT_MISSING", "No import preview"); const result = resultOf(p.root), questions = list(result, "questions");
    return { ticket: p.ticket, title: p.title, count: questions.filter(q => !composite(q)).length, reviewCount: questions.filter(q => !composite(q) && object(q).needsReview === true).length,
      questions, groups: result.groups, visuals: result.visualElements, warnings: result.warnings, status: p.root.status ?? null, processing: p.root.processing ?? null,
      importDiagnostics: importDiagnostics(p.root), missingAssets: p.missing, assetCount: p.assets.size };
  }
  async previewZip(path: string): Promise<unknown> {
    const zip = await BoundedZip.open(path, { archiveBytes: BANK_ZIP_LIMIT, expandedBytes: MAX_JSON_BYTES + RESOURCE_LIMIT + MANIFEST_LIMIT, entries: ENTRY_LIMIT });
    try {
      const manifest = object(parseJson(await zip.read("manifest.json", MANIFEST_LIMIT))), bank = object(manifest.bank);
      invariant(manifest.format !== "practiq-backup", "LOCAL_USE_BACKUP_RESTORE", "Use full-data restoration for this backup");
      invariant(Object.keys(manifest).sort().join() === "bank,format,version" && Object.keys(bank).sort().join() === "description,title" && manifest.format === "practiq-question-bank" && manifest.version === 2 &&
        typeof bank.title === "string" && bank.title.trim() && [...bank.title].length <= 255 && typeof bank.description === "string" && [...bank.description].length <= 20000,
      "LOCAL_BANK_ZIP_INVALID", "Unsupported package or invalid bank metadata");
      const pending = this.stage(parseJson(await zip.read("questions.json", MAX_JSON_BYTES)), bank.title as string, bank.description as string), refs = resourceReferences(pending.root);
      const allowed = new Set(["manifest.json", "questions.json", ...refs.keys()]);
      invariant(allowed.size === zip.entries.size && [...zip.entries.keys()].every(key => allowed.has(key)), "LOCAL_BANK_ZIP_INVALID", "Missing or undeclared ZIP files");
      let total = 0;
      for (const [name, ref] of refs) {
        const bytes = await zip.read(name, ASSET_LIMIT); total += bytes.length; invariant(total <= RESOURCE_LIMIT, "LOCAL_BANK_ZIP_INVALID", "Resources exceed 256 MiB");
        const duration = await verifyResource(ref, bytes);
        if (duration !== null) for (const q of list(resultOf(pending.root), "questions")) if (text(object(q).audioRef, "sha256") === ref.sha256) validateSegment(q, duration);
        const digest = text(ref, "sha256"), previous = pending.assets.get(digest);
        invariant(!previous || previous.media === ref.mediaType, "LOCAL_BANK_ZIP_INVALID", "Conflicting resource types");
        pending.assets.set(digest, { media: text(ref, "mediaType"), bytes });
      }
      pending.missing = []; this.pending = pending; return this.previewValue();
    } finally { zip.close(); }
  }
  private selected(ticket: string): Pending { invariant(this.pending?.ticket === ticket, "LOCAL_IMPORT_EXPIRED", "Import preview expired"); return this.pending; }
  private assertBank(bank: string): void { invariant(this.db.prepare("SELECT 1 FROM banks WHERE id=?").get(bank), "LOCAL_BANK_MISSING", "Destination bank no longer exists"); }
  private digest(p: Pending): string { return hash(canonical(resultOf(p.root))); }
  private repairDiagnostics(p: Pending, importId: string): void {
    const diagnostics = importDiagnostics(p.root), questions = list(resultOf(p.root), "questions");
    if (!diagnostics.length) return;
    const saved = this.db.prepare("SELECT id FROM questions WHERE import_id=? ORDER BY position").all(importId).map(row => String(row.id));
    if (saved.length !== questions.length) return;
    const ids = new Map(questions.map((q, i) => [text(q, "id"), saved[i]])), rows = new Map(readQuestions(this.db, this.assets, [], saved).map(row => [row.id, row])), identities = new Set<string>();
    for (const question of questions) {
      const row = rows.get(ids.get(text(question, "id"))!); if (!row) return;
      const expected = object(validateQuestion(remapQuestion(question, ids))), actual = object(validateQuestion(row.question));
      for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) { expected[key] ??= null; actual[key] ??= null; }
      const expectedSources = diagnostics.flatMap(d => list(d.processing, "questionSources")).filter(source => text(source, "questionId") === text(question, "id")).map(source => canonical({ ...object(source), questionId: row.id })).sort();
      const actualSources = [...new Set(row.sources.map(canonical))].sort(), expectedSet = [...new Set(expectedSources)];
      const identity = canonical([object(question).stem ?? null, object(question).sourceText ?? null, object(question).answerMode ?? null, object(question).answerPayload ?? null, object(question).options, object(question).items,
        [...new Set(row.sources.map(source => canonical([object(source).stage, object(source).unitIndex])))].sort()]);
      if (canonical(expected) !== canonical(actual) || canonical(expectedSet) !== canonical(actualSources) || identities.has(identity)) return;
      identities.add(identity);
    }
    writeDiagnostics(this.db, importId, remapDiagnostics(diagnostics, ids));
  }
  duplicates(ticket: string, bank: string): { groups: { id: string; stem: string | null; count: number }[]; check: string } {
    const p = this.selected(ticket); this.assertBank(bank);
    const rows = readQuestions(this.db, this.assets, [bank]), index = new QuestionIndex(rows), signatures = new Set(rows.filter(row => !row.question.parentId).map(row => treeSignature(index.trees.get(row.id)!)));
    const directory = mkdtempSync(join(this.assets.directory, ".practiq-compare-")), db = openPracticeDatabase(directory);
    try {
      const staged = new BankPackages(db, new Assets(directory, db)), imported = staged.importPending({ ...p, assets: new Map() }, null, p.title), incoming = readQuestions(db, staged.assets, [imported.bankId]);
      const mapping = new Map(incoming.map((row, i) => [row.id, text(list(resultOf(p.root), "questions")[i], "id")])), incomingIndex = new QuestionIndex(incoming), checks: string[] = [], groups: { id: string; stem: string | null; count: number }[] = [];
      for (const row of incoming.filter(row => !row.question.parentId)) {
        const tree = incomingIndex.trees.get(row.id)!, digest = treeSignature(tree); checks.push(digest);
        if (signatures.has(digest)) groups.push({ id: mapping.get(row.id)!, stem: row.question.stem, count: tree.filter(row => !composite(row.question)).length });
      }
      return { groups, check: hash(canonical([bank, this.digest(p), [...signatures].sort(), checks])) };
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  import(ticket: string, bank: string | null, title: string, skip = false, check?: string) {
    const p = this.selected(ticket), skipped = new Set<string>();
    if (skip) {
      invariant(bank, "LOCAL_BANK_MISSING", "Choose an existing bank before skipping duplicates"); const comparison = this.duplicates(ticket, bank);
      invariant(check === comparison.check, "LOCAL_DUPLICATE_CHECK_CHANGED", "Destination content changed; compare duplicates again");
      comparison.groups.forEach(group => skipped.add(group.id));
      let before = -1;
      while (before !== skipped.size) { before = skipped.size; for (const q of list(resultOf(p.root), "questions")) if (skipped.has(text(q, "parentId"))) skipped.add(text(q, "id")); }
    }
    const result = this.importPending(p, bank, title, skipped); this.pending = undefined; return result;
  }
  private importPending(p: Pending, bank: string | null, title: string, skipped = new Set<string>(), source?: { threadId: string; checkpointId: string }) {
    title = title.trim();
    invariant(title && [...title].length <= 255 && (bank !== null || title === p.title.trim() || [...title].length <= 15), "LOCAL_NAME_INVALID", "Invalid bank name");
    if (bank !== null) this.assertBank(bank);
    const digest = this.digest(p);
    for (const [digest, { bytes }] of p.assets) this.assets.write(digest, bytes);
    return transaction(this.db, () => {
      if (source) {
        const previous = this.db.prepare("SELECT i.bank_id,i.id,i.digest FROM ai_imports a JOIN imports i ON i.id=a.import_id WHERE a.thread_id=? AND a.digest=?").get(source.threadId, digest);
        if (previous) { invariant(previous.digest === digest, "LOCAL_IMPORT_RECEIPT_INVALID", "Saved import receipt points to different content"); this.repairDiagnostics(p, String(previous.id)); return { bankId: String(previous.bank_id), count: list(resultOf(p.root), "questions").filter(q => !composite(q)).length }; }
      }
      for (const [digest, { media, bytes }] of p.assets) this.db.prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?)").run(digest, media, bytes.length, `assets/${digest}`);
      const id = bank ?? randomUUID();
      if (bank === null) this.db.prepare("INSERT INTO banks VALUES(?,?,?,?)").run(id, title, p.description, Date.now());
      const previous = this.db.prepare("SELECT id FROM imports WHERE bank_id=? AND digest=?").get(id, digest);
      if (previous) { this.repairDiagnostics(p, String(previous.id)); return { duplicate: true, bankId: id, count: 0, skippedCount: 0 }; }
      const result = structuredClone(resultOf(p.root)), original = list(result, "questions");
      result.questions = original.filter(q => !skipped.has(text(q, "id")));
      const keepContext = !skipped.size || list(result, "questions").length > 0;
      for (const key of ["groups", "visualElements"]) result[key] = list(result, key).filter(value => {
        const refs = list(value, "questionIds"), wasEmpty = !refs.length; object(value).questionIds = refs.filter(id => !skipped.has(String(id)));
        return keepContext && (wasEmpty || list(value, "questionIds").length > 0);
      });
      const importId = randomUUID(), questions = list(result, "questions"), ids = new Map(questions.map(q => [text(q, "id"), randomUUID()]));
      this.db.prepare("INSERT INTO imports VALUES(?,?,?,?)").run(importId, id, digest, Date.now());
      const offset = Number(this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS position FROM questions WHERE bank_id=?").get(id)!.position);
      questions.forEach((q, i) => writeQuestion(this.db, remapQuestion(q, ids) as unknown as Question, id, importId, offset + i, false, false));
      const diagnostics = importDiagnostics(p.root), retained = new Map(questions.map(q => [text(q, "id"), text(q, "id")]));
      putContext(this.db, id, result, ids, importId, remapDiagnostics(diagnostics, retained));
      if (source) this.db.prepare("INSERT INTO ai_imports VALUES(?,?,?,?)").run(source.threadId, digest, source.checkpointId, importId);
      const count = questions.filter(q => !composite(q)).length;
      return { duplicate: count === 0 && skipped.size > 0, bankId: id, count, skippedCount: original.filter(q => skipped.has(text(q, "id")) && !composite(q)).length };
    });
  }
  async export(bank: string, destination: string): Promise<{ path: string }> {
    const target = bankExportDestination(this.assets.directory, destination);
    const snapshot = transaction(this.db, () => {
      const metadata = this.db.prepare("SELECT title,description FROM banks WHERE id=?").get(bank); invariant(metadata, "LOCAL_BANK_MISSING", "Bank no longer exists");
      const rows = readQuestions(this.db, this.assets, [bank]), frozen = freeze(rows);
      const clean = (key: string) => list(frozen, key).map(value => { const item = object(structuredClone(value)); delete item.id; return item; });
      let warnings = this.db.prepare("SELECT w.message FROM import_warnings w JOIN imports i ON i.id=w.import_id WHERE i.bank_id=? AND w.position>=0 ORDER BY i.created_at,i.rowid,w.position").all(bank).map(row => String(row.message));
      const missingFields = ["questions", "media"].filter(field => field === "questions" && !rows.length || warnings.includes(`PRACTIQ_MISSING:${field}`));
      warnings = warnings.filter(value => !["PRACTIQ_MISSING:questions", "PRACTIQ_MISSING:media"].includes(value));
      const groups = clean("groups"), visuals = clean("visuals");
      for (const row of this.db.prepare("SELECT title,instructions FROM sections s WHERE bank_id=? AND NOT EXISTS(SELECT 1 FROM section_questions WHERE section_id=s.id) ORDER BY rowid").all(bank)) groups.push({ title: row.title, instructions: row.instructions, questionIds: [] });
      for (const row of this.db.prepare("SELECT content FROM visuals WHERE bank_id=? AND document_level=1 AND (? OR json_extract(content,'$.documentOnly')=1) ORDER BY rowid").all(bank, Number(!rows.length))) visuals.push({ ...object(JSON.parse(String(row.content))), questionIds: [] });
      const diagnostics = readDiagnostics(this.db, bank), result = { schemaVersion: 3, questions: rows.map(row => row.question), groups, visualElements: visuals, warnings, missingFields, confidenceScore: rows.length ? rows.reduce((min, row) => Math.min(min, row.question.confidence), 1) * 100 : 0 };
      const status = diagnostics.some(d => d.status === "PARTIAL") ? "PARTIAL" : diagnostics.every(d => d.status === "SUCCEEDED") ? "SUCCEEDED" : null;
      const root = diagnostics.length ? { result, importDiagnostics: diagnostics, status, processing: diagnostics.length === 1 ? diagnostics[0].processing : null } : result;
      return { root: validateDocument(root), metadata };
    });
    const refs = resourceReferences(snapshot.root), json = Buffer.from(JSON.stringify(snapshot.root)), manifest = Buffer.from(JSON.stringify({ format: "practiq-question-bank", version: 2, bank: snapshot.metadata }));
    invariant(refs.size + 2 <= ENTRY_LIMIT && json.length <= MAX_JSON_BYTES && manifest.length <= MANIFEST_LIMIT, "LOCAL_BANK_ZIP_INVALID", "Bank package exceeds its entry or metadata limit");
    const entries: ZipSource[] = [{ name: "manifest.json", data: manifest }, { name: "questions.json", data: json }]; let total = 0;
    for (const [name, ref] of refs) {
      const bytes = this.assets.read(text(ref, "sha256"), Number(ref.sizeBytes)); total += bytes.length;
      invariant(total <= RESOURCE_LIMIT, "LOCAL_BANK_ZIP_INVALID", "Resources exceed 256 MiB");
      const duration = await verifyResource(ref, bytes);
      if (duration !== null) for (const q of list(resultOf(snapshot.root), "questions")) if (text(object(q).audioRef, "sha256") === ref.sha256) validateSegment(q, duration);
      entries.push({ name, path: this.assets.path(text(ref, "sha256")), size: bytes.length, sha256: text(ref, "sha256") });
    }
    await writeZip(target, entries, BANK_ZIP_LIMIT); return { path: destination };
  }
}
