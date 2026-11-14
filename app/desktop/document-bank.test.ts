import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactReference, DesktopDocumentBankSelection, DocumentBankImport, DocumentParseResult } from "../src/contracts.generated.js";
import { PracticeStore } from "./store.js";
import { BoundedZip } from "./zip.js";
import { bankResourcePlan } from "./bank-references.js";
import { parseJson, validateParsedDocument } from "./document-contract.js";
import { selectBankQuestions } from "./document-bank.js";
import { readQuestions } from "./questions.js";
import { readDiagnostics } from "./diagnostics.js";

const fixtures: { path: string; store: PracticeStore }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-direct-bank-")), store = new PracticeStore(join(path, "data")); fixtures.push({ path, store });
  const zip = await BoundedZip.open(new URL("../fixtures/service-export/partial-media-bank.zip", import.meta.url).pathname, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  try {
    const root = parseJson(await zip.read("questions.json", 32 * 1024 * 1024)) as Omit<DocumentBankImport, "title">, value: DocumentBankImport = { title: "Direct backend result", ...root }, resources: { reference: ArtifactReference; bytes: Buffer }[] = [];
    for (const [name, reference] of bankResourcePlan(value)) resources.push({ reference: reference as unknown as ArtifactReference, bytes: await zip.read(name, 25 * 1024 * 1024) });
    const selection: DesktopDocumentBankSelection = { threadId: randomUUID(), checkpointId: "reviewed-checkpoint", scope: "full" };
    const perform = (data = value, files: unknown[] = resources, source = selection) => store.request({ type: "_import_document_bank", value: data, resources: files, selection: source }) as Promise<{ bankId: string; count: number }>;
    return { path, store, value, resources, selection, perform };
  } finally { zip.close(); }
}

it("retains complete material and shared-option groups when exporting selected children", () => {
  const original = validateParsedDocument(parseJson(readFileSync(new URL("../fixtures/composite.json", import.meta.url)))) as unknown as DocumentParseResult, before = structuredClone(original);
  expect(selectBankQuestions(original, [4]).questions.map(question => question.id)).toEqual(original.questions.slice(0, 9).map(question => question.id));
  expect(selectBankQuestions(original, [10, 10]).questions.map(question => question.id)).toEqual(["words-root", "words-root1", "words-root2"]);
  expect(original).toEqual(before); for (const invalid of [[], [-1], [0.5], [15], [Number.MAX_SAFE_INTEGER]]) expect(() => selectBankQuestions(original, invalid)).toThrow();
});

