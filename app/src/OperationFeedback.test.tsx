// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorNotice } from "./OperationFeedback";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([false, true])("keeps diagnostics collapsed, then handles copy failure=%s", async fail => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async () => { if (fail) throw new Error("Clipboard unavailable"); });
  render(<ErrorNotice error={{ code: "OPERATION_FAILED", diagnostic: "Disk full", requestId: "request-123" }} />);
  expect(screen.getByText(/Disk full/).closest("details")?.open).toBe(false);
  expect(screen.getByText(/Disk full/).textContent).not.toContain("操作失败");
  await user.click(screen.getByText("诊断详情", { exact: true }));
  await user.click(screen.getByRole("button", { name: "复制诊断" }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("request-123"));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", fail ? "复制失败，请手动选择诊断文字。" : "诊断已复制");
});

it("keeps native ZIP diagnostics collapsed without losing the recovery guidance", () => {
  render(<ErrorNotice error={{ code: "LOCAL_BANK_ZIP_INVALID", params: { detail: "invalid Zip archive: Could not find EOCD" } }} />);
  expect(screen.getByText(/Could not find EOCD/).closest("details")?.open).toBe(false);
  expect(screen.getByText("题库 ZIP 无法读写。导入请确认包和资源完整；导出请选择新文件名。").closest("details")).toBeNull();
});

it("does not reuse copy feedback after the diagnostic changes", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { rerender } = render(<ErrorNotice error={{ code: "OPERATION_FAILED", diagnostic: "Disk full" }} />);
  await user.click(screen.getByText("诊断详情", { exact: true }));
  await user.click(screen.getByRole("button", { name: "复制诊断" }));
  expect((await screen.findByRole("status")).textContent).toBe("诊断已复制");
  rerender(<ErrorNotice error={{ code: "OPERATION_FAILED", diagnostic: "Permission denied" }} />);
  expect(screen.queryByRole("status")).toBeNull();
  await user.click(screen.getByRole("button", { name: "复制诊断" }));
  expect((await screen.findByRole("status")).textContent).toBe("诊断已复制");
});
