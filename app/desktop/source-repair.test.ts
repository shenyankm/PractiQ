import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiStorage, sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { DocumentTasks } from "./document-tasks.js";
import { fileDigest, readBounded } from "./filesystem.js";
import { SqliteStore } from "./graph-store.js";
import { modelSlots, tencentSlots } from "./provider-slots.js";
import { SourceRepairs } from "./source-repair.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.tasks.close(); f.store.stop(); f.calls.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-source-repair-")), calls = new AiDatabase(path), storage = new AiStorage(path), tasks = new DocumentTasks(path, storage, calls), store = new SqliteStore(path);
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const source = Buffer.from("Original questions and supplied answers.\n"), sha256 = hash(source), document = { sourceType: "text" as const, mediaType: "text/plain", fileName: "questions.txt", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length };
  await storage.putSource(document, source); const receipt = tasks.create({ requestId: randomUUID(), document }, config); tasks.stop(receipt.threadId, receipt.runId!, "DOCUMENT_PARSE_FAILED", "prepare");
  const controls = { running: false }, repairs = new SourceRepairs(tasks, store, () => controls.running), status = repairs.status(receipt.threadId), request = { requestId: randomUUID(), expectedVersion: status.taskVersion }, replacement = join(path, "replacement.txt"); writeFileSync(replacement, source);
  const f = { path, calls, storage, tasks, store, source, document, receipt, repairs, request, controls, replacement, stored: storage.sourcePath(document), quarantine: join(storage.root, ".quarantine", "source-repair") }; fixtures.push(f); return f;
}
const rows = (f: Awaited<ReturnType<typeof setup>>) => ({ tasks: f.tasks.db.prepare("SELECT * FROM document_tasks").all(), operations: f.tasks.db.prepare("SELECT * FROM document_operations").all(), artifacts: f.tasks.db.prepare("SELECT * FROM document_artifacts").all(), calls: f.calls.db.prepare("SELECT * FROM ai_calls").all() });

