// @vitest-environment jsdom
import "./import-test-setup";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Client } from "../../shared/cloud/api";
import { SourceRepair } from "../../shared/cloud/SourceRepair";
import { storageKey } from "../../shared/cloud/serviceStorage";
import { setNativeBridge } from "../../shared/cloud/transport";
import { taskId, runId, newTaskId } from "../../shared/cloud/test-fixtures";
import type { DesktopDocumentReply, DesktopDocumentRequest, DesktopSourceStatus } from "./contracts.generated";

afterEach(() => { cleanup(); setNativeBridge(null); localStorage.clear(); vi.restoreAllMocks(); });
function fixture() {
  const status: DesktopSourceStatus = { threadId: taskId, taskVersion: 123, document: { fileName: "original.txt", objectKey: `practiq-agent/sources/${"a".repeat(64)}/source.txt`, sha256: "a".repeat(64), sizeBytes: 1, sourceType: "text", mediaType: "text/plain" }, status: "corrupt", errorCode: "DOCUMENT_CHECKSUM_MISMATCH", canRepair: true };
  const controls = { unknown: false, cancelled: false, wrongReceipt: false }, calls: DesktopDocumentRequest[] = [];
  const documents = vi.fn(async (request: DesktopDocumentRequest): Promise<DesktopDocumentReply> => {
    calls.push(structuredClone(request));
    if (request.type === "source_status") return { type: request.type, value: structuredClone(status) };
    if (request.type === "repair_source") {
      if (controls.unknown) throw Error("Worker stopped; source repair is unconfirmed");
      if (!controls.cancelled) { status.status = "verified"; status.errorCode = null; status.canRepair = false; }
      return { type: request.type, value: { threadId: taskId, requestId: controls.wrongReceipt ? newTaskId : request.value.requestId, status: controls.cancelled ? "cancelled" : "repaired", quarantineId: controls.cancelled ? null : runId } };
    }
    throw Error(`Unexpected document action ${request.type}`);
  });
  const forbidden = vi.fn(async (): Promise<never> => { throw Error("No HTTP, provider or file-path transport allowed"); });
  const bridge = { origin: "http://127.0.0.1:8090", revision: runId, documents, confirm: vi.fn(async () => true), fetch: forbidden, pickSources: forbidden, upload: forbidden, download: forbidden, save: forbidden }; setNativeBridge(bridge);
  const client = new Client(), errors: unknown[] = [], run = async (perform: (current: Client) => Promise<void>) => { try { await perform(client); } catch (error) { errors.push(error); } };
  return { client, errors, run, calls, controls, status, documents, bridge, forbidden };
}

it("checks passively only after a click and repairs through a native request with a durable intent", async () => {
  const f = fixture(), user = userEvent.setup(); render(<SourceRepair client={f.client} threadId={taskId} busy={false} run={f.run} />);
  expect(f.calls).toEqual([]); await user.click(screen.getByRole("button", { name: "校验原文" })); await screen.findByText("保存的原文校验失败。");
  expect(f.calls.map(call => call.type)).toEqual(["source_status"]); expect(f.client.pendingSourceRepairs()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "选择原文件并修复" })); await screen.findByText("原文已修复，损坏副本及修复清单已保留。");
  await waitFor(() => expect(f.client.pendingSourceRepairs()).toEqual([])); expect(f.calls.map(call => call.type)).toEqual(["source_status", "repair_source", "source_status"]);
  expect(f.calls[1]).toMatchObject({ value: { expectedVersion: 123 } }); expect(f.errors).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled(); expect(f.bridge.confirm).not.toHaveBeenCalled();
});

it("retains an uncertain repair across remount and explicitly reuses its frozen version and request", async () => {
  const f = fixture(), user = userEvent.setup(); f.controls.unknown = true;
  const first = render(<SourceRepair client={f.client} threadId={taskId} busy={false} run={f.run} />); await user.click(screen.getByRole("button", { name: "校验原文" })); await screen.findByRole("button", { name: "选择原文件并修复" });
  await user.click(screen.getByRole("button", { name: "选择原文件并修复" })); await screen.findByRole("button", { name: "重试原修复请求" });
  const original = f.calls.find(call => call.type === "repair_source")!; expect(f.client.pendingSourceRepairs()).toHaveLength(1); expect(f.errors).toHaveLength(1);
  first.unmount(); f.client.disconnect(); f.status.taskVersion = 456; f.status.status = "verified"; f.status.canRepair = false; f.controls.unknown = false;
  const second = new Client(), count = f.calls.length; render(<SourceRepair client={second} threadId={taskId} busy={false} run={async perform => { await perform(second); }} />);
  expect(f.calls).toHaveLength(count); await user.click(screen.getByRole("button", { name: "重试原修复请求" })); await screen.findByText("原文已修复，损坏副本及修复清单已保留。");
  expect(f.calls.filter(call => call.type === "repair_source")).toEqual([original, original]); expect(second.pendingSourceRepairs()).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
});

it("blocks new repair when local recovery storage is malformed or cannot persist an intent", async () => {
  const f = fixture(), key = storageKey("practiq-source-repair-intents-v1", f.client.storageScope), user = userEvent.setup(); localStorage.setItem(key, JSON.stringify([{ threadId: taskId, requestId: runId, expectedVersion: 123, path: "/must-not-exist" }]));
  const component = render(<SourceRepair client={f.client} threadId={taskId} busy={false} run={f.run} />); expect(screen.getByRole("alert").textContent).toContain("无法读取原文修复"); expect(f.calls).toEqual([]);
  component.unmount(); localStorage.removeItem(key); render(<SourceRepair client={f.client} threadId={taskId} busy={false} run={f.run} />); await user.click(screen.getByRole("button", { name: "校验原文" })); await screen.findByRole("button", { name: "选择原文件并修复" });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("quota"); }); await user.click(screen.getByRole("button", { name: "选择原文件并修复" })); await waitFor(() => expect(f.errors).toContainEqual(expect.objectContaining({ code: "RECOVERY_STORAGE_UNAVAILABLE" })));
  expect(f.calls.map(call => call.type)).toEqual(["source_status"]);
});

it.each(["cancelled", "wrong_receipt"])("handles %s repair receipts without losing unconfirmed requests", async mode => {
  const f = fixture(); f.controls.cancelled = mode === "cancelled"; f.controls.wrongReceipt = mode === "wrong_receipt";
  const work = f.client.repairSource(f.status);
  if (mode === "cancelled") { expect((await work).status).toBe("cancelled"); expect(f.client.pendingSourceRepairs()).toEqual([]); }
  else { await expect(work).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(f.client.pendingSourceRepairs()).toHaveLength(1); }
  expect(f.calls).toHaveLength(1); f.client.disconnect(); await expect(f.client.retrySourceRepair(runId)).rejects.toMatchObject({ name: "AbortError" }); expect(f.calls).toHaveLength(1);
});
