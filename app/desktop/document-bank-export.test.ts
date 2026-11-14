import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactReference, DesktopDocumentBankSelection, DocumentBankImport } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSettingsView, AiSnapshot } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { bankResourcePlan } from "./bank-references.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { DocumentRuntime } from "./document-runtime.js";
import { ModelClient } from "./model.js";
import { PracticeStore } from "./store.js";
import { TencentClient } from "./tencent.js";
import * as zipWriter from "./zip.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.calls.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup(invalidImage = false) {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-export-")), data = join(path, "data"), calls = new AiDatabase(data), checkpoints = new SqliteCheckpoints(data), http = vi.fn(async (): Promise<Response> => { throw Error("Export cannot call providers"); });
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } }, view: AiSettingsView = { revision: config.revision, preferences: config.preferences, configured: { modelApiKey: false, tencentSecretId: false, tencentSecretKey: false } };
  const api = new DocumentApi(data, calls, checkpoints, new ModelClient(calls, http), new TencentClient(calls, http)), source = Buffer.from("Saved source and supplied answers"), sha256 = hash(source), document = { fileName: "source-text.txt", sourceType: "text" as const, mediaType: "text/plain", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length }; await api.storage.putSource(document, source);
  const zip = await zipWriter.BoundedZip.open(new URL("../fixtures/service-export/partial-media-bank.zip", import.meta.url).pathname, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  const root = JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString()) as Omit<DocumentBankImport, "title">, resources: ArtifactReference[] = [], references = new Map<string, ArtifactReference>();
  try { for (const [name, declared] of bankResourcePlan(root)) { const bytes = invalidImage && String(declared.mediaType).startsWith("image/") ? Buffer.from("not an image") : await zip.read(name, 25 * 1024 * 1024), reference = await api.storage.putArtifact(bytes, sha256, "saved-resource", resources.length, String(declared.mediaType)); resources.push(reference); references.set(String(declared.objectKey), reference); } }
  finally { zip.close(); }
  for (const visual of root.result.visualElements) for (const key of ["imageRef", "sourceRef"] as const) if (visual[key]) visual[key] = references.get(visual[key].objectKey)!;
  for (const question of root.result.questions) if (question.audioRef) question.audioRef = references.get(question.audioRef.objectKey)!;
  const runtime = new DocumentRuntime(api.tasks, checkpoints, { prepare: async () => ({ artifacts: [] }), recognize: async () => ({ artifacts: [] }), structure: async () => ({ artifacts: [] }), assemble: async () => {
    const result = await api.storage.putArtifact(Buffer.from(JSON.stringify(root.result)), sha256, "result", 0, "application/json"), processing = await api.storage.putArtifact(Buffer.from(JSON.stringify(root.processing)), sha256, "processing", 0, "application/json");
    return { artifacts: [...resources, result, processing], result, processing, status: root.status };
  } }, api.store);
  const receipt = api.tasks.create({ requestId: randomUUID(), document }, config); await runtime.run(receipt.threadId, config); const record = api.tasks.record(receipt.threadId); expect(record.state).toBe("COMPLETED");
  const selection: DesktopDocumentBankSelection = { threadId: record.id, checkpointId: record.checkpointId!, scope: "full" }, target = join(path, "bank.zip"); const f = { path, data, calls, checkpoints, api, config, view, root, resources, source, document, record, selection, target, http }; fixtures.push(f); return f;
}
const outputFiles = (f: Awaited<ReturnType<typeof setup>>) => readdirSync(f.path).filter(name => name === "bank.zip" || name.startsWith(".practiq-"));

it("exports historical partial media without keys or model work and round-trips through the normal ZIP importer", async () => {
  const f = await setup(), before = f.api.tasks.record(f.record.id), calls = f.calls.db.prepare("SELECT * FROM ai_calls").all();
  expect(await f.api.exportBankZip(f.selection, f.view, f.target)).toEqual({ threadId: f.record.id, checkpointId: f.selection.checkpointId, saved: true });
  const zip = await zipWriter.BoundedZip.open(f.target, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  try {
    expect(JSON.parse((await zip.read("manifest.json", 65536)).toString())).toEqual({ format: "practiq-question-bank", version: 2, bank: { title: "source-text", description: "" } });
    expect(JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString())).toEqual(f.root);
    for (const [name, ref] of bankResourcePlan(f.root)) expect(hash(await zip.read(name, 25 * 1024 * 1024))).toBe(ref.sha256);
  } finally { zip.close(); }
  expect(existsSync(join(f.data, "practiq.sqlite"))).toBe(false); const reader = new PracticeStore(join(f.path, "reader"));
  try { const preview = await reader.packages.previewZip(f.target) as { ticket: string; title: string; assetCount: number }; expect(preview.assetCount).toBeGreaterThan(0); const imported = reader.packages.import(preview.ticket, null, preview.title); expect(imported.count).toBe(2); }
  finally { reader.close(); }
  expect(f.api.tasks.record(f.record.id)).toEqual(before); expect(f.calls.db.prepare("SELECT * FROM ai_calls").all()).toEqual(calls); expect(f.http).not.toHaveBeenCalled(); expect(outputFiles(f)).toEqual(["bank.zip"]);
});

