import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopMaintenancePreview, DesktopMaintenanceRequest } from "../src/contracts.generated.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { sourceKey } from "./ai-storage.js";
import { hash } from "./assets.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { ModelClient } from "./model.js";
import { modelSlots } from "./provider-slots.js";
import { TencentClient } from "./tencent.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.calls.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-maintenance-")), calls = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path), http = vi.fn(async (): Promise<Response> => { throw Error("Maintenance cannot call providers"); });
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const api = new DocumentApi(path, calls, checkpoints, new ModelClient(calls, http), new TencentClient(calls, http)), source = Buffer.from("Supplied source retained through maintenance"), sha256 = hash(source), document = { fileName: "source.txt", sourceType: "text" as const, mediaType: "text/plain", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length }; await api.storage.putSource(document, source);
  const add = async (expired = false) => { const receipt = api.tasks.create({ requestId: randomUUID(), document }, config); await api.runtime.initialize(receipt.threadId); api.tasks.stop(receipt.threadId, receipt.runId!); if (expired) api.tasks.update(receipt.threadId, receipt.runId!, value => { value.createdAt = 0; }); return receipt.threadId; };
  const expired = await add(true), fresh = await add(); calls.createTask(sha256, 64, expired);
  for (const state of ["unknown", "succeeded", "failed"] as const) { calls.claim(expired, state, { inputDigest: sha256, endpoint: "https://model.example/v1/responses", model: "model", promptVersion: "test" }); if (state !== "unknown") calls.finish(expired, state, state, {}, { inputTokens: 2, outputTokens: 1 }); }
  const f = { path, calls, checkpoints, api, config, http, document, source, add, expired, fresh }; fixtures.push(f); return f;
}
const preview = async (f: Awaited<ReturnType<typeof setup>>) => (await f.api.request({ type: "maintenance_preview", revision: f.config.revision }, f.config)).value as DesktopMaintenancePreview;
const clean = (f: Awaited<ReturnType<typeof setup>>, value: DesktopMaintenanceRequest) => f.api.request({ type: "cleanup_state", revision: f.config.revision, value }, f.config);
const taskExists = (f: Awaited<ReturnType<typeof setup>>, id: string) => Boolean(f.api.tasks.db.prepare("SELECT 1 FROM document_tasks WHERE id=?").get(id));

it("previews expired/stopped, incomplete deletions and known orphan namespaces without modifying any persisted state", async () => {
  const f = await setup(), deleting = await f.add(), active = await f.add(true), invalid = await f.add(true), orphan = randomUUID(), storeOrphan = randomUUID(); f.api.tasks.beginDelete(deleting);
  f.api.tasks.update(active, f.api.tasks.record(active).runId, value => { value.state = "RUNNING"; }); f.api.tasks.db.prepare("UPDATE document_tasks SET record=? WHERE id=?").run('{"version":"unknown"}', invalid);
  f.checkpoints.db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?,?,?)").run(`document:${orphan}`, "", "orphan", null, Buffer.from("{}"), Buffer.from("{}")); f.checkpoints.db.prepare("INSERT INTO checkpoint_writes VALUES(?,?,?,?,?,?,?,?)").run(`document:${orphan}`, "", "orphan", "one", 0, "value", Buffer.from("{}"), "");
  await f.api.store.put(["document_tasks", storeOrphan, "units"], "orphan", { retainedUntilExplicitCleanup: true }); await f.api.store.put(["document_tasks", "unknown"], "keep", { unknown: true }); await f.api.store.put(["unrelated"], "keep", { unrelated: true });
  const before = f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all(), stored = f.api.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all(), value = await preview(f);
  expect(value.canClean).toBe(true); expect(new Set(value.candidates.map(item => `${item.threadId}:${item.kind}`))).toEqual(new Set([`${f.expired}:expired`, `${deleting}:deletion`, `${orphan}:orphan`, `${storeOrphan}:orphan`])); expect(value.skipped).toBeGreaterThanOrEqual(2);
  expect(f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all()).toEqual(before); expect(f.api.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all()).toEqual(stored); expect(f.http).not.toHaveBeenCalled();
});

