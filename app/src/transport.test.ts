// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "./transport";

afterEach(() => { delete window.practiq; sessionStorage.clear(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("uses native data in development even with a saved preview scenario", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("MODE", "development");
  sessionStorage.setItem("practiq-preview", "normal");
  const banks = [{ id: "local-bank", title: "My saved bank" }];
  const request = vi.fn().mockResolvedValue({ ok: true, value: banks });
  window.practiq = { request, close: vi.fn(), onCloseRequested: vi.fn() };
  const args = { request: { type: "banks" } };
  expect(await invoke("request", args)).toEqual(banks);
  expect(request).toHaveBeenCalledExactlyOnceWith(args.request, undefined);
});

it("preserves native errors instead of substituting demo results", async () => {
  window.practiq = { request: vi.fn().mockResolvedValue({ ok: false, error: { code: "LOCAL_DATABASE_UNAVAILABLE" } }), close: vi.fn(), onCloseRequested: vi.fn() };
  await expect(invoke("request", { request: { type: "banks" } })).rejects.toEqual({ code: "LOCAL_DATABASE_UNAVAILABLE" });
});

it("uses the narrow Electron bridge without forwarding failed operations to the old runtime", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, value: [{ id: "bank" }] });
  window.practiq = { request, close: vi.fn(), onCloseRequested: vi.fn() };
  expect(await invoke("request", { request: { type: "banks" }, locale: "en" })).toEqual([{ id: "bank" }]);
  expect(request).toHaveBeenCalledWith({ type: "banks" }, "en");
  const error = { code: "LOCAL_NAME_INVALID", message: "Invalid name" };
  request.mockResolvedValue({ ok: false, error });
  await expect(invoke("request", { request: { type: "banks" } })).rejects.toEqual(error);
  await expect(invoke("arbitrary-channel", { path: "/private" })).rejects.toMatchObject({ code: "OPERATION_FAILED" });
});

it("sends explicit grading through the Electron main-process action", async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, value: { id: "session" } });
  window.practiq = { request, close: vi.fn(), onCloseRequested: vi.fn() };
  const grade = { type: "grade", id: "session", ordinal: 0, retry: false, snapshot_key: "snapshot:attempts" };
  expect(await invoke("ai_request", { request: grade, locale: "zh-TW" })).toEqual({ id: "session" });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: "ai_grade", request: grade }, "zh-TW");
});

it("refuses missing desktop IPC instead of starting a legacy runtime or substituting preview data", async () => {
  sessionStorage.setItem("practiq-preview", "normal");
  await expect(invoke("request", { request: { type: "banks" } })).rejects.toMatchObject({ code: "DESKTOP_UNAVAILABLE" });
});
