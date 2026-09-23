import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("reads images through the binary Tauri command", async () => {
  const bytes = new ArrayBuffer(4);
  vi.mocked(invoke).mockResolvedValue(bytes);
  expect(await api({ type: "asset", hash: "digest" })).toBe(bytes);
  expect(invoke).toHaveBeenCalledWith("read_asset", { hash: "digest" });
});