it("cleans only the reviewed batch, retains every paid receipt/shared file and replays its durable receipt after reopen", async () => {
  const f = await setup(), orphan = randomUUID(); await f.api.store.put(["document_tasks", orphan, "units"], "one", { saved: true }); await f.api.store.put(["source_repairs"], "audit", { preserved: true }); await f.api.store.put(["document_tasks", f.fresh, "units"], "keep", { preserved: true });
  const paid = f.calls.db.prepare("SELECT * FROM ai_calls ORDER BY id").all(), aiTasks = f.calls.db.prepare("SELECT * FROM ai_tasks ORDER BY id").all(), fresh = f.api.tasks.record(f.fresh), value = { requestId: randomUUID(), previewId: (await preview(f)).previewId };
  const receipt = await clean(f, value); expect(receipt).toEqual({ type: "cleanup_state", value: { ...value, cleaned: 2 } }); expect(taskExists(f, f.expired)).toBe(false); expect(await f.checkpoints.getTuple({ configurable: { thread_id: `document:${f.expired}` } })).toBeUndefined(); expect(await f.api.store.search(["document_tasks", orphan])).toEqual([]);
  expect(f.api.tasks.record(f.fresh)).toEqual(fresh); expect(await f.api.store.get(["source_repairs"], "audit")).not.toBeNull(); expect(await f.api.store.get(["document_tasks", f.fresh, "units"], "keep")).not.toBeNull(); expect(f.calls.db.prepare("SELECT * FROM ai_calls ORDER BY id").all()).toEqual(paid); expect(f.calls.db.prepare("SELECT * FROM ai_tasks ORDER BY id").all()).toEqual(aiTasks); expect(f.api.storage.source(f.document)).toEqual(f.source);
  await f.api.close(); f.api = new DocumentApi(f.path, f.calls, f.checkpoints, new ModelClient(f.calls, f.http), new TencentClient(f.calls, f.http)); expect(await clean(f, value)).toEqual(receipt); expect(f.http).not.toHaveBeenCalled();
  await expect(clean(f, { ...value, previewId: randomUUID() })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
});

it.each(["changed", "resumed", "missing", "expired_preview", "unknown_preview"])("refuses a %s preview before writing any intent or deletion fence", async kind => {
  const f = await setup(), p = await preview(f), task = f.api.tasks.record(f.expired);
  if (kind === "changed") f.api.tasks.update(task.id, task.runId, value => { value.errorCode = "DOCUMENT_RUN_FAILED"; });
  if (kind === "resumed") f.api.tasks.update(task.id, task.runId, value => { value.state = "PENDING"; });
  if (kind === "missing") await f.api.runtime.delete(task.id);
  if (kind === "expired_preview") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  const before = f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all(); await expect(clean(f, { requestId: randomUUID(), previewId: kind === "unknown_preview" ? randomUUID() : p.previewId })).rejects.toMatchObject({ code: "MAINTENANCE_PREVIEW_STALE" }); expect(f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all()).toEqual(before); expect(await f.api.store.search(["document_maintenance"])).toEqual([]); expect(f.http).not.toHaveBeenCalled();
});

it("does not delete an orphan that acquired an admitted task after preview", async () => {
  const f = await setup(), orphan = randomUUID(); await f.api.store.put(["document_tasks", orphan, "units"], "one", { saved: true }); const p = await preview(f), row = f.api.tasks.db.prepare("SELECT * FROM document_tasks WHERE id=?").get(f.fresh)!;
  f.api.tasks.db.prepare("INSERT INTO document_tasks VALUES(?,?,?,?)").run(orphan, row.created_at, row.updated_at, JSON.stringify({ ...JSON.parse(String(row.record)), id: orphan }));
  await expect(clean(f, { requestId: randomUUID(), previewId: p.previewId })).rejects.toMatchObject({ code: "MAINTENANCE_PREVIEW_STALE" }); expect(taskExists(f, orphan)).toBe(true); expect(taskExists(f, f.expired)).toBe(true); expect(f.http).not.toHaveBeenCalled();
});

it("keeps previews passive and refuses cleanup while another read or provider slot is active", async () => {
  const f = await setup(), p = await preview(f); let release!: () => void;
  const job = modelSlots.run(1, undefined, async () => new Promise<void>(resolve => { release = resolve; })); await Promise.resolve();
  try { expect((await preview(f)).canClean).toBe(false); await expect(clean(f, { requestId: randomUUID(), previewId: p.previewId })).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" }); } finally { release(); await job; }
  expect(taskExists(f, f.expired)).toBe(true); expect(f.http).not.toHaveBeenCalled();
});

it("fences new requests and exports during cleanup, coalesces identical explicit retries and drains safely on close", async () => {
  const f = await setup(), value = { requestId: randomUUID(), previewId: (await preview(f)).previewId }, remove = f.api.runtime.delete.bind(f.api.runtime); let release!: () => void;
  vi.spyOn(f.api.runtime, "delete").mockImplementation(async id => { await new Promise<void>(resolve => { release = resolve; }); return remove(id); }); const first = clean(f, value); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  try {
  await expect(f.api.request({ type: "list", revision: f.config.revision, offset: 0, limit: 20, state: "" }, f.config)).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" }); await expect(clean(f, { ...value, requestId: randomUUID() })).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" });
  expect(() => f.api.exportBankZip({ threadId: f.fresh, checkpointId: "saved", scope: "full" }, f.config, join(f.path, "blocked.zip"))).toThrow(expect.objectContaining({ code: "MAINTENANCE_BUSY" }));
  const retry = clean(f, value); await Promise.resolve(); let closed = false; const closing = f.api.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false); release(); expect(await first).toEqual(await retry); await closing;
  } finally { release(); }
  f.api = new DocumentApi(f.path, f.calls, f.checkpoints, new ModelClient(f.calls, f.http), new TencentClient(f.calls, f.http)); expect((await preview(f)).candidates).toEqual([]); expect(f.http).not.toHaveBeenCalled();
});