it("checks source integrity passively and quarantines corrupt bytes before exact replacement without altering task or call evidence", async () => {
  const f = await setup(), before = rows(f); expect(f.repairs.status(f.receipt.threadId)).toMatchObject({ status: "verified", errorCode: null, canRepair: false });
  writeFileSync(f.stored, "damaged"); expect(f.repairs.status(f.receipt.threadId)).toMatchObject({ status: "corrupt", errorCode: "DOCUMENT_SIZE_MISMATCH", canRepair: true });
  expect(f.store.read(f.repairs.namespace, f.request.requestId)).toBeNull(); expect(await f.repairs.repair(f.receipt.threadId, f.request, null)).toBeNull(); expect(existsSync(f.quarantine)).toBe(false);
  const result = await f.repairs.repair(f.receipt.threadId, f.request, f.replacement); expect(result).toMatchObject({ status: "repaired", requestId: f.request.requestId });
  const directory = join(f.quarantine, result!.quarantineId!); expect(readFileSync(join(directory, "original"), "utf8")).toBe("damaged");
  expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toMatchObject({ version: 1, completed: true, document: f.document, requestId: f.request.requestId, original: { file: "original", sha256: hash(Buffer.from("damaged")), sizeBytes: 7 } });
  expect(lstatSync(directory).mode & 0o777).toBe(0o700); for (const file of [f.stored, join(directory, "original"), join(directory, "manifest.json")]) expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(f.storage.source(f.document)).toEqual(f.source); expect(rows(f)).toEqual(before); expect(await f.repairs.repair(f.receipt.threadId, f.request, "/unneeded/missing/file")).toEqual(result); expect(readdirSync(f.quarantine)).toHaveLength(1);
  await expect(f.repairs.repair(f.receipt.threadId, { ...f.request, expectedVersion: f.request.expectedVersion + 1 }, f.replacement)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  writeFileSync(f.stored, "changed again"); await expect(f.repairs.repair(f.receipt.threadId, f.request, null)).rejects.toMatchObject({ code: "SOURCE_REPAIR_CHANGED" });
});

it.each(["missing", "checksum", "empty"])("repairs a %s source while retaining its original condition", async kind => {
  const f = await setup(); if (kind === "missing") unlinkSync(f.stored); else writeFileSync(f.stored, kind === "empty" ? "" : Buffer.alloc(f.source.length, 120));
  expect(f.repairs.status(f.receipt.threadId).errorCode).toBe(kind === "missing" ? "OBJECT_NOT_FOUND" : kind === "checksum" ? "DOCUMENT_CHECKSUM_MISMATCH" : "DOCUMENT_SIZE_MISMATCH");
  const result = await f.repairs.repair(f.receipt.threadId, f.request, f.replacement), directory = join(f.quarantine, result!.quarantineId!), manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  expect(f.storage.source(f.document)).toEqual(f.source); expect(manifest.completed).toBe(true); expect(manifest.original === null).toBe(kind === "missing"); if (kind === "empty") expect(readFileSync(join(directory, "original"))).toHaveLength(0);
});

it("keeps integrity checks read-only for another owner and refuses missing roots or altered repair receipts", async () => {
  const f = await setup(); vi.spyOn(process, "geteuid").mockReturnValue(999999); expect(f.repairs.status(f.receipt.threadId).status).toBe("verified"); vi.restoreAllMocks();
  writeFileSync(f.stored, "damaged"); await f.repairs.repair(f.receipt.threadId, f.request, f.replacement);
  f.store.updateSync(f.repairs.namespace, f.request.requestId, value => ({ ...value!, result: { ...(value!.result as object), status: "verified" } }));
  await expect(f.repairs.repair(f.receipt.threadId, f.request, null)).rejects.toMatchObject({ code: "SOURCE_REPAIR_INVALID" });
  rmSync(f.storage.root, { recursive: true }); expect(() => f.repairs.status(f.receipt.threadId)).toThrow(); await expect(f.repairs.repair(f.receipt.threadId, { ...f.request, requestId: randomUUID() }, f.replacement)).rejects.toMatchObject({ code: "SOURCE_REPAIR_ROOT_MISSING" }); expect(existsSync(f.storage.root)).toBe(false);
});

it.each(["wrong_hash", "too_large", "symlink", "directory", "fifo"])("rejects %s replacement before changing source or creating repair records", async kind => {
  const f = await setup(); writeFileSync(f.stored, "damaged"); unlinkSync(f.replacement);
  if (kind === "wrong_hash") writeFileSync(f.replacement, Buffer.alloc(f.source.length, 120));
  if (kind === "too_large") writeFileSync(f.replacement, Buffer.alloc(f.source.length + 1));
  if (kind === "symlink") symlinkSync(f.stored, f.replacement);
  if (kind === "directory") mkdirSync(f.replacement);
  if (kind === "fifo") execFileSync("mkfifo", [f.replacement]);
  await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toThrow(); expect(readFileSync(f.stored, "utf8")).toBe("damaged"); expect(existsSync(f.quarantine)).toBe(false); expect(f.store.read(f.repairs.namespace, f.request.requestId)).toBeNull();
  if (kind === "fifo") { expect(() => fileDigest(f.replacement, 100)).toThrow(); expect(() => readBounded(f.replacement, 100)).toThrow(); }
});

it.each(["runtime", "task", "model", "tencent"])("requires stopped %s writers before changing any source", async kind => {
  const f = await setup(); writeFileSync(f.stored, "damaged"); let release: (() => void) | undefined, work: Promise<void> | undefined;
  if (kind === "runtime") f.controls.running = true;
  if (kind === "task") f.tasks.update(f.receipt.threadId, f.receipt.runId!, record => { record.state = "PENDING"; });
  if (kind === "model" || kind === "tencent") work = (kind === "model" ? modelSlots : tencentSlots).run(1, undefined, () => new Promise<void>(resolve => { release = resolve; }));
  try { expect(f.repairs.status(f.receipt.threadId).canRepair).toBe(false); await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toMatchObject({ code: "SOURCE_REPAIR_BUSY" }); expect(existsSync(f.quarantine)).toBe(false); expect(readFileSync(f.stored, "utf8")).toBe("damaged"); }
  finally { release?.(); await work; }
});

it("fences changed task versions and rejects stored source or quarantine symlinks", async () => {
  const f = await setup(); writeFileSync(f.stored, "damaged"); f.tasks.update(f.receipt.threadId, f.receipt.runId!, record => { record.errorCode = "DOCUMENT_RUN_FAILED"; });
  await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toMatchObject({ code: "STALE_CHECKPOINT" }); expect(existsSync(f.quarantine)).toBe(false);
  f.request.expectedVersion = f.repairs.status(f.receipt.threadId).taskVersion; unlinkSync(f.stored); symlinkSync(f.replacement, f.stored);
  expect(() => f.repairs.status(f.receipt.threadId)).toThrow(); await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toThrow(); unlinkSync(f.stored); writeFileSync(f.stored, "damaged");
  symlinkSync(f.path, join(f.storage.root, ".quarantine")); await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toMatchObject({ code: "INVALID_OBJECT_REFERENCE" }); expect(readFileSync(f.stored, "utf8")).toBe("damaged");
});

it.each(["before_manifest", "before_source", "after_source", "before_receipt"])("retains preservation evidence and explicitly finishes %s interruption after reopening the Store", async phase => {
  const f = await setup(); writeFileSync(f.stored, "damaged"); const target = f.repairs as unknown as { publish(path: string, bytes: Buffer): void }, publish = target.publish.bind(f.repairs), update = f.store.updateSync.bind(f.store); let count = 0;
  vi.spyOn(target, "publish").mockImplementation((path, bytes) => { count++; if (phase === "before_manifest" && count === 1 || phase === "before_source" && count === 2 || phase === "after_source" && count === 3) throw Error("Interrupted filesystem write"); publish(path, bytes); });
  vi.spyOn(f.store, "updateSync").mockImplementation((namespace, key, change) => { update(namespace, key, value => { const next = change(value); if (phase === "before_receipt" && next?.result) throw Error("Interrupted receipt write"); return next; }); });
  const before = rows(f); await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toThrow(); expect(rows(f)).toEqual(before); const pending = f.store.read(f.repairs.namespace, f.request.requestId)!.value; expect(pending.result).toBeNull(); const directory = join(f.quarantine, String(pending.quarantineId)); expect(readFileSync(join(directory, "original"), "utf8")).toBe("damaged");
  vi.restoreAllMocks(); f.store.stop(); f.store = new SqliteStore(f.path); f.repairs = new SourceRepairs(f.tasks, f.store, () => false);
  const alreadyPublished = phase === "after_source" || phase === "before_receipt"; expect(f.repairs.status(f.receipt.threadId).status).toBe(alreadyPublished ? "verified" : "corrupt");
  const replay = await f.repairs.repair(f.receipt.threadId, f.request, null); expect(replay === null).toBe(!alreadyPublished);
  const result = replay ?? await f.repairs.repair(f.receipt.threadId, f.request, f.replacement); expect(result).toMatchObject({ status: "repaired", quarantineId: pending.quarantineId }); expect(f.storage.source(f.document)).toEqual(f.source); expect(rows(f)).toEqual(before); expect(readdirSync(f.quarantine)).toHaveLength(1); expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).completed).toBe(true);
});

