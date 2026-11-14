import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSettings } from "./ai-settings.js";
import { AiClient } from "./ai-client.js";
import { documentAction } from "./document-action.js";
import { AppError } from "./errors.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
async function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-document-action-")); directories.push(path);
  const decrypt = vi.fn(async (bytes: Buffer) => ({ result: bytes.toString(), shouldReEncrypt: false }));
  const settings = new AiSettings(path, { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: decrypt }), before = await settings.view();
  const view = await settings.save({ revision: before.revision, preferences: before.preferences, secrets: { modelApiKey: "TEST_ONLY" } });
  const call = vi.spyOn(AiClient.prototype, "call"), client = () => Object.create(AiClient.prototype) as AiClient;
  const request = { type: "create" as const, revision: view.revision, value: { requestId: randomUUID(), document: { objectKey: `sources/text/${"a".repeat(64)}.txt`, sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/plain", sourceType: "text", fileName: "source.txt" } } };
  const receipt = { type: "create" as const, value: { threadId: randomUUID(), requestId: request.value.requestId, runId: randomUUID(), accepted: true } };
  return { settings, view, request, receipt, call, client, decrypt };
}

it("reads tasks and recovers acknowledged creates without decrypting credentials", async () => {
  const f = await setup(); f.call.mockResolvedValueOnce({ type: "list", value: { items: [], hasMore: false, nextCursor: null } }).mockResolvedValueOnce(f.receipt);
  await documentAction({ type: "list", revision: f.view.revision, offset: 0, limit: 20, state: "" }, f.settings, f.client);
  expect(await documentAction(f.request, f.settings, f.client)).toEqual(f.receipt); expect(f.decrypt).not.toHaveBeenCalled();
  expect(f.call.mock.calls.every(([value]) => value.type === "document" && !("secrets" in value.config))).toBe(true);
});

it("uses a credential snapshot only after a definite pre-admission response", async () => {
  const f = await setup(); f.call.mockRejectedValueOnce(new AppError("MODEL_NOT_CONFIGURED", "snapshot required")).mockResolvedValueOnce(f.receipt);
  expect(await documentAction(f.request, f.settings, f.client)).toEqual(f.receipt); expect(f.decrypt).toHaveBeenCalledOnce(); expect(f.call).toHaveBeenCalledTimes(2);
  expect(f.call.mock.calls[1][0]).toMatchObject({ type: "document", config: { secrets: { modelApiKey: "TEST_ONLY" } } });
});

it("never automatically replays an uncertain admission", async () => {
  const f = await setup(); f.call.mockRejectedValueOnce(new AppError("AI_WORKER_STOPPED", "unknown outcome"));
  await expect(documentAction(f.request, f.settings, f.client)).rejects.toMatchObject({ code: "AI_WORKER_STOPPED" }); expect(f.call).toHaveBeenCalledOnce(); expect(f.decrypt).not.toHaveBeenCalled();
});

it("saves recognition preferences without decrypting keys or starting the worker", async () => {
  const f = await setup(), settings = { ...f.view.preferences.import, tencentConcurrency: 1, deduplicateQuestions: true };
  const reply = await documentAction({ type: "save_import_settings", revision: f.view.revision, value: { revision: f.view.revision, settings } }, f.settings, f.client);
  expect(reply.type).toBe("save_import_settings"); expect((await f.settings.view()).preferences.import).toEqual(settings); expect((await f.settings.view()).configured.modelApiKey).toBe(true);
  expect(f.decrypt).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled();
  await expect(documentAction({ type: "save_import_settings", revision: f.view.revision, value: { revision: f.view.revision, settings } }, f.settings, f.client)).rejects.toMatchObject({ code: "IMPORT_SETTINGS_CONFLICT" });
});

it("rejects stale authorizations and renderer configuration before obtaining secrets", async () => {
  const f = await setup();
  await expect(documentAction({ ...f.request, revision: randomUUID() }, f.settings, f.client)).rejects.toMatchObject({ code: "LOCAL_SETTINGS_CHANGED" });
  await expect(documentAction({ ...f.request, config: { secrets: {} } }, f.settings, f.client)).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled(); expect(f.decrypt).not.toHaveBeenCalled();
});

it("reports configuration changes during admission without sending another request", async () => {
  const f = await setup(); f.call.mockRejectedValueOnce(new AppError("MODEL_NOT_CONFIGURED", "snapshot required")).mockImplementationOnce(async () => {
    await f.settings.save({ revision: f.view.revision, preferences: f.view.preferences }); return f.receipt;
  });
  await expect(documentAction(f.request, f.settings, f.client)).rejects.toMatchObject({ code: "LOCAL_SETTINGS_CHANGED" }); expect(f.call).toHaveBeenCalledTimes(2);
});

it.each(["replay", "cancel", "replace"])("handles source repair %s through the trusted picker without credential decryption", async mode => {
  const f = await setup(), threadId = randomUUID(), value = { requestId: randomUUID(), expectedVersion: 123 }, request = { type: "repair_source" as const, revision: f.view.revision, threadId, value }, result = { threadId, requestId: value.requestId, status: "repaired" as const, quarantineId: randomUUID() }, picker = vi.fn(async () => mode === "cancel" ? null : "/native/private/original.txt");
  if (mode === "replay") f.call.mockResolvedValueOnce(result);
  else f.call.mockResolvedValueOnce(null).mockResolvedValueOnce({ type: "source_status", value: { threadId, document: f.request.value.document, taskVersion: 123, status: "corrupt", errorCode: "DOCUMENT_SIZE_MISMATCH", canRepair: true } }).mockResolvedValueOnce(result);
  expect(await documentAction(request, f.settings, f.client, undefined, picker)).toEqual({ type: "repair_source", value: mode === "cancel" ? { ...result, status: "cancelled", quarantineId: null } : result });
  expect(f.decrypt).not.toHaveBeenCalled(); expect(picker).toHaveBeenCalledTimes(mode === "replay" ? 0 : 1);
  expect(f.call.mock.calls[0][0]).toEqual({ type: "repair_source", threadId, value, path: null });
  if (mode === "replace") expect(f.call.mock.calls.at(-1)![0]).toEqual({ type: "repair_source", threadId, value, path: "/native/private/original.txt" });
  expect(f.call).toHaveBeenCalledTimes(mode === "replay" ? 1 : mode === "cancel" ? 2 : 3);
  await expect(documentAction({ ...request, path: "/renderer/chosen/path" }, f.settings, f.client, undefined, picker)).rejects.toThrow();
});

it("keeps unknown source repair outcomes without opening a picker or replaying", async () => {
  const f = await setup(), picker = vi.fn(); f.call.mockRejectedValueOnce(new AppError("AI_WORKER_STOPPED", "unknown outcome"));
  await expect(documentAction({ type: "repair_source", revision: f.view.revision, threadId: randomUUID(), value: { requestId: randomUUID(), expectedVersion: 123 } }, f.settings, f.client, undefined, picker)).rejects.toMatchObject({ code: "AI_WORKER_STOPPED" });
  expect(picker).not.toHaveBeenCalled(); expect(f.call).toHaveBeenCalledOnce(); expect(f.decrypt).not.toHaveBeenCalled();
});

it.each(["save", "cancel"])("exports bank ZIP through a native %s dialog without keys or renderer paths", async mode => {
  const f = await setup(), threadId = randomUUID(), selection = { threadId, checkpointId: "reviewed", scope: "completed" as const }, picker = vi.fn(async () => mode === "cancel" ? null : "/private/native/export.zip"), saved = { threadId, checkpointId: selection.checkpointId, saved: true };
  f.call.mockResolvedValueOnce({ type: "head", value: { threadId, checkpointId: "reviewed", runId: randomUUID(), state: "FAILED", updatedAt: new Date().toISOString(), modelConfigured: false, resumeCompatible: false } }).mockResolvedValueOnce(saved);
  expect(await documentAction({ type: "export_bank_zip", revision: f.view.revision, value: selection }, f.settings, f.client, undefined, undefined, picker)).toEqual({ type: "export_bank_zip", value: { ...saved, saved: mode === "save" } });
  expect(picker).toHaveBeenCalledWith(`practiq-bank-${threadId}.zip`); expect(f.decrypt).not.toHaveBeenCalled(); expect(f.call).toHaveBeenCalledTimes(mode === "save" ? 2 : 1);
  if (mode === "save") expect(f.call.mock.calls.at(-1)![0]).toMatchObject({ type: "export_bank_zip", value: selection, path: "/private/native/export.zip", config: { configured: { modelApiKey: true } } });
  expect(f.call.mock.calls.every(([request]) => !("config" in request) || !("secrets" in request.config))).toBe(true);
  await expect(documentAction({ type: "export_bank_zip", revision: f.view.revision, value: selection, path: "/renderer/path.zip" }, f.settings, f.client, undefined, undefined, picker)).rejects.toThrow();
});
