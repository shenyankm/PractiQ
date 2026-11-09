// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { invoke } from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("uses native data in development even with a saved preview scenario", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("MODE", "development");
  sessionStorage.setItem("practiq-preview", "normal");
  const banks = [{ id: "local-bank", title: "My saved bank" }];
  vi.mocked(nativeInvoke).mockResolvedValue(banks);
  const args = { request: { type: "banks" } };

  expect(await invoke("request", args)).toEqual(banks);
  expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith("request", args);
});

it("preserves native errors instead of substituting demo results", async () => {
  vi.mocked(nativeInvoke).mockRejectedValue({ code: "LOCAL_DATABASE_UNAVAILABLE" });

  await expect(invoke("request", { request: { type: "banks" } }))
    .rejects.toEqual({ code: "LOCAL_DATABASE_UNAVAILABLE" });
});