it("imports the historical partial-media snapshot directly, preserving diagnostics, checked assets and schema 11", async () => {
  const f = await setup(), imported = await f.perform(), rows = readQuestions(f.store.db, f.store.assets, [imported.bankId]);
  expect(imported.count).toBe(2); expect(f.store.banks()[0].title).toBe("Direct backend"); expect(rows.every(row => !row.missingAssets)).toBe(true);
  expect(readDiagnostics(f.store.db, imported.bankId)[0].status).toBe(f.value.status); expect(rows.some(row => row.visuals.length > 0)).toBe(true);
  for (const resource of f.resources) expect(f.store.assets.read(resource.reference.sha256, resource.bytes.length)).toEqual(resource.bytes);
  expect(f.store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(11); expect(f.store.db.prepare("SELECT * FROM ai_imports").get()).toMatchObject({ thread_id: f.selection.threadId, checkpoint_id: f.selection.checkpointId });
  expect((await f.perform()).bankId).toBe(imported.bankId); expect(f.store.banks()).toHaveLength(1);
});

it("limits newly imported names by Unicode codepoints without splitting surrogate pairs", async () => {
  const f = await setup(), value = { ...f.value, title: "😀".repeat(16) }, receipt = await f.perform(value);
  expect(f.store.banks().find(bank => bank.id === receipt.bankId)!.title).toBe("😀".repeat(15));
});

it("recovers the same local receipt after restart without overwriting edits or importing a second bank", async () => {
  const f = await setup(), imported = await f.perform(), rows = readQuestions(f.store.db, f.store.assets, [imported.bankId]), root = rows.find(row => !row.question.parentId)!;
  f.store.saveBank(imported.bankId, "My local edits", "Retain these"); f.store.favorite(root.id, true);
  f.store.close(); f.store = new PracticeStore(join(f.path, "data")); fixtures.find(fixture => fixture.path === f.path)!.store = f.store;
  const recovered = await f.store.packages.importDocument(f.value, f.resources, { ...f.selection, threadId: f.selection.threadId.toUpperCase() });
  expect(recovered).toEqual(imported); expect(f.store.banks()).toHaveLength(1); expect(f.store.banks()[0].title).toBe("My local edits"); expect(readQuestions(f.store.db, f.store.assets, [imported.bankId]).find(row => row.id === root.id)?.favorite).toBe(true);
});

it.each(["missing", "extra", "corrupt", "alias", "too-large"])("rejects %s resources before creating database references", async kind => {
  const f = await setup(), files = f.resources.map(resource => ({ ...resource, reference: { ...resource.reference }, bytes: Buffer.from(resource.bytes) })); let value = f.value;
  if (kind === "missing") files.pop();
  if (kind === "extra") files.push(files[0]);
  if (kind === "corrupt") files[0].bytes = Buffer.from("damaged resource");
  if (kind === "alias") files[0].reference.objectKey = "foreign-resource";
  if (kind === "too-large") { value = structuredClone(value); value.result.visualElements[0].imageRef!.sizeBytes = 25 * 1024 * 1024 + 1; }
  const write = vi.spyOn(f.store.assets, "write"); await expect(f.perform(value, files)).rejects.toThrow(); expect(write).not.toHaveBeenCalled();
  expect(f.store.banks()).toHaveLength(0); expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM assets").get()!.n).toBe(0); expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_imports").get()!.n).toBe(0);
});

it("rolls back the bank, questions, metadata and identity receipt together on receipt failure", async () => {
  const f = await setup(); f.store.db.exec("CREATE TRIGGER fail_document_receipt BEFORE INSERT ON ai_imports BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END");
  await expect(f.perform()).rejects.toThrow("simulated receipt failure");
  for (const table of ["banks", "questions", "imports", "assets", "ai_imports"]) expect(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
  f.store.db.exec("DROP TRIGGER fail_document_receipt"); expect((await f.perform()).count).toBe(2);
});

it("refuses a corrupted identity link rather than adopting another local bank", async () => {
  const f = await setup(), first = await f.perform(), changed = structuredClone(f.value); changed.result.warnings.push("Different saved snapshot");
  const second = await f.perform(changed), target = f.store.db.prepare("SELECT id FROM imports WHERE bank_id=?").get(second.bankId)!.id;
  f.store.db.prepare("UPDATE ai_imports SET import_id=? WHERE import_id IN (SELECT id FROM imports WHERE bank_id=?)").run(target, first.bankId);
  await expect(f.perform()).rejects.toMatchObject({ code: "LOCAL_IMPORT_RECEIPT_INVALID" }); expect(f.store.banks()).toHaveLength(2);
});

it("validates listening segment bounds before storing any resource references", async () => {
  const f = await setup(), value = structuredClone(f.value), question = value.result.questions.find(question => question.audioRef)!; question.audioEndSeconds = 1000000;
  const write = vi.spyOn(f.store.assets, "write"); await expect(f.perform(value)).rejects.toThrow(); expect(write).not.toHaveBeenCalled(); expect(f.store.banks()).toHaveLength(0);
});

it("leaves a pending ZIP preview available while importing a document result", async () => {
  const f = await setup(), preview = f.store.packages.preview({ schemaVersion: 3, questions: [{ id: "one", stem: "Pending preview", answerMode: "true_false", answerPayload: { value: true } }], groups: [], visualElements: [], warnings: [], confidenceScore: 0 }, "Pending") as { ticket: string };
  await f.perform(); expect(f.store.packages.import(preview.ticket, null, "Pending").count).toBe(1); expect(f.store.banks()).toHaveLength(2);
});
