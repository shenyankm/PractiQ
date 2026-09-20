// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("keeps JSON import usable without models and preserves the destination bank", async () => {
  vi.mocked(invoke).mockRejectedValue("请先配置模型地址");
  vi.mocked(api).mockImplementation(async (request) => {
    switch (request.type) {
      case "banks":
        return [
          { id: "bank-1", title: "现有题库", description: "", count: 0 },
        ] as never;
      case "sessions":
      case "questions":
        return [] as never;
      case "info":
        return { version: "test", dataDirectory: "/tmp/test" } as never;
      case "pick_import":
        return {
          ticket: "ticket",
          title: "新文件",
          count: 1,
          reviewCount: 0,
          assetCount: 0,
          missingAssets: [],
          warnings: [],
          status: "SUCCEEDED",
        } as never;
      case "import":
        return { bankId: "bank-1", count: 1, duplicate: false } as never;
      default:
        throw new Error(`Unexpected request: ${request.type}`);
    }
  });
  render(<App />);
  const open = await screen.findByRole("button", { name: /打开题库/ });
  await waitFor(() => expect(open.hasAttribute("disabled")).toBe(false));
  await userEvent.click(open);
  const start = screen.getByRole("button", { name: "导入" });
  await waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  await userEvent.click(start);
  expect(
    await screen.findByRole("heading", { name: "导入题库", level: 1 }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("navigation")).getByRole("button", {
      name: "导入题库",
    }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "文档解析" })).toBeNull();
  expect(screen.getByText(/暂不支持 Word 文件/).textContent).toContain(
    "导出为 PDF",
  );
  expect(screen.getByText(/支持 PDF/).textContent).toContain(".jpeg");
  expect(screen.getByText(/支持 PDF/).textContent).not.toMatch(/\.gif|\.webp/);
  expect(await screen.findByText("请先配置模型地址")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() =>
    expect(screen.getAllByText("请先配置模型地址")).toHaveLength(1),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "选择题库 JSON" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox").textContent).toContain(
    "现有题库",
  );
  await waitFor(() =>
    expect(
      within(dialog)
        .getByRole("button", { name: "确认导入" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "确认导入" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      type: "import",
      ticket: "ticket",
      bank_id: "bank-1",
      title: "新文件",
    }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(
        ([command, args]) =>
          command === "ai_request" &&
          (args as { request: { type: string } }).request.type &&
          ["list", "operations", "batches"].includes(
            (args as { request: { type: string } }).request.type,
          ),
      ),
  ).toBe(true);
});