it("refuses altered quarantine evidence and owner mismatch without replacing source", async () => {
  const f = await setup(); writeFileSync(f.stored, "damaged"); const target = f.repairs as unknown as { publish(path: string, bytes: Buffer): void }, publish = target.publish.bind(f.repairs); let count = 0;
  vi.spyOn(target, "publish").mockImplementation((path, bytes) => { if (++count === 2) throw Error("Stop before source"); publish(path, bytes); }); await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toThrow(); vi.restoreAllMocks();
  const pending = f.store.read(f.repairs.namespace, f.request.requestId)!.value, directory = join(f.quarantine, String(pending.quarantineId)); writeFileSync(join(directory, "original"), "altered");
  await expect(f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).rejects.toMatchObject({ code: "SOURCE_REPAIR_INVALID" }); expect(readFileSync(f.stored, "utf8")).toBe("damaged");
  vi.spyOn(process, "geteuid").mockReturnValue(999999); await expect(f.repairs.repair(f.receipt.threadId, { ...f.request, requestId: randomUUID() }, f.replacement)).rejects.toMatchObject({ code: "SOURCE_REPAIR_OWNER" }); expect(readFileSync(f.stored, "utf8")).toBe("damaged");
});

it.each(["before_manifest", "after_manifest", "after_source", "after_completion"])("keeps durable evidence across real SIGKILL %s and resumes only explicitly", async phase => {
  const f = await setup(), before = rows(f); writeFileSync(f.stored, "damaged");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { AiDatabase } from ${JSON.stringify(new URL("../.build/electron/app/desktop/ai-database.js", import.meta.url).href)};
    import { AiStorage } from ${JSON.stringify(new URL("../.build/electron/app/desktop/ai-storage.js", import.meta.url).href)};
    import { DocumentTasks } from ${JSON.stringify(new URL("../.build/electron/app/desktop/document-tasks.js", import.meta.url).href)};
    import { SqliteStore } from ${JSON.stringify(new URL("../.build/electron/app/desktop/graph-store.js", import.meta.url).href)};
    import { SourceRepairs } from ${JSON.stringify(new URL("../.build/electron/app/desktop/source-repair.js", import.meta.url).href)};
    const data = JSON.parse(process.argv[1]), calls = new AiDatabase(data.path), storage = new AiStorage(data.path), tasks = new DocumentTasks(data.path, storage, calls), store = new SqliteStore(data.path), repairs = new SourceRepairs(tasks, store, () => false);
    const publish = repairs.publish.bind(repairs); let count = 0;
    repairs.publish = (path, bytes) => {
      count++; if (data.phase === "before_manifest" && count === 1) process.kill(process.pid, "SIGKILL");
      publish(path, bytes);
      if (data.phase === "after_manifest" && count === 1 || data.phase === "after_source" && count === 2 || data.phase === "after_completion" && count === 3) process.kill(process.pid, "SIGKILL");
    };
    await repairs.repair(data.id, data.request, data.replacement);
  `, JSON.stringify({ path: f.path, id: f.receipt.threadId, request: f.request, replacement: f.replacement, phase })], { timeout: 15000, encoding: "utf8" });
  expect(child.signal, child.stderr).toBe("SIGKILL"); const pending = f.store.read(f.repairs.namespace, f.request.requestId)!.value; expect(pending.result).toBeNull(); expect(rows(f)).toEqual(before);
  const directory = join(f.quarantine, String(pending.quarantineId)); expect(readFileSync(join(directory, "original"), "utf8")).toBe("damaged");
  const published = phase === "after_source" || phase === "after_completion"; expect(f.repairs.status(f.receipt.threadId).status).toBe(published ? "verified" : "corrupt"); expect(f.store.read(f.repairs.namespace, f.request.requestId)!.value.result).toBeNull();
  const receipt = await f.repairs.repair(f.receipt.threadId, f.request, null); expect(receipt === null).toBe(!published);
  expect(receipt ?? await f.repairs.repair(f.receipt.threadId, f.request, f.replacement)).toMatchObject({ status: "repaired", quarantineId: pending.quarantineId }); expect(f.storage.source(f.document)).toEqual(f.source); expect(rows(f)).toEqual(before);
});