it("keeps selection closures and human revision history in portable exports without changing the original", async () => {
  const f = await setup(), before = structuredClone(f.root), question = structuredClone(f.root.result.questions[0]); question.analysis = "Human supplied correction";
  const requestId = randomUUID(); f.api.revisions.save(f.record.id, { requestId, checkpointId: f.selection.checkpointId, expectedRevision: null, questionIndex: 0, question });
  await f.api.exportBankZip({ ...f.selection, revisionId: requestId, questionIndexes: [0] }, f.view, f.target);
  const zip = await zipWriter.BoundedZip.open(f.target, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  try { const value = JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString()); expect(value.result.questions[0].analysis).toBe("Human supplied correction"); expect(value.result.warnings.some((warning: string) => warning.includes("Human-corrected"))).toBe(true); expect(value.result.questions.length).toBeLessThanOrEqual(f.root.result.questions.length); }
  finally { zip.close(); }
  expect(f.api.tasks.result(f.api.tasks.record(f.record.id))).toEqual(before.result); expect(f.http).not.toHaveBeenCalled();
});

it("exports only the completed scope of stopped work", async () => {
  const f = await setup(); f.api.tasks.stop(f.record.id, f.record.runId, "DOCUMENT_PARSE_FAILED", "structure");
  await expect(f.api.exportBankZip(f.selection, f.view, f.target)).rejects.toMatchObject({ code: "BANK_EXPORT_NOT_READY" });
  expect((await f.api.exportBankZip({ ...f.selection, scope: "completed" }, f.view, f.target)).saved).toBe(true); expect(f.api.tasks.record(f.record.id).state).toBe("FAILED"); expect(f.http).not.toHaveBeenCalled();
});

it.each(["stale", "source", "resource", "inside", "exists", "symlink", "invalid_image"])("rejects %s export without publishing or replacing user files", async kind => {
  const f = await setup(kind === "invalid_image"), selection = { ...f.selection }; let target = f.target;
  if (kind === "stale") selection.checkpointId = "stale";
  if (kind === "source") writeFileSync(f.api.storage.sourcePath(f.document), "damaged");
  if (kind === "resource") writeFileSync(join(f.api.storage.root, f.resources[0].objectKey), "damaged");
  if (kind === "inside") target = join(f.data, "bank.zip");
  if (kind === "exists") writeFileSync(target, "Existing user file");
  if (kind === "symlink") symlinkSync(f.api.storage.sourcePath(f.document), target);
  await expect(f.api.exportBankZip(selection, f.view, target)).rejects.toThrow();
  if (kind === "exists") expect(readFileSync(target, "utf8")).toBe("Existing user file"); else if (kind === "symlink") expect(readFileSync(target)).toEqual(f.source); else expect(existsSync(target)).toBe(false);
  expect(readdirSync(f.path).some(name => name.startsWith(".practiq-"))).toBe(false); expect(f.http).not.toHaveBeenCalled();
});

it.each(["checkpoint", "expiry", "deletion", "source"])("rechecks %s after ZIP streaming and before publication", async kind => {
  const f = await setup(), write = zipWriter.writeZip;
  vi.spyOn(zipWriter, "writeZip").mockImplementation((target, entries, limit, overwrite, guard) => write(target, entries, limit, overwrite, () => {
    if (kind === "checkpoint") f.api.tasks.update(f.record.id, f.record.runId, record => { record.checkpointId = "changed"; });
    if (kind === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 181 * 24 * 60 * 60 * 1000);
    if (kind === "deletion") f.api.tasks.beginDelete(f.record.id);
    if (kind === "source") writeFileSync(f.api.storage.sourcePath(f.document), "damaged"); guard?.();
  }));
  await expect(f.api.exportBankZip(f.selection, f.view, f.target)).rejects.toThrow(); expect(outputFiles(f)).toEqual([]); expect(f.http).not.toHaveBeenCalled();
});