it.each(["checkpoint", "store", "final_commit"])("preserves a pending receipt after %s failure and finishes only on explicit retry", async phase => {
  const f = await setup(), value = { requestId: randomUUID(), previewId: (await preview(f)).previewId }; await f.api.store.put(["document_tasks", f.expired, "units"], "one", { saved: true });
  if (phase === "checkpoint") vi.spyOn(f.checkpoints, "deleteThread").mockRejectedValueOnce(Error("disk failure"));
  if (phase === "store") { const batch = f.api.store.batch.bind(f.api.store); vi.spyOn(f.api.store, "batch").mockImplementation(async operations => { if (operations.some(operation => "namespace" in operation && operation.namespace[0] === "document_tasks" && "value" in operation && operation.value === null)) throw Error("disk failure"); return batch(operations); }); }
  if (phase === "final_commit") f.api.tasks.db.exec("CREATE TEMP TRIGGER reject_cleanup BEFORE DELETE ON document_tasks BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  await expect(clean(f, value)).rejects.toThrow(); vi.restoreAllMocks(); if (phase === "final_commit") f.api.tasks.db.exec("DROP TRIGGER reject_cleanup");
  const p = await preview(f); expect(p.pending).toEqual([{ ...value, completed: 0, total: 1 }]); expect(taskExists(f, f.expired)).toBe(true); await expect(clean(f, { requestId: randomUUID(), previewId: p.previewId })).rejects.toMatchObject({ code: "MAINTENANCE_PENDING" });
  expect((await clean(f, value)).value).toEqual({ ...value, cleaned: 1 }); expect(taskExists(f, f.expired)).toBe(false); expect(f.http).not.toHaveBeenCalled();
});

it("bounds a batch to 100 candidates and leaves the rest for another explicit preview", async () => {
  const f = await setup(); await f.api.runtime.delete(f.expired);
  await f.api.store.batch(Array.from({ length: 105 }, () => ({ namespace: ["document_tasks", randomUUID(), "units"], key: "one", value: { saved: true } })));
  const p = await preview(f); expect(p.candidates).toHaveLength(100); expect(p.hasMore).toBe(true); await clean(f, { requestId: randomUUID(), previewId: p.previewId }); expect((await preview(f)).candidates).toHaveLength(5); expect(f.http).not.toHaveBeenCalled();
});

it("refuses an unreadable pending journal without adopting its candidates or changing tasks", async () => {
  const f = await setup(), requestId = randomUUID(), previewId = randomUUID(), saved = { version: 99, requestId, previewId, status: "pending", candidates: [{ threadId: f.expired, kind: "expired", fileName: "source.txt", fingerprint: "a".repeat(64) }], completed: [] };
  await f.api.store.put(["document_maintenance"], requestId, saved); const before = f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all();
  await expect(preview(f)).rejects.toMatchObject({ code: "MAINTENANCE_RECEIPT_INVALID" }); await expect(clean(f, { requestId, previewId })).rejects.toMatchObject({ code: "MAINTENANCE_RECEIPT_INVALID" });
  expect(f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all()).toEqual(before); expect((await f.api.store.get(["document_maintenance"], requestId))!.value).toEqual(saved); expect(f.http).not.toHaveBeenCalled();
});

it.each(["intent", "deleted", "receipt"])("survives real SIGKILL after %s without automatically replaying cleanup", async phase => {
  const f = await setup(), requestId = randomUUID(), base = new URL("../.build/electron/app/desktop/", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const data=JSON.parse(process.argv[1]), get=name=>import(data.base+name+'.js'), [{AiDatabase},{SqliteCheckpoints},{DocumentApi},{ModelClient},{TencentClient}]=await Promise.all(['ai-database','checkpoints','document-api','model','tencent'].map(get));
    const calls=new AiDatabase(data.path), checkpoints=new SqliteCheckpoints(data.path), http=async()=>{throw Error('No providers')}, api=new DocumentApi(data.path,calls,checkpoints,new ModelClient(calls,http),new TencentClient(calls,http)), config={revision:data.revision,preferences:data.preferences,configured:{modelApiKey:false,tencentSecretId:false,tencentSecretKey:false}}, kill=()=>process.kill(process.pid,'SIGKILL');
    const put=api.store.put.bind(api.store); api.store.put=async(path,key,value)=>{await put(path,key,value); if(path[0]==='document_maintenance'&&(data.phase==='intent'&&value.completed.length===0||data.phase==='receipt'&&value.status==='completed'))kill();};
    if(data.phase==='deleted'){const remove=api.runtime.delete.bind(api.runtime);api.runtime.delete=async id=>{await remove(id);kill();};}
    const preview=await api.request({type:'maintenance_preview',revision:config.revision},config);await api.request({type:'cleanup_state',revision:config.revision,value:{requestId:data.requestId,previewId:preview.value.previewId}},config);
  `, JSON.stringify({ path: f.path, base, phase, requestId, revision: f.config.revision, preferences: f.config.preferences })], { timeout: 15000, encoding: "utf8" });
  expect(child.signal, child.stderr).toBe("SIGKILL"); const journal = (await f.api.store.get(["document_maintenance"], requestId))!.value, before = f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all();
  await f.api.close(); f.api = new DocumentApi(f.path, f.calls, f.checkpoints, new ModelClient(f.calls, f.http), new TencentClient(f.calls, f.http)); const p = await preview(f); expect(f.api.tasks.db.prepare("SELECT * FROM document_tasks ORDER BY id").all()).toEqual(before);
  expect(p.pending.length).toBe(phase === "receipt" ? 0 : 1); expect((await clean(f, { requestId, previewId: String(journal.previewId) })).value).toEqual({ requestId, previewId: journal.previewId, cleaned: 1 }); expect(taskExists(f, f.expired)).toBe(false); expect(f.calls.db.prepare("SELECT count(*) AS n FROM ai_calls").get()!.n).toBe(3); expect(f.api.storage.source(f.document)).toEqual(f.source); expect(f.http).not.toHaveBeenCalled();
});
