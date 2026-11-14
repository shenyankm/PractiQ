import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AiSnapshot } from "./ai-settings.js";
import { AiDatabase } from "./ai-database.js";
import { hash } from "./assets.js";
import { sourceKey } from "./ai-storage.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DocumentApi } from "./document-api.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";

const fixtures: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { await f.api.close(); f.checkpoints.close(); f.calls.close(); rmSync(f.path, { recursive: true, force: true }); } });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-lifecycle-")), calls = new AiDatabase(path), checkpoints = new SqliteCheckpoints(path), http = vi.fn(async (): Promise<Response> => { throw Error("Lifecycle operations must not reach a provider"); });
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: 0.5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" } }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const api = new DocumentApi(path, calls, checkpoints, new ModelClient(calls, http), new TencentClient(calls, http)), source = Buffer.from("Original supplied question and answer"), sha256 = hash(source), document = { sourceType: "text" as const, mediaType: "text/plain", fileName: "questions.txt", objectKey: sourceKey("text", sha256), sha256, sizeBytes: source.length }; await api.storage.putSource(document, source);
  const add = async (state: "COMPLETED" | "FAILED" | "PAUSED" | "CANCELLED" | "PENDING" = "COMPLETED", createdAt = Date.now()) => {
    const receipt = api.tasks.create({ requestId: randomUUID(), document }, config); await api.runtime.initialize(receipt.threadId);
    api.tasks.update(receipt.threadId, receipt.runId!, record => { record.state = state; record.createdAt = createdAt; }); api.tasks.db.prepare("UPDATE document_tasks SET created_at=? WHERE id=?").run(createdAt, receipt.threadId); return receipt;
  };
  const f = { path, calls, checkpoints, http, config, source, document, api, add }; fixtures.push(f); return f;
}
const count = (f: Awaited<ReturnType<typeof setup>>, table: string, id: string) => Number(f.api.tasks.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === "document_tasks" ? "id" : "task_id"}=?`).get(id)!.n);

it("removes only stopped task state, operation receipts and checkpoints while retaining shared bytes, unrelated state and every paid-call receipt", async () => {
  const f = await setup(), task = await f.add(), other = await f.add(), artifact = await f.api.storage.putArtifact(Buffer.from("saved artifact"), f.document.sha256, "result", 0, "text/plain");
  f.api.tasks.db.prepare("INSERT INTO document_artifacts VALUES(?,?,?)").run(task.threadId, artifact.objectKey, JSON.stringify(artifact));
  await f.api.store.put(["document_tasks", task.threadId, "corrections"], "original", { answer: "retained until explicit delete" });
  await f.api.store.put(["document_tasks", other.threadId, "corrections"], "unrelated", { preserved: true }); await f.api.store.put(["source_repairs"], "audit", { threadId: task.threadId, preserved: true });
  f.calls.createTask(f.document.sha256, 64, task.threadId);
  for (const state of ["unknown", "succeeded", "failed"] as const) { f.calls.claim(task.threadId, state, { inputDigest: f.document.sha256, endpoint: "https://model.example/v1/responses", model: "test", promptVersion: "test" }); if (state !== "unknown") f.calls.finish(task.threadId, state, state, { supplied: true }, { inputTokens: 5, outputTokens: 2 }); }
  const receipts = f.calls.db.prepare("SELECT * FROM ai_calls").all(), otherRecord = f.api.tasks.record(other.threadId);
  const command = { type: "delete" as const, revision: f.config.revision, threadId: task.threadId }, expected = { type: "delete", value: { threadId: task.threadId, deleted: true } };
  expect(await f.api.request(command, f.config)).toEqual(expected); expect(await f.api.request(command, f.config)).toEqual(expected);
  for (const table of ["document_tasks", "document_operations", "document_artifacts"]) expect(count(f, table, task.threadId)).toBe(0);
  expect(await f.checkpoints.getTuple({ configurable: { thread_id: `document:${task.threadId}` } })).toBeUndefined(); expect(await f.api.store.search(["document_tasks", task.threadId])).toEqual([]);
  expect(f.api.tasks.record(other.threadId)).toEqual(otherRecord); expect(await f.api.store.get(["document_tasks", other.threadId, "corrections"], "unrelated")).not.toBeNull(); expect(await f.api.store.get(["source_repairs"], "audit")).not.toBeNull();
  expect(f.calls.db.prepare("SELECT * FROM ai_calls").all()).toEqual(receipts); expect(f.api.storage.source(f.document)).toEqual(f.source); expect(f.api.storage.artifact(artifact).toString()).toBe("saved artifact"); expect(f.http).not.toHaveBeenCalled();
});

it.each(["PENDING", "RUNNING", "PAUSING"] as const)("refuses %s tasks without deleting checkpoints or evidence", async state => {
  const f = await setup(), task = await f.add(); f.api.tasks.update(task.threadId, task.runId!, value => { value.state = state; }); const before = f.api.tasks.record(task.threadId), checkpoint = await f.checkpoints.getTuple({ configurable: { thread_id: `document:${task.threadId}` } });
  await expect(f.api.runtime.delete(task.threadId)).rejects.toMatchObject({ code: "TASK_BUSY" }); expect(f.api.tasks.record(task.threadId)).toEqual(before); expect(await f.checkpoints.getTuple({ configurable: { thread_id: `document:${task.threadId}` } })).toEqual(checkpoint); expect(f.http).not.toHaveBeenCalled();
});

it.each(["checkpoint", "store", "final_commit"])("retains the durable fence after %s failure and finishes only on explicit retry", async phase => {
  const f = await setup(), task = await f.add(); await f.api.store.put(["document_tasks", task.threadId, "units"], "one", { supplied: true });
  if (phase === "checkpoint") vi.spyOn(f.checkpoints, "deleteThread").mockRejectedValueOnce(Error("checkpoint disk failure"));
  if (phase === "store") vi.spyOn(f.api.store, "batch").mockRejectedValueOnce(Error("store disk failure"));
  if (phase === "final_commit") f.api.tasks.db.exec(`CREATE TEMP TRIGGER reject_delete BEFORE DELETE ON document_tasks BEGIN SELECT RAISE(ABORT,'disk failure'); END`);
  await expect(f.api.runtime.delete(task.threadId)).rejects.toThrow(); expect(count(f, "document_tasks", task.threadId)).toBe(1); expect(count(f, "document_operations", task.threadId)).toBe(1);
  expect(() => f.api.tasks.record(task.threadId)).toThrow(expect.objectContaining({ code: "TASK_DELETING" })); expect(f.api.tasks.list().items).toMatchObject([{ threadId: task.threadId, state: "EXPIRED" }]); expect(f.api.tasks.list(0, 20, "EXPIRED").items).toHaveLength(1); expect(f.api.tasks.list(0, 20, "COMPLETED").items).toEqual([]);
  await expect(f.api.runtime.control(task.threadId, { requestId: randomUUID(), action: "resume", checkpointId: "old" }, f.config)).rejects.toMatchObject({ code: "TASK_DELETING" });
  await f.api.runtime.recover(); expect(count(f, "document_tasks", task.threadId)).toBe(1); expect(f.http).not.toHaveBeenCalled(); vi.restoreAllMocks(); if (phase === "final_commit") f.api.tasks.db.exec("DROP TRIGGER reject_delete");
  expect(await f.api.runtime.delete(task.threadId)).toEqual({ threadId: task.threadId, deleted: true }); expect(count(f, "document_tasks", task.threadId)).toBe(0); expect(f.api.storage.source(f.document)).toEqual(f.source);
});

it("coalesces concurrent deletion and fences all reads and source repair while asynchronous cleanup is pending", async () => {
  const f = await setup(), task = await f.add(); let release!: () => void; const remove = f.checkpoints.deleteThread.bind(f.checkpoints);
  vi.spyOn(f.checkpoints, "deleteThread").mockImplementation(async id => { await new Promise<void>(resolve => { release = resolve; }); await remove(id); });
  const first = f.api.runtime.delete(task.threadId), second = f.api.runtime.delete(task.threadId); expect(first).toBe(second);
  expect(() => f.api.repairs.status(task.threadId)).toThrow(expect.objectContaining({ code: "TASK_DELETING" }));
  await expect(f.api.repairs.repair(task.threadId, { requestId: randomUUID(), expectedVersion: 1 }, null)).rejects.toMatchObject({ code: "TASK_DELETING" });
  release(); await Promise.all([first, second]); expect(f.checkpoints.deleteThread).toHaveBeenCalledOnce(); expect(f.http).not.toHaveBeenCalled();
});

it("cleans more than one Store page and explicit orphan namespaces without touching neighboring identities", async () => {
  const f = await setup(), id = randomUUID(), other = randomUUID();
  await f.api.store.batch(Array.from({ length: 105 }, (_, index) => ({ namespace: ["document_tasks", id, "units"], key: String(index), value: { supplied: true } })));
  await f.api.store.put(["document_tasks", other, "units"], "keep", { preserved: true });
  expect(await f.api.runtime.delete(id)).toEqual({ threadId: id, deleted: true }); expect(await f.api.store.search(["document_tasks", id])).toEqual([]); expect(await f.api.store.get(["document_tasks", other, "units"], "keep")).not.toBeNull(); expect(f.http).not.toHaveBeenCalled();
});

it("uses stable created-time/id cursors through equal timestamps, new insertions and deleted boundaries", async () => {
  const f = await setup(), created = Date.now() - 1000, tasks = []; for (let index = 0; index < 7; index++) tasks.push(await f.add("COMPLETED", created));
  const ordered = tasks.map(task => task.threadId).sort().reverse(), first = f.api.tasks.list(0, 2), firstIDs = first.items.map(item => item.threadId); expect(firstIDs).toEqual(ordered.slice(0, 2)); expect(first.hasMore).toBe(true); expect(first.nextCursor).toBeTypeOf("string");
  await f.add("COMPLETED", created + 2000); expect(f.api.tasks.list(2, 2).items[0].threadId).toBe(firstIDs[1]); await f.api.runtime.delete(firstIDs[1]);
  const seen = [...firstIDs]; let cursor = first.nextCursor;
  while (cursor) { const page = f.api.tasks.list(0, 2, "", cursor); seen.push(...page.items.map(item => item.threadId)); cursor = page.nextCursor; }
  expect(seen).toEqual(ordered); expect(new Set(seen).size).toBe(7); expect(f.http).not.toHaveBeenCalled();
});

it.each(["offset", "filter", "encoding", "position", "extra", "uuid", "timezone"])("rejects %s cursors without changing task state", async kind => {
  const f = await setup(); await f.add(); await f.add(); const first = f.api.tasks.list(0, 1), original = first.nextCursor!, decoded = JSON.parse(Buffer.from(original, "base64url").toString()); let cursor = original;
  if (kind === "encoding") cursor += "="; if (kind === "position") decoded[0] = "not a date"; if (kind === "extra") decoded.push("unexpected"); if (kind === "uuid") decoded[1] = "arbitrary-thread"; if (kind === "timezone") decoded[0] = decoded[0].replace("Z", "");
  if (!["offset", "filter", "encoding"].includes(kind)) cursor = Buffer.from(JSON.stringify(decoded)).toString("base64url");
  expect(() => f.api.tasks.list(kind === "offset" ? 1 : 0, 1, kind === "filter" ? "COMPLETED" : "", cursor)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" })); expect(f.api.tasks.list(0, 1)).toEqual(first); expect(f.http).not.toHaveBeenCalled();
});

it("seeks by database creation order when saved task metadata has a different timestamp", async () => {
  const f = await setup(), base = Date.now() - 2000; await f.add("COMPLETED", base); await f.add("COMPLETED", base + 1); const last = await f.add("COMPLETED", base + 2);
  f.api.tasks.update(last.threadId, last.runId!, record => { record.createdAt = 0; }); const first = f.api.tasks.list(0, 1); expect(first.items[0].threadId).toBe(last.threadId);
  const next = f.api.tasks.list(0, 20, "", first.nextCursor!); expect(next.items).toHaveLength(2); expect(next.items.some(item => item.threadId === last.threadId)).toBe(false); expect(f.http).not.toHaveBeenCalled();
});

it("binds filtered cursors and keeps cancelled, active and expired states distinct", async () => {
  const f = await setup(), one = await f.add("CANCELLED"), two = await f.add("CANCELLED"), active = await f.add("PENDING"); await f.add("PENDING", 0);
  const first = f.api.tasks.list(0, 1, "CANCELLED"), second = f.api.tasks.list(0, 1, "CANCELLED", first.nextCursor!); expect(new Set([...first.items, ...second.items].map(item => item.threadId))).toEqual(new Set([one.threadId, two.threadId]));
  expect(f.api.tasks.list(0, 20, "active").items.map(item => item.threadId)).toEqual([active.threadId]); expect(f.api.tasks.list(0, 20, "EXPIRED").items).toHaveLength(1); expect(f.http).not.toHaveBeenCalled();
});

it.each(["fence", "checkpoint", "store"])("recovers real SIGKILL after %s without automatically resuming or finishing deletion", async phase => {
  const f = await setup(), task = await f.add(); await f.api.store.put(["document_tasks", task.threadId, "units"], "one", { supplied: true });
  const base = new URL("../.build/electron/app/desktop/", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const data=JSON.parse(process.argv[1]), {AiDatabase}=await import(data.base+'ai-database.js'), {SqliteCheckpoints}=await import(data.base+'checkpoints.js'), {DocumentApi}=await import(data.base+'document-api.js'), {ModelClient}=await import(data.base+'model.js'), {TencentClient}=await import(data.base+'tencent.js');
    const calls=new AiDatabase(data.path), checkpoints=new SqliteCheckpoints(data.path), http=async()=>{throw Error('No providers')}, api=new DocumentApi(data.path,calls,checkpoints,new ModelClient(calls,http),new TencentClient(calls,http));
    const kill=()=>process.kill(process.pid,'SIGKILL');
    if(data.phase==='fence') { const begin=api.tasks.beginDelete.bind(api.tasks); api.tasks.beginDelete=id=>{begin(id);kill();}; }
    if(data.phase==='checkpoint') { const remove=checkpoints.deleteThread.bind(checkpoints); checkpoints.deleteThread=async id=>{await remove(id);kill();}; }
    if(data.phase==='store') api.tasks.finishDelete=kill;
    await api.request({type:'delete',revision:data.revision,threadId:data.id},{revision:data.revision,preferences:data.preferences,configured:{modelApiKey:false,tencentSecretId:false,tencentSecretKey:false}});
  `, JSON.stringify({ base, path: f.path, id: task.threadId, phase, revision: f.config.revision, preferences: f.config.preferences })], { timeout: 15000, encoding: "utf8" });
  expect(child.signal, child.stderr).toBe("SIGKILL"); expect(count(f, "document_tasks", task.threadId)).toBe(1); await f.api.runtime.recover(); expect(count(f, "document_tasks", task.threadId)).toBe(1); expect(() => f.api.tasks.record(task.threadId)).toThrow(expect.objectContaining({ code: "TASK_DELETING" }));
  await f.api.runtime.delete(task.threadId); expect(count(f, "document_tasks", task.threadId)).toBe(0); expect(f.api.storage.source(f.document)).toEqual(f.source); expect(f.http).not.toHaveBeenCalled();
});
